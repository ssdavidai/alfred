"""PlaneSyncNudgeWorkflow — event-triggered single-record forward sync (#574).

Cron-based ``PlaneSyncWorkflow`` runs every 15 s and is the safety net.
This nudge workflow is fired by ``ctrl-api`` immediately after a vault
write against ``matter/`` or ``task/`` paths and syncs just the ONE
affected record to Plane, dropping end-to-end latency from ~15 s to
1–3 s.

The nudge is additive — it never replaces the cron. If the nudge fails
for any reason (Temporal unreachable, activity error, Plane outage) the
cron's next tick picks the record up via the normal mtime-cursor path.

Feature-gated by ``PLANE_SYNC_ENABLED=true`` — same flag as the cron.

Design notes
------------
* Reuses the cron's activities (``sync_matter_to_plane`` /
  ``sync_task_to_plane``) so forward-sync semantics stay in one place.
* Does NOT advance ``last_vault_mtime`` on the cursor — that's the
  cron's job. The nudge only PATCHES ``project_map`` / ``issue_map``
  when the upsert mints a new Plane UUID, so subsequent cron runs
  don't double-create.
* Uses a no-retry policy on the feature-flag check (cheap env read),
  but retries sync activities briefly since Plane can 429.
* Workflow IDs are caller-supplied and should be unique; we rely on
  Temporal's native ID-reuse semantics to deduplicate rapid
  back-to-back nudges (see ``packages/ctrl/src/api/routes/plane.ts``).

Input shape: ``{"record_type": "matter" | "task", "slug": "<slug>"}``.
We take a dict (not positional args) so the Temporal CLI caller in
``ctrl-api`` can pass a single ``--input '{...}'`` flag, matching
every other workflow-start call site in the codebase.
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
        ensure_inbox_project,
        fetch_single_plane_record,
        load_plane_sync_state,
        plane_sync_is_enabled,
        save_plane_sync_state,
        sync_matter_to_plane,
        sync_task_to_plane,
    )


@dataclass
class PlaneSyncNudgeResult:
    """Compact status payload returned to the caller (mostly for tests)."""
    started: bool = False
    synced: bool = False
    action: str = ""          # "create" | "update" | "skip" | "archived" | ""
    plane_id: str = ""
    record_type: str = ""
    slug: str = ""
    skipped_reason: str = ""
    error_messages: list[str] = field(default_factory=list)


@workflow.defn(name="PlaneSyncNudgeWorkflow")
class PlaneSyncNudgeWorkflow:
    """Event-triggered single-record forward sync. Fired on vault writes."""

    @workflow.run
    async def run(self, input: dict[str, Any]) -> PlaneSyncNudgeResult:
        record_type = str(input.get("record_type") or "")
        slug = str(input.get("slug") or "")
        workflow.logger.info(
            "plane_nudge.start type=%s slug=%s", record_type, slug
        )
        result = PlaneSyncNudgeResult(record_type=record_type, slug=slug)

        if record_type not in ("matter", "task"):
            result.skipped_reason = f"unsupported record_type: {record_type}"
            workflow.logger.warning(
                "plane_nudge: rejected type=%s slug=%s reason=%s",
                record_type, slug, result.skipped_reason,
            )
            return result

        if not slug:
            result.skipped_reason = "slug is required"
            return result

        # 1. Feature flag — same contract as PlaneSyncWorkflow. Env reads
        #    live in an activity for determinism.
        enabled: bool = await workflow.execute_activity(
            plane_sync_is_enabled,
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
        if not enabled:
            result.skipped_reason = "PLANE_SYNC_ENABLED is not 'true'"
            workflow.logger.info(
                "plane_nudge: feature flag off — skipping type=%s slug=%s",
                record_type, slug,
            )
            return result

        result.started = True

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=1),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=10),
        )

        # 2. Load the cursor. If the tenant has never run forward-sync
        #    the cursor file is absent and we get an empty map back —
        #    the nudge then either primes the map (matter nudge) or
        #    skips cleanly (task nudge with no Inbox yet). Cron will
        #    confirm/correct on its next tick either way.
        state: dict[str, Any] = await workflow.execute_activity(
            load_plane_sync_state,
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=retry,
        )
        project_map: dict[str, str] = dict(state.get("project_map") or {})
        issue_map: dict[str, str] = dict(state.get("issue_map") or {})

        # 3. Fetch the changed record. Returns None on 404 — we treat
        #    that as a graceful skip. A task nudge for a just-deleted
        #    record simply no-ops; the cron's archive-cascade path
        #    will reconcile Plane on the next tick.
        record: Optional[dict[str, Any]] = await workflow.execute_activity(
            fetch_single_plane_record,
            args=[record_type, slug],
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=retry,
        )
        if record is None:
            result.skipped_reason = "record not found (404)"
            workflow.logger.info(
                "plane_nudge: record missing type=%s slug=%s — soft no-op",
                record_type, slug,
            )
            return result

        # 4. Matter path: directly upsert the Plane project.
        if record_type == "matter":
            try:
                outcome = await workflow.execute_activity(
                    sync_matter_to_plane,
                    args=[record, project_map],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                msg = f"matter {slug}: {exc}"[:500]
                result.error_messages.append(msg)
                workflow.logger.warning(
                    "plane_nudge.project_upsert_failed slug=%s error=%s",
                    slug, exc,
                )
                return result

            result.synced = True
            result.action = str(outcome.get("action") or "")
            result.plane_id = str(outcome.get("plane_id") or "")

            # If a new Plane UUID was minted, persist it to the cursor
            # so the cron doesn't double-create on its next tick.
            if result.plane_id and project_map.get(slug) != result.plane_id:
                project_map[slug] = result.plane_id
                await self._persist_maps(
                    state, project_map, issue_map, retry,
                )
            workflow.logger.info(
                "plane_nudge.done type=matter slug=%s action=%s plane_id=%s",
                slug, result.action, result.plane_id,
            )
            return result

        # 5. Task path: we need an Inbox project to exist so orphan tasks
        #    (no matter link) have somewhere to land. If the cron hasn't
        #    created it yet we ensure it here so the nudge doesn't
        #    artificially skip the sync. On a cold start (no Plane sync
        #    ever run) this is where the Inbox gets created; that's fine
        #    — the activity is idempotent.
        if INBOX_SLUG_SENTINEL not in project_map:
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
                # Soft-fail: tasks WITH a matter link still sync. Tasks
                # without one will return action=skip which the cron
                # catches up on.
                workflow.logger.warning(
                    "plane_nudge.inbox_ensure_failed error=%s — continuing",
                    exc,
                )

        # Matter-ref lookup: if the task references a matter that isn't
        # in project_map yet, the cron hasn't synced the matter and
        # ``sync_task_to_plane`` will route to Inbox (or skip if Inbox
        # is also missing). Either is correct; no special-case here.
        try:
            # label_cache=None → falls back to per-task ensure_labels;
            # the nudge only handles ONE task so the extra round-trip
            # is acceptable and keeps the signature simple.
            outcome = await workflow.execute_activity(
                sync_task_to_plane,
                args=[record, project_map, issue_map, None],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            msg = f"task {slug}: {exc}"[:500]
            result.error_messages.append(msg)
            workflow.logger.warning(
                "plane_nudge.issue_upsert_failed slug=%s error=%s",
                slug, exc,
            )
            return result

        result.action = str(outcome.get("action") or "")
        result.plane_id = str(outcome.get("plane_id") or "")

        if result.action == "skip":
            # The forward-sync activity couldn't route (no Inbox, no
            # matter). Cron will resolve on a later tick once the
            # matter lands. Not an error.
            result.skipped_reason = "sync_task_to_plane returned action=skip"
            workflow.logger.info(
                "plane_nudge: task slug=%s skipped (cron will retry)", slug,
            )
            return result

        result.synced = True

        # Persist map updates when the upsert minted a new UUID or
        # cleared an existing one (archive cascade drops the slug).
        map_changed = False
        if result.action == "archived":
            if slug in issue_map:
                del issue_map[slug]
                map_changed = True
        elif result.plane_id and issue_map.get(slug) != result.plane_id:
            issue_map[slug] = result.plane_id
            map_changed = True

        if map_changed:
            await self._persist_maps(state, project_map, issue_map, retry)

        workflow.logger.info(
            "plane_nudge.done type=task slug=%s action=%s plane_id=%s",
            slug, result.action, result.plane_id,
        )
        return result

    async def _persist_maps(
        self,
        state: dict[str, Any],
        project_map: dict[str, str],
        issue_map: dict[str, str],
        retry: RetryPolicy,
    ) -> None:
        """Write back the updated maps WITHOUT touching ``last_vault_mtime``.

        The nudge must not advance the cron's cursor — doing so could
        silently skip other records changed in the same window that
        haven't been nudged yet. We preserve the existing mtime and
        only overwrite the two maps.
        """
        state_out = {
            "last_vault_mtime": float(state.get("last_vault_mtime") or 0.0),
            "project_map": project_map,
            "issue_map": issue_map,
        }
        try:
            await workflow.execute_activity(
                save_plane_sync_state,
                args=[state_out],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            # Cursor persistence failure is non-fatal for the nudge —
            # the Plane write already succeeded. The cron will
            # eventually re-persist the maps on its next run.
            workflow.logger.warning(
                "plane_nudge.persist_failed error=%s — map update will "
                "be recovered on next cron tick",
                exc,
            )
