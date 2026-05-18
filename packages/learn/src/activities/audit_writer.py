"""STORE-P2-2 — unified audit-row emission helper.

Phase 2 of the Storage Architecture migration moves the legacy
``vault/event/<*>-action-<ts>-<id>.md`` audit markdown files behind a
single ctrl-api endpoint, ``POST /api/v1/audit``, backed by the ``audit``
table in ``state.db``. STORE-P2-1 shipped the endpoint (and migration
003); P2-2 — this module — adds the writer side in alfred-learn.

The six in-scope writers (per epic #898) call ``write_audit_safe`` from
inside their existing ``@activity.defn`` activities:

  1. ``state_mutator.apply_state_change_v2`` — emits ``state_change``.
  2. ``steward.apply_state_change`` — emits ``steward_action``.
  3. ``decision_router`` outcome linkage — flows through
     ``apply_state_change_v2`` (covered by #1).
  4. Desk action handlers (delegate/defer/handle/do) — these live in
     ctrl-api (TypeScript), not learn, so they are out of scope here.
  5. ``signal_actions._emit_signal_action_audit`` — emits
     ``signal_action`` (autonomous-fire bookkeeping is the same path).
  6. ``task_creation._emit_audit_record`` — emits ``auto_task_created``.

Replay-safety note
------------------
All call sites for STORE-P2-2 are inside ``@activity.defn`` bodies, not
inside ``@workflow.run`` bodies. Per ``packages/learn/CLAUDE.md`` and
``state_mutator.py``'s contract, activity-internal logic is replay-safe
and does NOT need a ``workflow.patched(...)`` gate. If a future writer
introduces an audit emission directly inside a workflow body, that call
MUST be wrapped with ``workflow.patched("audit_v2_<unique-name>")``.

Enforcement gate
----------------
``STATE_AUDIT_ENFORCEMENT`` controls per-writer behaviour:

  * ``shadow`` (default) — write BOTH the legacy ``vault/event/*.md`` AND
    the audit row. Lets us soak the new path and diff against the old
    one before any markdown writers retire.
  * ``warn``   — audit row only; legacy markdown writes still happen but
    log a warning. Reserved for the post-soak phase.
  * ``reject`` — audit row only; legacy markdown emission raises. Final
    cutover state; flipped only after the soak period.

This module exposes ``current_enforcement_mode()`` so writers can branch
on the env at emission time. Per epic §"What NOT to do", we DO NOT flip
to warn/reject in this PR; the helper just plumbs the knob through.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn.audit")


# Env knob name matches the STATE_CHANGE_ENFORCEMENT family from SM-A so
# the rollout follows the same operator pattern.
STATE_AUDIT_ENFORCEMENT_ENV = "STATE_AUDIT_ENFORCEMENT"
_VALID_MODES = ("shadow", "warn", "reject")


def current_enforcement_mode() -> str:
    """Return the active enforcement mode for audit writers.

    Defaults to ``"shadow"`` (write both legacy markdown AND audit row)
    so a deploy lands safely without any caller flipping. An unknown
    value also degrades to ``"shadow"`` — fail-safe rather than
    fail-shut.
    """
    raw = (os.environ.get(STATE_AUDIT_ENFORCEMENT_ENV) or "shadow").strip().lower()
    if raw in _VALID_MODES:
        return raw
    logger.warning(
        "audit_writer: unrecognised %s=%s — defaulting to shadow",
        STATE_AUDIT_ENFORCEMENT_ENV, raw,
    )
    return "shadow"


async def write_audit_safe(
    *,
    actor: str,
    action_type: str,
    target_type: str,
    target_id: str,
    payload: dict[str, Any],
    decision_origin: str | None = None,
    reasoning: str | None = None,
    reversible: bool = False,
) -> dict[str, Any] | None:
    """Best-effort POST to ``/api/v1/audit``.

    Returns the server's ``{"id", "ts"}`` response on success, ``None``
    on transport / server failure (logged + swallowed — a stuck audit
    emitter must never starve the caller's primary mutation, which has
    already landed). The shadow-mode contract is that the legacy
    markdown audit is still the authoritative record during the soak
    period, so a missing row here is recoverable by re-running the
    backfill once the new table is the single source of truth.

    Wrapped clients are short-lived (one HTTP call per invocation);
    callers don't pass ``VaultClient`` because most of them already
    have their own client open and we don't want lifecycle entanglement
    between the primary write and the audit emission.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        return await client.write_audit(
            actor=actor,
            action_type=action_type,
            target_type=target_type,
            target_id=target_id,
            payload=payload,
            decision_origin=decision_origin,
            reasoning=reasoning,
            reversible=reversible,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "audit_writer.write_audit_safe: POST /api/v1/audit FAILED "
            "actor=%s action=%s target=%s/%s err=%s",
            actor, action_type, target_type, target_id, exc,
        )
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "audit_writer.write_audit_safe: unexpected error "
            "actor=%s action=%s target=%s/%s err=%r",
            actor, action_type, target_type, target_id, exc,
        )
        return None
    finally:
        await client.close()


__all__ = [
    "STATE_AUDIT_ENFORCEMENT_ENV",
    "current_enforcement_mode",
    "write_audit_safe",
]
