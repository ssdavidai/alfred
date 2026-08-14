"""NarDayRecapWorkflow — compute nar_entry rows for one calendar day (#584).

Thin wrapper around ``compute_nar_day``.  Triggered by the backfill
script (after validation) or ad-hoc via Temporal for a single day.

Not scheduled automatically — the backfill is a separate orchestrator
step that runs once validation confirms the reference days match.
"""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.nar_recap import compute_nar_day


@workflow.defn(name="NarDayRecapWorkflow")
class NarDayRecapWorkflow:
    """Compute and write nar_entry rows for a single UTC calendar day.

    Input: ``{"date": "YYYY-MM-DD"}`` dict, or a bare ISO date string.
    Output: the summary dict from ``compute_nar_day``.
    """

    @workflow.run
    async def run(self, params: dict | str) -> dict:
        if isinstance(params, str):
            day_iso = params
        else:
            day_iso = params.get("date", "")
        if not day_iso:
            raise ValueError("NarDayRecapWorkflow: 'date' param is required (YYYY-MM-DD)")

        workflow.logger.info("nar_recap.start date=%s", day_iso)
        result: dict = await workflow.execute_activity(
            compute_nar_day,
            day_iso,
            start_to_close_timeout=timedelta(minutes=30),
            retry_policy=RetryPolicy(
                maximum_attempts=2,
                initial_interval=timedelta(seconds=10),
                backoff_coefficient=2.0,
                maximum_interval=timedelta(minutes=2),
            ),
        )
        workflow.logger.info(
            "nar_recap.done date=%s entries=%d displaced=%.1fmin engaged=%.2fh",
            day_iso,
            result.get("entries_written", 0),
            result.get("displaced_minutes", 0.0),
            result.get("engaged_hours", 0.0),
        )
        return result
