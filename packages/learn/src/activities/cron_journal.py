"""Cron-journal reconciler activity (#418 / GH #556).

The ctrl-api endpoint POST /api/v1/alfred-journal/reconcile-cron reads
Hermes' session store read-only, finds sessions with source='cron' whose
job id maps to a jobs.json entry with a non-empty ``deliver`` field, and
journals each into alfred_journal (source_kind='cron').  Idempotent on
hermes_session_id; window 48 h, cap 50 sessions per call.

This activity is the sole caller.  It never raises on a ctrl-api failure
(log + return) so Temporal does not enter an unbounded retry loop.  The
endpoint is idempotent — the next scheduled run (6 h) will pick up any
sessions still inside the 48-hour window.
"""
from __future__ import annotations

import logging
import os

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.retry_policy import classify_status

logger = logging.getLogger("alfred-learn")

_ENV_FLAG = "CRON_JOURNAL_RECONCILE_ENABLED"


def _flag_on() -> bool:
    """True when CRON_JOURNAL_RECONCILE_ENABLED is a truthy value.

    Default OFF so the fleet does not run this before Sir enables it
    explicitly (lesson from FLEET_AUDIT_ENABLED defaulting ON).
    """
    return os.environ.get(_ENV_FLAG, "").strip().lower() in ("true", "1", "yes")


@activity.defn
async def cron_journal_reconcile_is_enabled() -> bool:
    """Invocation-time gate — mirrors the registration-time check.

    Exposed as an activity so the workflow's flag read is deterministic
    from Temporal's perspective (env reads inside activities, not in
    workflow bodies — same pattern as fleet_audit_is_enabled).
    """
    return _flag_on()


@activity.defn
async def reconcile_cron_journal() -> dict:
    """Call POST /api/v1/alfred-journal/reconcile-cron.

    Never raises — catches all HTTP and transport errors, classifies them
    via retry_policy.classify_status, logs a warning, and returns a dict
    with ok=False.  The endpoint is idempotent; missed runs are recovered
    at the next 6-hour tick as long as sessions remain inside the 48-hour
    window.
    """
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(
            base_url=config.alfred_ctrl_url, timeout=30.0, headers=headers,
        ) as http:
            resp = await http.post("/api/v1/alfred-journal/reconcile-cron")
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001
        status = getattr(getattr(exc, "response", None), "status_code", None)
        activity.logger.warning(
            "reconcile_cron_journal: ctrl-api call failed "
            "(status=%s classification=%s) — skipping, next run picks up in 6 h: %s",
            status,
            classify_status(status),
            str(exc)[:200],
        )
        return {"ok": False, "error": str(exc)[:200]}
