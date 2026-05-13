"""PatternDetectionWorkflow — hourly scan of the unified observation
pool for clusters that suggest a recurring rule (OBS-4).

Schedule: every 1 hour, overlap=SKIP. The detector is cheap
(deterministic clustering, single ctrl-api list call) but we don't
want overlapping runs to race on the skip-set checks.

The workflow is a one-shot wrapper around the single
``detect_pattern_proposals`` activity. Everything interesting — the
clustering, the skip-set, the writes — happens in the activity. We
keep the workflow thin so adding new activity calls later requires
the standard ``workflow.patched()`` discipline (see
packages/learn/CLAUDE.md).
"""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.pattern_detection import detect_pattern_proposals


_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=30),
    maximum_interval=timedelta(minutes=2),
    maximum_attempts=3,
)


@workflow.defn
class PatternDetectionWorkflow:
    @workflow.run
    async def run(self) -> dict:
        result = await workflow.execute_activity(
            detect_pattern_proposals,
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=_RETRY,
        )
        return result if isinstance(result, dict) else {}
