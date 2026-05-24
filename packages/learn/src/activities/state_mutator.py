"""Universal state-mutation primitive — Phase A of the read-then-write contract.

Every actor that mutates a matter's or task's state field
(``current_state``, ``as_of``, ``status``, ``surface_class``,
``outcome``, ``pending_confirmation``) must route through
``apply_state_change_v2``. The function wraps a read-reason-write cycle
with optimistic-concurrency retries, env-gated shadow/live modes, an
in-process registry of "propose" functions, and a single atomic
three-artefact write delegated to ctrl-api's
``POST /api/v1/state-changes`` endpoint.

See ``packages/learn/docs/STATE-MUTATION.md`` for the full spec.

Phase A scope: build v2 fresh. The legacy ``steward.apply_state_change``
(v1) is untouched here; Phase B turns it into a thin shim around v2.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Literal

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Public dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ObservedWindow:
    """The interval the writer reasoned over.

    ``start`` is typically the target's prior ``as_of``; ``end`` is the
    moment the writer started reasoning (``now``). Path lists carry the
    vault references that materially influenced the decision so the
    audit record can replay the writer's input set later.
    """

    start: datetime
    end: datetime
    signal_paths: list[str]
    decision_paths: list[str]
    other_refs: list[str]


@dataclass(frozen=True)
class ProposedMutation:
    """A propose function's verdict.

    ``fields`` MUST contain only declared state fields (the API rejects
    anything else). ``confidence`` is 0.0–1.0; deterministic writers
    pass 1.0. ``fan_out`` is a tuple of named downstream effects to
    trigger after the write lands (e.g. ``"steward.related_to_resignal"``).
    Tuples (rather than lists) keep the dataclass hashable.
    """

    fields: dict[str, Any]
    reason: str
    confidence: float
    fan_out: tuple[str, ...] = ()


@dataclass(frozen=True)
class MutationResult:
    """The outcome of one ``apply_state_change_v2`` call.

    ``applied=False`` means the propose function returned ``None`` —
    no ctrl-api round-trip happened. ``effective_mode`` reflects the
    env veto applied to the caller's intent. ``pending_confirmation``
    is set when a live-mode write fell below the confidence threshold
    (the patch still lands; downstream consumers gate further action).
    """

    target_path: str
    source: str
    applied: bool
    mode: Literal["shadow", "live"]
    effective_mode: Literal["shadow", "live"]
    audit_record_path: str | None
    timeline_entry_id: str | None
    prior_as_of: str | None
    new_as_of: str | None
    pending_confirmation: bool
    retried_count: int
    fan_out_triggered: list[str] = field(default_factory=list)


class MutatorContentionError(RuntimeError):
    """Raised when optimistic-concurrency retries exhaust on the same target.

    ctrl-api returns ``409 Conflict`` when the caller's ``expected_as_of``
    no longer matches the on-disk value. ``apply_state_change_v2``
    re-fetches and re-proposes up to ``MAX_RETRIES`` total attempts;
    beyond that, the contention is genuine and the writer's workflow
    surfaces the failure for the next scheduled tick.
    """


# ---------------------------------------------------------------------------
# Propose-function registry
# ---------------------------------------------------------------------------
#
# Temporal activities cannot accept callables as arguments (deterministic
# replay constraint). Instead each writer's propose function registers
# itself under a stable name and ``apply_state_change_v2`` resolves the
# string back to a callable in-process at activity invocation time.
#
# The contract for a propose function:
#
#     async def propose(
#         *,
#         target: dict[str, Any],
#         observed: ObservedWindow,
#         args: dict[str, Any],
#     ) -> ProposedMutation | None:
#         ...
#
# Returning ``None`` means "no mutation warranted" — the mutator skips
# the ctrl-api round-trip entirely and returns ``applied=False``.
#
# Other writers (Phase B–E) expose their proposers via ``@propose_fn``:
#
#     from src.activities.state_mutator import propose_fn
#
#     @propose_fn("nightly_narrative.propose_matter_narrative")
#     async def _propose(*, target, observed, args): ...
#
# The decorator does NOT make the proposer a Temporal activity. Writers
# that also need their propose function to be invokable as a
# ``workflow.execute_activity`` (Pattern A in spec §6.1) should layer
# ``@activity.defn`` separately on the same callable — order matters:
# put ``@activity.defn`` outermost so the registry sees the underlying
# coroutine, not the activity wrapper, so it can be called in-process
# from within ``apply_state_change_v2``.

ProposeFn = Callable[..., Awaitable["ProposedMutation | None"]]

PROPOSE_REGISTRY: dict[str, ProposeFn] = {}


def propose_fn(name: str) -> Callable[[ProposeFn], ProposeFn]:
    """Decorator: register an async propose function under ``name``.

    Names should follow the same dotted-identifier convention as
    ``source`` strings (``writer.propose_thing``). Duplicate registration
    raises — fail loud at import time rather than silently overwriting.
    """

    def _decorator(fn: ProposeFn) -> ProposeFn:
        if name in PROPOSE_REGISTRY and PROPOSE_REGISTRY[name] is not fn:
            raise ValueError(
                f"propose_fn: name {name!r} already registered by "
                f"{PROPOSE_REGISTRY[name].__qualname__}"
            )
        PROPOSE_REGISTRY[name] = fn
        return fn

    return _decorator


def _resolve_propose_fn(name: str) -> ProposeFn:
    try:
        return PROPOSE_REGISTRY[name]
    except KeyError as exc:
        raise KeyError(
            f"state_mutator: no propose function registered for "
            f"{name!r}. Known: {sorted(PROPOSE_REGISTRY)!r}"
        ) from exc


# ---------------------------------------------------------------------------
# Env / mode resolution
# ---------------------------------------------------------------------------

# We deliberately share the env name with Steward (spec §4.5). The
# operator's veto is global — one switch, all writers obey.
STEWARD_LIVE_MODE_ENV = "STEWARD_LIVE_MODE"
STEWARD_CONFIDENCE_THRESHOLD_ENV = "STEWARD_CONFIDENCE_THRESHOLD"
STEWARD_HIGH_CONFIDENCE_THRESHOLD_ENV = "STEWARD_HIGH_CONFIDENCE_THRESHOLD"

DEFAULT_STEWARD_CONFIDENCE_THRESHOLD = 0.6
DEFAULT_STEWARD_HIGH_CONFIDENCE_THRESHOLD = 0.85

_VALID_ENV_MODES = ("shadow", "live", "live_high_confidence_only")

MAX_RETRIES = 3

# Sir-matter-task #3 (2026-05-24): user-toggleable settings file shared
# with ctrl-api (Lane I writes; we read). Mirrors the precedence
# established in ``signal_actions._resolve_signal_action_mode``:
#   1. Env STEWARD_LIVE_MODE (override; kept for ops emergency)
#   2. /alfred-data/settings.json key ``state_mutator_mode``
#   3. Default "live" (was "shadow" — left state_mutator in shadow for
#      every fresh tenant, which is why 13 matters sat at
#      ``current_state: null, signal_count_24h: 0`` on home.alfred.black)
from pathlib import Path as _Path

_STATE_MUTATOR_SETTINGS_PATH = _Path("/alfred-data/settings.json")
_STATE_MUTATOR_SETTINGS_KEY = "state_mutator_mode"
_DEFAULT_STATE_MUTATOR_MODE = "live"


def _resolve_state_mutator_mode() -> str:
    """Return the effective live-mode for state_mutator.

    Sir-matter-task #3 (2026-05-24): default flipped from ``"shadow"``
    to ``"live"`` and a user-toggleable settings file added so Sir can
    flip the surface from /study without a redeploy.

    Precedence:
      1. Env ``STEWARD_LIVE_MODE`` if set (emergency override).
      2. ``/alfred-data/settings.json`` key ``state_mutator_mode`` if
         the file exists and the key is one of the valid modes.
      3. Default ``"live"``.

    Returns one of: ``"shadow"``, ``"live"``,
    ``"live_high_confidence_only"``. Any read error (missing file,
    malformed JSON, IO error) fail-safes to the default. Unrecognised
    values (env or file) log a warning and fall back to the default.

    Settings file is written by ctrl-api (Lane I owns the writer). On
    a fresh tenant the file does not exist — that's the steady state
    and must NOT emit a warning.
    """
    import json as _json

    # 1. Env override.
    env_raw = os.environ.get(STEWARD_LIVE_MODE_ENV)
    if env_raw:
        raw = env_raw.strip().lower()
        if raw in _VALID_ENV_MODES:
            return raw
        logger.warning(
            "state_mutator._resolve_state_mutator_mode: unrecognised %s=%s "
            "— falling back to settings/default",
            STEWARD_LIVE_MODE_ENV, raw,
        )
        # fall through to settings/default

    # 2. Settings file.
    try:
        if _STATE_MUTATOR_SETTINGS_PATH.exists():
            data = _json.loads(_STATE_MUTATOR_SETTINGS_PATH.read_text())
            value = data.get(_STATE_MUTATOR_SETTINGS_KEY) if isinstance(data, dict) else None
            if isinstance(value, str):
                raw = value.strip().lower()
                if raw in _VALID_ENV_MODES:
                    return raw
                logger.warning(
                    "state_mutator._resolve_state_mutator_mode: "
                    "unrecognised settings.json %s=%s — using default %s",
                    _STATE_MUTATOR_SETTINGS_KEY, raw, _DEFAULT_STATE_MUTATOR_MODE,
                )
    except (_json.JSONDecodeError, ValueError) as exc:
        logger.warning(
            "state_mutator._resolve_state_mutator_mode: settings.json "
            "parse failed (%s) — using default %s",
            exc, _DEFAULT_STATE_MUTATOR_MODE,
        )
    except OSError as exc:
        logger.warning(
            "state_mutator._resolve_state_mutator_mode: settings.json "
            "read failed (%s) — using default %s",
            exc, _DEFAULT_STATE_MUTATOR_MODE,
        )

    # 3. Default.
    return _DEFAULT_STATE_MUTATOR_MODE


def _resolve_env_live_mode() -> str:
    """Legacy resolver — kept as a thin alias to
    ``_resolve_state_mutator_mode`` so the existing call sites in
    ``apply_state_change_v2`` don't have to be touched.

    Sir-matter-task #3 (2026-05-24): previously this read only the env
    and defaulted to ``"shadow"``. New behaviour delegates to the
    settings-aware resolver which defaults to ``"live"``.
    """
    return _resolve_state_mutator_mode()


def _resolve_confidence_threshold(env_name: str, default: float) -> float:
    raw = (os.environ.get(env_name) or "").strip()
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        logger.warning(
            "state_mutator: %s=%s is not a number — using default %.2f",
            env_name, raw, default,
        )
        return default
    if not 0.0 <= v <= 1.0:
        logger.warning(
            "state_mutator: %s=%.2f out of range — using default %.2f",
            env_name, v, default,
        )
        return default
    return v


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


def _observed_to_envelope(observed: ObservedWindow) -> dict[str, Any]:
    return {
        "start": _iso(observed.start),
        "end": _iso(observed.end),
        "signal_paths": list(observed.signal_paths),
        "decision_paths": list(observed.decision_paths),
        "other_refs": list(observed.other_refs),
    }


# ---------------------------------------------------------------------------
# Helper activity: read_target
# ---------------------------------------------------------------------------


@activity.defn
async def read_target(path: str) -> dict[str, Any]:
    """Read a matter or task record. Returns ``{frontmatter, body, as_of}``.

    ``as_of`` is lifted from frontmatter onto the top level so callers
    don't have to dig — this is the value that goes into the
    ``expected_as_of`` field of the next ``apply_state_change_v2`` call.

    Missing record → returns ``{frontmatter: {}, body: "", as_of: None}``
    so a fresh-seed write (``prior_as_of=null``) is expressible without
    a separate "exists?" probe.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        try:
            record = await client.read_record(path)
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                return {"frontmatter": {}, "body": "", "as_of": None}
            raise
        fm = record.get("frontmatter") or {}
        if not isinstance(fm, dict):
            fm = {}
        body = record.get("body") or record.get("content") or ""
        as_of_raw = fm.get("as_of")
        as_of = str(as_of_raw).strip() if as_of_raw else None
        return {
            "frontmatter": fm,
            "body": str(body),
            "as_of": as_of,
        }
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Helper activity: gather_observed
# ---------------------------------------------------------------------------


def _parse_iso_or_none(ts: Any) -> datetime | None:
    if ts is None:
        return None
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    if not isinstance(ts, str):
        return None
    s = ts.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _record_targets(fm: dict[str, Any], target_path: str) -> bool:
    """True iff a signal/decision/event record references ``target_path``.

    Checks the four conventional pointer fields:
      * ``target_path`` — resolved post-router
      * ``target_candidates`` — pre-router; list of {path,...} or str
      * ``parent_matter`` — task→matter linkage
      * ``related_matters`` — list of additional matter pointers
    """
    target_path = target_path.strip()
    if not target_path:
        return False
    tp = str(fm.get("target_path") or "").strip()
    if tp == target_path:
        return True
    parent = str(fm.get("parent_matter") or fm.get("matter") or "").strip()
    if parent == target_path:
        return True
    related = fm.get("related_matters")
    if isinstance(related, list):
        for r in related:
            if isinstance(r, str) and r.strip() == target_path:
                return True
    cands = fm.get("target_candidates")
    if isinstance(cands, list):
        for c in cands:
            if isinstance(c, dict) and str(c.get("path") or "").strip() == target_path:
                return True
            if isinstance(c, str) and c.strip() == target_path:
                return True
    return False


@activity.defn
async def gather_observed(target_path: str, since: str) -> ObservedWindow:
    """Walk signal/decision/event records pointing at ``target_path``.

    ``since`` is an ISO-8601 UTC timestamp; records older than this are
    skipped. The walk consults ``applied_at`` first then falls back to
    ``created`` / ``record.created`` so signals that haven't been routed
    yet still surface.

    Returns the populated ``ObservedWindow`` with ``end = now`` —
    the writer's reasoning window closes at the moment of the read.
    """
    cutoff = _parse_iso_or_none(since) or datetime.now(timezone.utc)
    end = datetime.now(timezone.utc)

    config = load_config()
    client = VaultClient(config)

    signal_paths: list[str] = []
    decision_paths: list[str] = []
    other_refs: list[str] = []

    try:
        # Signals are state.db rows (storage cutover #27) — query
        # ctrl-api's /api/v1/state/signals scoped to this matter
        # instead of walking vault/signal/. decision/ + event/ stay
        # canonical vault markdown.
        try:
            from src.utils.signal_state import (
                StateClient,
                signal_row_to_record,
            )

            async with StateClient(config) as sc:
                sig_rows = await sc.list_signals(
                    matter=target_path, since=since, limit=10_000,
                )
            for row in sig_rows:
                rec = signal_row_to_record(row)
                fm = rec.get("frontmatter") or {}
                if not _record_targets(fm, target_path):
                    if str(fm.get("target_matter_path") or "").strip() != target_path:
                        continue
                ts_raw = (
                    fm.get("applied_at")
                    or fm.get("created")
                    or rec.get("created")
                )
                ts = _parse_iso_or_none(ts_raw)
                if ts is None or ts < cutoff:
                    continue
                sid = str(rec.get("id") or "").strip()
                if sid:
                    signal_paths.append(sid)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "state_mutator.gather_observed: state.db signal query "
                "failed target=%s err=%s", target_path, exc,
            )

        for record_type, sink in (
            ("decision", decision_paths),
            ("event", other_refs),
        ):
            try:
                records = await client.list_records(record_type, limit=10_000)
            except httpx.HTTPError as exc:
                logger.warning(
                    "state_mutator.gather_observed: %s list failed target=%s err=%s",
                    record_type, target_path, exc,
                )
                continue
            for rec in records:
                if not isinstance(rec, dict):
                    continue
                fm = rec.get("frontmatter") or rec
                if not isinstance(fm, dict):
                    fm = {}
                if not _record_targets(fm, target_path):
                    continue
                ts_raw = (
                    fm.get("applied_at")
                    or fm.get("created")
                    or rec.get("created")
                )
                ts = _parse_iso_or_none(ts_raw)
                if ts is None or ts < cutoff:
                    continue
                path = str(rec.get("path") or fm.get("path") or "").strip()
                if path:
                    sink.append(path)
    finally:
        await client.close()

    return ObservedWindow(
        start=cutoff,
        end=end,
        signal_paths=signal_paths,
        decision_paths=decision_paths,
        other_refs=other_refs,
    )


# ---------------------------------------------------------------------------
# Core activity: apply_state_change_v2
# ---------------------------------------------------------------------------


def _build_undo_recipe(
    target_path: str,
    prior_fm: dict[str, Any],
    fields: dict[str, Any],
    expires_at: str,
) -> dict[str, Any]:
    """Build the ``vault_patch`` revert recipe.

    For every field the new write touches we record its prior value so a
    later revert can restore it byte-for-byte. Fields that didn't exist
    on the prior record map to ``None``; the ctrl-api revert helper
    treats ``None`` as "delete the key".
    """
    revert_fields: dict[str, Any] = {}
    for k in fields.keys():
        revert_fields[k] = prior_fm.get(k) if k in prior_fm else None
    return {
        "vault_patch": {
            "target_path": target_path,
            "revert_fields": revert_fields,
        },
        "expires_at": expires_at,
    }


def _build_envelope(
    *,
    target_path: str,
    source: str,
    expected_as_of: str | None,
    observed: ObservedWindow,
    fields: dict[str, Any],
    reason: str,
    confidence: float,
    effective_mode: str,
    undo_recipe: dict[str, Any],
) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "target_path": target_path,
        "source": source,
        "observed_window": _observed_to_envelope(observed),
        "fields": fields,
        "reason": reason,
        "confidence": confidence,
        "mode": effective_mode,
        "undo_recipe": undo_recipe,
    }
    if expected_as_of is not None:
        envelope["expected_as_of"] = expected_as_of
    return envelope


def _json_default(obj: Any) -> Any:
    """Best-effort serializer for envelope values that slipped through with
    a non-JSON-native type. Most common case: a prior-frontmatter value that
    Temporal's data converter restored as a datetime, or a payload field
    from an upstream API that retains the parsed datetime."""
    if isinstance(obj, datetime):
        return _iso(obj)
    raise TypeError(f"state-mutator: not JSON-serializable: {type(obj).__name__}")


async def _post_state_change(envelope: dict[str, Any]) -> httpx.Response:
    """POST the envelope to ctrl-api. Returns the raw response.

    We use a fresh client per call (rather than reusing
    ``VaultClient``) because the state-changes endpoint is outside the
    vault-record namespace and we want explicit control over status
    handling — ``raise_for_status`` would obscure the 409 we treat as a
    retry signal.
    """
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    } if api_key else {"Content-Type": "application/json"}
    # Pre-serialize so stray datetime values are coerced to ISO strings via
    # our _json_default; httpx's default JSON encoder would raise on them.
    body = json.dumps(envelope, default=_json_default)
    async with httpx.AsyncClient(
        base_url=config.alfred_ctrl_url, timeout=30.0, headers=headers
    ) as client:
        return await client.post("/api/v1/state-changes", content=body)


async def _trigger_fan_out(
    fan_out: tuple[str, ...],
    target_path: str,
    source: str,
) -> list[str]:
    """Emit one fan-out signal record per entry in ``fan_out``.

    Phase A implementation: best-effort write to the steward-signals
    stream the same way ``steward._emit_steward_dependency_signals``
    does. Downstream consumers (Phase B+ retrofits) register handlers
    that observe these signals. Failures are logged; the mutation has
    already landed.
    """
    if not fan_out:
        return []
    triggered: list[str] = []
    config = load_config()
    streams_path = os.path.join(config.streams_dir, "state-mutator-signals.jsonl")
    try:
        os.makedirs(os.path.dirname(streams_path), exist_ok=True)
    except OSError as exc:
        logger.warning(
            "state_mutator.fan_out: cannot create streams dir path=%s err=%s",
            streams_path, exc,
        )
        return []
    now_iso = _now_iso()
    try:
        with open(streams_path, "a", encoding="utf-8") as f:
            import json as _json
            for idx, name in enumerate(fan_out):
                record = {
                    "id": (
                        f"evt_state_mutator_fanout_"
                        f"{int(datetime.now(timezone.utc).timestamp() * 1_000_000)}_{idx}"
                    ),
                    "ts": now_iso,
                    "kind": "state_mutator:fan_out",
                    "ref": f"vault:{target_path}",
                    "name": name,
                    "source": source,
                }
                f.write(_json.dumps(record) + "\n")
                triggered.append(name)
    except OSError as exc:
        logger.warning(
            "state_mutator.fan_out: write failed path=%s err=%s",
            streams_path, exc,
        )
        return triggered
    return triggered


def _coerce_observed(value: ObservedWindow | dict[str, Any]) -> ObservedWindow:
    """Accept ObservedWindow or its JSON-safe envelope dict.

    Workflow callers (e.g. plane_reverse_sync._mirror_status_v2) pre-
    serialize to dict so Temporal's data converter doesn't choke on
    datetime fields. In-process callers (briefing, steward, …) pass
    the dataclass directly.
    """
    if isinstance(value, ObservedWindow):
        return value
    start = value.get("start")
    end = value.get("end")
    if isinstance(start, str):
        start = datetime.fromisoformat(start.replace("Z", "+00:00"))
    if isinstance(end, str):
        end = datetime.fromisoformat(end.replace("Z", "+00:00"))
    return ObservedWindow(
        start=start,
        end=end,
        signal_paths=list(value.get("signal_paths") or []),
        decision_paths=list(value.get("decision_paths") or []),
        other_refs=list(value.get("other_refs") or []),
    )


@activity.defn
async def apply_state_change_v2(
    target_path: str,
    source: str,
    observed: ObservedWindow | dict[str, Any],
    propose_fn_name: str,
    propose_fn_args: dict[str, Any],
    mode: Literal["shadow", "live"] = "shadow",
    expected_as_of: str | None = None,
) -> MutationResult:
    """Read-reason-write-log primitive — universal mutator entrypoint.

    Spec §4.1 + §4.5 + §6.2. Steps:

    1. Read the target (so the propose function reasons against fresh state).
    2. Invoke the registered propose function. ``None`` → no-op return.
    3. Resolve ``effective_mode`` from caller intent ∩ env veto.
    4. For live mode, gate on confidence threshold; sub-threshold writes
       stamp ``pending_confirmation=True`` into ``fields`` but still
       persist via ctrl-api so reviewers see the proposed change.
    5. POST the envelope to ctrl-api's ``/api/v1/state-changes``. On
       409 (as_of mismatch), re-read, re-propose, retry — bounded at
       ``MAX_RETRIES``. After that, raise ``MutatorContentionError``.
    6. On 2xx, return a populated ``MutationResult``; fan-out per
       ``proposed.fan_out``.

    The function is exposed both as a ``@activity.defn`` (for
    ``workflow.execute_activity`` in workflows — Pattern A in spec
    §6.1) and as a plain ``async def`` callable for in-process calls
    from inside another activity (Pattern B in spec §6.2). Temporal's
    ``@activity.defn`` decorator preserves the underlying coroutine,
    so direct invocation is safe.
    """
    if mode not in ("shadow", "live"):
        raise ValueError(f"state_mutator: unsupported mode {mode!r}")

    observed = _coerce_observed(observed)
    propose = _resolve_propose_fn(propose_fn_name)
    env_mode = _resolve_env_live_mode()

    # Mode downgrade: env can only DOWNGRADE caller intent.
    if mode == "live" and env_mode == "shadow":
        effective_mode: Literal["shadow", "live"] = "shadow"
    elif mode == "shadow":
        effective_mode = "shadow"
    else:
        effective_mode = "live"

    current_expected_as_of = expected_as_of
    retried_count = 0
    last_response: httpx.Response | None = None

    for attempt in range(MAX_RETRIES):
        target_snapshot = await read_target(target_path)
        prior_fm: dict[str, Any] = target_snapshot.get("frontmatter") or {}
        prior_as_of: str | None = target_snapshot.get("as_of")

        proposed = await propose(
            target=target_snapshot,
            observed=observed,
            args=propose_fn_args,
        )
        if proposed is None:
            return MutationResult(
                target_path=target_path,
                source=source,
                applied=False,
                mode=mode,
                effective_mode=effective_mode,
                audit_record_path=None,
                timeline_entry_id=None,
                prior_as_of=prior_as_of,
                new_as_of=None,
                pending_confirmation=False,
                retried_count=retried_count,
                fan_out_triggered=[],
            )

        # Confidence gate: sub-threshold live writes land as pending
        # but still mutate state so the dashboard sees the proposal.
        pending_confirmation = False
        if effective_mode == "live":
            if env_mode == "live_high_confidence_only":
                threshold = _resolve_confidence_threshold(
                    STEWARD_HIGH_CONFIDENCE_THRESHOLD_ENV,
                    DEFAULT_STEWARD_HIGH_CONFIDENCE_THRESHOLD,
                )
            else:
                threshold = _resolve_confidence_threshold(
                    STEWARD_CONFIDENCE_THRESHOLD_ENV,
                    DEFAULT_STEWARD_CONFIDENCE_THRESHOLD,
                )
            if proposed.confidence < threshold:
                pending_confirmation = True

        fields = dict(proposed.fields)
        if pending_confirmation:
            fields["pending_confirmation"] = True

        # Undo recipe with 7-day expiry — matches Steward's window.
        expires_at = _iso(datetime.now(timezone.utc) + timedelta(days=7))
        undo_recipe = _build_undo_recipe(
            target_path=target_path,
            prior_fm=prior_fm,
            fields=fields,
            expires_at=expires_at,
        )

        envelope = _build_envelope(
            target_path=target_path,
            source=source,
            expected_as_of=current_expected_as_of,
            observed=observed,
            fields=fields,
            reason=proposed.reason,
            confidence=proposed.confidence,
            effective_mode=effective_mode,
            undo_recipe=undo_recipe,
        )

        try:
            response = await _post_state_change(envelope)
        except httpx.HTTPError as exc:
            logger.warning(
                "state_mutator.apply_state_change_v2: ctrl-api POST failed "
                "target=%s source=%s attempt=%d err=%s",
                target_path, source, attempt + 1, exc,
            )
            raise

        last_response = response

        if response.status_code == 409:
            try:
                payload = response.json()
            except (ValueError, httpx.DecodingError):
                payload = {}
            new_as_of = (
                str(payload.get("current_as_of") or "").strip()
                or str(payload.get("as_of") or "").strip()
                or None
            )
            logger.info(
                "state_mutator.apply_state_change_v2: 409 conflict "
                "target=%s source=%s expected_as_of=%s server_as_of=%s "
                "attempt=%d/%d — retrying",
                target_path, source, current_expected_as_of, new_as_of,
                attempt + 1, MAX_RETRIES,
            )
            current_expected_as_of = new_as_of
            retried_count = attempt + 1
            continue

        if response.status_code >= 400:
            response.raise_for_status()

        body = response.json() or {}
        audit_record_path = body.get("audit_record_path")
        timeline_entry_id = body.get("timeline_entry_id")
        new_as_of = body.get("new_as_of")

        fan_out_triggered = await _trigger_fan_out(
            proposed.fan_out, target_path, source
        )

        return MutationResult(
            target_path=target_path,
            source=source,
            applied=True,
            mode=mode,
            effective_mode=effective_mode,
            audit_record_path=str(audit_record_path) if audit_record_path else None,
            timeline_entry_id=str(timeline_entry_id) if timeline_entry_id else None,
            prior_as_of=prior_as_of,
            new_as_of=str(new_as_of) if new_as_of else None,
            pending_confirmation=pending_confirmation,
            retried_count=retried_count,
            fan_out_triggered=fan_out_triggered,
        )

    # All retries exhausted.
    server_as_of: str | None = None
    if last_response is not None and last_response.status_code == 409:
        try:
            payload = last_response.json()
            server_as_of = (
                str(payload.get("current_as_of") or "").strip()
                or str(payload.get("as_of") or "").strip()
                or None
            )
        except (ValueError, httpx.DecodingError):
            server_as_of = None
    raise MutatorContentionError(
        f"state_mutator: exhausted {MAX_RETRIES} retries on "
        f"target={target_path!r} source={source!r} "
        f"last_server_as_of={server_as_of!r}"
    )


__all__ = [
    "ObservedWindow",
    "ProposedMutation",
    "MutationResult",
    "MutatorContentionError",
    "PROPOSE_REGISTRY",
    "propose_fn",
    "read_target",
    "gather_observed",
    "apply_state_change_v2",
]
