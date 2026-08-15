"""AttentionTrendReadWorkflow — fetch trend data and produce a clerk read (#584).

Input: ``{"grain": "week"|"month"|"quarter", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}``
Output: summary dict (``observation_id``, ``observations_count``, ``replaced``).
"""
from __future__ import annotations
from datetime import timedelta
from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.attention_trend_read import read_attention_trends


@workflow.defn(name="AttentionTrendReadWorkflow")
class AttentionTrendReadWorkflow:
    @workflow.run
    async def run(self, params: dict) -> dict:
        grain = params.get("grain", "week")
        from_ = params.get("from", "")
        to = params.get("to", "")
        if not from_ or not to:
            raise ValueError("AttentionTrendReadWorkflow: 'from' and 'to' params are required")
        workflow.logger.info("attention_trend_read.start grain=%s from=%s to=%s", grain, from_, to)
        result: dict = await workflow.execute_activity(
            read_attention_trends,
            {"grain": grain, "from": from_, "to": to},
            start_to_close_timeout=timedelta(minutes=15),
            retry_policy=RetryPolicy(maximum_attempts=2,
                                     initial_interval=timedelta(seconds=10),
                                     backoff_coefficient=2.0,
                                     maximum_interval=timedelta(minutes=2)),
        )
        workflow.logger.info("attention_trend_read.done grain=%s obs=%d replaced=%s",
                             grain, result.get("observations_count", 0), result.get("replaced"))
        return result
