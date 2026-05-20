"""DecisionPatternsWorkflow — daily extraction of recurring rules from
the principal's recent decisions. Writes proposed patterns into
``decision_pattern/*.md`` so the principal can promote them to real
standing rules / instincts on /study.

Schedule: cron ``0 3 * * *`` (03:00 local). Runs once per day so the
clerk is hit at most a few times per tenant. Single activity; the
heavy lifting (per-matter grouping + clerk calls + vault writes) lives
in ``decision_patterns.extract_decision_patterns``.
"""
from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.decision_patterns import extract_decision_patterns


_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=30),
    maximum_interval=timedelta(minutes=2),
    maximum_attempts=3,
)


@workflow.defn
class DecisionPatternsWorkflow:
    @workflow.run
    async def run(self) -> dict:
        result = await workflow.execute_activity(
            extract_decision_patterns,
            start_to_close_timeout=timedelta(minutes=10),
            retry_policy=_RETRY,
        )
        return result if isinstance(result, dict) else {}
