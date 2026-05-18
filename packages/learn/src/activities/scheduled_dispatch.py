"""Scheduled dispatch — fire delegate-with-note dispatches when their
execute_at falls due.

When the principal clicks Delegate on a Desk card with a time-bearing
note ("send Adam Wednesday morning"), the DecisionRouterWorkflow flips
the decision to ``state: scheduled`` with an ``execute_at`` stamped
from clerk's parse. The source ``needs_attention`` record is also
flipped to ``status: scheduled`` so it drops off /desk.

This activity, driven by ``ScheduledDispatchWorkflow`` on a 15-minute
cadence, scans scheduled decisions and triggers the actual dispatch
when their time arrives.

Idempotent: once we trigger dispatch the decision transitions to
``state: executing`` and is no longer in the scan set.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("scheduled-dispatch")


def _http() -> httpx.AsyncClient:
    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=cfg.alfred_ctrl_url, headers=headers, timeout=60.0
    )


@activity.defn
async def fire_due_scheduled_dispatches() -> dict[str, Any]:
    """Scan scheduled decisions, dispatch any whose execute_at has passed."""
    now = datetime.now(timezone.utc)
    fired = 0
    examined = 0
    async with _http() as client:
        resp = await client.get(
            "/api/v1/decisions?state=scheduled&limit=500",
        )
        resp.raise_for_status()
        scheduled = resp.json().get("decisions", []) or []
        for d in scheduled:
            execute_at = d.get("execute_at")
            if not isinstance(execute_at, str) or not execute_at:
                continue
            try:
                due = datetime.fromisoformat(execute_at.replace("Z", "+00:00"))
                if due.tzinfo is None:
                    due = due.replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            examined += 1
            if due > now:
                continue

            # It's time. Trigger the real dispatch.
            decision_id = str(d.get("id") or "")
            source = str(d.get("source") or "")
            source_record = str(d.get("source_record") or "")
            note = str(d.get("note") or "")

            if source != "needs_attention" or not source_record:
                logger.warning(
                    "scheduled_dispatch: unsupported source for %s (%s)",
                    decision_id, source,
                )
                continue
            na_id = (
                source_record.removeprefix("needs_attention/").removesuffix(".md")
            )
            try:
                dispatch_resp = await client.post(
                    f"/api/v1/admin/needs-attention/{na_id}/dispatch",
                    json={
                        "note": note,
                        "decision_origin": f"decision/{decision_id}.md",
                    },
                )
                dispatch_resp.raise_for_status()
                dispatch_json = dispatch_resp.json()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "scheduled_dispatch: dispatch failed for %s: %s",
                    decision_id, exc,
                )
                continue

            # Flip decision to executing.
            existing_side_effects = d.get("side_effects") or {}
            if not isinstance(existing_side_effects, dict):
                existing_side_effects = {}
            next_side_effects = dict(existing_side_effects)
            next_side_effects["fired_at"] = now.isoformat()
            next_side_effects["re_routed_signal"] = dispatch_json.get(
                "re_routed_signal"
            )
            next_side_effects["needs_attention_audit"] = dispatch_json.get(
                "audit_record_path"
            )

            await client.patch(
                f"/api/v1/decisions/{decision_id}",
                json={
                    "state": "executing",
                    "executing_at": now.isoformat(),
                    "side_effects": next_side_effects,
                },
            )
            fired += 1
            logger.info(
                "scheduled_dispatch: fired decision=%s na=%s (due %s)",
                decision_id, na_id, execute_at,
            )

    if examined or fired:
        logger.info(
            "scheduled_dispatch: examined=%d fired=%d", examined, fired,
        )
    return {"examined": examined, "fired": fired}
