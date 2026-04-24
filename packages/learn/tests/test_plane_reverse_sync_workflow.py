"""Tests for PlaneReverseSyncWorkflow (#536 B7).

Same stubbing strategy as ``test_plane_sync_workflow.py``: register
replacement activities under the same name via
``activity.defn(name=...)`` so the workflow executes end-to-end inside
``WorkflowEnvironment.start_time_skipping`` but never touches the
network or the filesystem.

Covered:

* **Loop guard #1** (origin stamp + hash) — Plane echo of an outbound
  PUT with matching ``external_id=alfred:<slug>`` and matching hash is
  skipped, no vault write.
* **Loop guard #2** (suppression window) — inbound event within 30s of
  the outbound signature (same hash, no external_id) is skipped.
* **Loop guard #3** (field hash compare) — inbound patch that wouldn't
  change the record's loop-guard fields does NOT write the file.
* Positive: human-created issue → new vault task.
* Positive: issue state changed by human → vault task status updated.
* Archived project → matter archived frontmatter flag set, body preserved.
* Cursor advances correctly across runs.
* **Infinite-loop regression test** — simulates Plane webhook-back on
  every outbound PUT. Must settle within ≤2 bounces per user edit.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Optional

from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.activities.plane_reverse_sync import (
    _parse_alfred_external_id,
    _load_reverse_cursor,
    _SUPPRESSION_WINDOW_MS,
)
from src.utils.plane_mapping import (
    compute_loop_guard_hash,
    plane_issue_to_vault_patch,
    plane_project_to_matter_patch,
    vault_task_to_plane_update,
)
from src.workflows.plane_reverse_sync import (
    PlaneReverseSyncResult,
    PlaneReverseSyncWorkflow,
    _alfred_external_slug,
)


# ---------------------------------------------------------------------------
# Pure-function coverage for the workflow helpers
# ---------------------------------------------------------------------------

class TestAlfredExternalSlug:
    def test_none(self):
        assert _alfred_external_slug(None) is None

    def test_non_string(self):
        assert _alfred_external_slug(42) is None

    def test_unprefixed(self):
        assert _alfred_external_slug("plane:abc") is None

    def test_empty_after_prefix(self):
        assert _alfred_external_slug("alfred:") is None

    def test_valid(self):
        assert _alfred_external_slug("alfred:client-x") == "client-x"


class TestParseAlfredExternalId:
    def test_equivalent_to_workflow_helper(self):
        """Keep both helpers in lockstep so workflow + activity agree."""
        for v, expected in [
            (None, None),
            (42, None),
            ("", None),
            ("plane:abc", None),
            ("alfred:", None),
            ("alfred:foo", "foo"),
        ]:
            assert _parse_alfred_external_id(v) == expected
            assert _alfred_external_slug(v) == expected


class TestLoadReverseCursor:
    def test_missing_file(self, tmp_path):
        cursor = _load_reverse_cursor(tmp_path / "nope.json")
        assert cursor == {"last_event_id": "", "last_event_ts": 0.0}

    def test_valid_cursor(self, tmp_path):
        p = tmp_path / "c.json"
        p.write_text('{"last_event_id": "evt-1", "last_event_ts": 123.4}')
        cursor = _load_reverse_cursor(p)
        assert cursor == {"last_event_id": "evt-1", "last_event_ts": 123.4}

    def test_corrupt_returns_default(self, tmp_path):
        p = tmp_path / "c.json"
        p.write_text("not json")
        cursor = _load_reverse_cursor(p)
        assert cursor == {"last_event_id": "", "last_event_ts": 0.0}


# ---------------------------------------------------------------------------
# Stub factory for workflow execution
# ---------------------------------------------------------------------------

_CALL_LOG: list[tuple[str, Any]] = []


def _reset_call_log() -> None:
    _CALL_LOG.clear()


def _make_stubs(
    *,
    events: list[dict[str, Any]],
    project_map: Optional[dict[str, str]] = None,
    issue_map: Optional[dict[str, str]] = None,
    outbound_sigs: Optional[dict[str, dict[str, Any]]] = None,
    cursor: Optional[dict[str, Any]] = None,
    existing_frontmatter: Optional[dict[str, dict[str, Any]]] = None,
    plane_id_to_vault_path: Optional[dict[str, str]] = None,
    enabled: bool = True,
    raise_on_apply_path: Optional[str] = None,
    fixed_now_ms: Optional[int] = None,
) -> tuple[list, dict[str, Any]]:
    """Build the full set of stub activities for one workflow run.

    ``existing_frontmatter`` maps vault path → frontmatter dict so the
    guard #3 path-hash comparison has something to work with. Defaults
    to empty (records look missing to the workflow), which is the
    realistic state when a human just created an issue in Plane.

    ``plane_id_to_vault_path`` seeds the ``find_vault_task_path_by_plane_id``
    stub activity. This simulates the vault scan fallback that the
    workflow uses when the in-memory forward-sync map misses a
    ``plane_issue_id`` (the reverse-sync-created task rename case
    that #594 fixes). Any plane_id not in the map returns ``None``
    from the stub, matching the production "no task with this
    plane_issue_id" outcome.
    """
    project_map = project_map or {}
    issue_map = issue_map or {}
    outbound_sigs = outbound_sigs or {}
    cursor = cursor or {"last_event_id": "", "last_event_ts": 0.0}
    existing_frontmatter = existing_frontmatter or {}
    plane_id_to_vault_path = plane_id_to_vault_path or {}

    # Internal state so tests can assert on it after the run
    state: dict[str, Any] = {
        "cursor_writes": [],
        "patches_applied": [],
        "tasks_created": [],
        "comments_applied": [],
        "archives": [],
        "events_marked_processed": [],
        # Mutable snapshot of frontmatter so apply_plane_patch_to_vault
        # observes the effect of its own writes within a single run.
        "frontmatter": dict(existing_frontmatter),
    }

    @activity.defn(name="plane_reverse_sync_is_enabled")
    async def stub_enabled() -> bool:
        _CALL_LOG.append(("enabled", None))
        return enabled

    @activity.defn(name="load_reverse_sync_state")
    async def stub_load_state() -> dict[str, Any]:
        _CALL_LOG.append(("load_state", None))
        return {
            "cursor": dict(cursor),
            "project_map": dict(project_map),
            "issue_map": dict(issue_map),
            "outbound_signatures": dict(outbound_sigs),
        }

    @activity.defn(name="save_reverse_sync_cursor")
    async def stub_save_cursor(c: dict[str, Any]) -> None:
        _CALL_LOG.append(("save_cursor", dict(c)))
        state["cursor_writes"].append(dict(c))

    @activity.defn(name="fetch_plane_events")
    async def stub_fetch(since_id: str) -> list[dict[str, Any]]:
        _CALL_LOG.append(("fetch", since_id))
        out: list[dict[str, Any]] = []
        seen_cursor = not since_id
        for ev in events:
            if seen_cursor:
                out.append(ev)
            else:
                if ev.get("id") == since_id:
                    seen_cursor = True
        return out

    @activity.defn(name="check_loop_guards")
    async def stub_guards(
        plane_id: str,
        external_id: Optional[str],
        payload: dict[str, Any],
        sigs: dict[str, dict[str, Any]],
        now_ms: Optional[int] = None,
    ) -> dict[str, Any]:
        _CALL_LOG.append(("guards", (plane_id, external_id)))
        # Re-implement the guard logic inline so the test validates the
        # observable behaviour without depending on activity internals
        # (temporalio wraps @activity.defn in a way that doesn't expose
        # __wrapped__). Mirror src.activities.plane_reverse_sync:check_loop_guards.
        now = fixed_now_ms if fixed_now_ms is not None else (
            now_ms if now_ms is not None else int(time.time() * 1000)
        )
        inbound_hash = compute_loop_guard_hash(payload or {})

        slug = _parse_alfred_external_id(external_id)
        sig = sigs.get(str(plane_id)) if plane_id else None

        if slug and sig and str(sig.get("hash")) == inbound_hash:
            return {
                "skip": True,
                "reason": "guard1_origin_stamp_hash_match",
                "hash": inbound_hash,
            }
        if sig and str(sig.get("hash")) == inbound_hash:
            ts = int(sig.get("ts") or 0)
            if now - ts <= _SUPPRESSION_WINDOW_MS:
                return {
                    "skip": True,
                    "reason": "guard2_suppression_window",
                    "hash": inbound_hash,
                }
        return {"skip": False, "reason": "", "hash": inbound_hash}

    @activity.defn(name="apply_plane_patch_to_vault")
    async def stub_apply(
        record_type: str,
        path: str,
        patch: dict[str, Any],
        inbound_hash: str,
    ) -> dict[str, Any]:
        _CALL_LOG.append(("apply", (record_type, path, dict(patch))))
        if raise_on_apply_path == path:
            raise RuntimeError(f"simulated vault failure for {path}")

        current = state["frontmatter"].get(path)
        if current is None:
            return {"applied": False, "action": "missing", "reason": "record_not_found"}

        # Emulate guard #3: if all patched fields are already the current
        # values, don't write.
        has_diff = any(current.get(k) != v for k, v in patch.items())
        if not has_diff:
            return {"applied": False, "action": "noop_no_diff", "reason": "no_field_changed"}

        merged = dict(current)
        merged.update(patch)
        state["frontmatter"][path] = merged
        state["patches_applied"].append({"path": path, "patch": dict(patch)})
        return {"applied": True, "action": "patched", "reason": "",
                "changed_fields": sorted(patch.keys())}

    @activity.defn(name="find_vault_task_path_by_plane_id")
    async def stub_find_by_plane_id(plane_issue_id: str) -> Optional[str]:
        _CALL_LOG.append(("find_by_plane_id", plane_issue_id))
        return plane_id_to_vault_path.get(str(plane_issue_id)) or None

    @activity.defn(name="create_vault_task_from_plane_issue")
    async def stub_create(
        issue: dict[str, Any],
        matter_slug: Optional[str],
    ) -> dict[str, Any]:
        _CALL_LOG.append(("create_task", (issue.get("id"), matter_slug)))
        slug = f"from-{issue.get('id')}"
        path = f"task/{slug}.md"
        state["tasks_created"].append({
            "path": path, "slug": slug, "plane_issue_id": issue.get("id"),
            "matter_slug": matter_slug,
        })
        # Seed frontmatter so subsequent updates in the same run see it
        patch = plane_issue_to_vault_patch(issue)
        state["frontmatter"][path] = {
            "type": "task",
            "plane_issue_id": str(issue.get("id") or ""),
            "external_id": f"plane:{issue.get('id')}",
            **patch,
        }
        return {"path": path, "slug": slug,
                "plane_issue_id": issue.get("id")}

    @activity.defn(name="append_plane_comment_to_vault")
    async def stub_append_comment(
        path: str,
        comment: dict[str, Any],
    ) -> dict[str, Any]:
        _CALL_LOG.append(("comment", (path, comment.get("id"))))
        state["comments_applied"].append({"path": path, "comment": dict(comment)})
        return {"applied": True, "count": 1}

    @activity.defn(name="archive_vault_record")
    async def stub_archive(path: str, record_type: str) -> dict[str, Any]:
        _CALL_LOG.append(("archive", (path, record_type)))
        state["archives"].append({"path": path, "type": record_type})
        current = state["frontmatter"].get(path, {})
        state["frontmatter"][path] = {**current, "archived": True}
        return {"applied": True}

    @activity.defn(name="mark_plane_event_processed")
    async def stub_mark(event_id: str, vault_path: str, classification: str) -> None:
        _CALL_LOG.append(("mark_processed", (event_id, vault_path, classification)))
        state["events_marked_processed"].append(event_id)

    stubs = [
        stub_enabled,
        stub_load_state,
        stub_save_cursor,
        stub_fetch,
        stub_guards,
        stub_apply,
        stub_create,
        stub_find_by_plane_id,
        stub_append_comment,
        stub_archive,
        stub_mark,
    ]
    return stubs, state


async def _run_workflow(stubs: list) -> PlaneReverseSyncResult:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"plane-reverse-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[PlaneReverseSyncWorkflow],
            activities=stubs,
        )
        async with worker:
            result = await client.execute_workflow(
                PlaneReverseSyncWorkflow.run,
                id=f"plane-reverse-run-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


# ---------------------------------------------------------------------------
# Helpers to build Plane stream events
# ---------------------------------------------------------------------------

def _stream_event(
    plane_event: str,
    action: str,
    data: dict[str, Any],
    *,
    event_id: Optional[str] = None,
) -> dict[str, Any]:
    """Shape a ``stream_type: "plane"`` stream event the way ctrl-api emits it."""
    return {
        "id": event_id or f"evt-{uuid.uuid4()}",
        "stream_id": "plane",
        "stream_type": "plane",
        "received_at": "2026-04-23T12:00:00Z",
        "source_ref": f"plane:{plane_event}:{data.get('id', 'x')}:delivery-xyz",
        "summary": f"Plane {plane_event} {action}",
        "raw": {
            "event": plane_event,
            "action": action,
            "data": data,
        },
    }


def _issue_payload(
    issue_id: str,
    *,
    name: str = "Prepare brief",
    state_group: str = "unstarted",
    priority: str = "medium",
    external_id: Optional[str] = None,
    project_id: str = "proj-1",
    labels: Optional[list[str]] = None,
) -> dict[str, Any]:
    labels = labels or []
    body: dict[str, Any] = {
        "id": issue_id,
        "name": name,
        "state_detail": {"group": state_group},
        "priority": priority,
        "labels": [{"name": lb} for lb in labels],
        "project": project_id,
    }
    if external_id is not None:
        body["external_id"] = external_id
    return body


def _project_payload(
    project_id: str,
    *,
    name: str = "Client X",
    is_archived: bool = False,
    external_id: Optional[str] = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": project_id,
        "name": name,
        "description_text": "",
        "is_archived": is_archived,
    }
    if external_id is not None:
        body["external_id"] = external_id
    return body


# ---------------------------------------------------------------------------
# Feature flag
# ---------------------------------------------------------------------------

class TestFeatureFlag:
    def test_disabled_short_circuits(self):
        _reset_call_log()
        stubs, _ = _make_stubs(events=[], enabled=False)
        result = asyncio.run(_run_workflow(stubs))
        assert result.started is False
        assert "PLANE_SYNC_ENABLED" in result.skipped_reason
        assert [c[0] for c in _CALL_LOG] == ["enabled"]


# ---------------------------------------------------------------------------
# Loop guard #1 — origin stamp + hash match
# ---------------------------------------------------------------------------

class TestLoopGuard1OriginStamp:
    def test_echo_of_our_outbound_put_is_skipped(self):
        """Simulate: we just PUT an issue with external_id=alfred:client-x-task.
        Plane fires webhook with the same external_id and the same body.
        Guard #1 must drop it so no vault write happens."""
        _reset_call_log()
        issue_id = "plane-iss-1"
        outbound_payload = {
            "name": "My task",
            "state": "started",     # outbound uses 'state' key
            "priority": "medium",
        }
        outbound_hash = compute_loop_guard_hash(outbound_payload)
        # Plane echoes via state_detail.group — hash must still match.
        echo = _issue_payload(
            issue_id,
            name="My task",
            state_group="started",
            priority="medium",
            external_id="alfred:client-x-task",
        )
        ev = _stream_event("issue", "updated", echo)

        stubs, state = _make_stubs(
            events=[ev],
            issue_map={"client-x-task": issue_id},
            outbound_sigs={issue_id: {"hash": outbound_hash, "ts": int(time.time() * 1000)}},
            existing_frontmatter={"task/client-x-task.md": {
                "name": "My task", "status": "active", "priority": "medium",
            }},
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.events_skipped_loop_guard == 1
        assert result.tasks_updated == 0
        assert state["patches_applied"] == []

    def test_echo_with_different_hash_is_not_skipped(self):
        """If the hash doesn't match (a human edited it in Plane after our PUT),
        we must apply the patch, not skip it."""
        _reset_call_log()
        issue_id = "plane-iss-2"
        # We recorded a hash for 'medium' priority, but Plane now reports 'urgent'.
        outbound_payload = {
            "name": "Task", "state": "started", "priority": "medium",
        }
        outbound_hash = compute_loop_guard_hash(outbound_payload)

        echo = _issue_payload(
            issue_id,
            name="Task",
            state_group="started",
            priority="urgent",
            external_id="alfred:my-task",
        )
        ev = _stream_event("issue", "updated", echo)

        stubs, state = _make_stubs(
            events=[ev],
            issue_map={"my-task": issue_id},
            outbound_sigs={issue_id: {"hash": outbound_hash, "ts": int(time.time() * 1000)}},
            existing_frontmatter={"task/my-task.md": {
                "name": "Task", "status": "active", "priority": "medium",
            }},
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.events_skipped_loop_guard == 0
        assert result.tasks_updated == 1


# ---------------------------------------------------------------------------
# Loop guard #2 — suppression window
# ---------------------------------------------------------------------------

class TestLoopGuard2SuppressionWindow:
    def test_recent_outbound_sig_same_hash_skipped(self):
        """Webhook arrives 1s after outbound PUT. Hash matches. Skip."""
        _reset_call_log()
        issue_id = "plane-iss-a"
        # No external_id on the inbound — this is the race where Plane
        # sent the webhook before we managed to persist our signature.
        echo = _issue_payload(
            issue_id,
            name="Silent echo",
            state_group="started",
            priority="low",
            external_id=None,
        )
        ev = _stream_event("issue", "updated", echo)

        # Build hash off the same payload so they match.
        inbound_hash = compute_loop_guard_hash(echo)
        sig_ts = int(time.time() * 1000) - 1000  # 1 second ago

        stubs, _ = _make_stubs(
            events=[ev],
            issue_map={"silent-echo": issue_id},
            outbound_sigs={issue_id: {"hash": inbound_hash, "ts": sig_ts}},
            existing_frontmatter={"task/silent-echo.md": {
                "name": "Silent echo", "status": "active", "priority": "low",
            }},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.events_skipped_loop_guard == 1

    def test_stale_outbound_sig_does_not_skip(self):
        """Outbound sig is 60s old — outside the 30s window.
        Even with matching hash we must let the event through so a
        genuine later Plane write isn't silently dropped."""
        _reset_call_log()
        issue_id = "plane-iss-b"
        echo = _issue_payload(
            issue_id,
            name="Old echo",
            state_group="started",
            priority="low",
            external_id=None,
        )
        ev = _stream_event("issue", "updated", echo)
        inbound_hash = compute_loop_guard_hash(echo)
        stale_ts = int(time.time() * 1000) - 60_000  # 60s ago

        stubs, _ = _make_stubs(
            events=[ev],
            issue_map={"old-echo": issue_id},
            outbound_sigs={issue_id: {"hash": inbound_hash, "ts": stale_ts}},
            # Force guard #3 to trigger a write by making current state differ.
            existing_frontmatter={"task/old-echo.md": {
                "name": "Old echo", "status": "todo", "priority": "low",
            }},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.events_skipped_loop_guard == 0
        assert result.tasks_updated == 1


# ---------------------------------------------------------------------------
# Loop guard #3 — field-level hash idempotency
# ---------------------------------------------------------------------------

class TestLoopGuard3FieldHash:
    def test_noop_patch_does_not_write(self):
        """Inbound update arrives with fields that already match current
        frontmatter. Guard #3 must stop the write."""
        _reset_call_log()
        issue_id = "plane-iss-c"
        echo = _issue_payload(
            issue_id,
            name="Unchanged",
            state_group="unstarted",
            priority="medium",
            # external_id fresh slug that doesn't match anything in
            # outbound_sigs — so guards 1 + 2 do NOT fire.
            external_id="alfred:unchanged",
        )
        ev = _stream_event("issue", "updated", echo)

        stubs, state = _make_stubs(
            events=[ev],
            issue_map={"unchanged": issue_id},
            outbound_sigs={},  # no outbound sig
            existing_frontmatter={
                "task/unchanged.md": {
                    "name": "Unchanged",
                    "status": "todo",      # == unstarted round-trip
                    "priority": "medium",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.tasks_updated == 0
        assert state["patches_applied"] == []
        # The workflow did process the event, it just wrote nothing.
        assert result.events_skipped_loop_guard == 0

    def test_actual_change_writes(self):
        """Sanity check: a true change does flow through guard #3 to a write."""
        _reset_call_log()
        issue_id = "plane-iss-d"
        echo = _issue_payload(
            issue_id, name="Changed", state_group="started", priority="urgent",
            external_id="alfred:changed",
        )
        ev = _stream_event("issue", "updated", echo)

        stubs, state = _make_stubs(
            events=[ev],
            issue_map={"changed": issue_id},
            existing_frontmatter={
                "task/changed.md": {
                    "name": "Changed", "status": "todo", "priority": "medium",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.tasks_updated == 1
        assert len(state["patches_applied"]) == 1


# ---------------------------------------------------------------------------
# Positive paths — human edits from Plane
# ---------------------------------------------------------------------------

class TestHumanCreatedIssue:
    def test_no_external_id_creates_vault_task(self):
        _reset_call_log()
        plane_issue = _issue_payload(
            "plane-new-1", name="Manually filed bug",
            state_group="unstarted", priority="high",
            external_id=None, project_id="proj-x",
        )
        ev = _stream_event("issue", "created", plane_issue)

        stubs, state = _make_stubs(
            events=[ev],
            # Forward-sync has already synced the matter earlier, so
            # project_map has the plane_id → vault slug mapping
            project_map={"client-x": "proj-x"},
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.tasks_created == 1
        created = state["tasks_created"][0]
        assert created["plane_issue_id"] == "plane-new-1"
        assert created["matter_slug"] == "client-x"


class TestHumanUpdatedIssue:
    def test_state_change_applies_patch(self):
        _reset_call_log()
        issue_id = "plane-iss-upd"
        # State moved started → completed in Plane
        updated = _issue_payload(
            issue_id, name="Done now",
            state_group="completed", priority="low",
            external_id="alfred:done-task",
        )
        ev = _stream_event("issue", "updated", updated)

        stubs, state = _make_stubs(
            events=[ev],
            issue_map={"done-task": issue_id},
            existing_frontmatter={
                "task/done-task.md": {
                    "name": "Done now", "status": "active", "priority": "low",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.tasks_updated == 1
        applied = state["patches_applied"][0]
        assert applied["path"] == "task/done-task.md"
        assert applied["patch"]["status"] == "done"


class TestIssueRenameNoDuplicate:
    """Regression tests for #594: ``issue.updated`` that changes ``name``
    must land on the existing vault task (found by ``plane_issue_id``),
    not spawn a new file at ``task/<sanitised-new-name>.md``.

    The bug scenario:
      1. Human creates a Plane issue "Foo" → reverse-sync mints
         ``task/foo.md`` with ``external_id: plane:<id>`` (NOT
         ``alfred:<slug>``) and a ``plane_issue_id`` frontmatter field.
      2. Forward-sync hasn't yet synced this task back, so
         ``issue_map`` does not contain ``foo → <id>`` yet.
      3. Human renames the Plane issue to "Bar" → webhook fires
         ``issue.updated``. Old code: no ``alfred:`` external_id, no
         entry in ``plane_issue_to_slug`` → fall through to
         ``create_vault_task_from_plane_issue`` which derives a NEW
         slug from "bar" → ``task/bar-*.md`` created, leaving
         ``task/foo.md`` stale. Permanent duplication.
      4. New code: workflow calls ``find_vault_task_path_by_plane_id``
         as a third resolution step, finds ``task/foo.md``, applies
         the name patch in place. Filename is left alone — the slug
         filename is just a stable id, the ``name`` frontmatter is
         the source of truth for display.
    """

    def test_rename_updates_existing_task_no_new_file(self):
        _reset_call_log()
        issue_id = "plane-reverse-created-1"
        # Vault task was minted by reverse-sync, so external_id is
        # plane:<id> (NOT alfred:<slug>) and forward-sync hasn't seen
        # it yet.
        renamed = _issue_payload(
            issue_id,
            name="Bar — renamed issue",
            state_group="unstarted",
            priority="medium",
            external_id=f"plane:{issue_id}",  # non-alfred stamp from reverse-sync
        )
        ev = _stream_event("issue", "updated", renamed)

        stubs, state = _make_stubs(
            events=[ev],
            # issue_map is EMPTY — this is the bug-triggering precondition.
            issue_map={},
            # But the vault scan will find the task by plane_issue_id.
            plane_id_to_vault_path={issue_id: "task/foo-original-slug.md"},
            existing_frontmatter={
                "task/foo-original-slug.md": {
                    "name": "Foo — original name",
                    "status": "todo",
                    "priority": "medium",
                    "plane_issue_id": issue_id,
                    "external_id": f"plane:{issue_id}",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))

        # No new task file — we updated in place.
        assert result.tasks_created == 0, (
            "rename spawned a new vault task — #594 regression"
        )
        assert state["tasks_created"] == []
        # The existing task's name was patched.
        assert result.tasks_updated == 1
        assert len(state["patches_applied"]) == 1
        applied = state["patches_applied"][0]
        # Filename stays at the original (stale) slug — that's by
        # design; the name frontmatter is the display source of truth.
        assert applied["path"] == "task/foo-original-slug.md"
        assert applied["patch"]["name"] == "Bar — renamed issue"
        # And the vault lookup activity was indeed consulted.
        assert any(
            call[0] == "find_by_plane_id" and call[1] == issue_id
            for call in _CALL_LOG
        ), "vault scan activity was never invoked"

    def test_rename_on_truly_new_issue_still_creates(self):
        """Baseline: ``issue.updated`` for a plane_id that has neither a
        forward-sync map entry NOR a vault task with matching
        ``plane_issue_id`` must still mint a new vault task (Plane
        sometimes reorders event delivery so an updated event can land
        before the paired created event).
        """
        _reset_call_log()
        issue_id = "plane-genuinely-new-1"
        updated = _issue_payload(
            issue_id,
            name="Filed directly in Plane",
            state_group="unstarted",
            priority="low",
            external_id=None,
            project_id="proj-new",
        )
        ev = _stream_event("issue", "updated", updated)

        stubs, state = _make_stubs(
            events=[ev],
            issue_map={},                # not in forward-sync map
            plane_id_to_vault_path={},   # vault scan also misses
            project_map={"client-new": "proj-new"},
        )
        result = asyncio.run(_run_workflow(stubs))

        # Genuinely new → mint it.
        assert result.tasks_created == 1
        assert result.tasks_updated == 0
        assert len(state["tasks_created"]) == 1
        assert state["tasks_created"][0]["plane_issue_id"] == issue_id
        # Vault scan was consulted before giving up and creating.
        assert any(
            call[0] == "find_by_plane_id" and call[1] == issue_id
            for call in _CALL_LOG
        ), "vault scan activity was skipped — we'd create duplicates on any race"

    def test_rename_with_alfred_external_id_bypasses_scan(self):
        """Issues that ARE Alfred-originated (``external_id=alfred:<slug>``)
        resolve via the existing fast path and must NOT trigger the
        vault scan — keeps the hot path cheap.
        """
        _reset_call_log()
        issue_id = "plane-alfred-originated"
        renamed = _issue_payload(
            issue_id,
            name="Renamed but Alfred-originated",
            state_group="started",
            priority="medium",
            external_id="alfred:alfred-task",  # fast-path slug
        )
        ev = _stream_event("issue", "updated", renamed)

        stubs, state = _make_stubs(
            events=[ev],
            issue_map={"alfred-task": issue_id},
            plane_id_to_vault_path={},  # scan would miss if called
            existing_frontmatter={
                "task/alfred-task.md": {
                    "name": "Original name",
                    "status": "active",
                    "priority": "medium",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.tasks_updated == 1
        assert result.tasks_created == 0
        # Crucially, the vault scan was NOT invoked — fast path held.
        assert not any(
            call[0] == "find_by_plane_id" for call in _CALL_LOG
        ), "vault scan fired on the fast path — wasted activity round-trip"


class TestIssueDeleted:
    def test_delete_archives_task(self):
        _reset_call_log()
        issue_id = "plane-iss-del"
        deleted = _issue_payload(
            issue_id, name="Gone", state_group="cancelled",
            external_id="alfred:gone-task",
        )
        ev = _stream_event("issue", "deleted", deleted)

        stubs, state = _make_stubs(
            events=[ev],
            issue_map={"gone-task": issue_id},
            existing_frontmatter={"task/gone-task.md": {
                "name": "Gone", "status": "active",
            }},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.archives == 1
        assert state["archives"] == [{"path": "task/gone-task.md", "type": "task"}]


# ---------------------------------------------------------------------------
# Project events
# ---------------------------------------------------------------------------

class TestProjectArchived:
    def test_archive_flag_via_update_sets_matter_status(self):
        """When Plane reports a project with is_archived=True via update,
        guard #3 compares current vs archived state. Body preserved."""
        _reset_call_log()
        proj_id = "proj-archived"
        archived_project = _project_payload(
            proj_id, name="Sunset engagement", is_archived=True,
            external_id="alfred:sunset",
        )
        ev = _stream_event("project", "updated", archived_project)

        stubs, state = _make_stubs(
            events=[ev],
            project_map={"sunset": proj_id},
            existing_frontmatter={"matter/sunset.md": {
                "name": "Sunset engagement",
                "status": "active",
                "description": "Was an active engagement",
            }},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.matters_updated == 1
        applied = state["patches_applied"][0]
        assert applied["path"] == "matter/sunset.md"
        assert applied["patch"]["status"] == "archived"

    def test_delete_event_archives_matter(self):
        _reset_call_log()
        proj_id = "proj-del"
        ev = _stream_event("project", "deleted", {
            "id": proj_id, "name": "Gone", "external_id": "alfred:gone-proj",
        })
        stubs, state = _make_stubs(
            events=[ev],
            project_map={"gone-proj": proj_id},
            existing_frontmatter={"matter/gone-proj.md": {
                "name": "Gone", "status": "active",
            }},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.archives == 1
        assert state["archives"] == [{"path": "matter/gone-proj.md", "type": "matter"}]


# ---------------------------------------------------------------------------
# Cursor advancement
# ---------------------------------------------------------------------------

class TestCursorAdvancement:
    def test_cursor_saved_after_successful_run(self):
        _reset_call_log()
        events = [
            _stream_event(
                "issue", "updated",
                _issue_payload("p1", name="A", state_group="started",
                               external_id="alfred:a"),
                event_id="evt-1",
            ),
            _stream_event(
                "issue", "updated",
                _issue_payload("p2", name="B", state_group="started",
                               external_id="alfred:b"),
                event_id="evt-2",
            ),
        ]
        stubs, state = _make_stubs(
            events=events,
            issue_map={"a": "p1", "b": "p2"},
            existing_frontmatter={
                "task/a.md": {"name": "A", "status": "todo"},
                "task/b.md": {"name": "B", "status": "todo"},
            },
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.tasks_updated == 2
        assert result.last_event_id == "evt-2"
        # Cursor persisted exactly once, with the newest id
        cursor_writes = state["cursor_writes"]
        assert len(cursor_writes) == 1
        assert cursor_writes[0]["last_event_id"] == "evt-2"

    def test_no_events_no_cursor_write(self):
        _reset_call_log()
        stubs, state = _make_stubs(events=[])
        result = asyncio.run(_run_workflow(stubs))
        assert result.last_event_id == ""
        assert state["cursor_writes"] == []


# ---------------------------------------------------------------------------
# Infinite-loop regression — THE critical test
# ---------------------------------------------------------------------------

class TestInfiniteLoopSettles:
    """Simulate: user edits vault → forward-sync PUTs → Plane fires
    webhook → reverse-sync receives it → guards should stop it cold.

    The canonical flow we're testing:

      1. User edits frontmatter in vault → forward-sync pushes it to
         Plane and records the outbound signature (hash of what we sent).
      2. Plane accepts and immediately fires an ``issue_updated`` webhook
         back. The webhook's payload has matching external_id
         (``alfred:<slug>``) and matching loop-guard hash.
      3. Reverse-sync picks up the stream event. Guard #1 or #2 or #3
         (in order) must catch it and skip the vault write.
      4. No vault write → no mtime bump → forward-sync's next run finds
         nothing to push. Loop settles.

    Pass criterion: **exactly one reverse-sync tick, zero vault writes,
    zero task creates.** If any of these cross 2 we've regressed.
    """

    def test_single_echo_does_not_bounce(self):
        _reset_call_log()
        slug = "bounce-task"
        plane_id = "plane-bounce-1"

        # What forward-sync would have sent as the outbound update body
        outbound_body = vault_task_to_plane_update({
            "name": "Echo", "status": "active", "priority": "high",
        })
        outbound_hash = compute_loop_guard_hash(outbound_body)

        # What Plane echoes back (state_detail.group form)
        echo = _issue_payload(
            plane_id, name="Echo", state_group="started", priority="high",
            external_id=f"alfred:{slug}",
        )
        echo_hash = compute_loop_guard_hash(echo)
        # Forward/reverse MUST agree byte-for-byte or guards fail.
        assert outbound_hash == echo_hash, (
            "forward and reverse hashes disagree — loop guards will no-op"
        )

        ev = _stream_event("issue", "updated", echo, event_id="echo-1")

        stubs, state = _make_stubs(
            events=[ev],
            issue_map={slug: plane_id},
            # Outbound signature recorded 500ms ago — well within the 30s window
            outbound_sigs={plane_id: {"hash": outbound_hash,
                                      "ts": int(time.time() * 1000) - 500}},
            # Current frontmatter reflects what we just wrote to Plane, so
            # guard #3 would also skip even if guards 1/2 missed.
            existing_frontmatter={f"task/{slug}.md": {
                "name": "Echo", "status": "active", "priority": "high",
            }},
        )
        result = asyncio.run(_run_workflow(stubs))

        # THE invariant: one echo event, one skip, zero bounces.
        assert result.events_seen == 1
        assert result.events_skipped_loop_guard == 1
        assert result.tasks_updated == 0
        assert result.tasks_created == 0
        assert state["patches_applied"] == [], (
            "echo triggered a vault write — loop is not settled"
        )

    def test_amplifier_test_stays_at_2_bounces_max(self):
        """Simulate TWO rounds: one real user edit + its echo.

        Round 1: reverse-sync processes the user's edit from Plane →
                 applies the patch → vault file is updated.
        Round 2: Plane echoes the next forward-sync round-trip →
                 reverse-sync must recognise it as our own echo →
                 NO further vault write.

        If round 2 results in a write, we'd loop forever. So the
        counter of total vault writes across both rounds must be ≤1.
        """
        _reset_call_log()
        slug = "amp"
        plane_id = "plane-amp"

        # ── Round 1: human edits priority in Plane → reverse-sync writes it
        round1 = _stream_event(
            "issue", "updated",
            _issue_payload(plane_id, name="Amp", state_group="started",
                           priority="urgent", external_id=f"alfred:{slug}"),
            event_id="round1",
        )

        stubs1, state1 = _make_stubs(
            events=[round1],
            issue_map={slug: plane_id},
            outbound_sigs={},  # no prior outbound sig — this is a real edit
            existing_frontmatter={f"task/{slug}.md": {
                "name": "Amp", "status": "active", "priority": "medium",
            }},
        )
        r1 = asyncio.run(_run_workflow(stubs1))
        round1_writes = len(state1["patches_applied"])

        # ── Round 2: the reverse-sync write would cause forward-sync to
        #    push it back to Plane, which echoes a webhook. Simulate that
        #    by building the echo exactly as forward-sync would + recording
        #    the outbound signature the way plane_sync.py does.
        outbound = vault_task_to_plane_update({
            "name": "Amp", "status": "active", "priority": "urgent",
        })
        outbound_hash = compute_loop_guard_hash({
            "name": "Amp", "description": "",
            "priority": "urgent",
            "state": outbound["state_group"],
        })

        echo = _issue_payload(
            plane_id, name="Amp", state_group="started",
            priority="urgent", external_id=f"alfred:{slug}",
        )
        round2 = _stream_event("issue", "updated", echo, event_id="round2")

        stubs2, state2 = _make_stubs(
            events=[round2],
            issue_map={slug: plane_id},
            outbound_sigs={plane_id: {"hash": outbound_hash,
                                      "ts": int(time.time() * 1000) - 500}},
            existing_frontmatter={f"task/{slug}.md": {
                "name": "Amp", "status": "active", "priority": "urgent",
            }},
        )
        r2 = asyncio.run(_run_workflow(stubs2))
        round2_writes = len(state2["patches_applied"])

        # Round 1: one vault write for the real edit
        assert round1_writes == 1, (
            f"round 1 (real edit) wrote {round1_writes} times, expected 1"
        )
        # Round 2: zero — the echo is suppressed
        assert round2_writes == 0, (
            f"round 2 (echo) wrote {round2_writes} times — LOOP NOT SETTLED"
        )
        assert r1.tasks_updated == 1
        assert r2.events_skipped_loop_guard == 1
        # Absolute budget: ≤2 workflow runs total, ≤1 vault write total.
        total_writes = round1_writes + round2_writes
        assert total_writes == 1, (
            f"total writes across 2 rounds = {total_writes}, must be ≤1 "
            "or we regressed the loop guards"
        )
