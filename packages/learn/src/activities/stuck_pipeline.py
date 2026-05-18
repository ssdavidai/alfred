"""STORE-P4-2 — stuck-pipeline alert activities.

Two activities back ``StuckPipelineAlertWorkflow`` (hourly schedule):

  * ``check_stuck_pipeline`` — calls ``GET /api/v1/streams/stuck-report``
    on ctrl-api and returns the JSON.
  * ``post_stuck_pipeline_alert`` — POSTs a Slack-compatible payload to
    ``ALERT_WEBHOOK_URL`` (the same env var ctrl-api's health monitor
    uses). If unset, logs at ERROR and returns — there's no separate
    alerting daemon to spin up.

The "stuck" predicate is owned by ctrl-api (events in
``/vault/_raw/<date>.jsonl`` older than 7d AND NOT in
``stream_event_processed``). alfred-learn just polls + forwards.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("alfred-learn")


@activity.defn
async def check_stuck_pipeline(
    stuck_after_days: int = 7,
    sample_size: int = 10,
) -> dict[str, Any]:
    """Fetch the stuck-pipeline report from ctrl-api."""
    config = load_config()
    base = config.alfred_ctrl_url
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    async with httpx.AsyncClient(
        base_url=base, timeout=30.0, headers=headers,
    ) as client:
        resp = await client.get(
            "/api/v1/streams/stuck-report",
            params={
                "stuck_after_days": int(stuck_after_days),
                "sample_size": int(sample_size),
            },
        )
        resp.raise_for_status()
        data = resp.json()

    activity.logger.info(
        "check_stuck_pipeline: unprocessed_old=%d oldest_date=%s "
        "oldest_age_days=%d partitions_with_lag=%d",
        int(data.get("unprocessed_old_count", 0)),
        data.get("oldest_date"),
        int(data.get("oldest_age_days", 0)),
        len(data.get("consumer_lag_by_date", []) or []),
    )
    return data


@activity.defn
async def post_stuck_pipeline_alert(report: dict[str, Any]) -> dict[str, Any]:
    """Post a Slack-compatible alert to ``ALERT_WEBHOOK_URL``.

    Mirrors the alert-shape used by ctrl-api's ``monitoring/alerts.ts``
    (the same env var pair governs both sides). If
    ``ALERT_WEBHOOK_URL`` is unset, logs at ERROR and returns — no
    silent no-op, but no separate alerting daemon either.

    Returns ``{"posted": bool, "reason": str|None}`` so the workflow
    can surface the outcome in the Temporal UI.
    """
    webhook = os.environ.get("ALERT_WEBHOOK_URL", "").strip()
    webhook_type = os.environ.get("ALERT_WEBHOOK_TYPE", "slack").strip().lower()

    unprocessed = int(report.get("unprocessed_old_count", 0))
    oldest_date = report.get("oldest_date") or "?"
    oldest_age = int(report.get("oldest_age_days", 0))
    samples = list(report.get("sample_event_ids", []) or [])[:3]
    sample_str = ", ".join(samples) if samples else "(none)"

    # 3-line text payload — fits Slack default-row layout and is also
    # readable in Discord's fallback ``content`` field.
    text = (
        f":rotating_light: *Alfred stream pipeline stuck*: "
        f"{unprocessed} unprocessed events older than 7d\n"
        f"Oldest partition: `{oldest_date}` ({oldest_age}d old)\n"
        f"Sample event ids: {sample_str}"
    )

    if not webhook:
        activity.logger.error(
            "post_stuck_pipeline_alert: ALERT_WEBHOOK_URL is unset — "
            "stuck pipeline detected but no channel to post to. "
            "unprocessed=%d oldest_date=%s age=%dd",
            unprocessed, oldest_date, oldest_age,
        )
        return {"posted": False, "reason": "no_webhook_configured"}

    if webhook_type == "discord":
        payload: dict[str, Any] = {"content": text}
    else:
        payload = {"text": text}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                webhook,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            # Slack returns 200 OK with body "ok"; Discord returns 204.
            # Anything >=400 we surface as a workflow-visible error so a
            # broken webhook URL doesn't fail silently.
            if resp.status_code >= 400:
                activity.logger.error(
                    "post_stuck_pipeline_alert: webhook POST failed "
                    "status=%d body=%s",
                    resp.status_code, resp.text[:200],
                )
                return {
                    "posted": False,
                    "reason": f"webhook_status_{resp.status_code}",
                }
    except httpx.HTTPError as exc:
        activity.logger.error(
            "post_stuck_pipeline_alert: webhook POST raised: %s", exc,
        )
        return {"posted": False, "reason": f"transport_error:{exc}"}

    activity.logger.info(
        "post_stuck_pipeline_alert: posted unprocessed=%d oldest=%s",
        unprocessed, oldest_date,
    )
    return {"posted": True, "reason": None}
