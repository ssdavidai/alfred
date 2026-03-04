"""Workflow 4: Learning — processes observation queue and alfred_instructions into observation records.

Entry Point A: observation queue (from chat hook)
Entry Point B: alfred_instructions watcher (from vault records)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from src.activities.clerk import clerk_extract_instruction_observation, clerk_extract_observation
    from src.activities.observe import (
        clear_observation_queue,
        execute_alfred_instructions,
        read_observation_queue,
        scan_alfred_instructions,
        validate_observation,
    )
    from src.activities.vault import write_observation_record


@dataclass
class LearningResult:
    observations: int = 0
    instructions_executed: int = 0


@workflow.defn(name="LearningWorkflow")
class LearningWorkflow:
    @workflow.run
    async def run(self) -> LearningResult:
        observations_created = 0
        instructions_executed = 0

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

        return LearningResult(
            observations=observations_created,
            instructions_executed=instructions_executed,
        )
