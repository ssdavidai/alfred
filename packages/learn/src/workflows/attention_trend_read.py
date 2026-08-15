"""AttentionTrendReadWorkflow — fetch trend data and produce a clerk read (#584).

Input (two shapes):

  Explicit (button / ctrl-api):
    {"grain": "week"|"month"|"quarter", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}

  Schedule (grain only — workflow derives from/to at run time):
    {"grain": "week"}

The TRENDS tab in AttentionPage.tsx fixes its window at page-load:

    const thirteenWeeksAgo = () => {
      const d = new Date(); d.setDate(d.getDate() - 91); ...
    };
    const [trendsFrom] = useState(thirteenWeeksAgo);  // today − 91 days
    const [trendsTo]   = useState(now);               // today

Grain only controls how periods are bucketed inside this fixed window.
When the schedule fires (no explicit from/to), _window_for_grain derives
from = today − 91, to = today — exactly matching thirteenWeeksAgo()→now()
so the pre-computed observation key matches what the UI requests on page load.

Output: summary dict (``observation_id``, ``observations_count``, ``replaced``).
"""
from __future__ import annotations

import datetime
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.attention_trend_read import read_attention_trends

# 91 days = thirteenWeeksAgo() in JS (d.setDate(d.getDate() − 91)).
# Grain only changes period bucketing, not the window.
_TRENDS_WINDOW_DAYS = 91


def _window_for_grain(grain: str, ref: datetime.date) -> tuple[datetime.date, datetime.date]:
    """Return (from_date, to_date) matching the UI's thirteenWeeksAgo()→now() default.

    AttentionPage.tsx line 32: ``d.setDate(d.getDate() - 91)`` for any grain.
    """
    return ref - datetime.timedelta(days=_TRENDS_WINDOW_DAYS), ref


@workflow.defn(name="AttentionTrendReadWorkflow")
class AttentionTrendReadWorkflow:
    """Fetch attention trends, ask the clerk for observations, persist the read.

    Accepts explicit from/to (button path) or derives them from grain alone
    (schedule path). Explicit from/to always win when both are supplied.
    """

    @workflow.run
    async def run(self, params: dict[str, Any]) -> dict[str, Any]:
        grain = params.get("grain", "week")
        from_ = params.get("from", "")
        to = params.get("to", "")

        if bool(from_) != bool(to):
            raise ValueError(
                "AttentionTrendReadWorkflow: supply both 'from' and 'to', or neither"
            )

        if not from_:
            # Schedule path — derive the 91-day trailing window at run time.
            today = workflow.now().date()
            from_date, to_date = _window_for_grain(grain, today)
            from_ = from_date.isoformat()
            to = to_date.isoformat()

        workflow.logger.info(
            "attention_trend_read.start grain=%s from=%s to=%s", grain, from_, to
        )
        result: dict[str, Any] = await workflow.execute_activity(
            read_attention_trends,
            {"grain": grain, "from": from_, "to": to},
            start_to_close_timeout=datetime.timedelta(minutes=15),
            retry_policy=RetryPolicy(
                maximum_attempts=2,
                initial_interval=datetime.timedelta(seconds=10),
                backoff_coefficient=2.0,
                maximum_interval=datetime.timedelta(minutes=2),
            ),
        )
        workflow.logger.info(
            "attention_trend_read.done grain=%s obs=%d replaced=%s",
            grain, result.get("observations_count", 0), result.get("replaced"),
        )
        return result
