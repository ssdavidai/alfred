"""DeferResurfaceWorkflow — hourly sweep that re-surfaces deferred
needs_attention cards when their resurface_at falls due.

The principal's "when shall I resurface this?" defer note has already
been parsed by the DecisionRouterWorkflow into a concrete
``resurface_at`` timestamp on the needs_attention record. This
workflow scans every hour, finds skipped records whose timestamp has
passed, and flips them back to ``status: pending`` so they reappear
on /desk. Idempotent — once flipped the next pass skips them.
"""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.defer_resurface import resurface_due_needs_attention


_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    maximum_interval=timedelta(minutes=2),
    maximum_attempts=3,
)


@workflow.defn
class DeferResurfaceWorkflow:
    @workflow.run
    async def run(self) -> dict:
        result = await workflow.execute_activity(
            resurface_due_needs_attention,
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=_RETRY,
        )
        return result if isinstance(result, dict) else {}
