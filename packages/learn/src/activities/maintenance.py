"""Nightly maintenance activities — one-shot janitor/distiller via ctrl-api.

These call the existing ctrl-api endpoints that exec alfred CLI commands
inside the alfred container. Bounded execution, no continuous daemons.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("alfred-learn")


@activity.defn
async def run_janitor_scan_and_fix() -> dict[str, Any]:
    """Run janitor scan + fix via ctrl-api. Returns summary stats."""
    config = load_config()
    base = config.alfred_ctrl_url
    api_key = __import__("os").environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"}

    async with httpx.AsyncClient(base_url=base, timeout=300.0, headers=headers) as client:
        # 1. Scan for issues
        scan_resp = await client.post("/api/v1/workers/janitor/scan")
        scan_resp.raise_for_status()
        scan_data = scan_resp.json()

        issues_found = 0
        if isinstance(scan_data, dict):
            issues_found = scan_data.get("issues", scan_data.get("count", 0))

        # 2. Fix issues (the janitor respects max_stubs_per_sweep cap)
        fix_resp = await client.post("/api/v1/workers/janitor/fix")
        fix_resp.raise_for_status()
        fix_data = fix_resp.json()

        issues_fixed = 0
        if isinstance(fix_data, dict):
            issues_fixed = fix_data.get("fixed", fix_data.get("count", 0))

    activity.logger.info(
        "janitor complete: found=%d fixed=%d", issues_found, issues_fixed
    )
    return {"issues_found": issues_found, "issues_fixed": issues_fixed}


@activity.defn
async def run_distiller_batch() -> dict[str, Any]:
    """Run distiller extraction via ctrl-api. Returns summary stats."""
    config = load_config()
    base = config.alfred_ctrl_url
    api_key = __import__("os").environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"}

    async with httpx.AsyncClient(base_url=base, timeout=300.0, headers=headers) as client:
        resp = await client.post("/api/v1/workers/distiller/run")
        resp.raise_for_status()
        data = resp.json()

    learnings = 0
    if isinstance(data, dict):
        learnings = data.get("created", data.get("learnings", 0))

    activity.logger.info("distiller complete: learnings=%d", learnings)
    return {"learnings_created": learnings}


# ---------------------------------------------------------------------------
# Stream-event purge (Phase 6.6 / T6.6.3)
# ---------------------------------------------------------------------------

# Records where ``signal_extracted_at`` is set AND ``created`` is older
# than this delta are purged by ``purge_old_stream_events``. The number
# is the SPEC retention window for raw stream events post-extraction
# (RFC #842 §6.6) — short enough that the purge meaningfully reclaims
# vault space, long enough that an operator running an incident-triage
# 7-day window post-mortem can still see the raw event.
_STREAM_EVENT_RETENTION_DAYS: int = 7


def _stream_event_purge_enabled() -> bool:
    """Activity-time gate read from env on each invocation.

    The schedule registration also gates on this flag (so a tenant
    without it never gets the schedule), but the activity re-checks
    so a stale schedule on a tenant that flipped the flag off doesn't
    keep deleting records — it just no-ops on every tick.
    """
    import os
    return os.environ.get(
        "STEWARD_STREAM_EVENT_PURGE_ENABLED", "",
    ).strip().lower() in ("true", "1", "yes")


def _parse_iso8601(value: str) -> datetime | None:
    """Best-effort ISO8601 parse → UTC-aware datetime, or ``None``.

    Tolerates both ``Z`` and ``+00:00`` suffixes; treats naive
    timestamps as UTC (matches the convention used elsewhere in
    alfred-learn). Returns ``None`` on parse failure so the caller can
    treat unparseable records as "not safe to purge" (default to keep).
    """
    if not value:
        return None
    s = str(value).strip()
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


@activity.defn
async def purge_old_stream_events() -> dict[str, Any]:
    """Delete ``stream_event/*`` records older than 7 days that have a signal.

    Filtering rules:

      * ``frontmatter.signal_extracted_at`` MUST be set (extraction
        succeeded). Unprocessed records are kept indefinitely so the
        signal extractor can still pick them up — operators see the
        cursor not advancing as the loud failure signal.
      * ``frontmatter.created`` MUST parse and be < ``now - 7 days``.
        Records without a parseable created field are kept (defensive
        — would rather leak vault space than delete a record the
        retention math can't reason about).
      * Records under ``event/`` and ``conversation/`` are NEVER
        touched by this activity. The migrator (T6.6.1) is the only
        thing that moves them; if any are still there post-migration,
        operator owns the call to keep them.

    Lazy-imports ``httpx`` and ``VaultClient`` inside the activity
    body per the alfred-learn workflow-sandbox restriction.

    Returns ``{"listed", "purged", "kept", "errors", "error_messages"}``.
    Per-record try/except — one corrupted record doesn't stall the
    sweep.
    """
    # Lazy imports — keep workflow-sandbox happy.
    import os
    from src.utils.vault_client import VaultClient

    if not _stream_event_purge_enabled():
        logger.info(
            "purge_old_stream_events: STEWARD_STREAM_EVENT_PURGE_ENABLED "
            "not set — no-op"
        )
        return {
            "listed": 0,
            "purged": 0,
            "kept": 0,
            "errors": 0,
            "error_messages": [],
        }

    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    cutoff = datetime.now(timezone.utc) - timedelta(
        days=_STREAM_EVENT_RETENTION_DAYS
    )

    # 1. List stream_event records via ctrl-api directly (preview=0
    # to skip body excerpts — we only need frontmatter for the
    # decision). Using the raw httpx client rather than VaultClient
    # because list_records doesn't expose the preview knob.
    listed = 0
    purged = 0
    kept = 0
    errors = 0
    error_messages: list[str] = []

    try:
        async with httpx.AsyncClient(
            base_url=cfg.alfred_ctrl_url,
            timeout=60.0,
            headers=headers,
        ) as ctrl:
            resp = await ctrl.get(
                "/api/v1/vault/list/stream_event",
                params={"preview": "0"},
            )
            resp.raise_for_status()
            payload = resp.json()
    except httpx.HTTPError as exc:
        logger.warning(
            "purge_old_stream_events: list failed err=%s", exc,
        )
        return {
            "listed": 0,
            "purged": 0,
            "kept": 0,
            "errors": 1,
            "error_messages": [f"list_stream_event: {exc}"[:500]],
        }

    results = []
    if isinstance(payload, dict):
        candidates = payload.get("results")
        if isinstance(candidates, list):
            results = candidates
    listed = len(results)
    logger.info(
        "purge_old_stream_events: listed=%d cutoff=%s",
        listed, cutoff.isoformat(),
    )

    if not results:
        return {
            "listed": 0,
            "purged": 0,
            "kept": 0,
            "errors": 0,
            "error_messages": [],
        }

    # 2. Per-record decision + delete.
    client = VaultClient(cfg)
    try:
        for rec in results:
            if not isinstance(rec, dict):
                kept += 1
                continue
            fm = rec.get("frontmatter") or {}
            if not isinstance(fm, dict):
                kept += 1
                continue
            path = str(rec.get("path") or "").strip()
            if not path:
                kept += 1
                continue

            # Must have a signal extracted.
            extracted_at = fm.get("signal_extracted_at")
            if extracted_at in (None, "", "null"):
                kept += 1
                continue

            # Must have a parseable created < cutoff.
            created_raw = (
                fm.get("created")
                or rec.get("created")
                or ""
            )
            created_dt = _parse_iso8601(str(created_raw))
            if created_dt is None:
                kept += 1
                continue
            if created_dt >= cutoff:
                kept += 1
                continue

            # Defense-in-depth: only purge actual stream_event/ paths.
            # ctrl-api's list/<type> is type-filtered server-side so
            # this should always be true, but a future refactor of
            # the listing endpoint shouldn't accidentally delete
            # event/ records.
            if not path.startswith("stream_event/"):
                kept += 1
                continue

            try:
                deleted = await client.delete_record(path)
            except Exception as exc:  # noqa: BLE001
                errors += 1
                if len(error_messages) < 10:
                    error_messages.append(
                        f"delete {path}: {exc}"[:500]
                    )
                logger.warning(
                    "purge_old_stream_events: delete failed path=%s err=%s",
                    path, exc,
                )
                continue

            if deleted:
                purged += 1
            else:
                # 404 → already gone, treat as kept (no-op).
                kept += 1
    finally:
        await client.close()

    logger.info(
        "purge_old_stream_events: listed=%d purged=%d kept=%d errors=%d",
        listed, purged, kept, errors,
    )
    return {
        "listed": listed,
        "purged": purged,
        "kept": kept,
        "errors": errors,
        "error_messages": error_messages,
    }
