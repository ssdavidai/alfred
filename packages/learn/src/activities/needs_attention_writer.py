"""STORE-P6-1 followup — needs_attention row emission helper.

Phase 6 lock-down of the Storage Architecture migration moves the
legacy ``vault/needs_attention/*.md`` records behind ctrl-api's
``POST /api/v1/needs-attention``, backed by the ``needs_attention``
table in ``state.db``. This module — the writer side in
alfred-learn — mirrors ``audit_writer.py`` (STORE-P2-2) and
``signal_writer.py`` (STORE-P3-3) one-for-one:

  * Best-effort shadow wrapper that swallows transport / server
    failures so a stuck row writer never starves the primary markdown
    write that already landed during the soak period.
  * ``NEEDS_ATTENTION_SQL_ENFORCEMENT=shadow|warn|reject`` env knob
    plumbed through ``current_enforcement_mode()`` — defaults to
    ``shadow``; the rollout policy keeps both writers running
    (markdown + SQL) until the new path soaks.

Replay-safety note
------------------
The single call site for this helper is inside an
``@activity.defn`` body (``signal_actions.write_needs_attention_record``),
NOT inside an ``@workflow.run`` body. Per
``packages/learn/CLAUDE.md`` and ``audit_writer.py``'s contract,
activity-internal logic is replay-safe and does NOT need a
``workflow.patched(...)`` gate. If a future writer introduces a
needs_attention row emission directly inside a workflow body, that
call MUST be wrapped with
``workflow.patched("needs_attention_sql_v1_<unique-name>")``.

Enforcement gate
----------------
``NEEDS_ATTENTION_SQL_ENFORCEMENT`` controls per-writer behaviour:

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

logger = logging.getLogger("alfred-learn.needs_attention_writer")


# Env knob name matches the STATE_AUDIT_ENFORCEMENT / SIGNAL_SQL_ENFORCEMENT
# families so the rollout follows the same operator pattern.
NEEDS_ATTENTION_SQL_ENFORCEMENT_ENV = "NEEDS_ATTENTION_SQL_ENFORCEMENT"
_VALID_MODES = ("shadow", "warn", "reject")


def current_enforcement_mode() -> str:
    """Return the active enforcement mode for needs_attention writers.

    Defaults to ``"shadow"`` (write both legacy markdown AND SQL row)
    so a deploy lands safely without any caller flipping. An unknown
    value also degrades to ``"shadow"`` — fail-safe rather than
    fail-shut.
    """
    raw = (
        os.environ.get(NEEDS_ATTENTION_SQL_ENFORCEMENT_ENV) or "shadow"
    ).strip().lower()
    if raw in _VALID_MODES:
        return raw
    logger.warning(
        "needs_attention_writer: unrecognised %s=%s — defaulting to shadow",
        NEEDS_ATTENTION_SQL_ENFORCEMENT_ENV, raw,
    )
    return "shadow"


async def write_needs_attention_safe(
    *,
    headline: str,
    body: str,
    source_signal_id: str | None = None,
    target_matter: str | None = None,
    target_kind: str | None = None,
    payload: dict[str, Any] | None = None,
    id: str | None = None,
) -> dict[str, Any] | None:
    """Best-effort POST to ``/api/v1/needs-attention``.

    Returns the server's ``{"id", "ts"}`` response on success, ``None``
    on transport / server failure (logged + swallowed — a stuck row
    emitter must never starve the caller's primary markdown write,
    which has already landed). The shadow-mode contract is that the
    legacy ``needs_attention/*.md`` markdown record is still
    authoritative during the soak period, so a missing row here is
    recoverable by re-running the backfill once the SQL table is the
    single source of truth.

    STORE-P6-1f-F: ``id`` is forwarded as a deterministic primary key.
    A 409 Conflict response (duplicate id) is treated as success —
    Temporal retried; the row already landed; return a synthesised
    ``{"id": id}`` so the caller's downstream bookkeeping keeps the
    same pseudo-path.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        return await client.write_needs_attention(
            headline=headline,
            body=body,
            source_signal_id=source_signal_id,
            target_matter=target_matter,
            target_kind=target_kind,
            payload=payload,
            id=id,
        )
    except httpx.HTTPStatusError as exc:
        # 409 == duplicate id == retry landed on an already-written row.
        # Treat as success so the caller's idempotency contract holds.
        if (
            id is not None
            and exc.response is not None
            and exc.response.status_code == 409
        ):
            logger.info(
                "needs_attention_writer.write_needs_attention_safe: "
                "409 conflict id=%s — treating as idempotent success",
                id,
            )
            return {"id": id, "ts": ""}
        logger.warning(
            "needs_attention_writer.write_needs_attention_safe: "
            "POST /api/v1/needs-attention FAILED headline=%s err=%s",
            headline[:80], exc,
        )
        return None
    except httpx.HTTPError as exc:
        logger.warning(
            "needs_attention_writer.write_needs_attention_safe: "
            "POST /api/v1/needs-attention FAILED headline=%s err=%s",
            headline[:80], exc,
        )
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "needs_attention_writer.write_needs_attention_safe: "
            "unexpected error headline=%s err=%r",
            headline[:80], exc,
        )
        return None
    finally:
        await client.close()


__all__ = [
    "NEEDS_ATTENTION_SQL_ENFORCEMENT_ENV",
    "current_enforcement_mode",
    "write_needs_attention_safe",
]
