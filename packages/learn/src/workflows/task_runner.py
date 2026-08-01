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
        recover_stale_blocked_tasks,
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

                # 5. Execute via the Hermes workers gateway. The clerk
                # completion budget is 900s (_CLERK_COMPLETION_BUDGET_SECONDS);
                # the old 300s ceiling here guaranteed any task longer than
                # 5 minutes died on activity timeout before the clerk budget
                # was ever reached (#365/#366 smoke finding).
                exec_result: dict[str, Any] = await workflow.execute_activity(
                    execute_task,
                    args=[task, context],
                    start_to_close_timeout=timedelta(seconds=960),
                    heartbeat_timeout=timedelta(seconds=120),
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
                    # Contains one clerk call; 120s starved it (same
                    # budget-mismatch class as execute_task above).
                    start_to_close_timeout=timedelta(seconds=300),
                    heartbeat_timeout=timedelta(seconds=120),
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
                        # #399: stamp WHY, with the transient signature the
                        # recovery sweep keys on — an exception block is
                        # retryable state, a considered LLM block is not.
                        args=[
                            task,
                            "blocked",
                            "transient-execution-error: runner exception",
                        ],
                        start_to_close_timeout=timedelta(seconds=15),
                        retry_policy=RetryPolicy(maximum_attempts=3),
                    )
                except Exception:
                    workflow.logger.warning(
                        "task_runner: could not mark %s blocked", task_path
                    )
                result.failed += 1

        return result


@workflow.defn(name="BlockedTaskRecoveryWorkflow")
class BlockedTaskRecoveryWorkflow:
    """#399 — bounded recovery for transient-error-blocked tasks.

    Own workflow (not a TaskRunner pre-pass) so the deployed
    TaskRunnerWorkflow's replay history is untouched. Scheduled as
    ``al-blocked-task-recovery`` every 6h; the sweep itself is a no-op
    when nothing carries the transient signature.
    """

    @workflow.run
    async def run(self) -> dict:
        return await workflow.execute_activity(
            recover_stale_blocked_tasks,
            start_to_close_timeout=timedelta(seconds=120),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
