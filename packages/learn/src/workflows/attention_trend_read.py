"""AttentionTrendReadWorkflow — weekly pre-compute of the trailing-7-day
attention trend so the Range tab on /attention is always populated (#584).

The UI's default Range window is sevenAgo()→now() (today − 6 days to today,
computed at render time in AttentionPage.tsx).  The window must be derived at
workflow-run time; the schedule passes only the grain ({"grain": "week"}).
"""
from __future__ import annotations

import datetime
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.attention_trend_read import read_attention_trends

# Days in a full trailing window per grain.  week = 7-day = sevenAgo()→now().
_GRAIN_DAYS: dict[str, int] = {"week": 7, "month": 30, "quarter": 91}


def _window_for_grain(grain: str, ref: datetime.date) -> tuple[datetime.date, datetime.date]:
    """Return (from_date, to_date) matching the UI default for the given grain.

    ``week`` → ref − 6 days to ref (7-day inclusive, same as sevenAgo()→now()).
    """
    n = _GRAIN_DAYS.get(grain, 7)
    return ref - datetime.timedelta(days=n - 1), ref


@workflow.defn(name="AttentionTrendReadWorkflow")
class AttentionTrendReadWorkflow:
    """Pre-compute the attention trend observation for the trailing window.

    Input: ``{"grain": "week"}`` — workflow derives from/to at run time.
    """

    @workflow.run
    async def run(self, params: dict[str, Any] | str | None = None) -> dict[str, Any]:
        grain = "week"
        if isinstance(params, dict):
            grain = str(params.get("grain", "week"))

        today = workflow.now().date()
        from_date, to_date = _window_for_grain(grain, today)

        workflow.logger.info(
            "attention_trend_read.start grain=%s from=%s to=%s",
            grain, from_date.isoformat(), to_date.isoformat(),
        )
        result: dict[str, Any] = await workflow.execute_activity(
            read_attention_trends,
            {"grain": grain, "from": from_date.isoformat(), "to": to_date.isoformat()},
            start_to_close_timeout=datetime.timedelta(minutes=10),
            retry_policy=RetryPolicy(
                maximum_attempts=2,
                initial_interval=datetime.timedelta(seconds=30),
                backoff_coefficient=2.0,
                maximum_interval=datetime.timedelta(minutes=3),
            ),
        )
        workflow.logger.info(
            "attention_trend_read.done grain=%s obs=%d replaced=%s",
            grain, result.get("observations_count", 0), result.get("replaced", False),
        )
        return result
