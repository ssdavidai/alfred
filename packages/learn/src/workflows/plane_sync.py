"""PlaneSyncWorkflow — one-way vault → Plane sync (#536 B4).

Runs every 15 minutes. Reads the tenant's vault (canonical source),
upserts the mirrored Plane workspace (projects for matters, issues for
tasks). Two-way sync (Plane → vault) lands in B7; this workflow is
strictly write-only toward Plane.

Feature-gated by ``PLANE_SYNC_ENABLED=true``. When unset or falsy the
workflow short-circuits immediately so tenants who don't run Plane never
pay Temporal activity cost.

Yield budget
------------
All I/O happens in activities. The workflow itself never holds full
record bodies in long-lived state — task fetches are paginated through
``list_changed_task_paths`` (lightweight refs only) followed by per-chunk
``fetch_task_records_batch`` calls. Cursor advancement is per-batch so a
mid-run failure leaves a partial-cursor that the next run picks up
cleanly.

Pagination (#592)
-----------------
Mature tenants (example-owner: ~2545 tasks at ~2 KB each) used to overflow
Temporal's 2 MB activity-result ceiling on the legacy single-shot
``fetch_changed_tasks`` activity, freezing the cursor permanently. PR
#591 capped the return at 300 records as a stop-gap; this workflow
implements the proper two-stage paginated fetch + per-batch cursor
advancement.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.plane_sync import (
        INBOX_SLUG_SENTINEL,
        TASK_FETCH_BATCH_SIZE,
        ensure_inbox_project,
        fetch_changed_matters,
        fetch_task_records_batch,
        list_changed_task_paths,
        load_plane_sync_state,
        plane_sync_is_enabled,
        preload_project_labels,
        save_plane_sync_state,
        sync_matter_to_plane,
        sync_task_to_plane,
    )


# Heartbeat every N records so long-running activities don't time out
# silently when the fleet has a large initial backlog.
HEARTBEAT_EVERY = 10


@dataclass
class PlaneSyncResult:
    started: bool = False
    matters_synced: int = 0
    tasks_synced: int = 0
    tasks_skipped: int = 0
    tasks_archived: int = 0
    # Counter kept for wire compatibility with historical workflow results —
    # the activity no longer returns ``action="archived_by_plane"`` (a 404
    # on update now resolves to stale_dropped, never an auto-archive, see
    # the tenant-a cascade hotfix). New runs always report zero here.
    tasks_archived_by_plane: int = 0
    # Tasks whose mapped Plane issue 404'd on update. The activity
    # checked every other known project for the issue; either it was
    # deleted from a stale project (cross-project move) and fresh-created
    # next tick, or it's gone entirely (reconciliation will confirm).
    # Either way the slug is dropped from issue_map.
    tasks_stale_dropped: int = 0
    errors: int = 0
    last_vault_mtime: float = 0.0
    skipped_reason: str = ""
    error_messages: list[str] = field(default_factory=list)
    # Number of paginated task batches the workflow processed this run.
    # Useful for verifying cold-start backfills — e.g. example-owner's ~2545
    # tasks should land in ~26 batches with TASK_FETCH_BATCH_SIZE=100.
    task_batches: int = 0


@workflow.defn(name="PlaneSyncWorkflow")
class PlaneSyncWorkflow:
    """Vault → Plane one-way sync. Schedule: every 15 minutes."""

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

        # 2. Fetch changed matters. Matters are bounded (single-digit
        #    matters per tenant typical, low-double-digit at the high end)
        #    so the single-shot fetch + body-preview pattern still fits
        #    Temporal's 2 MB ceiling comfortably. If matter counts ever
        #    blow up we'll need the same two-stage refactor here.
        matters: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_changed_matters,
            args=[since],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=retry,
        )
        matters.sort(key=lambda m: float(m.get("mtime") or 0.0))

        processed_mtime = since
        matter_errors_in_run = False

        # 3. Matters → Plane projects. Process in mtime order so a
        #    mid-run failure leaves the cursor at the last successful
        #    matter's mtime (advanced by the per-batch save below).
        for idx, matter in enumerate(matters):
            if idx % HEARTBEAT_EVERY == 0:
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
                matter_errors_in_run = True
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

        # 3b. Persist matter progress before we start the (potentially
        #     long) task pagination. If the task-fetch loop crashes mid-
        #     run, the cursor still reflects matters that succeeded so we
        #     don't re-run their upserts on the next tick.
        if matters and not matter_errors_in_run:
            interim_state = {
                "last_vault_mtime": processed_mtime,
                "project_map": project_map,
                "issue_map": issue_map,
            }
            await workflow.execute_activity(
                save_plane_sync_state,
                args=[interim_state],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=retry,
            )

        # 4. Ensure the Inbox project exists before the task loop. Tasks
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

        # 5. List task paths (STAGE 1 of the paginated fetch). Lightweight
        #    refs only — no frontmatter, no body. Sorted ascending by
        #    mtime so we process oldest-first and the cursor advances
        #    monotonically.
        task_refs: list[dict[str, Any]] = await workflow.execute_activity(
            list_changed_task_paths,
            args=[since],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=retry,
        )

        # 6. Preload labels for every project we'll touch this run. The
        #    matter-resolution logic in the per-batch loop matches the
        #    one in ``sync_task_to_plane`` so the preload set equals the
        #    touched set. The cache is computed once and threaded through
        #    every batch.
        label_cache: dict[str, dict[str, str]] = {}
        if task_refs:
            target_projects: set[str] = set()
            for ref in task_refs:
                matter_slug = ref.get("matter_slug")
                pid: Optional[str] = None
                if matter_slug:
                    pid = project_map.get(matter_slug)
                if not pid:
                    pid = project_map.get(INBOX_SLUG_SENTINEL)
                if pid:
                    target_projects.add(pid)
            if target_projects:
                try:
                    label_cache = await workflow.execute_activity(
                        preload_project_labels,
                        args=[sorted(target_projects)],
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=retry,
                    )
                except Exception as exc:  # noqa: BLE001
                    # Soft-fail: sync_task_to_plane falls back to the
                    # legacy per-task fetch when the cache is empty.
                    workflow.logger.warning(
                        "plane_sync.preload_labels_failed error=%s — "
                        "falling back to per-task label fetch",
                        exc,
                    )
                    label_cache = {}

        # 7. Process tasks in batches of TASK_FETCH_BATCH_SIZE. Each
        #    iteration: fetch the full TaskRecord shape for the chunk
        #    (STAGE 2), upsert each into Plane, persist cursor at the
        #    end of the batch. Per-batch cursor advancement means a
        #    mid-run failure leaves a partial-cursor the next run picks
        #    up cleanly — no full re-do of completed batches.
        batch_count = 0
        path_chunks: list[list[str]] = [
            [ref["path"] for ref in task_refs[i:i + TASK_FETCH_BATCH_SIZE]]
            for i in range(0, len(task_refs), TASK_FETCH_BATCH_SIZE)
        ]

        for batch_idx, paths in enumerate(path_chunks):
            workflow.logger.info(
                "plane_sync: task batch %d/%d size=%d",
                batch_idx + 1, len(path_chunks), len(paths),
            )
            try:
                tasks: list[dict[str, Any]] = await workflow.execute_activity(
                    fetch_task_records_batch,
                    args=[paths],
                    start_to_close_timeout=timedelta(seconds=120),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                # Whole-batch fetch failure → record one error, hold the
                # cursor at the previous batch's mtime, stop processing
                # further batches. Next run picks up from where the
                # cursor advanced to.
                result.errors += 1
                msg = f"task batch {batch_idx + 1}: {exc}"[:500]
                result.error_messages.append(msg)
                workflow.logger.warning(
                    "plane_sync.task_batch_fetch_failed batch=%d error=%s",
                    batch_idx + 1, exc,
                )
                break

            # Defensive: re-sort by mtime since the activity may have
            # dropped 404'd paths and re-ordering matters for the
            # processed_mtime advancement below.
            tasks.sort(key=lambda t: float(t.get("mtime") or 0.0))
            batch_errors = False
            batch_processed_mtime = processed_mtime

            for idx, task in enumerate(tasks):
                if idx % HEARTBEAT_EVERY == 0:
                    workflow.logger.info(
                        "plane_sync: task progress batch=%d %d/%d",
                        batch_idx + 1, idx, len(tasks),
                    )
                try:
                    outcome = await workflow.execute_activity(
                        sync_task_to_plane,
                        args=[task, project_map, issue_map, label_cache],
                        start_to_close_timeout=timedelta(seconds=30),
                        retry_policy=retry,
                    )
                except Exception as exc:  # noqa: BLE001
                    result.errors += 1
                    batch_errors = True
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
                    # Tasks whose matter isn't in Plane yet are deferred.
                    # The cursor does NOT advance past them — the next
                    # run can retry once the matter shows up.
                    result.tasks_skipped += 1
                    continue

                if action == "archived":
                    # Vault record carries `archived: true` — the cascade
                    # in the activity already deleted the Plane issue.
                    # Drop the slug from issue_map so a later un-archive
                    # recreates cleanly, and DO advance the cursor past
                    # this record (the archive is a completed unit of
                    # work).
                    if slug in issue_map:
                        del issue_map[slug]
                    result.tasks_archived += 1
                    if mt > batch_processed_mtime:
                        batch_processed_mtime = mt
                    continue

                if action == "archived_by_plane":
                    # LEGACY path, kept for wire compatibility with any
                    # in-flight workflows that still return this action
                    # value. The activity no longer emits it — see
                    # tasks_stale_dropped below for the replacement
                    # path. On the next deploy every run reports zero
                    # here.
                    if slug in issue_map:
                        del issue_map[slug]
                    result.tasks_archived_by_plane += 1
                    if mt > batch_processed_mtime:
                        batch_processed_mtime = mt
                    continue

                if action == "stale_dropped":
                    # 404-on-update resolved either as a cross-project
                    # move (the activity DELETE'd the stale issue; next
                    # tick will create fresh in the correct project) or
                    # a not-found-anywhere miss (the activity logged
                    # stale_issue_map). Either way we drop the slug
                    # from issue_map and advance the cursor. Vault is
                    # NOT archived — that's the whole point of this
                    # fix vs the prior auto-archive behaviour.
                    if slug in issue_map:
                        del issue_map[slug]
                    result.tasks_stale_dropped += 1
                    if mt > batch_processed_mtime:
                        batch_processed_mtime = mt
                    continue

                if slug and plane_id:
                    issue_map[slug] = plane_id
                result.tasks_synced += 1
                if mt > batch_processed_mtime:
                    batch_processed_mtime = mt

            batch_count += 1

            # Per-batch cursor save. Only advance ``last_vault_mtime``
            # when the batch had no per-task errors. On any error we
            # hold at the pre-batch value so the next run retries —
            # but matters and earlier successful batches still get
            # persisted (so we don't re-do them).
            if not batch_errors:
                processed_mtime = batch_processed_mtime
            batch_state = {
                "last_vault_mtime": processed_mtime,
                "project_map": project_map,
                "issue_map": issue_map,
            }
            await workflow.execute_activity(
                save_plane_sync_state,
                args=[batch_state],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=retry,
            )

            # If this batch had errors, stop so the next run retries
            # the failed records before moving on.
            if batch_errors:
                workflow.logger.info(
                    "plane_sync: batch %d had errors — holding cursor "
                    "and deferring remaining batches to next run",
                    batch_idx + 1,
                )
                break

        result.task_batches = batch_count
        result.last_vault_mtime = processed_mtime

        # 8. Final cursor save. Per-batch saves above already persisted
        #    incremental progress through the task pipeline; this final
        #    save is the catch-all for runs where no per-batch save
        #    fired (no matters AND no task batches; or matter-only run
        #    with no task refs; or matter errors with no tasks). It
        #    also guarantees at least one save per run so the cursor
        #    file always reflects the latest successful state.
        final_state = {
            "last_vault_mtime": processed_mtime,
            "project_map": project_map,
            "issue_map": issue_map,
        }
        await workflow.execute_activity(
            save_plane_sync_state,
            args=[final_state],
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=retry,
        )

        workflow.logger.info(
            "plane_sync.done matters=%d tasks=%d batches=%d skipped=%d "
            "archived=%d archived_by_plane=%d stale_dropped=%d errors=%d "
            "cursor=%s",
            result.matters_synced,
            result.tasks_synced,
            result.task_batches,
            result.tasks_skipped,
            result.tasks_archived,
            result.tasks_archived_by_plane,
            result.tasks_stale_dropped,
            result.errors,
            processed_mtime,
        )
        return result
