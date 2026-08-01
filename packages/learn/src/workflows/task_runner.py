"""Workflow: Task Runner — picks up queued tasks, executes them, writes results.

Runs on a 2-minute Temporal schedule. Scans for vault tasks with
status=queued and owner=alfred, then executes them via OpenClaw
sessions_spawn with full tool access.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.tasks import (
        assemble_task_context,
        check_task_prerequisites,
        complete_task,
        evaluate_consequentials,
        execute_task,
        fetch_queued_tasks,
        update_task_status,
        write_task_artifacts,
    )


@dataclass
class TaskRunnerResult:
    executed: int = 0
    skipped: int = 0
    failed: int = 0
    created_follow_ups: int = 0
    paths: list[str] = field(default_factory=list)


@workflow.defn(name="TaskRunnerWorkflow")
class TaskRunnerWorkflow:
    @workflow.run
    async def run(self) -> TaskRunnerResult:
        result = TaskRunnerResult()

        # 1. Fetch queued AI tasks
        tasks: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_queued_tasks,
            start_to_close_timeout=timedelta(seconds=30),
        )

        if not tasks:
            return result

        # Process up to 5 tasks per run (avoid long-running workflows)
        for task in tasks[:5]:
            task_path = task.get("path", "unknown")

            # Steps 2-8 all live inside one try so a single poisoned task
            # (e.g. a depends_on reference that can never resolve) marks
            # THAT task failed and the loop moves on. Before #367, steps
            # 2-3 sat outside the try: one bad task failed the whole run,
            # and with the schedule's SKIP overlap policy a permanently
            # failing task wedged the entire runner for days (322 skipped
            # ticks on home).
            try:
                # 2. Check prerequisites
                ready: bool = await workflow.execute_activity(
                    check_task_prerequisites,
                    args=[task],
                    start_to_close_timeout=timedelta(seconds=15),
                )

                if not ready:
                    result.skipped += 1
                    continue

                # 3. Mark active
                await workflow.execute_activity(
                    update_task_status,
                    args=[task, "active"],
                    start_to_close_timeout=timedelta(seconds=15),
                )

                # 4. Assemble context
                context: str = await workflow.execute_activity(
                    assemble_task_context,
                    args=[task],
                    start_to_close_timeout=timedelta(seconds=30),
                )

                # 5. Execute via sessions_spawn
                exec_result: dict[str, Any] = await workflow.execute_activity(
                    execute_task,
                    args=[task, context],
                    start_to_close_timeout=timedelta(seconds=300),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )

                # 6. Write artifacts
                if exec_result.get("output"):
                    artifact_path: str = await workflow.execute_activity(
                        write_task_artifacts,
                        args=[task, exec_result],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                    result.paths.append(artifact_path)

                # 7. Complete task
                await workflow.execute_activity(
                    complete_task,
                    args=[task, exec_result],
                    start_to_close_timeout=timedelta(seconds=30),
                )

                # 8. Evaluate consequentials — ledger entry, matter resolution, follow-up errands
                follow_up_paths: list[str] = await workflow.execute_activity(
                    evaluate_consequentials,
                    args=[task, exec_result],
                    start_to_close_timeout=timedelta(seconds=120),
                )

                result.created_follow_ups += len(follow_up_paths)
                result.executed += 1

            except Exception:
                # Mark task as blocked on failure. Best-effort with a
                # bounded retry: if even this write fails, count the
                # failure and move on rather than wedging the run.
                try:
                    await workflow.execute_activity(
                        update_task_status,
                        args=[task, "blocked"],
                        start_to_close_timeout=timedelta(seconds=15),
                        retry_policy=RetryPolicy(maximum_attempts=3),
                    )
                except Exception:
                    workflow.logger.warning(
                        "task_runner: could not mark %s blocked", task_path
                    )
                result.failed += 1

        return result
