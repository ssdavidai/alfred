"""PlaneSyncWorkflow — one-way vault → Plane sync (#536 B4).

Runs every 60 seconds. Reads the tenant's vault (canonical source),
upserts the mirrored Plane workspace (projects for matters, issues for
tasks). Two-way sync (Plane → vault) lands in B7; this workflow is
strictly write-only toward Plane.

Feature-gated by ``PLANE_SYNC_ENABLED=true``. When unset or falsy the
workflow short-circuits immediately so tenants who don't run Plane never
pay Temporal activity cost.

Yield budget
------------
All I/O happens in activities. The workflow itself never holds full
record bodies — ``fetch_changed_*`` return frontmatter + slug only, and
we never buffer more than the cap below in workflow state. That keeps
each workflow activation well under Temporal's 2-second replay budget
even when a tenant has a few thousand vault records.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.plane_sync import (
        INBOX_SLUG_SENTINEL,
        ensure_inbox_project,
        fetch_changed_matters,
        fetch_changed_tasks,
        load_plane_sync_state,
        plane_sync_is_enabled,
        save_plane_sync_state,
        sync_matter_to_plane,
        sync_task_to_plane,
    )


# Hard cap on records processed per workflow run. Keeps workflow state
# size bounded; overflow gets caught on the next minute tick.
MAX_RECORDS_PER_RUN = 200

# Heartbeat every N records so long-running activities don't time out
# silently when the fleet has a large initial backlog.
HEARTBEAT_EVERY = 10


@dataclass
class PlaneSyncResult:
    started: bool = False
    matters_synced: int = 0
    tasks_synced: int = 0
    tasks_skipped: int = 0
    errors: int = 0
    last_vault_mtime: float = 0.0
    skipped_reason: str = ""
    error_messages: list[str] = field(default_factory=list)


@workflow.defn(name="PlaneSyncWorkflow")
class PlaneSyncWorkflow:
    """Vault → Plane one-way sync. Schedule: every 60 seconds."""

    @workflow.run
    async def run(self) -> PlaneSyncResult:
        workflow.logger.info("plane_sync.start")
        result = PlaneSyncResult()

        # Env-var reads aren't deterministic so they live in an activity.
        # Short start_to_close — this is a one-liner env read.
        enabled: bool = await workflow.execute_activity(
            plane_sync_is_enabled,
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
        if not enabled:
            result.skipped_reason = "PLANE_SYNC_ENABLED is not 'true'"
            workflow.logger.info(
                "plane_sync: feature flag off — skipping run"
            )
            return result

        result.started = True

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=1),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=30),
        )

        # 1. Load cursor (creates defaults if missing)
        state: dict[str, Any] = await workflow.execute_activity(
            load_plane_sync_state,
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=retry,
        )

        since = float(state.get("last_vault_mtime", 0.0) or 0.0)
        project_map: dict[str, str] = dict(state.get("project_map") or {})
        issue_map: dict[str, str] = dict(state.get("issue_map") or {})

        # 2. Fetch changed matters + tasks. Sizes capped by vault list
        #    endpoint's own limit (10k) and cut further by MAX_RECORDS_PER_RUN.
        matters: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_changed_matters,
            args=[since],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=retry,
        )
        tasks: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_changed_tasks,
            args=[since],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=retry,
        )

        # 3. Budget the per-run work. Sort by mtime ascending so the
        #    oldest change is processed first; overflow catches up on
        #    the next minute tick. Matters go first so their projects
        #    exist before tasks try to reference them.
        matters.sort(key=lambda m: float(m.get("mtime") or 0.0))
        tasks.sort(key=lambda t: float(t.get("mtime") or 0.0))

        total = len(matters) + len(tasks)
        if total > MAX_RECORDS_PER_RUN:
            workflow.logger.info(
                "plane_sync: backlog %d exceeds per-run cap %d; "
                "processing oldest first, rest deferred to next run",
                total, MAX_RECORDS_PER_RUN,
            )
            # Preserve matter-first ordering even under cap — a task whose
            # matter is in the same batch needs the project to upsert first.
            matter_budget = min(len(matters), MAX_RECORDS_PER_RUN)
            remaining = max(0, MAX_RECORDS_PER_RUN - matter_budget)
            matters = matters[:matter_budget]
            tasks = tasks[:remaining]

        processed_mtime = since

        # 4. Matters → Plane projects
        for idx, matter in enumerate(matters):
            if idx % HEARTBEAT_EVERY == 0:
                # workflow.logger writes to the Temporal history, heartbeats
                # live inside activities — but a periodic log here keeps an
                # observable breadcrumb trail during long backlogs.
                workflow.logger.info(
                    "plane_sync: matter progress %d/%d", idx, len(matters)
                )
            try:
                outcome = await workflow.execute_activity(
                    sync_matter_to_plane,
                    args=[matter, project_map],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                result.errors += 1
                msg = f"matter {matter.get('slug')}: {exc}"[:500]
                result.error_messages.append(msg)
                workflow.logger.warning(
                    "plane_sync.project_upsert_failed slug=%s error=%s",
                    matter.get("slug"), exc,
                )
                # Do NOT advance the cursor past a record that failed —
                # next run picks it up and retries.
                continue
            slug = outcome.get("slug") or matter.get("slug") or ""
            plane_id = outcome.get("plane_id") or ""
            if slug and plane_id:
                project_map[slug] = plane_id
            result.matters_synced += 1
            mt = float(matter.get("mtime") or 0.0)
            if mt > processed_mtime:
                processed_mtime = mt

        # 5. Ensure the Inbox project exists before the task loop. Tasks
        #    with no matter link go there so Sir has a triage surface in
        #    Plane instead of invisible "skipped" tasks. Idempotent — the
        #    activity fast-paths when the sentinel already maps.
        try:
            inbox_outcome: dict[str, Any] = await workflow.execute_activity(
                ensure_inbox_project,
                args=[project_map],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry,
            )
            inbox_id = str(inbox_outcome.get("plane_id") or "")
            if inbox_id:
                project_map[INBOX_SLUG_SENTINEL] = inbox_id
        except Exception as exc:  # noqa: BLE001
            # Soft-fail: tasks with a matter still sync fine; only the
            # orphan triage path degrades.
            workflow.logger.warning(
                "plane_sync.inbox_ensure_failed error=%s — matter-less tasks will skip this run",
                exc,
            )

        # 6. Tasks → Plane issues
        for idx, task in enumerate(tasks):
            if idx % HEARTBEAT_EVERY == 0:
                workflow.logger.info(
                    "plane_sync: task progress %d/%d", idx, len(tasks)
                )
            try:
                outcome = await workflow.execute_activity(
                    sync_task_to_plane,
                    args=[task, project_map, issue_map],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                result.errors += 1
                msg = f"task {task.get('slug')}: {exc}"[:500]
                result.error_messages.append(msg)
                workflow.logger.warning(
                    "plane_sync.issue_upsert_failed slug=%s error=%s",
                    task.get("slug"), exc,
                )
                continue

            action = outcome.get("action")
            slug = outcome.get("slug") or task.get("slug") or ""
            plane_id = outcome.get("plane_id") or ""
            mt = float(task.get("mtime") or 0.0)

            if action == "skip":
                # Tasks whose matter isn't in Plane yet are deferred. The
                # cursor does NOT advance past them — the next run can
                # retry once the matter shows up.
                result.tasks_skipped += 1
                continue

            if slug and plane_id:
                issue_map[slug] = plane_id
            result.tasks_synced += 1
            if mt > processed_mtime:
                processed_mtime = mt

        # 6. Persist cursor. Only advance ``last_vault_mtime`` when every
        #    record succeeded. On any failure or skip we hold the cursor at
        #    the pre-run value so the next run retries the deferred records.
        #    This trades a few extra vault list_records reads for strict
        #    correctness under partial failure.
        # Only hold the cursor on real errors. Previously we also held
        # on any skip, but skips are now extremely rare (only the no-inbox
        # race on workflow boot) and a single skipped record was enough
        # to freeze backfill indefinitely. Errors get their usual
        # retry-on-next-tick behavior.
        advance_mtime = processed_mtime
        if result.errors > 0:
            advance_mtime = since

        state_out = {
            "last_vault_mtime": advance_mtime,
            "project_map": project_map,
            "issue_map": issue_map,
        }
        await workflow.execute_activity(
            save_plane_sync_state,
            args=[state_out],
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=retry,
        )
        result.last_vault_mtime = advance_mtime

        workflow.logger.info(
            "plane_sync.done matters=%d tasks=%d skipped=%d errors=%d "
            "cursor=%s",
            result.matters_synced,
            result.tasks_synced,
            result.tasks_skipped,
            result.errors,
            advance_mtime,
        )
        return result
