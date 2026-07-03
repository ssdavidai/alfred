"""Workflow 5: Reflection — nightly review of observations to refine instincts.

Enhancements:
- Reads distiller_learnings from completed tasks (last 24h)
- Reads janitor_note flags from recent records
- Feeds all three into Clerk reflection prompt
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.clerk import clerk_reflect
    from src.activities.reflect import validate_proposals
    from src.activities.vault import (
        apply_instinct_change,
        fetch_active_instincts,
        fetch_distiller_learnings,
        fetch_janitor_flags,
        fetch_unprocessed_observations,
        mark_observations_processed,
        rebuild_intuition_index,
        write_reflection_report,
    )


@dataclass
class ReflectionResult:
    changes: int = 0
    report: str = ""


@workflow.defn(name="ReflectionWorkflow")
class ReflectionWorkflow:
    @workflow.run
    async def run(self) -> ReflectionResult:
        # 1. Read unprocessed observations
        observations: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_unprocessed_observations,
            start_to_close_timeout=timedelta(seconds=30),
        )

        if not observations:
            return ReflectionResult(changes=0)

        # 2. Read current intuition (all active instincts)
        instincts: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_active_instincts,
            start_to_close_timeout=timedelta(seconds=30),
        )

        # 2b. Read distiller learnings from completed tasks (last 24h)
        distiller_learnings: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_distiller_learnings,
            start_to_close_timeout=timedelta(seconds=30),
        )

        # 2c. Read janitor flags from recent records
        janitor_flags: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_janitor_flags,
            start_to_close_timeout=timedelta(seconds=30),
        )

        # 3. Ask Clerk to analyze (LLM — creative)
        proposals = await workflow.execute_activity(
            clerk_reflect,
            args=[observations, instincts, distiller_learnings, janitor_flags],
            # 900s: one LLM pass over the whole observation batch + the full
            # instinct set is slow, and the batch is now larger + env-tunable
            # (REFLECTION_BATCH_SIZE, default 250) to keep Codex/clerk CALL COUNT
            # low when draining a backlog. Timeout must move WITH the batch size:
            # 120s@small and 300s@75 both timed out and marked nothing processed.
            # retry cap 2 so a genuine overflow fails fast (doesn't burn quota
            # retrying forever).
            start_to_close_timeout=timedelta(seconds=900),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )

        # 4. Validate each proposal (Python — structural)
        valid_proposals: list[dict[str, Any]] = await workflow.execute_activity(
            validate_proposals,
            args=[proposals],
            start_to_close_timeout=timedelta(seconds=10),
        )

        # 5. Apply changes to vault
        changes = 0
        for proposal in valid_proposals:
            await workflow.execute_activity(
                apply_instinct_change,
                args=[proposal],
                start_to_close_timeout=timedelta(seconds=30),
            )
            changes += 1

        # 6. Mark observations as processed
        await workflow.execute_activity(
            mark_observations_processed,
            args=[observations],
            start_to_close_timeout=timedelta(seconds=30),
        )

        # 7. Rebuild intuition index (cosmetic — nothing in the loop reads it).
        # Cap retries so a failure fails fast instead of wedging the whole
        # workflow. An uncapped promotion-contract 422 here retried ~26k times
        # over a month and blocked the schedule from ever draining the
        # observation backlog. The activity now also swallows the 422
        # (belt-and-suspenders); this cap bounds any other failure mode.
        # (Adding retry_policy to an existing activity call is replay-safe.)
        await workflow.execute_activity(
            rebuild_intuition_index,
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )

        # 8. Write reflection report (human-facing summary; nothing in the loop
        # reads it). Bounded retries so no failure mode can wedge the workflow —
        # the "reflection" type is non-canonical and 422s (the activity now
        # swallows that), and a transient error must not retry forever.
        report_path: str = await workflow.execute_activity(
            write_reflection_report,
            args=[observations, valid_proposals, changes],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

        return ReflectionResult(changes=changes, report=report_path)
