"""STORE-P3-3 — signal + observation row emission helper.

Phase 3 of the Storage Architecture migration moves the legacy
``vault/signal/*.md`` and ``vault/observation/*.md`` records behind two
ctrl-api endpoints, ``POST /api/v1/signals`` and
``POST /api/v1/observations``, backed by the ``signal`` and
``observation`` tables in ``state.db``. STORE-P3-2 shipped the endpoints
(plus the ``embedding`` table for vec-search); P3-3 — this module —
adds the writer side in alfred-learn.

Mirrors ``audit_writer.py`` (STORE-P2-2) shape one-for-one:

  * Best-effort shadow wrapper that swallows transport / server
    failures so a stuck row writer never starves the primary markdown
    write that already landed during the soak period.
  * ``SIGNAL_SQL_ENFORCEMENT=shadow|warn|reject`` env knob plumbed
    through ``current_enforcement_mode()`` — defaults to ``shadow``;
    the rollout policy keeps both writers running (markdown + SQL)
    until the new path soaks.

Replay-safety note
------------------
All call sites for STORE-P3-3 are inside ``@activity.defn`` bodies
(``signals.write_signal_record`` and
``signal_observations.extract_observation_from_signal``), NOT inside
``@workflow.run`` bodies. Per ``packages/learn/CLAUDE.md`` and
``audit_writer.py``'s contract, activity-internal logic is replay-safe
and does NOT need a ``workflow.patched(...)`` gate. If a future writer
introduces a signal / observation row emission directly inside a
workflow body, that call MUST be wrapped with
``workflow.patched("signal_sql_v1_<unique-name>")``.

Enforcement gate
----------------
``SIGNAL_SQL_ENFORCEMENT`` controls per-writer behaviour:

  * ``shadow`` (default) — write BOTH the legacy markdown record AND
    the SQL row. Lets us soak the new path and diff against the old
    one before any markdown writers retire.
  * ``warn``   — SQL row only; legacy markdown writes still happen but
    log a warning. Reserved for the post-soak phase.
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

logger = logging.getLogger("alfred-learn.signal_writer")


# Env knob name matches the STATE_AUDIT_ENFORCEMENT family from P2-2 so
# the rollout follows the same operator pattern.
SIGNAL_SQL_ENFORCEMENT_ENV = "SIGNAL_SQL_ENFORCEMENT"
_VALID_MODES = ("shadow", "warn", "reject")


def current_enforcement_mode() -> str:
    """Return the active enforcement mode for signal + observation writers.

    Defaults to ``"shadow"`` (write both legacy markdown AND SQL row)
    so a deploy lands safely without any caller flipping. An unknown
    value also degrades to ``"shadow"`` — fail-safe rather than
    fail-shut.
    """
    raw = (os.environ.get(SIGNAL_SQL_ENFORCEMENT_ENV) or "shadow").strip().lower()
    if raw in _VALID_MODES:
        return raw
    logger.warning(
        "signal_writer: unrecognised %s=%s — defaulting to shadow",
        SIGNAL_SQL_ENFORCEMENT_ENV, raw,
    )
    return "shadow"


async def write_signal_safe(
    *,
    source_type: str,
    body: str,
    source_event: str | None = None,
    target_matter: str | None = None,
    target_kind: str | None = None,
    actor: str | None = None,
    decision_required: bool = False,
    display_headline: str | None = None,
    display_body: str | None = None,
    classified_noise: bool = False,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Best-effort POST to ``/api/v1/signals``.

    Returns the server's ``{"id", "ts"}`` response on success, ``None``
    on transport / server failure (logged + swallowed — a stuck row
    emitter must never starve the caller's primary markdown write,
    which has already landed). The shadow-mode contract is that the
    legacy markdown signal is still the authoritative record during
    the soak period, so a missing row here is recoverable by re-running
    the P3-4 backfill once the SQL table is the single source of truth.

    ``payload`` (Round 2.7, migration 007) is a JSON-serialisable dict
    capturing the legacy markdown frontmatter (effect, action_proposal,
    confidences, raw_quote, reasoning, target_*). Downstream routers
    read those fields out of the SQL row's payload column.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        return await client.write_signal(
            source_type=source_type,
            body=body,
            source_event=source_event,
            target_matter=target_matter,
            target_kind=target_kind,
            actor=actor,
            decision_required=decision_required,
            display_headline=display_headline,
            display_body=display_body,
            classified_noise=classified_noise,
            payload=payload,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "signal_writer.write_signal_safe: POST /api/v1/signals FAILED "
            "source_type=%s target_matter=%s err=%s",
            source_type, target_matter, exc,
        )
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "signal_writer.write_signal_safe: unexpected error "
            "source_type=%s target_matter=%s err=%r",
            source_type, target_matter, exc,
        )
        return None
    finally:
        await client.close()


async def write_observation_safe(
    *,
    instinct_id: str,
    signal_id: str | None = None,
    confidence: float | None = None,
    embedding: list[float] | None = None,
    embedding_id: int | None = None,
) -> dict[str, Any] | None:
    """Best-effort POST to ``/api/v1/observations``.

    Returns ``{"id", "ts", "embedding_id"}`` on success, ``None`` on
    transport / server / validation failure (logged + swallowed). Same
    shadow-mode contract as ``write_signal_safe`` — the legacy
    ``observation/*.md`` markdown record is still authoritative during
    the soak period.

    Pass either an inline ``embedding`` (list[float], 768 dims) or a
    pre-allocated ``embedding_id`` rowid — never both. ``None`` for
    both is valid (observation row with no vector attached).
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        return await client.write_observation(
            instinct_id=instinct_id,
            signal_id=signal_id,
            confidence=confidence,
            embedding=embedding,
            embedding_id=embedding_id,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "signal_writer.write_observation_safe: POST /api/v1/observations "
            "FAILED instinct=%s signal=%s err=%s",
            instinct_id, signal_id, exc,
        )
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "signal_writer.write_observation_safe: unexpected error "
            "instinct=%s signal=%s err=%r",
            instinct_id, signal_id, exc,
        )
        return None
    finally:
        await client.close()


__all__ = [
    "SIGNAL_SQL_ENFORCEMENT_ENV",
    "current_enforcement_mode",
    "write_signal_safe",
    "write_observation_safe",
]
