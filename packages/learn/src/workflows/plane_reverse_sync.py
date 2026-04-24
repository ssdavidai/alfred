"""PlaneReverseSyncWorkflow — Plane → vault two-way sync ingress (#536 B7).

Runs every 10 seconds. Consumes ``stream_type: "plane"`` events emitted
by ctrl-api's ``POST /api/v1/plane/webhook`` (see
``packages/ctrl/src/api/routes/plane.ts``), translates them into vault
matter/task/comment patches, and applies them with three loop guards
that prevent oscillation with ``PlaneSyncWorkflow``:

1. Origin stamp + hash match (``external_id == "alfred:<slug>"`` and
   the inbound hash equals the last outbound signature).
2. Suppression window (outbound signature recorded within 30s + same hash).
3. Field-level hash compare inside ``apply_plane_patch_to_vault``.

Feature-gated by ``PLANE_SYNC_ENABLED`` (same flag as forward-sync so
the two sides flip together).

Per-run heartbeat behaviour mirrors forward-sync: we emit periodic
``workflow.logger.info`` breadcrumbs every ``HEARTBEAT_EVERY`` events so
large webhook backlogs surface in Temporal history without staying
silent.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.plane_reverse_sync import (
        append_plane_comment_to_vault,
        apply_plane_patch_to_vault,
        archive_vault_record,
        check_loop_guards,
        create_vault_task_from_plane_issue,
        fetch_plane_events,
        find_vault_task_path_by_plane_id,
        load_reverse_sync_state,
        mark_plane_event_processed,
        plane_reverse_sync_is_enabled,
        save_reverse_sync_cursor,
    )
    from src.activities.plane_alfred_triggers import (
        detect_alfred_plane_trigger,
        resolve_plane_approval,
        spawn_alfred_for_plane_trigger,
    )
    from src.activities.plane_sync import INBOX_SLUG_SENTINEL
    from src.utils.plane_mapping import (
        plane_issue_to_vault_patch,
        plane_project_to_matter_patch,
    )


MAX_EVENTS_PER_RUN = 200
HEARTBEAT_EVERY = 10


@dataclass
class PlaneReverseSyncResult:
    started: bool = False
    events_seen: int = 0
    events_skipped_loop_guard: int = 0
    matters_updated: int = 0
    tasks_updated: int = 0
    tasks_created: int = 0
    archives: int = 0
    comments_applied: int = 0
    unknown_events: int = 0
    errors: int = 0
    skipped_reason: str = ""
    last_event_id: str = ""
    error_messages: list[str] = field(default_factory=list)
    # B8 — Alfred-as-a-Plane-user counters. Spawned sessions are
    # fire-and-forget from the workflow's perspective; these counters
    # let #536 B9 verification correlate reverse-sync ticks with
    # openclaw session logs.
    alfred_triggers_seen: int = 0
    alfred_sessions_spawned: int = 0
    alfred_spawns_failed: int = 0
    alfred_approvals_resolved: int = 0
    alfred_spawn_session_keys: list[str] = field(default_factory=list)


def _alfred_external_slug(external_id: Any) -> Optional[str]:
    """Pure-function shim so the workflow can inspect external_id without
    reaching into activity code.

    Shape-checks are deliberately narrow: we only consume
    ``alfred:<slug>`` ids; anything else means "not ours".
    """
    if not isinstance(external_id, str):
        return None
    if not external_id.startswith("alfred:"):
        return None
    rest = external_id[len("alfred:"):]
    return rest or None


def _matter_path_for_slug(slug: str) -> str:
    return f"matter/{slug}.md"


def _task_path_for_slug(slug: str) -> str:
    return f"task/{slug}.md"


@workflow.defn(name="PlaneReverseSyncWorkflow")
class PlaneReverseSyncWorkflow:
    """Plane → vault ingress. Schedule: every 10 seconds."""

    @workflow.run
    async def run(self) -> PlaneReverseSyncResult:
        workflow.logger.info("plane_reverse_sync.start")
        result = PlaneReverseSyncResult()

        enabled: bool = await workflow.execute_activity(
            plane_reverse_sync_is_enabled,
            start_to_close_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
        if not enabled:
            result.skipped_reason = "PLANE_SYNC_ENABLED is not 'true'"
            workflow.logger.info(
                "plane_reverse_sync: feature flag off — skipping run"
            )
            return result

        result.started = True

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=1),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=30),
        )

        state: dict[str, Any] = await workflow.execute_activity(
            load_reverse_sync_state,
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=retry,
        )
        cursor: dict[str, Any] = dict(state.get("cursor") or {})
        project_map: dict[str, str] = dict(state.get("project_map") or {})
        issue_map: dict[str, str] = dict(state.get("issue_map") or {})
        outbound_sigs: dict[str, dict[str, Any]] = dict(
            state.get("outbound_signatures") or {}
        )

        # Invert the forward-sync maps so we can go plane_id → slug
        # without an extra activity round-trip.
        plane_project_to_slug: dict[str, str] = {
            pid: slug for slug, pid in project_map.items() if pid
        }
        plane_issue_to_slug: dict[str, str] = {
            pid: slug for slug, pid in issue_map.items() if pid
        }

        since_id = str(cursor.get("last_event_id") or "")

        events: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_plane_events,
            args=[since_id],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=retry,
        )

        if len(events) > MAX_EVENTS_PER_RUN:
            workflow.logger.info(
                "plane_reverse_sync: backlog %d exceeds per-run cap %d; "
                "processing oldest first, rest deferred to next run",
                len(events), MAX_EVENTS_PER_RUN,
            )
            events = events[:MAX_EVENTS_PER_RUN]

        last_processed_id = since_id

        for idx, event in enumerate(events):
            if idx % HEARTBEAT_EVERY == 0:
                workflow.logger.info(
                    "plane_reverse_sync: progress %d/%d", idx, len(events)
                )
            result.events_seen += 1

            try:
                # B8 — check for an Alfred-as-user trigger BEFORE vault
                # dispatch so the spawn fires even when the event would
                # otherwise be a vault no-op (e.g. a comment mention that
                # doesn't change any vault field). Spawn is fire-and-
                # forget; we capture the session id for #536 B9.
                await self._maybe_spawn_alfred(event=event, result=result, retry=retry)

                await self._dispatch_event(
                    event=event,
                    project_map=project_map,
                    issue_map=issue_map,
                    plane_project_to_slug=plane_project_to_slug,
                    plane_issue_to_slug=plane_issue_to_slug,
                    outbound_sigs=outbound_sigs,
                    result=result,
                    retry=retry,
                )
            except Exception as exc:  # noqa: BLE001
                result.errors += 1
                eid = str(event.get("id") or "")
                msg = f"event {eid}: {exc}"[:500]
                result.error_messages.append(msg)
                workflow.logger.warning(
                    "plane_reverse_sync.event_failed id=%s error=%s",
                    eid, exc,
                )
                # Do NOT advance the cursor past a failed event — retry next run
                continue

            # Advance cursor only after a successful dispatch (or a
            # loop-guard skip, which is still "processed").
            eid = str(event.get("id") or "")
            if eid:
                last_processed_id = eid

        # Persist cursor. It advances as long as the dispatcher finished
        # each event (skip or apply). A mid-list failure pins the
        # cursor at the most recent successful id.
        if last_processed_id and last_processed_id != since_id:
            await workflow.execute_activity(
                save_reverse_sync_cursor,
                args=[{"last_event_id": last_processed_id, "last_event_ts": 0.0}],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=retry,
            )
            result.last_event_id = last_processed_id

        workflow.logger.info(
            "plane_reverse_sync.done seen=%d skipped=%d matters=%d tasks=%d "
            "created=%d archives=%d comments=%d errors=%d",
            result.events_seen,
            result.events_skipped_loop_guard,
            result.matters_updated,
            result.tasks_updated,
            result.tasks_created,
            result.archives,
            result.comments_applied,
            result.errors,
        )
        return result

    # ---------------------------------------------------------------------
    # Per-event dispatcher — keeps ``run`` readable.
    # ---------------------------------------------------------------------

    async def _dispatch_event(
        self,
        *,
        event: dict[str, Any],
        project_map: dict[str, str],
        issue_map: dict[str, str],
        plane_project_to_slug: dict[str, str],
        plane_issue_to_slug: dict[str, str],
        outbound_sigs: dict[str, dict[str, Any]],
        result: PlaneReverseSyncResult,
        retry: RetryPolicy,
    ) -> None:
        """Route a single ``stream_type: "plane"`` event to the right branch."""
        raw = event.get("raw") or {}
        if not isinstance(raw, dict):
            result.unknown_events += 1
            return

        plane_event = str(raw.get("event") or "").lower()
        action = str(raw.get("action") or "").lower()
        data = raw.get("data")
        if not isinstance(data, dict):
            result.unknown_events += 1
            return

        plane_id = str(data.get("id") or "")
        external_id = data.get("external_id")

        # Loop guards #1 + #2 run for project/issue updates. Created
        # events with no external_id are human-created and bypass these
        # guards (there's no prior outbound signature to match against).
        is_alfred_origin = _alfred_external_slug(external_id) is not None
        guard_applicable = plane_event in {"project", "issue"} and action in {
            "updated", "created", "deleted",
        } and (is_alfred_origin or plane_id in outbound_sigs)

        if guard_applicable:
            guard = await workflow.execute_activity(
                check_loop_guards,
                args=[plane_id, external_id, data, outbound_sigs],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=retry,
            )
            if guard.get("skip"):
                result.events_skipped_loop_guard += 1
                workflow.logger.info(
                    "plane_reverse_sync: loop guard skipped event id=%s "
                    "reason=%s",
                    event.get("id"), guard.get("reason"),
                )
                return

        # ── Project events ──────────────────────────────────────────────
        if plane_event == "project":
            slug = _alfred_external_slug(external_id) or plane_project_to_slug.get(
                plane_id
            )
            if not slug:
                # Alfred doesn't know this project — harmless; surveyor
                # may adopt it later if the matter gets created.
                result.unknown_events += 1
                return
            path = _matter_path_for_slug(slug)

            if action == "deleted":
                outcome = await workflow.execute_activity(
                    archive_vault_record,
                    args=[path, "matter"],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )
                if outcome.get("applied"):
                    result.archives += 1
                return

            if action in {"updated", "created"}:
                patch = plane_project_to_matter_patch(data)
                # Guard #3 fires inside apply_plane_patch_to_vault.
                outcome = await workflow.execute_activity(
                    apply_plane_patch_to_vault,
                    args=["matter", path, patch, ""],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )
                if outcome.get("applied"):
                    result.matters_updated += 1
                return

            result.unknown_events += 1
            return

        # ── Issue events ────────────────────────────────────────────────
        if plane_event == "issue":
            slug = _alfred_external_slug(external_id) or plane_issue_to_slug.get(
                plane_id
            )

            if action == "created":
                if slug:
                    # This is the echo of our own POST — loop guard
                    # should have caught it; if it slipped through, the
                    # hash compare in apply_plane_patch_to_vault will
                    # still noop.
                    path = _task_path_for_slug(slug)
                    patch = plane_issue_to_vault_patch(data)
                    outcome = await workflow.execute_activity(
                        apply_plane_patch_to_vault,
                        args=["task", path, patch, ""],
                        start_to_close_timeout=timedelta(seconds=30),
                        retry_policy=retry,
                    )
                    if outcome.get("applied"):
                        result.tasks_updated += 1
                    return

                # Human-created Plane issue — mint a vault task.
                project_id = str(data.get("project") or data.get("project_id") or "")
                matter_slug = plane_project_to_slug.get(project_id)
                await workflow.execute_activity(
                    create_vault_task_from_plane_issue,
                    args=[data, matter_slug],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=retry,
                )
                result.tasks_created += 1
                return

            if action == "updated":
                # Path resolution for an update event must **never** depend
                # on the current ``name`` — a rename changes the name but
                # not the ``plane_issue_id``. Order of precedence (#594):
                #   1. ``external_id=alfred:<slug>`` on the payload (the
                #      stable origin stamp for Alfred-created issues) —
                #      already folded into ``slug`` above.
                #   2. ``plane_issue_to_slug[plane_id]`` from the
                #      forward-sync map (catches Alfred-originated issues
                #      that forward-sync has seen) — also folded into
                #      ``slug`` above.
                #   3. Vault scan by ``plane_issue_id`` — covers vault
                #      tasks created by reverse-sync that forward-sync
                #      hasn't yet picked up (``external_id=plane:<id>``,
                #      not in forward-sync's ``issue_map``). Without this
                #      fallback a rename on a reverse-sync-minted task
                #      creates a duplicate vault file at a slug derived
                #      from the new ``name``.
                #   4. Only if all three miss, create a new vault task
                #      (Plane can reorder ``created``/``updated`` delivery).
                path: Optional[str] = None
                if slug:
                    path = _task_path_for_slug(slug)
                elif plane_id:
                    existing_path = await workflow.execute_activity(
                        find_vault_task_path_by_plane_id,
                        args=[plane_id],
                        start_to_close_timeout=timedelta(seconds=30),
                        retry_policy=retry,
                    )
                    if existing_path:
                        path = existing_path
                        workflow.logger.info(
                            "plane_reverse_sync: resolved issue.updated via "
                            "vault scan plane_id=%s path=%s "
                            "(stale slug filename ok)",
                            plane_id, path,
                        )

                if not path:
                    # Genuinely new Plane issue — mint a vault task.
                    project_id = str(data.get("project") or data.get("project_id") or "")
                    matter_slug = plane_project_to_slug.get(project_id)
                    await workflow.execute_activity(
                        create_vault_task_from_plane_issue,
                        args=[data, matter_slug],
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=retry,
                    )
                    result.tasks_created += 1
                    return
                patch = plane_issue_to_vault_patch(data)

                # Detect matter reassignment: if the issue has moved to a
                # different Plane project, propagate the new matter slug
                # into the vault task's `related_matters` (and scalar
                # `matter`). If moved to the Inbox project, clear matter
                # linkage. `apply_plane_patch_to_vault`'s per-field diff
                # no-ops when current values already match — safe to
                # include in every patch without oscillating.
                new_project_id = str(
                    data.get("project") or data.get("project_id") or ""
                )
                new_matter_slug = (
                    plane_project_to_slug.get(new_project_id)
                    if new_project_id else None
                )
                if new_matter_slug == INBOX_SLUG_SENTINEL:
                    patch["related_matters"] = []
                    patch["matter"] = ""
                elif new_matter_slug:
                    patch["related_matters"] = [new_matter_slug]
                    patch["matter"] = new_matter_slug

                outcome = await workflow.execute_activity(
                    apply_plane_patch_to_vault,
                    args=["task", path, patch, ""],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )
                if outcome.get("applied"):
                    result.tasks_updated += 1
                return

            if action == "deleted":
                if not slug:
                    result.unknown_events += 1
                    return
                path = _task_path_for_slug(slug)
                outcome = await workflow.execute_activity(
                    archive_vault_record,
                    args=[path, "task"],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )
                if outcome.get("applied"):
                    result.archives += 1
                return

            result.unknown_events += 1
            return

        # ── Issue comment events ────────────────────────────────────────
        if plane_event == "issue_comment" and action == "created":
            # Comment payloads carry ``issue`` → plane issue id. Resolve
            # to a vault task via issue_map; if not found, skip.
            issue_id = str(data.get("issue") or data.get("issue_id") or "")
            slug = plane_issue_to_slug.get(issue_id)
            if not slug:
                result.unknown_events += 1
                return
            path = _task_path_for_slug(slug)
            outcome = await workflow.execute_activity(
                append_plane_comment_to_vault,
                args=[path, data],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry,
            )
            if outcome.get("applied"):
                result.comments_applied += 1
            return

        # Anything else — cycles, modules, members — is not in B7 scope.
        result.unknown_events += 1

    # ---------------------------------------------------------------------
    # B8 — Alfred-as-a-Plane-user trigger dispatch.
    # Runs BEFORE the vault patch so a session spawn still fires when
    # the event would be a vault no-op (e.g. a comment on an already-
    # mirrored task, or an assignment update that doesn't change
    # non-assignee fields). Spawn is fire-and-forget; the workflow
    # advances its cursor as soon as the spawn call returns.
    # ---------------------------------------------------------------------

    async def _maybe_spawn_alfred(
        self,
        *,
        event: dict[str, Any],
        result: PlaneReverseSyncResult,
        retry: RetryPolicy,
    ) -> None:
        """Detect + spawn for a single stream event.

        Never raises — any spawn failure is recorded on the result and
        the reverse-sync loop continues. The cursor advances on the
        outer dispatch loop regardless, so a broken Alfred-session
        spawn never blocks the sync.
        """
        raw = event.get("raw") or {}
        if not isinstance(raw, dict):
            return

        try:
            trigger = await workflow.execute_activity(
                detect_alfred_plane_trigger,
                args=[raw],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning(
                "plane_reverse_sync._maybe_spawn_alfred: detect failed: %s", exc
            )
            return

        if not trigger:
            return

        result.alfred_triggers_seen += 1
        trigger_type = str(trigger.get("trigger_type") or "")

        if trigger_type == "approval":
            try:
                outcome = await workflow.execute_activity(
                    resolve_plane_approval,
                    args=[
                        str(trigger.get("issue_id") or ""),
                        str(trigger.get("comment_body") or ""),
                        str(trigger.get("author_id") or ""),
                    ],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=retry,
                )
                if outcome.get("approved"):
                    result.alfred_approvals_resolved += 1
                    workflow.logger.info(
                        "plane_reverse_sync: approval resolved issue=%s "
                        "session=%s",
                        trigger.get("issue_id"),
                        outcome.get("session_id"),
                    )
            except Exception as exc:  # noqa: BLE001
                workflow.logger.warning(
                    "plane_reverse_sync: approval resolve failed: %s", exc
                )
            return

        if trigger_type not in {"mention", "assignment"}:
            return

        try:
            spawn_outcome = await workflow.execute_activity(
                spawn_alfred_for_plane_trigger,
                args=[trigger],
                # Spawn POST plus best-effort Plane context fetch should
                # finish well under a minute; cap firmly so a stalled
                # gateway can't starve the sync loop.
                start_to_close_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
        except Exception as exc:  # noqa: BLE001
            result.alfred_spawns_failed += 1
            workflow.logger.warning(
                "plane_reverse_sync: spawn activity failed: %s", exc
            )
            return

        if spawn_outcome and spawn_outcome.get("spawned"):
            result.alfred_sessions_spawned += 1
            sk = str(spawn_outcome.get("session_key") or "")
            if sk:
                result.alfred_spawn_session_keys.append(sk)
            workflow.logger.info(
                "plane_reverse_sync: alfred session spawned type=%s "
                "issue=%s session=%s requires_approval=%s",
                trigger_type,
                trigger.get("issue_id"),
                sk[:12] if sk else "",
                bool(trigger.get("requires_approval")),
            )
        else:
            result.alfred_spawns_failed += 1
            err = ""
            if isinstance(spawn_outcome, dict):
                err = str(spawn_outcome.get("error") or "")
            workflow.logger.warning(
                "plane_reverse_sync: alfred session NOT spawned type=%s "
                "issue=%s error=%s",
                trigger_type, trigger.get("issue_id"), err,
            )
