"""NarDayRecapWorkflow — compute nar_entry rows for one calendar day (#584).

Thin wrapper around ``compute_nar_day``.  Runs nightly on ``al-nar-recap``
for the previous UTC day, and can be invoked ad-hoc or by the backfill
script for any single date.

Without a daily run the nar_entry table simply stops gaining rows.  Displaced
time comes from those rows; engaged time is derived live from sessions.  So a
missing day is not a gap on the chart — it is 0 - engaged, a confident
negative.  Observed on a live tenant: an eight-day hole rendered as -6.4h on
its worst day.
"""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.nar_recap import compute_nar_day


def resolve_recap_date(params: dict | str | None, now_date) -> str:
    """Which day a run recaps: an explicit ISO date wins; otherwise yesterday.

    Pure so it can be unit-tested without a Temporal sandbox. `now_date` is
    the caller's date (workflow.now().date() in the workflow) — never
    datetime.utcnow(), so a replay resolves identically.
    """
    if isinstance(params, str):
        day_iso = params
    else:
        day_iso = (params or {}).get("date", "")
    if day_iso:
        return day_iso
    return (now_date - timedelta(days=1)).isoformat()


@workflow.defn(name="NarDayRecapWorkflow")
class NarDayRecapWorkflow:
    """Compute and write nar_entry rows for a single UTC calendar day.

    Input: ``{"date": "YYYY-MM-DD"}`` dict, or a bare ISO date string.
    Output: the summary dict from ``compute_nar_day``.
    """

    @workflow.run
    async def run(self, params: dict | str) -> dict:
        explicit = params if isinstance(params, str) else (params or {}).get("date", "")
        day_iso = resolve_recap_date(params, workflow.now().date())
        if not explicit:
            # Scheduled runs pass no date: recap the day that just ended.
            workflow.logger.info("nar_recap: no date given, defaulting to %s", day_iso)

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
