"""RecallDispatcherWorkflow — calendar-driven Recall.ai bot dispatch.

Runs every 5 minutes (Temporal schedule ``al-recall-dispatcher``,
registered alongside the rest of the interval schedules). On each
tick:

  1. Read the recall_config + month-to-date usage + the set of
     calendar_event_ids that already have a non-terminal bot.
  2. Pull the next 15 minutes of calendar events via Composio
     (GOOGLECALENDAR_LIST_EVENTS).
  3. Apply the policy gate (off / principal_attendee / all). Filter to
     events with a meeting URL the principal hasn't already had a bot
     dispatched for.
  4. Check the monthly cap — if projected (used + leave_after_minutes)
     would exceed ``monthly_hours_cap * 60`` minutes, refuse the
     dispatch and log a skip.
  5. POST each surviving event to ctrl-api's create-bot route. The
     ctrl-api side also dedupes on calendar_event_id, so a torn run
     can't double-dispatch.

The workflow is idempotent: re-running the same tick produces no extra
bots because (a) ctrl-api dedupes by calendar_event_id, and (b) the
dispatcher reads the active-bots list each tick and skips IDs already
seen there.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.recall_dispatcher import (
        check_recall_dispatch_state,
        dispatch_recall_bot,
        fetch_upcoming_calendar_events,
        filter_dispatch_candidates,
    )


logger = logging.getLogger("recall-dispatcher-workflow")


_FETCH_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    maximum_interval=timedelta(minutes=2),
    maximum_attempts=3,
)

_DISPATCH_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=15),
    maximum_interval=timedelta(minutes=2),
    # 1 retry only — Recall create-bot is non-idempotent on its own
    # (no client-side request id), so we lean on ctrl-api's
    # calendar_event_id dedupe instead of more aggressive retries.
    maximum_attempts=2,
)


@workflow.defn
class RecallDispatcherWorkflow:
    @workflow.run
    async def run(self, window_minutes: int = 15) -> dict[str, Any]:
        state = await workflow.execute_activity(
            check_recall_dispatch_state,
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=_FETCH_RETRY,
        )
        policy = str(state.get("policy") or "off").lower()
        if policy in ("off", "manual_only"):
            return {
                "ok": True,
                "skipped": "policy_off",
                "policy": policy,
                "dispatched": 0,
            }

        # Monthly cap — refuse the entire tick if even one more bot of
        # the configured leave_after_minutes would push us past the cap.
        # The whole tick rather than per-event because every event in
        # this tick will trigger the same projection.
        cap_minutes = int(state.get("monthly_hours_cap") or 60) * 60
        used = int(state.get("bot_minutes_used") or 0)
        leave_after = int(state.get("leave_after_minutes") or 90)
        if used + leave_after > cap_minutes:
            logger.warning(
                "recall_dispatcher: monthly cap exceeded "
                "(used=%dmin + leave_after=%dmin > cap=%dmin); skipping",
                used,
                leave_after,
                cap_minutes,
            )
            return {
                "ok": True,
                "skipped": "monthly_cap",
                "policy": policy,
                "bot_minutes_used": used,
                "leave_after_minutes": leave_after,
                "monthly_cap_minutes": cap_minutes,
                "dispatched": 0,
            }

        events = await workflow.execute_activity(
            fetch_upcoming_calendar_events,
            window_minutes,
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=_FETCH_RETRY,
        )
        if not isinstance(events, list) or not events:
            return {
                "ok": True,
                "skipped": "no_events",
                "policy": policy,
                "dispatched": 0,
            }

        already = state.get("dispatched_event_ids") or []
        candidates = filter_dispatch_candidates(events, policy, already)
        if not candidates:
            return {
                "ok": True,
                "policy": policy,
                "candidates": 0,
                "dispatched": 0,
            }

        bot_name = state.get("bot_name") or "Alfred"
        outcomes: list[dict[str, Any]] = []
        for ev, _reason in candidates:
            outcome = await workflow.execute_activity(
                dispatch_recall_bot,
                args=[
                    ev.get("meeting_url"),
                    bot_name,
                    ev.get("calendar_event_id"),
                    ev.get("start_iso"),
                ],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=_DISPATCH_RETRY,
            )
            outcomes.append(outcome if isinstance(outcome, dict) else {})

        dispatched = sum(1 for o in outcomes if o.get("ok"))
        return {
            "ok": True,
            "policy": policy,
            "candidates": len(candidates),
            "dispatched": dispatched,
            "outcomes": outcomes,
        }
