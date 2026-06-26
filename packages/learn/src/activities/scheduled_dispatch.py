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

Idempotent (claim-before-act, #55 idiom): we flip the decision to the
non-terminal ``state: dispatching`` *before* the dispatch POST, so a
worker restart (every deploy) mid-activity no longer re-presents it in
the ``state=scheduled`` scan set and cannot re-fire. On a clean fire it
then transitions ``dispatching → executing``.
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

            # Claim-before-act (#55 idiom, mirrored from
            # decision_router.route_decision). The dispatch POST below
            # re-arms the source signal and triggers a real agent run — a
            # non-idempotent side effect. Flip the decision off the
            # ``scheduled`` scan set to the non-terminal ``dispatching``
            # state BEFORE dispatching, so a worker restart mid-activity
            # does not re-present this decision (the scan filters
            # ``state=scheduled``) and re-fire. A crash between this mark
            # and the dispatch strands the decision in ``dispatching`` — a
            # visible, sweepable state (recover_stuck_dispatching), strictly
            # safer than a silent double dispatch. If the mark write fails
            # we skip without dispatching; the decision stays ``scheduled``
            # and the next scan retries.
            try:
                claim_resp = await client.patch(
                    f"/api/v1/decisions/{decision_id}",
                    json={"state": "dispatching"},
                )
                claim_resp.raise_for_status()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "scheduled_dispatch: pre-dispatch 'dispatching' mark "
                    "failed for %s: %s — skipping (no dispatch)",
                    decision_id, exc,
                )
                continue

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
