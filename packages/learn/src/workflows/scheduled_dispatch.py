"""ScheduledDispatchWorkflow — periodic scan for due delegate-on-schedule
decisions.

Runs every 15 min via Temporal schedule (al-scheduled-dispatch). Calls
``fire_due_scheduled_dispatches`` which scans decisions in
``state: scheduled`` and triggers the real dispatch for any whose
``execute_at`` has passed.

Companion to the delegate-with-when path. When the principal types
"send Adam Wednesday morning" as a delegate note, the decision lands
in state=scheduled; this workflow makes the actual dispatch happen on
Wednesday morning.
"""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy


@workflow.defn
class ScheduledDispatchWorkflow:
    @workflow.run
    async def run(self) -> dict:
        return await workflow.execute_activity(
            "fire_due_scheduled_dispatches",
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
