"""InstructionAndCaptureWorkflow — executes alfred_instructions and captures
observations (formerly "LearningWorkflow"; renamed for clarity, since the
gen-1 "intuition engine" framing was misleading — the routing half was
JudgmentWorkflow, now retired. This workflow is a distinct utility:
instruction execution + observation capture, NOT routing).

Entry Point A: observation queue (from chat hook)
Entry Point B: alfred_instructions watcher (from vault records)
Entry Point C: chore-run-history seeding

The Temporal wire name stays "LearningWorkflow" so the existing
``al-learning`` schedule and any in-flight runs keep resolving without a
schedule migration. Renaming the wire name too would require reconciling
the schedule (handle.update) — deferred as optional.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.clerk import clerk_extract_instruction_observation, clerk_extract_observation
    from src.activities.observe import (
        clear_observation_queue,
        execute_alfred_instructions,
        read_observation_queue,
        scan_alfred_instructions,
        seed_observations_from_chore_runs,
        validate_observation,
    )
    from src.activities.vault import write_observation_record


@dataclass
class InstructionAndCaptureResult:
    observations: int = 0
    instructions_executed: int = 0
    chore_runs_seeded: int = 0


# Wire name pinned to the legacy "LearningWorkflow" so the al-learning
# schedule + in-flight runs keep resolving (see module docstring).
@workflow.defn(name="LearningWorkflow")
class InstructionAndCaptureWorkflow:
    @workflow.run
    async def run(self) -> InstructionAndCaptureResult:
        observations_created = 0
        instructions_executed = 0
        chore_runs_seeded = 0

        # Entry Point C (F.2): seed observations from chore-run-history.jsonl
        # Bypasses the queue+clerk pipeline because chore runs are
        # pre-structured and don't need an LLM to extract. Cursor-tracked
        # so each tick only processes new entries since the previous tick.
        try:
            seed_result = await workflow.execute_activity(
                seed_observations_from_chore_runs,
                args=[50],  # max_per_tick
                start_to_close_timeout=timedelta(seconds=60),
                heartbeat_timeout=timedelta(seconds=30),
            )
            if isinstance(seed_result, dict):
                chore_runs_seeded = int(seed_result.get("seeded", 0))
                observations_created += chore_runs_seeded
        except Exception as exc:
            workflow.logger.warning(
                "InstructionAndCaptureWorkflow: seed_observations_from_chore_runs raised: %s — continuing",
                exc,
            )

        # Entry Point A: Process observation queue (from chat hook)
        queue_items = await workflow.execute_activity(
            read_observation_queue,
            start_to_close_timeout=timedelta(seconds=10),
        )

        for item in queue_items:
            # Ask Clerk to extract structured observation
            observation = await workflow.execute_activity(
                clerk_extract_observation,
                args=[item],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

            # Validate (Python)
            is_valid: bool = await workflow.execute_activity(
                validate_observation,
                args=[observation],
                start_to_close_timeout=timedelta(seconds=10),
            )

            if is_valid:
                await workflow.execute_activity(
                    write_observation_record,
                    args=[observation],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                observations_created += 1

        # Entry Point B: alfred_instructions watcher
        hints = await workflow.execute_activity(
            scan_alfred_instructions,
            start_to_close_timeout=timedelta(seconds=30),
        )

        for hint in hints:
            # Create observation (learning)
            observation = await workflow.execute_activity(
                clerk_extract_instruction_observation,
                args=[hint],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

            is_valid = await workflow.execute_activity(
                validate_observation,
                args=[observation],
                start_to_close_timeout=timedelta(seconds=10),
            )

            if is_valid:
                await workflow.execute_activity(
                    write_observation_record,
                    args=[observation],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                observations_created += 1

            # Execute the instructions (action)
            await workflow.execute_activity(
                execute_alfred_instructions,
                args=[hint],
                start_to_close_timeout=timedelta(seconds=60),
            )
            instructions_executed += 1

        # Clear processed queue items
        if queue_items:
            await workflow.execute_activity(
                clear_observation_queue,
                args=[len(queue_items)],
                start_to_close_timeout=timedelta(seconds=10),
            )

        return InstructionAndCaptureResult(
            observations=observations_created,
            instructions_executed=instructions_executed,
            chore_runs_seeded=chore_runs_seeded,
        )
