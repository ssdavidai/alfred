"""Signal/observation pipeline adapter over ``state.db`` (#26/#27).

Storage cutover, PLAN.md Part I. The signal pipeline used to thread a
markdown path (``signal/<ts>-<hash>.md``) as the cross-record id from
``SignalExtractWorkflow`` → router → mutations → actions → briefing.
Markdown-as-database is the mistake Part I fixes: ``signal`` and
``observation`` are *machine bookkeeping*, not principal-facing vault
records, so they now live in ``state.db`` (Store 2), written through
ctrl-api's ``/api/v1/state/*`` API via :class:`StateClient`.

**Cross-record key.** The new cross-record key is the ``state.db`` row
id — a ULID string assigned by ctrl-api on insert. Activity/workflow
signatures that used to pass a ``signal_path`` string now pass that
ULID. The variable name ``signal_ref`` is used in new code; legacy
parameter names (``signal_path``) are kept where changing them would
churn a Temporal-registered signature, but they always carry the ULID.

**Shape compatibility.** The router, mutations, actions and brief
composer all consume a signal as a ``{"path": ..., "frontmatter":
{...}}`` dict (the shape ``VaultClient.read_record`` returned). To keep
those consumers' field access untouched, this module rehydrates a
``state.db`` ``signal`` row into exactly that shape via
:func:`signal_row_to_record` — ``frontmatter`` carries every field the
old YAML frontmatter did, lifted from dedicated columns + the
``payload`` JSON blob. ``path`` carries the ULID (an opaque ref now,
not a filesystem path).

This module is the single seam between the old markdown-shaped code and
``state.db``; nothing else in the pipeline imports ``StateClient``
directly for signals/observations.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from collections.abc import Collection
from typing import Any

from src.config import Config, load_config
from src.utils.state_client import StateClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Cross-record key helpers
# ---------------------------------------------------------------------------

# Legacy callers (Temporal history, sidecar columns) may still carry a
# markdown-style ``signal/<ts>-<hash>.md`` string. New code never
# produces those, but a defensive normaliser keeps a replayed history
# from crashing: a path-shaped ref simply has its basename taken (it
# won't resolve in state.db, and the activity treats that as
# "signal vanished" — the correct terminal behaviour).
def normalise_signal_ref(ref: str | None) -> str:
    """Return the bare ``state.db`` id for a cross-record signal ref.

    Accepts either a plain ULID (the new key) or a legacy
    ``signal/<name>.md`` path (pre-cutover Temporal history). For the
    legacy form the basename sans extension is returned — it will not
    resolve in ``state.db``, which is the intended outcome (those rows
    never existed there).
    """
    s = (ref or "").strip()
    if not s:
        return ""
    if "/" in s:
        s = s.rsplit("/", 1)[-1]
    if s.endswith(".md"):
        s = s[:-3]
    return s


def is_signal_ref(ref: str | None) -> bool:
    """True if ``ref`` looks like a usable cross-record signal ref."""
    return bool(normalise_signal_ref(ref))


# ---------------------------------------------------------------------------
# state.db row  ⇄  legacy signal-record dict
# ---------------------------------------------------------------------------
#
# The extractor builds a rich "signal dict" (target_*, effect_*,
# proposals, reasoning, display_*, …). Pre-cutover that dict was
# YAML-encoded into a vault record. Now it is split across the
# ``signal`` table's typed columns + the ``payload`` JSON blob:
#
#   column    headline   ← signal.display_headline / name
#   column    body       ← signal.display_body / reasoning summary
#   column    kind       ← signal.effect ("mutation"/"action"/"none"/…)
#   column    source     ← signal.source_type
#   column    ts         ← signal.created_at
#   column    entity_ref ← signal.target_path
#   column    matter_ref ← signal.target_matter_path
#   column    salience   ← signal.effect_confidence
#   column    status     ← routing status ("unrouted"/"applied"/…)
#   payload   {everything else — the full extractor dict}
#
# ``signal_row_to_record`` reverses this so a consumer that does
# ``record["frontmatter"]["target_path"]`` keeps working unchanged.

# Frontmatter fields that get a dedicated state.db column. Everything
# else on the extractor dict round-trips through ``payload``.
_COLUMN_BACKED_FIELDS = frozenset(
    {
        "effect",
        "source_type",
        "created",
        "created_at",
        "target_path",
        "target_matter_path",
        "effect_confidence",
        "status",
        "display_headline",
        "display_body",
    }
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def signal_dict_to_create_kwargs(signal: dict[str, Any]) -> dict[str, Any]:
    """Translate an extractor signal dict into ``StateClient.create_signal`` kwargs.

    The extractor dict is the rich object produced by
    ``extract_signals_from_event``. We keep the *entire* dict in
    ``payload`` so :func:`signal_row_to_record` can reconstruct a
    byte-for-byte-equivalent ``frontmatter`` for downstream consumers,
    and additionally project the routing-relevant fields onto typed
    columns so ctrl-api can index/filter them.
    """
    effect = str(signal.get("effect") or "").strip().lower() or "none"
    source_type = str(signal.get("source_type") or "").strip() or "unknown"
    created = (
        str(signal.get("created_at") or signal.get("created") or "").strip()
        or _now_iso()
    )
    headline = (
        str(signal.get("display_headline") or "").strip()
        or str(signal.get("raw_quote") or "").strip()[:120]
        or str(signal.get("name") or "").strip()
        or f"{source_type} signal"
    )
    body = (
        str(signal.get("display_body") or "").strip()
        or str(signal.get("reasoning") or "").strip()
    )

    target_path = signal.get("target_path")
    matter_path = signal.get("target_matter_path")
    try:
        salience = float(signal.get("effect_confidence") or 0.0)
    except (TypeError, ValueError):
        salience = 0.0

    # The full extractor dict is the payload. We strip nothing — the
    # rehydrator needs every field. ``status`` defaults to "unrouted" so a
    # freshly extracted signal is routable (C2); an explicit non-blank
    # status already on the dict (e.g. a re-projected/already-routed
    # signal) is honoured rather than silently reset. The column stays
    # authoritative on read; the payload copy is ignored.
    status = str(signal.get("status") or "").strip() or "unrouted"
    payload = dict(signal)
    payload.setdefault("created", created)

    return {
        "kind": effect,
        "source": source_type,
        "headline": headline[:300] or "signal",
        "body": body or None,
        "ts": created,
        "stream_event_id": (
            str(signal.get("source_event_path") or "").strip() or None
        ),
        "entity_ref": (
            str(target_path).strip() if isinstance(target_path, str) and target_path.strip() else None
        ),
        "matter_ref": (
            str(matter_path).strip() if isinstance(matter_path, str) and matter_path.strip() else None
        ),
        "salience": salience,
        "status": status,
        "payload": payload,
    }


def _coerce_payload(payload: Any) -> dict[str, Any]:
    """Return a row's payload as a dict, parsing a JSON string if needed.

    ctrl-api's GET routes return the ``payload_json`` column verbatim — a
    JSON STRING, not a parsed object. The rehydrators below previously did
    ``payload if isinstance(payload, dict) else {}``, which silently dropped
    the ENTIRE payload (action_proposal, decision_required, display fields,
    …) for every signal read back through the API. The router then saw no
    ``action_proposal`` and skipped every actionable signal as
    ``no_action_proposal`` — so no needs_attention card, no decision (#78).
    Parse the string here so column-light fields survive the round-trip.
    """
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str) and payload.strip():
        try:
            parsed = json.loads(payload)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, json.JSONDecodeError):
            return {}
    return {}


def signal_row_to_record(row: dict[str, Any]) -> dict[str, Any]:
    """Rehydrate a ``state.db`` ``signal`` row into a legacy record dict.

    Returns ``{"path": <ulid>, "frontmatter": {...}, "type": "signal"}``
    — the exact shape ``VaultClient.read_record`` produced for a
    ``signal/`` markdown record, so router / mutations / actions code
    that does ``record["frontmatter"]["..."]`` is untouched.

    The column values are authoritative; the ``payload`` blob fills in
    everything the columns don't carry.
    """
    payload = _coerce_payload(row.get("payload") or row.get("payload_json"))

    fm: dict[str, Any] = dict(payload)

    # Column-backed fields override the payload copy so a PATCH that
    # only touched a column (e.g. status) is reflected.
    fm["type"] = "signal"
    if row.get("kind") is not None:
        fm["effect"] = row.get("kind")
    if row.get("source") is not None:
        fm["source_type"] = row.get("source")
    created = row.get("ts") or payload.get("created") or payload.get("created_at")
    if created:
        fm["created"] = created
        fm["created_at"] = created
    if row.get("entity_ref"):
        fm["target_path"] = row.get("entity_ref")
    if row.get("matter_ref"):
        fm["target_matter_path"] = row.get("matter_ref")
    if row.get("salience") is not None:
        fm["effect_confidence"] = row.get("salience")
    if row.get("status"):
        fm["status"] = row.get("status")
    else:
        fm.setdefault("status", "unrouted")
    if row.get("headline"):
        fm.setdefault("display_headline", row.get("headline"))
    if row.get("body"):
        fm.setdefault("display_body", row.get("body"))

    # Routing-side fields the extractor doesn't set live only on the
    # column / on PATCH; surface them if present.
    for k in ("applied_at", "audit_record_path", "matched_instinct"):
        if k in payload:
            fm.setdefault(k, payload[k])

    return {
        "path": str(row.get("id") or ""),
        "id": str(row.get("id") or ""),
        "type": "signal",
        "created": created,
        "frontmatter": fm,
    }


# ---------------------------------------------------------------------------
# Thin async helpers — used by the cut-over activities
# ---------------------------------------------------------------------------

async def write_signal(
    signal: dict[str, Any], *, config: Config | None = None
) -> str:
    """Persist an extractor signal dict to ``state.db``; return its ULID.

    The ``state.db`` ``signal`` table replaces ``vault/signal/``. ctrl-api
    assigns the ULID; that ULID is the cross-record key threaded through
    the rest of the pipeline.
    """
    cfg = config or load_config()
    kwargs = signal_dict_to_create_kwargs(signal)
    async with StateClient(cfg) as sc:
        signal_id = await sc.create_signal(**kwargs)
    logger.info(
        "signal_state.write_signal: id=%s effect=%s target=%s conf=%.2f",
        signal_id,
        kwargs.get("kind"),
        kwargs.get("entity_ref"),
        float(kwargs.get("salience") or 0.0),
    )
    return signal_id


async def read_signal_record(
    signal_ref: str, *, config: Config | None = None
) -> dict[str, Any] | None:
    """Fetch a signal by its cross-record ref, in legacy record shape.

    Returns ``None`` when the row does not exist (the ctrl-api endpoint
    404s) — callers treat that as "signal vanished", the same terminal
    branch the old 404-on-read path took.
    """
    ref = normalise_signal_ref(signal_ref)
    if not ref:
        return None
    cfg = config or load_config()
    import httpx

    async with StateClient(cfg) as sc:
        try:
            row = await sc.get_signal(ref)
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                return None
            raise
    if not isinstance(row, dict):
        return None
    return signal_row_to_record(row)


async def set_signal_status(
    signal_ref: str,
    status: str,
    *,
    applied_at: str | None = None,
    audit_record_ref: str | None = None,
    matched_instinct: str | None = None,
    config: Config | None = None,
) -> None:
    """Mark a signal's routing status in ``state.db``.

    Replaces the old ``patch_frontmatter_structured`` call that stamped
    ``status`` / ``applied_at`` / ``audit_record_path`` onto the markdown
    record. ``applied_at`` + ``audit_record_ref`` + ``matched_instinct``
    are folded into ``payload`` so the rehydrated record still surfaces
    them.

    Sir #4+#5 — close the signal→instinct loop. ``matched_instinct`` is
    the vault path of the instinct the action router matched this signal
    against. Without it the /instincts UI, matter aggregator, and audit
    feeds all see "0 of N signals matched any instinct" — instincts
    become dead inventory.

    Payload merge contract — ctrl-api's PATCH /state/signals/:id route
    OVERWRITES ``payload_json`` wholesale (no JSON merge). To avoid
    clobbering the extractor's original payload (action_proposal,
    reasoning, display_*, decision_required, …) we read the current row
    first and merge our patch on top before sending. The read is a single
    cheap GET; the alternative was watching the entire signal context
    vanish on every status PATCH.
    """
    ref = normalise_signal_ref(signal_ref)
    if not ref:
        return
    cfg = config or load_config()
    import httpx

    # Read-merge-write: pull the existing payload so we don't clobber
    # action_proposal / reasoning / display_* on the column. A 404 here
    # means the signal vanished — let the caller's PATCH 404 as well so
    # the failure surfaces consistently.
    existing_payload: dict[str, Any] = {}
    async with StateClient(cfg) as sc:
        try:
            row = await sc.get_signal(ref)
            if isinstance(row, dict):
                existing_payload = _coerce_payload(
                    row.get("payload") or row.get("payload_json")
                )
        except httpx.HTTPStatusError as exc:
            # 404 → row gone; fall through and let the PATCH below
            # raise the same 404 (consistent caller-facing behaviour).
            if exc.response is None or exc.response.status_code != 404:
                raise

        payload_patch: dict[str, Any] = dict(existing_payload)
        payload_patch["applied_at"] = applied_at or _now_iso()
        payload_patch["audit_record_path"] = audit_record_ref or ""
        if matched_instinct:
            payload_patch["matched_instinct"] = matched_instinct
        await sc.update_signal(ref, status=status, payload=payload_patch)


def observation_row_to_record(row: dict[str, Any]) -> dict[str, Any]:
    """Rehydrate a ``state.db`` ``observation`` row into a record dict.

    Returns ``{"path": <ulid>, "frontmatter": {...}}`` — the shape
    pattern detection's clusterer (``_build_clusters``) consumes. The
    canonical observation fields (subject/fact/topic/source_kind/sender/
    intent/created/matter_ref/instinct/...) come from the ``payload``
    JSON blob; typed columns override where they carry the field.
    """
    payload = _coerce_payload(row.get("payload") or row.get("payload_json"))
    fm: dict[str, Any] = dict(payload)
    fm["type"] = "observation"
    if row.get("subject") is not None:
        fm["subject"] = row.get("subject")
    # ``kind`` column == source_kind ("signal" / "decision").
    if row.get("kind") is not None:
        fm.setdefault("source_kind", row.get("kind"))
    if row.get("summary") is not None:
        fm.setdefault("fact", row.get("summary"))
    created = row.get("ts") or payload.get("created")
    if created:
        fm["created"] = created
    if row.get("instinct_ref"):
        fm.setdefault("instinct", row.get("instinct_ref"))
    if row.get("confidence") is not None:
        fm.setdefault("confidence", row.get("confidence"))
    if row.get("status"):
        fm.setdefault("status", row.get("status"))
    return {
        "path": str(row.get("id") or ""),
        "id": str(row.get("id") or ""),
        "type": "observation",
        "created": created,
        "frontmatter": fm,
    }


# The kinds that describe the world — what the intuition layer learns from and
# what the brief may show Sir. The observation table is a SHARED BUS and its
# readers historically filtered nothing, so any new derived/reporting kind
# written into it silently appeared in the daily brief and in pattern
# discovery. Consumers of those two surfaces must pass this set.
#
# Reporting kinds (e.g. attention_read) are deliberately absent: they are
# statements about the system, not observations about the world, and feeding
# them to pattern discovery would let a dashboard shape proposed instincts.
INTUITION_OBS_KINDS: frozenset[str] = frozenset({
    "chore_run", "decision", "signal", "constraint",
    "synthesis", "assumption", "contradiction", "system",
})


async def list_observation_records(
    *,
    kind: str | None = None,
    kinds: Collection[str] | None = None,
    since: str | None = None,
    limit: int | None = None,
    config: Config | None = None,
) -> list[dict[str, Any]]:
    """List ``state.db`` observations rehydrated into record dicts.

    Replaces ``GET /api/v1/vault/list/observation`` for the pattern
    detector — observations are Store 2 rows now.

    ``kinds`` filters to a SET of kinds (``kind`` filters to one, server-side).
    The filter is applied to the RAW ROW, before rehydration, deliberately:
    ``observation_row_to_record`` does not carry ``kind`` at the top level — it
    folds the column into ``frontmatter["source_kind"]`` via ``setdefault``, so
    a payload that already carries ``source_kind`` keeps its own value and the
    column is lost. Filtering the rehydrated record would therefore drop rows
    it should keep and keep rows it should drop.
    """
    cfg = config or load_config()
    async with StateClient(cfg) as sc:
        rows = await sc.list_observations(kind=kind, since=since, limit=limit)
    if kinds is not None:
        allowed = set(kinds)
        rows = [r for r in rows if r.get("kind") in allowed]
    return [observation_row_to_record(r) for r in rows]


async def list_unrouted_signal_refs(
    *, limit: int, since: str | None = None, config: Config | None = None
) -> list[str]:
    """Return ULIDs of ``status=unrouted`` signals, oldest-first.

    Replaces the old ``GET /api/v1/vault/list/signal`` walk +
    client-side frontmatter filter. ctrl-api filters on the indexed
    ``status`` column directly.
    """
    cfg = config or load_config()
    async with StateClient(cfg) as sc:
        rows = await sc.list_signals(status="unrouted", since=since, limit=limit)
    # state.db lists newest-first; the router historically drained
    # oldest-first so the backlog clears chronologically.
    rows_sorted = sorted(rows, key=lambda r: str(r.get("ts") or ""))
    out: list[str] = []
    for r in rows_sorted[: max(0, int(limit))]:
        rid = str(r.get("id") or "").strip()
        if rid:
            out.append(rid)
    return out
