"""STORE-P6-1 followup — pattern_proposal row emission helper.

Phase 6 lock-down of the Storage Architecture migration moves the
legacy ``vault/pattern_proposal/*.md`` records behind ctrl-api's
``POST /api/v1/pattern-proposals``, backed by the
``pattern_proposal`` table in ``state.db``. This module — the writer
side in alfred-learn — mirrors ``audit_writer.py`` (STORE-P2-2) and
``signal_writer.py`` (STORE-P3-3) one-for-one:

  * Best-effort shadow wrapper that swallows transport / server
    failures so a stuck row writer never starves the primary markdown
    write that already landed during the soak period.
  * ``PATTERN_PROPOSAL_SQL_ENFORCEMENT=shadow|warn|reject`` env knob
    plumbed through ``current_enforcement_mode()`` — defaults to
    ``shadow``; the rollout policy keeps both writers running
    (markdown + SQL) until the new path soaks.

Replay-safety note
------------------
The single call site for this helper is inside an
``@activity.defn`` body (``pattern_detection.detect_pattern_proposals``),
NOT inside an ``@workflow.run`` body. Per
``packages/learn/CLAUDE.md`` and ``audit_writer.py``'s contract,
activity-internal logic is replay-safe and does NOT need a
``workflow.patched(...)`` gate. If a future writer introduces a
pattern_proposal row emission directly inside a workflow body, that
call MUST be wrapped with
``workflow.patched("pattern_proposal_sql_v1_<unique-name>")``.

Enforcement gate
----------------
``PATTERN_PROPOSAL_SQL_ENFORCEMENT`` controls per-writer behaviour:

  * ``shadow`` (default) — write BOTH the legacy markdown record AND
    the SQL row. Lets us soak the new path and diff against the old
    one before any markdown writers retire.
  * ``warn``   — SQL row only; legacy markdown writes still happen
    but log a warning. Reserved for the post-soak phase.
  * ``reject`` — SQL row only; legacy markdown emission raises. Final
    cutover state; flipped only after the soak period.

Per epic §"What NOT to do", we DO NOT flip to warn/reject in this PR;
the helper just plumbs the knob through.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn.pattern_proposal_writer")


# Env knob name matches the STATE_AUDIT_ENFORCEMENT / SIGNAL_SQL_ENFORCEMENT
# families so the rollout follows the same operator pattern.
PATTERN_PROPOSAL_SQL_ENFORCEMENT_ENV = "PATTERN_PROPOSAL_SQL_ENFORCEMENT"
_VALID_MODES = ("shadow", "warn", "reject")


def current_enforcement_mode() -> str:
    """Return the active enforcement mode for pattern_proposal writers.

    Defaults to ``"shadow"`` (write both legacy markdown AND SQL row)
    so a deploy lands safely without any caller flipping. An unknown
    value also degrades to ``"shadow"`` — fail-safe rather than
    fail-shut.
    """
    raw = (
        os.environ.get(PATTERN_PROPOSAL_SQL_ENFORCEMENT_ENV) or "shadow"
    ).strip().lower()
    if raw in _VALID_MODES:
        return raw
    logger.warning(
        "pattern_proposal_writer: unrecognised %s=%s — defaulting to shadow",
        PATTERN_PROPOSAL_SQL_ENFORCEMENT_ENV, raw,
    )
    return "shadow"


async def write_pattern_proposal_safe(
    *,
    proposed_name: str,
    proposed_body: str,
    cluster_size: int = 0,
    member_observation_ids: list[str] | None = None,
    payload: dict[str, Any] | None = None,
    id: str | None = None,
) -> dict[str, Any] | None:
    """Best-effort POST to ``/api/v1/pattern-proposals``.

    Returns the server's ``{"id", "ts"}`` response on success, ``None``
    on transport / server failure (logged + swallowed — a stuck row
    emitter must never starve the caller's primary markdown write,
    which has already landed). The shadow-mode contract is that the
    legacy ``pattern_proposal/*.md`` markdown record is still
    authoritative during the soak period, so a missing row here is
    recoverable by re-running the backfill once the SQL table is the
    single source of truth.

    STORE-P6-1f-F: ``id`` is forwarded as a deterministic primary key.
    A 409 Conflict response (duplicate id) is treated as success —
    Temporal retried; the row already landed; we return a synthesised
    ``{"id": id}`` so the caller's downstream bookkeeping keeps the
    same pseudo-path.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        return await client.write_pattern_proposal(
            proposed_name=proposed_name,
            proposed_body=proposed_body,
            cluster_size=cluster_size,
            member_observation_ids=member_observation_ids,
            payload=payload,
            id=id,
        )
    except httpx.HTTPStatusError as exc:
        if (
            id is not None
            and exc.response is not None
            and exc.response.status_code == 409
        ):
            logger.info(
                "pattern_proposal_writer.write_pattern_proposal_safe: "
                "409 conflict id=%s — treating as idempotent success",
                id,
            )
            return {"id": id, "ts": ""}
        logger.warning(
            "pattern_proposal_writer.write_pattern_proposal_safe: "
            "POST /api/v1/pattern-proposals FAILED name=%s err=%s",
            proposed_name, exc,
        )
        return None
    except httpx.HTTPError as exc:
        logger.warning(
            "pattern_proposal_writer.write_pattern_proposal_safe: "
            "POST /api/v1/pattern-proposals FAILED name=%s err=%s",
            proposed_name, exc,
        )
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "pattern_proposal_writer.write_pattern_proposal_safe: "
            "unexpected error name=%s err=%r",
            proposed_name, exc,
        )
        return None
    finally:
        await client.close()


__all__ = [
    "PATTERN_PROPOSAL_SQL_ENFORCEMENT_ENV",
    "current_enforcement_mode",
    "write_pattern_proposal_safe",
]
