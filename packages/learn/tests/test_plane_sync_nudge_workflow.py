"""Tests for PlaneSyncNudgeWorkflow — event-triggered single-record forward sync (#574).

Uses Temporal's ``WorkflowEnvironment.start_time_skipping()`` so the
workflow itself is executed end-to-end. Activities are replaced with
stubs registered under the same name so no real vault / Plane I/O runs.

What's covered:

* Feature flag off → workflow short-circuits with ``started=False``.
* Invalid record_type → rejected before any activity runs.
* Empty slug → rejected before any activity runs.
* Matter nudge → single ``sync_matter_to_plane`` call + cursor map update.
* Task nudge with existing Inbox → single ``sync_task_to_plane`` call.
* Task nudge with missing Inbox → ``ensure_inbox_project`` fires first.
* Missing record (404) → soft no-op with ``skipped_reason``.
* Cursor ``last_vault_mtime`` is NEVER touched by the nudge.
* Archived task cascade drops the slug from ``issue_map``.
* Sync activity failure → workflow captures the error but doesn't crash.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.workflows.plane_sync_nudge import (
    PlaneSyncNudgeResult,
    PlaneSyncNudgeWorkflow,
)


# ---------------------------------------------------------------------------
# Shared call-log + stub factory
# ---------------------------------------------------------------------------

_CALL_LOG: list[tuple[str, Any]] = []


def _reset_call_log() -> None:
    _CALL_LOG.clear()


def _make_stubs(
    *,
    cursor_state: dict[str, Any] | None = None,
    record: dict[str, Any] | None = None,
    enabled: bool = True,
    matter_outcome: dict[str, str] | None = None,
    task_outcome: dict[str, str] | None = None,
    raise_on_matter: bool = False,
    raise_on_task: bool = False,
    inbox_plane_id: str = "prj-inbox",
) -> list:
    """Build stub activities for a single workflow run."""
    state_ref: dict[str, Any] = {
        "last_vault_mtime": float(
            (cursor_state or {}).get("last_vault_mtime", 0.0) or 0.0
        ),
        "project_map": dict((cursor_state or {}).get("project_map") or {}),
        "issue_map": dict((cursor_state or {}).get("issue_map") or {}),
    }

    @activity.defn(name="plane_sync_is_enabled")
    async def stub_enabled() -> bool:
        _CALL_LOG.append(("enabled", None))
        return enabled

    @activity.defn(name="load_plane_sync_state")
    async def stub_load() -> dict[str, Any]:
        _CALL_LOG.append(("load", None))
        return dict(state_ref)

    @activity.defn(name="save_plane_sync_state")
    async def stub_save(state: dict[str, Any]) -> None:
        _CALL_LOG.append(("save", dict(state)))
        state_ref["last_vault_mtime"] = float(
            state.get("last_vault_mtime", 0.0) or 0.0
        )
        state_ref["project_map"] = dict(state.get("project_map") or {})
        state_ref["issue_map"] = dict(state.get("issue_map") or {})

    @activity.defn(name="fetch_single_plane_record")
    async def stub_fetch(record_type: str, slug: str) -> dict[str, Any] | None:
        _CALL_LOG.append(("fetch_single", (record_type, slug)))
        return record

    @activity.defn(name="sync_matter_to_plane")
    async def stub_sync_matter(
        matter: dict[str, Any],
        project_map: dict[str, str],
    ) -> dict[str, str]:
        _CALL_LOG.append(("sync_matter", matter.get("slug")))
        if raise_on_matter:
            raise RuntimeError("simulated plane outage for matter")
        if matter_outcome is not None:
            return matter_outcome
        return {
            "slug": matter["slug"],
            "plane_id": f"prj-{matter['slug']}",
            "action": "create",
        }

    @activity.defn(name="sync_task_to_plane")
    async def stub_sync_task(
        task: dict[str, Any],
        project_map: dict[str, str],
        issue_map: dict[str, str],
        label_cache: dict[str, dict[str, str]] | None = None,
    ) -> dict[str, str]:
        _CALL_LOG.append(("sync_task", task.get("slug"), label_cache))
        if raise_on_task:
            raise RuntimeError("simulated plane outage for task")
        if task_outcome is not None:
            return task_outcome
        matter_slug = task.get("matter_slug")
        if matter_slug and matter_slug in project_map:
            pid = project_map[matter_slug]
        else:
            pid = project_map.get("__inbox__", "")
        if not pid:
            return {"slug": task["slug"], "plane_id": "", "action": "skip"}
        return {
            "slug": task["slug"],
            "plane_id": f"iss-{task['slug']}",
            "action": "create",
            "project_id": pid,
        }

    @activity.defn(name="ensure_inbox_project")
    async def stub_inbox(project_map: dict[str, str]) -> dict[str, str]:
        _CALL_LOG.append(("inbox", None))
        return {"plane_id": inbox_plane_id, "action": "created"}

    return [
        stub_enabled,
        stub_load,
        stub_save,
        stub_fetch,
        stub_sync_matter,
        stub_sync_task,
        stub_inbox,
    ]


async def _run(
    stubs: list,
    record_type: str,
    slug: str,
) -> PlaneSyncNudgeResult:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"plane-nudge-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[PlaneSyncNudgeWorkflow],
            activities=stubs,
        )
        async with worker:
            result: PlaneSyncNudgeResult = await client.execute_workflow(
                PlaneSyncNudgeWorkflow.run,
                {"record_type": record_type, "slug": slug},
                id=f"nudge-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------


class TestFeatureFlag:
    def test_disabled_short_circuits(self):
        _reset_call_log()
        stubs = _make_stubs(enabled=False)
        result = asyncio.run(_run(stubs, "matter", "alpha"))
        assert result.started is False
        assert "PLANE_SYNC_ENABLED" in result.skipped_reason
        # Only the feature-flag check ran — nothing else.
        assert [c[0] for c in _CALL_LOG] == ["enabled"]


class TestValidation:
    def test_invalid_record_type_rejected(self):
        _reset_call_log()
        stubs = _make_stubs()
        result = asyncio.run(_run(stubs, "project", "foo"))
        assert result.started is False
        assert "unsupported record_type" in result.skipped_reason
        # Rejected before any activity ran.
        assert _CALL_LOG == []

    def test_empty_slug_rejected(self):
        _reset_call_log()
        stubs = _make_stubs()
        result = asyncio.run(_run(stubs, "matter", ""))
        assert result.started is False
        assert "slug is required" in result.skipped_reason
        assert _CALL_LOG == []


class TestMatterNudge:
    def test_matter_upsert_primes_project_map(self):
        _reset_call_log()
        stubs = _make_stubs(
            cursor_state={},
            record={
                "slug": "alpha",
                "path": "matter/alpha.md",
                "frontmatter": {"name": "Alpha"},
                "body": "...",
                "mtime": 500.0,
            },
        )
        result = asyncio.run(_run(stubs, "matter", "alpha"))
        assert result.started is True
        assert result.synced is True
        assert result.action == "create"
        assert result.plane_id == "prj-alpha"
        assert result.record_type == "matter"
        assert result.slug == "alpha"

        # Exactly ONE sync_matter call; no sync_task.
        kinds = [c[0] for c in _CALL_LOG]
        assert kinds.count("sync_matter") == 1
        assert "sync_task" not in kinds

        # Cursor got saved with the new mapping but mtime preserved.
        saves = [c for c in _CALL_LOG if c[0] == "save"]
        assert len(saves) == 1
        saved = saves[0][1]
        assert saved["project_map"]["alpha"] == "prj-alpha"
        assert saved["last_vault_mtime"] == 0.0  # cursor NOT advanced

    def test_matter_update_does_not_persist_when_map_unchanged(self):
        _reset_call_log()
        stubs = _make_stubs(
            cursor_state={
                "last_vault_mtime": 0.0,
                "project_map": {"alpha": "prj-alpha"},
                "issue_map": {},
            },
            record={
                "slug": "alpha",
                "path": "matter/alpha.md",
                "frontmatter": {"name": "Alpha"},
                "body": "...",
                "mtime": 900.0,
            },
            matter_outcome={
                "slug": "alpha",
                "plane_id": "prj-alpha",
                "action": "update",
            },
        )
        result = asyncio.run(_run(stubs, "matter", "alpha"))
        assert result.synced is True
        assert result.action == "update"
        # plane_id unchanged → no save call
        saves = [c for c in _CALL_LOG if c[0] == "save"]
        assert len(saves) == 0


class TestTaskNudge:
    def test_task_with_matter_in_project_map(self):
        _reset_call_log()
        stubs = _make_stubs(
            cursor_state={
                "last_vault_mtime": 0.0,
                "project_map": {"alpha": "prj-alpha", "__inbox__": "prj-inbox"},
                "issue_map": {},
            },
            record={
                "slug": "t1",
                "path": "task/t1.md",
                "frontmatter": {"name": "Task 1"},
                "matter_slug": "alpha",
                "body": "...",
                "mtime": 700.0,
            },
        )
        result = asyncio.run(_run(stubs, "task", "t1"))
        assert result.synced is True
        assert result.action == "create"
        assert result.plane_id == "iss-t1"

        # ensure_inbox was NOT called (inbox already in map)
        kinds = [c[0] for c in _CALL_LOG]
        assert "inbox" not in kinds
        assert kinds.count("sync_task") == 1

        saves = [c for c in _CALL_LOG if c[0] == "save"]
        assert len(saves) == 1
        saved = saves[0][1]
        assert saved["issue_map"]["t1"] == "iss-t1"
        assert saved["last_vault_mtime"] == 0.0

    def test_task_with_missing_inbox_creates_one(self):
        _reset_call_log()
        stubs = _make_stubs(
            cursor_state={},
            record={
                "slug": "orphan",
                "path": "task/orphan.md",
                "frontmatter": {"name": "Orphan"},
                "matter_slug": None,
                "body": "...",
                "mtime": 800.0,
            },
        )
        result = asyncio.run(_run(stubs, "task", "orphan"))
        # Inbox call happened BEFORE the sync_task call
        kinds = [c[0] for c in _CALL_LOG]
        assert "inbox" in kinds
        assert kinds.index("inbox") < kinds.index("sync_task")
        assert result.synced is True
        assert result.action == "create"

    def test_archived_task_drops_from_issue_map(self):
        _reset_call_log()
        stubs = _make_stubs(
            cursor_state={
                "last_vault_mtime": 0.0,
                "project_map": {"alpha": "prj-alpha", "__inbox__": "prj-inbox"},
                "issue_map": {"t1": "iss-t1"},
            },
            record={
                "slug": "t1",
                "path": "task/t1.md",
                "frontmatter": {"name": "T1", "archived": True},
                "matter_slug": "alpha",
                "body": "",
                "mtime": 900.0,
            },
            task_outcome={
                "slug": "t1",
                "plane_id": "",
                "action": "archived",
            },
        )
        result = asyncio.run(_run(stubs, "task", "t1"))
        assert result.action == "archived"
        assert result.synced is True
        saves = [c for c in _CALL_LOG if c[0] == "save"]
        assert len(saves) == 1
        assert "t1" not in saves[0][1]["issue_map"]

    def test_task_skip_action_marked_but_not_synced(self):
        _reset_call_log()
        stubs = _make_stubs(
            cursor_state={},
            record={
                "slug": "orphan",
                "path": "task/orphan.md",
                "frontmatter": {"name": "Orphan"},
                "matter_slug": None,
                "body": "",
                "mtime": 100.0,
            },
            task_outcome={"slug": "orphan", "plane_id": "", "action": "skip"},
            inbox_plane_id="prj-inbox",
        )
        result = asyncio.run(_run(stubs, "task", "orphan"))
        assert result.action == "skip"
        assert result.synced is False
        assert "skip" in result.skipped_reason


class TestMissingRecord:
    def test_fetch_returns_none_produces_soft_noop(self):
        _reset_call_log()
        stubs = _make_stubs(cursor_state={}, record=None)
        result = asyncio.run(_run(stubs, "task", "vanished"))
        assert result.started is True  # feature flag passed
        assert result.synced is False
        assert "not found" in result.skipped_reason
        # No sync activity should have run
        assert "sync_task" not in [c[0] for c in _CALL_LOG]
        assert "sync_matter" not in [c[0] for c in _CALL_LOG]


class TestCursorPersistenceSemantics:
    def test_mtime_never_advances(self):
        """The nudge must never advance ``last_vault_mtime`` — that's
        the cron's job, and doing so would silently skip other records
        changed in the same window that haven't been nudged yet.
        """
        _reset_call_log()
        stubs = _make_stubs(
            cursor_state={
                "last_vault_mtime": 100.0,
                "project_map": {},
                "issue_map": {},
            },
            record={
                "slug": "alpha",
                "path": "matter/alpha.md",
                "frontmatter": {"name": "Alpha"},
                "body": "...",
                "mtime": 900.0,  # much newer than cursor
            },
        )
        result = asyncio.run(_run(stubs, "matter", "alpha"))
        assert result.synced is True
        saves = [c for c in _CALL_LOG if c[0] == "save"]
        assert len(saves) == 1
        # Cursor preserved at 100.0 even though record mtime is 900.0
        assert saves[0][1]["last_vault_mtime"] == 100.0


class TestSyncFailureCapture:
    def test_matter_sync_exception_captured(self):
        _reset_call_log()
        stubs = _make_stubs(
            cursor_state={},
            record={
                "slug": "alpha",
                "path": "matter/alpha.md",
                "frontmatter": {"name": "Alpha"},
                "body": "...",
                "mtime": 100.0,
            },
            raise_on_matter=True,
        )
        result = asyncio.run(_run(stubs, "matter", "alpha"))
        assert result.synced is False
        assert len(result.error_messages) == 1
        assert "alpha" in result.error_messages[0]
        # No cursor save on failure
        saves = [c for c in _CALL_LOG if c[0] == "save"]
        assert len(saves) == 0

    def test_task_sync_exception_captured(self):
        _reset_call_log()
        stubs = _make_stubs(
            cursor_state={
                "last_vault_mtime": 0.0,
                "project_map": {"alpha": "prj-alpha", "__inbox__": "prj-inbox"},
                "issue_map": {},
            },
            record={
                "slug": "t1",
                "path": "task/t1.md",
                "frontmatter": {"name": "T1"},
                "matter_slug": "alpha",
                "body": "",
                "mtime": 100.0,
            },
            raise_on_task=True,
        )
        result = asyncio.run(_run(stubs, "task", "t1"))
        assert result.synced is False
        assert len(result.error_messages) == 1
