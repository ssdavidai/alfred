"""Workflow: daily flywheel loop-health rollup + Sunday digest (#332)."""

from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.flywheel_telemetry import (
        compute_flywheel_rollup,
        send_flywheel_digest,
    )


@workflow.defn(name="FlywheelTelemetryWorkflow")
class FlywheelTelemetryWorkflow:
    """Daily 03:30: persist yesterday's rollup; Sundays also send the
    weekly digest via the sanctioned notify path."""

    @workflow.run
    async def run(self) -> dict:
        retry = RetryPolicy(maximum_attempts=3)
        rollup = await workflow.execute_activity(
            compute_flywheel_rollup,
            start_to_close_timeout=timedelta(seconds=300),
            retry_policy=retry,
        )
        result: dict = {"rollup": rollup}
        # Deterministic weekday from workflow time (no datetime.now in
        # workflow code — Temporal sandbox rule).
        if workflow.now().weekday() == 6:  # Sunday
            result["digest"] = await workflow.execute_activity(
                send_flywheel_digest,
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=retry,
            )
        return result
