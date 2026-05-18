"""StuckPipelineAlertWorkflow — STORE-P4-2 hourly stuck-consumer alert.

STORE-P4-1 ships the JSONL stream log + ``stream_event_processed`` table
+ a daily compactor. P4-2 closes the loop: if the consumer side falls
behind (any stream event with age > 7d AND ``processed_at IS NULL``),
post a Slack-compatible alert to ``ALERT_WEBHOOK_URL``.

The raw event being old isn't the problem on its own — the daily
compactor garbage-collects processed events at 7d. Anything past 7d
that's *not* marked processed = a stuck consumer.

Schedule: hourly via ``al-stuck-pipeline-alert`` (registered by
``scripts/register_schedules.py``), ``overlap=SKIP`` so a slow check
doesn't pile on.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.stuck_pipeline import (
        check_stuck_pipeline,
        post_stuck_pipeline_alert,
    )


@workflow.defn(name="StuckPipelineAlertWorkflow")
class StuckPipelineAlertWorkflow:
    """Hourly stuck-consumer alert.

    Calls ``GET /api/v1/streams/stuck-report`` on ctrl-api. If the
    report shows any unprocessed events older than the cutoff, posts a
    Slack-compatible alert to ``ALERT_WEBHOOK_URL``. Healthy fleet runs
    return the zero-state report and skip the alert step.

    Returns the underlying report dict (plus an ``alert_posted`` flag)
    so the Temporal UI surfaces both healthy and stuck runs.
    """

    @workflow.run
    async def run(
        self,
        stuck_after_days: int = 7,
        sample_size: int = 10,
    ) -> dict[str, Any]:
        workflow.logger.info(
            "stuck_pipeline_alert.start stuck_after_days=%d",
            stuck_after_days,
        )

        report = await workflow.execute_activity(
            check_stuck_pipeline,
            args=[int(stuck_after_days), int(sample_size)],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(
                maximum_attempts=2,
                initial_interval=timedelta(seconds=5),
                backoff_coefficient=2.0,
            ),
        )

        unprocessed = int(report.get("unprocessed_old_count", 0))
        if unprocessed <= 0:
            workflow.logger.info(
                "stuck_pipeline_alert.healthy unprocessed_old=0"
            )
            return {**report, "alert_posted": False}

        outcome = await workflow.execute_activity(
            post_stuck_pipeline_alert,
            args=[report],
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=RetryPolicy(
                maximum_attempts=2,
                initial_interval=timedelta(seconds=5),
            ),
        )
        posted = bool(outcome.get("posted")) if isinstance(outcome, dict) else False
        workflow.logger.info(
            "stuck_pipeline_alert.done unprocessed=%d posted=%s reason=%s",
            unprocessed,
            posted,
            (outcome or {}).get("reason"),
        )
        return {**report, "alert_posted": posted, "alert_outcome": outcome}
