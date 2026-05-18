"""Signal mutation router (T6.3.2).

Reads signals with ``effect=mutation`` and applies them through
Steward's existing ``apply_state_change`` activity. Same audit / undo /
confidence-gate semantics as #832 — the signal layer just produces a
different *source* of decisions; the application path is identical.

Pipeline per signal:

  1. Read signal record via ``VaultClient.read_record``.
  2. Validate ``effect == "mutation"``. If not, no-op (router shouldn't
     have called us; defensive).
  3. Build a Steward-shaped decision dict from
     ``signal.mutation_proposal`` + ``signal.target_confidence`` +
     ``signal.effect_confidence``. The combined confidence we pass to
     ``apply_state_change`` is ``min(target, effect)`` — the weakest link
     gates the action.
  4. Call ``apply_state_change(target_path, decision, signals_summary,
     mode, target_kind)``.
  5. Mark the signal record with ``status=applied`` + ``applied_at`` +
     ``audit_record_path``.
  6. Return ``apply_state_change``'s result unchanged (so the workflow
     can log/aggregate metrics).

Hard rules respected:

  * NO mocks. The activity calls real ``apply_state_change``, real
    ``VaultClient.patch_frontmatter_structured`` to mark signals
    applied, real audit emission via Steward's existing path.
  * Mode gating: caller passes ``mode`` ("shadow" / "live"), but it's
    downgraded to shadow if ``STEWARD_SIGNAL_ROUTER_LIVE_MODE`` env is
    anything other than ``"live"`` / ``"live_high_confidence_only"``.
    Same shape as Steward's existing ``STEWARD_LIVE_MODE`` env.
  * New env: ``STEWARD_SIGNAL_ROUTER_LIVE_MODE`` (separate from
    ``STEWARD_LIVE_MODE`` so Sir can soak conversation-corrections
    while task-Steward already ran live).
  * NO direct Anthropic, NO direct vault filesystem, NO ``time.sleep``
    in async code.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.activities.steward import apply_state_change
from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SIGNAL_ROUTER_LIVE_MODE_ENV = "STEWARD_SIGNAL_ROUTER_LIVE_MODE"

# High-confidence threshold mirrors Steward's
# STEWARD_HIGH_CONFIDENCE_THRESHOLD default. We don't read the env here —
# apply_state_change owns the threshold gate. We keep this constant
# locally only for the documented "park as pending" behavior comment in
# the mode-resolution branch; the actual gating happens downstream.
SIGNAL_ROUTER_HIGH_CONFIDENCE_THRESHOLD = 0.85

# Default ctrl-api list page size when scanning signal records. Matches
# the explicit cap used by signals.list_unprocessed_stream_events for
# the stream-event scan and the BATCH_LIMIT in the workflow.
DEFAULT_LIST_LIMIT = 50


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_utc_iso() -> str:
    """Current UTC timestamp as second-precision ISO-8601.

    Matches the format the SignalExtractWorkflow + apply_state_change
    use for ``created_at`` / ``timestamp`` fields so the
    ``applied_at`` field on the signal round-trips cleanly.
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _resolve_signal_router_mode() -> str:
    """Return the effective live-mode for the signal router.

    Same shape as ``steward._resolve_steward_live_mode`` but reads a
    separate env (``STEWARD_SIGNAL_ROUTER_LIVE_MODE``) so the
    conversation-correction surface can soak in shadow while the
    task-Steward path already runs live.

    Returns one of: ``"shadow"``, ``"live"``,
    ``"live_high_confidence_only"``. Anything unrecognised falls back
    to ``"shadow"`` — when in doubt, don't act.
    """
    raw = (
        os.environ.get(SIGNAL_ROUTER_LIVE_MODE_ENV) or "shadow"
    ).strip().lower()
    if raw in ("shadow", "live", "live_high_confidence_only"):
        return raw
    logger.warning(
        "signal_mutations._resolve_signal_router_mode: unrecognised %s=%s "
        "— defaulting to shadow",
        SIGNAL_ROUTER_LIVE_MODE_ENV, raw,
    )
    return "shadow"


def _coerce_float(value: Any, default: float = 0.0) -> float:
    """Best-effort float coercion, clamped to [0.0, 1.0].

    Defends against confidence fields landing as strings ("0.8") or
    percentages ("80") in the YAML round-trip — same defensive shape as
    ``signals._coerce_float``.
    """
    if value is None:
        return default
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN
        return default
    if f > 1.0 and f <= 100.0:
        f = f / 100.0
    if f < 0.0:
        return 0.0
    if f > 1.0:
        return 1.0
    return f


def _parse_proposal(value: Any) -> dict[str, Any] | None:
    """Coerce a frontmatter proposal field into a dict.

    ``write_signal_record`` serialises ``mutation_proposal`` as inline
    JSON in YAML (every YAML parser accepts JSON as a subset). The
    ctrl-api PATCH path keeps that structure end-to-end via
    ``json_set``, but a record written through the older scalar-only
    path may have been stringified to its ``repr``. Try JSON-decode as
    a fallback so we don't drop a salvageable signal.
    """
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s or s.lower() in ("null", "none"):
            return None
        try:
            decoded = json.loads(s)
        except (json.JSONDecodeError, TypeError):
            return None
        return decoded if isinstance(decoded, dict) else None
    return None


# ---------------------------------------------------------------------------
# Activity: list_unrouted_signals
# ---------------------------------------------------------------------------

@activity.defn
async def list_unrouted_signals(
    limit: int = DEFAULT_LIST_LIMIT,
    since: str | None = None,
) -> list[str]:
    """Return vault paths of signal records whose status is unrouted.

    Args:
      limit: max paths to return; oldest-first by ``created`` field.
      since: ISO8601 timestamp lower bound on ``frontmatter.created``.
        ``None`` means no lower bound.

    Filtering rules (per record):
      * ``frontmatter.status == "unrouted"`` (or null/missing —
        defensively counted as unrouted so a pre-#142 signal that
        doesn't carry the status field still drains).
      * ``frontmatter.created >= since`` when provided.

    Errors: a ctrl-api connection failure is logged and treated as
    "no signals this tick" (returns ``[]``). The 2-min workflow cadence
    retries naturally — raising would mark the activity failed and
    trigger Temporal exponential backoff which we don't want for
    transient blips.

    Implementation:
      1. ``GET /api/v1/vault/list/signal?preview=2000``. We do NOT use
         ``preview=0`` because the workflow doesn't need the body — but
         we keep the default ``preview`` for forward compatibility with
         tools that introspect signal bodies.
      2. Filter results client-side per the rules above.
      3. Sort ascending by ``frontmatter.created`` so the oldest
         backlog drains in chronological order.
      4. Slice to ``limit``.
    """
    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    since_dt: datetime | None = None
    if since:
        try:
            s = since.strip()
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            since_dt = datetime.fromisoformat(s)
            if since_dt.tzinfo is None:
                since_dt = since_dt.replace(tzinfo=timezone.utc)
        except (ValueError, AttributeError):
            since_dt = None

    filtered: list[tuple[datetime | None, str]] = []
    try:
        async with httpx.AsyncClient(
            base_url=cfg.alfred_ctrl_url,
            timeout=30.0,
            headers=headers,
        ) as client:
            try:
                resp = await client.get(
                    "/api/v1/vault/list/signal",
                    params={"preview": "2000"},
                )
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                logger.warning(
                    "signal_mutations.list_unrouted_signals: list signal "
                    "failed err=%s", exc,
                )
                return []

            try:
                payload = resp.json()
            except (ValueError, json.JSONDecodeError) as exc:
                logger.warning(
                    "signal_mutations.list_unrouted_signals: bad JSON err=%s",
                    exc,
                )
                return []

            results = (
                payload.get("results") if isinstance(payload, dict) else None
            )
            if not isinstance(results, list):
                return []

            for rec in results:
                if not isinstance(rec, dict):
                    continue
                fm = rec.get("frontmatter") or {}
                if not isinstance(fm, dict):
                    fm = {}

                # Status filter — accept null/missing as unrouted for
                # defensive backward compatibility with any signal
                # written before the status field was schemed.
                status_raw = fm.get("status")
                status_str = (
                    str(status_raw).strip().lower() if status_raw else ""
                )
                if status_str and status_str != "unrouted":
                    continue

                # since lower bound.
                created_raw = (
                    rec.get("created") or fm.get("created") or ""
                )
                created_dt: datetime | None = None
                created_str = str(created_raw).strip()
                if created_str:
                    s = created_str
                    if s.endswith("Z"):
                        s = s[:-1] + "+00:00"
                    try:
                        created_dt = datetime.fromisoformat(s)
                        if created_dt.tzinfo is None:
                            created_dt = created_dt.replace(
                                tzinfo=timezone.utc
                            )
                    except ValueError:
                        created_dt = None

                if since_dt is not None:
                    if created_dt is None or created_dt < since_dt:
                        continue

                path = str(rec.get("path") or "").strip()
                if not path:
                    continue

                filtered.append((created_dt, path))
    except httpx.HTTPError as exc:
        logger.warning(
            "signal_mutations.list_unrouted_signals: ctrl-api connect "
            "failed err=%s", exc,
        )
        return []
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "signal_mutations.list_unrouted_signals: unexpected error "
            "err=%s", exc,
        )
        return []

    sentinel_max = datetime.max.replace(tzinfo=timezone.utc)
    filtered.sort(key=lambda pair: pair[0] or sentinel_max)

    safe_limit = max(0, int(limit) if limit is not None else DEFAULT_LIST_LIMIT)
    return [path for _, path in filtered[:safe_limit]]


# ---------------------------------------------------------------------------
# Activity: apply_signal_mutation
# ---------------------------------------------------------------------------

@activity.defn
async def apply_signal_mutation(
    signal_path: str,
    mode: str = "shadow",
) -> dict[str, Any]:
    """Apply one ``effect=mutation`` signal through ``apply_state_change``.

    Returns the dict from ``apply_state_change`` augmented with the
    signal-side bookkeeping fields::

        {
          # original apply_state_change fields:
          "path": "event/steward-action-<ts>-<slug>.md",
          "mode": "shadow" | "live",
          "timestamp": "...",
          "live_action_taken": bool,
          "pending_confirmation": bool,
          "vault_patch_applied": bool,
          "plane_action": dict | None,
          "partially_applied": bool,
          "dependency_signals_emitted": int,
          # router-added:
          "signal_path": "signal/<ts>-<hash>.md",
          "signal_status": "applied" | "skipped" | "failed",
          "skip_reason": "" | "<why>",
        }

    On a recoverable validation skip (target_path missing, ambiguous,
    proposal malformed) the activity returns
    ``signal_status="skipped"`` and patches the signal frontmatter
    with ``status=skipped`` so the next tick doesn't re-process it.

    On apply_state_change failure the activity re-raises so Temporal
    retry kicks in — the signal stays at ``status=unrouted`` and the
    next tick retries naturally.
    """
    if not signal_path or not isinstance(signal_path, str):
        raise ValueError(
            f"apply_signal_mutation: invalid signal_path={signal_path!r}"
        )
    if mode not in ("shadow", "live"):
        raise ValueError(
            f"apply_signal_mutation: unsupported mode={mode!r}"
        )

    # Mode resolution — caller intent ∩ operator veto. Same defence-in-
    # depth shape as steward.apply_state_change: env can only DOWNGRADE,
    # never escalate. Even if mode='live' is passed, env=shadow forces
    # shadow on the downstream apply_state_change call.
    env_mode = _resolve_signal_router_mode()
    if mode == "live" and env_mode == "shadow":
        logger.info(
            "signal_mutations.apply_signal_mutation: downgraded caller "
            "mode='live' to 'shadow' — %s=shadow",
            SIGNAL_ROUTER_LIVE_MODE_ENV,
        )
        effective_mode = "shadow"
    else:
        effective_mode = mode

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        # 1. Read the signal record.
        try:
            record = await client.read_record(signal_path)
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                logger.warning(
                    "signal_mutations.apply_signal_mutation: 404 on path=%s "
                    "— signal vanished",
                    signal_path,
                )
                return {
                    "signal_path": signal_path,
                    "signal_status": "skipped",
                    "skip_reason": "signal_not_found",
                }
            raise
        if not isinstance(record, dict):
            logger.warning(
                "signal_mutations.apply_signal_mutation: unexpected record "
                "shape path=%s type=%s",
                signal_path, type(record).__name__,
            )
            return {
                "signal_path": signal_path,
                "signal_status": "skipped",
                "skip_reason": "bad_record_shape",
            }

        fm = record.get("frontmatter") or {}
        if not isinstance(fm, dict):
            fm = {}

        # 2. Validate effect.
        effect = str(fm.get("effect") or "").strip().lower()
        if effect != "mutation":
            logger.warning(
                "signal_mutations.apply_signal_mutation: signal effect=%r "
                "is not 'mutation' path=%s — defensive no-op",
                effect, signal_path,
            )
            return {
                "signal_path": signal_path,
                "signal_status": "skipped",
                "skip_reason": f"effect_is_{effect or 'missing'}",
            }

        target_path = fm.get("target_path")
        target_kind = fm.get("target_kind")
        if not target_path or not isinstance(target_path, str):
            # Ambiguous / unresolved-target signals can't be applied —
            # mark skipped so we don't re-process.
            logger.info(
                "signal_mutations.apply_signal_mutation: signal has no "
                "target_path path=%s — skipping",
                signal_path,
            )
            await _mark_signal_skipped(
                client, signal_path, reason="no_target_path",
            )
            return {
                "signal_path": signal_path,
                "signal_status": "skipped",
                "skip_reason": "no_target_path",
            }
        target_kind_str = str(target_kind or "").strip().lower()
        if target_kind_str not in ("task", "matter"):
            logger.warning(
                "signal_mutations.apply_signal_mutation: signal has "
                "unsupported target_kind=%r path=%s — skipping",
                target_kind, signal_path,
            )
            await _mark_signal_skipped(
                client, signal_path, reason=f"bad_target_kind_{target_kind_str}",
            )
            return {
                "signal_path": signal_path,
                "signal_status": "skipped",
                "skip_reason": f"bad_target_kind_{target_kind_str}",
            }

        proposal = _parse_proposal(fm.get("mutation_proposal"))
        if not proposal or not isinstance(proposal, dict):
            logger.warning(
                "signal_mutations.apply_signal_mutation: signal has no "
                "valid mutation_proposal path=%s — skipping",
                signal_path,
            )
            await _mark_signal_skipped(
                client, signal_path, reason="no_mutation_proposal",
            )
            return {
                "signal_path": signal_path,
                "signal_status": "skipped",
                "skip_reason": "no_mutation_proposal",
            }

        decision_label = str(proposal.get("decision") or "").strip()
        if not decision_label:
            logger.warning(
                "signal_mutations.apply_signal_mutation: mutation_proposal "
                "missing 'decision' path=%s — skipping",
                signal_path,
            )
            await _mark_signal_skipped(
                client, signal_path, reason="no_decision_label",
            )
            return {
                "signal_path": signal_path,
                "signal_status": "skipped",
                "skip_reason": "no_decision_label",
            }

        # 3. Build the Steward-shaped decision dict. Combined confidence
        # is min(target, effect) — the weakest link gates the action.
        target_confidence = _coerce_float(fm.get("target_confidence"), 0.0)
        effect_confidence = _coerce_float(fm.get("effect_confidence"), 0.0)
        combined_confidence = min(target_confidence, effect_confidence)
        source_type = str(fm.get("source_type") or "").strip()
        raw_quote = str(fm.get("raw_quote") or "")[:200]
        reasoning = str(fm.get("reasoning") or "")
        source_event_path = str(fm.get("source_event_path") or "")

        evidence_entry: dict[str, Any] = {
            "source": source_type or "signal",
            "ref": source_event_path,
            "note": raw_quote,
        }
        decision: dict[str, Any] = {
            "decision": decision_label,
            "confidence": combined_confidence,
            "evidence": [evidence_entry],
            "reasoning": reasoning,
            "source_contributions": {
                f"signal:{source_type or 'unknown'}": effect_confidence,
            },
            "no_signal_skip": False,
        }
        signals_summary: dict[str, Any] = {
            "signals": [evidence_entry],
            "evaluated_sources": [source_type] if source_type else [],
        }

        logger.info(
            "signal_mutations.apply_signal_mutation: routing path=%s "
            "target=%s kind=%s decision=%s combined_conf=%.2f mode=%s "
            "(env_mode=%s)",
            signal_path, target_path, target_kind_str, decision_label,
            combined_confidence, effective_mode, env_mode,
        )

        # 4. Apply through Steward's existing path. NOTE: we pass
        # ``mode=effective_mode`` — apply_state_change runs its OWN env
        # gate against STEWARD_LIVE_MODE which can independently
        # downgrade live→shadow. That's a defence-in-depth feature, not
        # a bug: the operator can pin the entire Steward stack to
        # shadow via STEWARD_LIVE_MODE without touching the signal-
        # router env.
        result = await apply_state_change(
            target_path,
            decision,
            signals_summary,
            mode=effective_mode,
            target_kind=target_kind_str,
        )
        if not isinstance(result, dict):
            logger.error(
                "signal_mutations.apply_signal_mutation: unexpected "
                "apply_state_change return type=%s path=%s",
                type(result).__name__, signal_path,
            )
            raise RuntimeError(
                "apply_state_change returned non-dict; signal stays unrouted "
                "for retry"
            )

        audit_record_path = str(result.get("path") or "")

        # 5. Mark the signal applied. We patch the structured fields
        # via patch_frontmatter_structured so the scalar set semantics
        # stay consistent with the rest of the steward / signal vault
        # writers. Errors raise — Temporal retry handles the transient
        # case; a permanent vault outage rightly bubbles up.
        await client.patch_frontmatter_structured(
            signal_path,
            scalar_updates={
                "status": "applied",
                "applied_at": _now_utc_iso(),
                "audit_record_path": audit_record_path,
            },
        )

        logger.info(
            "signal_mutations.apply_signal_mutation: applied path=%s "
            "audit=%s mode=%s pending=%s live_action=%s",
            signal_path, audit_record_path, result.get("mode"),
            result.get("pending_confirmation"),
            result.get("live_action_taken"),
        )

        return {
            **result,
            "signal_path": signal_path,
            "signal_status": "applied",
            "skip_reason": "",
        }
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Internal helper — mark signal as skipped (validation-failure path)
# ---------------------------------------------------------------------------

async def _mark_signal_skipped(
    client: VaultClient,
    signal_path: str,
    *,
    reason: str,
) -> None:
    """Patch a malformed signal record to ``status=skipped`` so we don't
    keep re-processing it on every tick.

    Failures here are logged but NOT raised — the signal is malformed
    by definition; failing the activity over a bookkeeping write would
    just retry the same skip every 2 minutes. Worst case the signal
    stays at ``unrouted`` and gets retried; the next pass will hit the
    same validation gate and try again to mark it skipped.
    """
    try:
        await client.patch_frontmatter_structured(
            signal_path,
            scalar_updates={
                "status": "skipped",
                "applied_at": _now_utc_iso(),
                "audit_record_path": "",
            },
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "signal_mutations._mark_signal_skipped: PATCH failed path=%s "
            "reason=%s err=%s",
            signal_path, reason, exc,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "signal_mutations._mark_signal_skipped: unexpected error "
            "path=%s reason=%s err=%s",
            signal_path, reason, exc,
        )
