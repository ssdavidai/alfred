"""DecayWatcherWorkflow — six-hourly sweep that stamps freshness bands
on pending needs_attention cards and auto-flips the deeply stale.

The actual decay curve + auto-flip thresholds live in
``src.utils.decay``; the side effects (read needs_attention, PATCH
decay_band / decay_score / status) live in
``src.activities.decay_watcher``. This workflow exists only to make
that activity run on a Temporal schedule with sensible timeouts +
retry. No clerk calls inside the workflow itself — keep replay
deterministic.
"""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.decay_watcher import watch_decay


_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    maximum_interval=timedelta(minutes=2),
    maximum_attempts=3,
)


@workflow.defn
class DecayWatcherWorkflow:
    @workflow.run
    async def run(self) -> dict:
        result = await workflow.execute_activity(
            watch_decay,
            start_to_close_timeout=timedelta(minutes=10),
            retry_policy=_RETRY,
        )
        return result if isinstance(result, dict) else {}
