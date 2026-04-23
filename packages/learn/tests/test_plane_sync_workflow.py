"""Tests for PlaneSyncWorkflow — vault → Plane one-way sync (#536 B4).

Uses Temporal's ``WorkflowEnvironment.start_time_skipping()`` so the
workflow itself is executed end-to-end (not just its activities). The
activities are replaced with test stubs registered under the same name,
so the production I/O code paths (vault reads, Plane HTTP calls,
cursor reads/writes) never run.

What's covered:

* Feature flag off → workflow short-circuits with ``started=False``.
* First run with empty cursor → matters + tasks fully backfilled.
* Incremental run → only records with mtime > cursor are processed.
* Matter without tasks → only the project is created.
* Task without matter → skipped, cursor doesn't advance past it.
* Task whose matter isn't in project_map yet → skipped, cursor held.
* Cursor persistence across runs via ``save_plane_sync_state`` stub.
* Pure-function helpers: ``_normalize_matter_ref`` variants +
  ``_record_mtime`` timestamp extraction + ``_iso_to_epoch`` edge cases.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.activities.plane_sync import (
    _OUTBOUND_SIGS_CAP,
    _iso_to_epoch,
    _load_cursor_from_disk,
    _load_outbound_sigs_from_disk,
    _normalize_matter_ref,
    _project_identifier_for_slug,
    _record_mtime,
    _record_outbound_signature,
    _save_outbound_sigs_to_disk,
    _slug_from_path,
)
from src.workflows.plane_sync import PlaneSyncResult, PlaneSyncWorkflow


# ---------------------------------------------------------------------------
# Pure-function coverage
# ---------------------------------------------------------------------------

class TestNormalizeMatterRef:
    def test_none(self):
        assert _normalize_matter_ref(None) is None

    def test_empty_string(self):
        assert _normalize_matter_ref("") is None

    def test_whitespace_only(self):
        assert _normalize_matter_ref("   ") is None

    def test_bare_slug(self):
        assert _normalize_matter_ref("client-x") == "client-x"

    def test_with_matter_prefix(self):
        assert _normalize_matter_ref("matter/client-x") == "client-x"

    def test_with_matter_prefix_and_md_suffix(self):
        assert _normalize_matter_ref("matter/client-x.md") == "client-x"

    def test_wikilink(self):
        assert _normalize_matter_ref("[[matter/client-x]]") == "client-x"

    def test_wikilink_bare(self):
        assert _normalize_matter_ref("[[client-x]]") == "client-x"

    def test_quoted(self):
        assert _normalize_matter_ref('"matter/client-x.md"') == "client-x"

    def test_non_string(self):
        assert _normalize_matter_ref(42) is None


class TestResolveTaskMatter:
    """Matter resolution across the three field conventions that
    co-exist on the fleet today (see #536 follow-up)."""

    def _resolve(self, fm):
        from src.activities.plane_sync import _resolve_task_matter
        return _resolve_task_matter(fm)

    def test_empty_frontmatter_returns_none(self):
        assert self._resolve({}) is None

    def test_scalar_matter_wins(self):
        assert self._resolve({"matter": "client-x"}) == "client-x"

    def test_scalar_legacy_related_matter(self):
        assert self._resolve({"related_matter": "legacy-slug"}) == "legacy-slug"

    def test_related_matters_head_of_list(self):
        assert self._resolve(
            {"related_matters": ["primary", "secondary"]}
        ) == "primary"

    def test_related_matters_empty_list_returns_none(self):
        assert self._resolve({"related_matters": []}) is None

    def test_related_matters_wikilink(self):
        assert self._resolve(
            {"related_matters": ["[[matter/foo]]"]}
        ) == "foo"

    def test_scalar_beats_array(self):
        # Scalar `matter` explicitly set should win over whatever the
        # enrichment pipeline wrote into `related_matters`.
        assert self._resolve(
            {"matter": "explicit", "related_matters": ["from-enrichment"]}
        ) == "explicit"

    def test_legacy_scalar_beats_array(self):
        assert self._resolve(
            {"related_matter": "legacy", "related_matters": ["from-enrichment"]}
        ) == "legacy"

    def test_non_list_related_matters_ignored(self):
        # Guard against malformed frontmatter (string where list expected).
        assert self._resolve({"related_matters": "not-a-list"}) is None


class TestInboxSentinel:
    """The Inbox project is keyed by a sentinel slug in project_map so
    it never collides with a real matter slug."""

    def test_sentinel_constant(self):
        from src.activities.plane_sync import INBOX_SLUG_SENTINEL
        assert INBOX_SLUG_SENTINEL == "__inbox__"
        # Dunder prefix ensures it can't collide with a real slug
        # (vault slugs are lowercase alnum + hyphens, enforced by the
        # curator).
        assert INBOX_SLUG_SENTINEL.startswith("__")


class TestSlugFromPath:
    def test_matter_path(self):
        assert _slug_from_path("matter/client-x.md") == "client-x"

    def test_task_path(self):
        assert _slug_from_path("task/2026/04/some-task.md") == "some-task"

    def test_no_extension(self):
        assert _slug_from_path("matter/client-x") == "client-x"

    def test_bare(self):
        assert _slug_from_path("client-x") == "client-x"


class TestRecordMtime:
    def test_uses_updated_preferentially(self):
        rec = {
            "frontmatter": {
                "created": "2026-01-01T00:00:00",
                "updated": "2026-04-01T00:00:00",
            }
        }
        assert _record_mtime(rec) > 0
        assert _record_mtime(rec) == _iso_to_epoch("2026-04-01T00:00:00")

    def test_falls_back_to_created(self):
        rec = {"frontmatter": {"created": "2026-01-01T00:00:00"}}
        assert _record_mtime(rec) == _iso_to_epoch("2026-01-01T00:00:00")

    def test_top_level_created(self):
        rec = {"created": "2026-01-01T00:00:00", "frontmatter": {}}
        assert _record_mtime(rec) == _iso_to_epoch("2026-01-01T00:00:00")

    def test_empty_record(self):
        assert _record_mtime({}) == 0.0

    def test_garbage_values(self):
        rec = {"frontmatter": {"created": "not a date", "updated": None}}
        assert _record_mtime(rec) == 0.0

    def test_iso_with_z_timezone(self):
        ts = _iso_to_epoch("2026-04-01T00:00:00Z")
        assert ts > 0


class TestProjectIdentifier:
    def test_short_slug(self):
        assert _project_identifier_for_slug("cx") == "CX"

    def test_long_slug_truncated_to_5(self):
        assert _project_identifier_for_slug("client-xylophone") == "CLIEN"

    def test_strips_non_alphanumeric(self):
        assert _project_identifier_for_slug("a-b_c.d") == "ABCD"

    def test_empty_falls_back(self):
        assert _project_identifier_for_slug("") == "ALFRD"

    def test_only_punctuation_falls_back(self):
        assert _project_identifier_for_slug("---") == "ALFRD"


# ---------------------------------------------------------------------------
# Cursor I/O
# ---------------------------------------------------------------------------

class TestCursorIO:
    def test_missing_file_returns_defaults(self, tmp_path):
        state = _load_cursor_from_disk(tmp_path / "nope.json")
        assert state == {
            "last_vault_mtime": 0.0,
            "project_map": {},
            "issue_map": {},
        }

    def test_round_trip(self, tmp_path, monkeypatch):
        # Route _cursor_path() to tmp
        monkeypatch.setenv("ALFRED_DATA_DIR", str(tmp_path))
        from src.activities.plane_sync import save_plane_sync_state, load_plane_sync_state

        payload = {
            "last_vault_mtime": 123.5,
            "project_map": {"a": "uuid-a", "b": "uuid-b"},
            "issue_map": {"t1": "uuid-t1"},
        }

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        asyncio.run(env.run(save_plane_sync_state, payload))
        loaded = asyncio.run(env.run(load_plane_sync_state))
        assert loaded == payload

    def test_corrupt_cursor_starts_fresh(self, tmp_path):
        p = tmp_path / "c.json"
        p.write_text("{this is not valid json")
        state = _load_cursor_from_disk(p)
        assert state["last_vault_mtime"] == 0.0
        assert state["project_map"] == {}
        assert state["issue_map"] == {}


# ---------------------------------------------------------------------------
# Workflow execution with stubbed activities
# ---------------------------------------------------------------------------
#
# Strategy: register replacement activities under the SAME name the
# workflow calls (via the function object's ``__temporal_activity_definition``
# metadata). Using ``activity.defn(name="load_plane_sync_state")`` lets us
# return canned data without talking to Plane or the vault.

# Shared call-log so tests can assert what the workflow invoked.
_CALL_LOG: list[tuple[str, Any]] = []


def _reset_call_log() -> None:
    _CALL_LOG.clear()


def _make_stubs(
    cursor_state: dict[str, Any],
    matters: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    matter_outcomes: dict[str, dict[str, str]] | None = None,
    task_outcomes: dict[str, dict[str, str]] | None = None,
    raise_on_matter: str | None = None,
    raise_on_task: str | None = None,
    enabled: bool = True,
) -> list:
    """Build stub activities for a single workflow run.

    ``matter_outcomes`` / ``task_outcomes`` are slug → outcome-dict
    overrides. Missing slugs default to create-success.
    """
    matter_outcomes = matter_outcomes or {}
    task_outcomes = task_outcomes or {}

    # Snapshot the incoming cursor state so the stubs can mutate it
    # across calls (simulating persistence within one workflow run).
    state_ref: dict[str, Any] = {
        "last_vault_mtime": float(cursor_state.get("last_vault_mtime", 0.0) or 0.0),
        "project_map": dict(cursor_state.get("project_map") or {}),
        "issue_map": dict(cursor_state.get("issue_map") or {}),
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
        _CALL_LOG.append(("save", state))
        state_ref["last_vault_mtime"] = float(state.get("last_vault_mtime", 0.0) or 0.0)
        state_ref["project_map"] = dict(state.get("project_map") or {})
        state_ref["issue_map"] = dict(state.get("issue_map") or {})

    @activity.defn(name="fetch_changed_matters")
    async def stub_fetch_matters(since: float) -> list[dict[str, Any]]:
        _CALL_LOG.append(("fetch_matters", since))
        return [m for m in matters if float(m.get("mtime") or 0.0) > since]

    @activity.defn(name="fetch_changed_tasks")
    async def stub_fetch_tasks(since: float) -> list[dict[str, Any]]:
        _CALL_LOG.append(("fetch_tasks", since))
        return [t for t in tasks if float(t.get("mtime") or 0.0) > since]

    @activity.defn(name="sync_matter_to_plane")
    async def stub_sync_matter(
        matter: dict[str, Any],
        project_map: dict[str, str],
    ) -> dict[str, str]:
        _CALL_LOG.append(("sync_matter", matter["slug"]))
        if raise_on_matter and matter["slug"] == raise_on_matter:
            raise RuntimeError("simulated plane outage for matter")
        out = matter_outcomes.get(matter["slug"])
        if out is not None:
            return out
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
    ) -> dict[str, str]:
        _CALL_LOG.append(("sync_task", task["slug"]))
        if raise_on_task and task["slug"] == raise_on_task:
            raise RuntimeError("simulated plane outage for task")
        out = task_outcomes.get(task["slug"])
        if out is not None:
            return out
        matter_slug = task.get("matter_slug")
        if not matter_slug:
            return {"slug": task["slug"], "plane_id": "", "action": "skip"}
        if matter_slug not in project_map:
            return {"slug": task["slug"], "plane_id": "", "action": "skip"}
        return {
            "slug": task["slug"],
            "plane_id": f"iss-{task['slug']}",
            "action": "create",
            "project_id": project_map[matter_slug],
        }

    return [
        stub_enabled,
        stub_load,
        stub_save,
        stub_fetch_matters,
        stub_fetch_tasks,
        stub_sync_matter,
        stub_sync_task,
    ]


async def _run_workflow(
    stubs: list,
) -> PlaneSyncResult:
    """Boot a time-skipping WorkflowEnvironment, register stubs + the real
    workflow class, execute it once, return the typed result.
    """
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"plane-sync-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[PlaneSyncWorkflow],
            activities=stubs,
        )
        async with worker:
            result = await client.execute_workflow(
                PlaneSyncWorkflow.run,
                id=f"plane-sync-test-run-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

class TestFeatureFlag:
    def test_disabled_short_circuits(self):
        _reset_call_log()
        stubs = _make_stubs(cursor_state={}, matters=[], tasks=[], enabled=False)
        result = asyncio.run(_run_workflow(stubs))
        assert result.started is False
        assert "PLANE_SYNC_ENABLED" in result.skipped_reason
        # Only the feature-flag check activity ran — nothing else
        assert [c[0] for c in _CALL_LOG] == ["enabled"]


class TestFirstRunBackfill:
    def test_empty_cursor_processes_all(self):
        _reset_call_log()
        matters = [
            {"slug": "alpha", "path": "matter/alpha.md",
             "frontmatter": {"name": "Alpha"}, "mtime": 100.0},
            {"slug": "beta", "path": "matter/beta.md",
             "frontmatter": {"name": "Beta"}, "mtime": 200.0},
        ]
        tasks = [
            {"slug": "t1", "path": "task/t1.md",
             "frontmatter": {"name": "Task One"},
             "matter_slug": "alpha", "mtime": 150.0},
            {"slug": "t2", "path": "task/t2.md",
             "frontmatter": {"name": "Task Two"},
             "matter_slug": "beta", "mtime": 250.0},
        ]
        stubs = _make_stubs(cursor_state={}, matters=matters, tasks=tasks)
        result = asyncio.run(_run_workflow(stubs))

        assert result.started is True
        assert result.matters_synced == 2
        assert result.tasks_synced == 2
        assert result.tasks_skipped == 0
        assert result.errors == 0
        assert result.last_vault_mtime == 250.0

        # Verify cursor was saved and project_map populated
        save_calls = [c for c in _CALL_LOG if c[0] == "save"]
        assert len(save_calls) == 1
        saved = save_calls[0][1]
        assert saved["project_map"] == {"alpha": "prj-alpha", "beta": "prj-beta"}
        assert saved["issue_map"] == {"t1": "iss-t1", "t2": "iss-t2"}

    def test_matter_without_tasks(self):
        _reset_call_log()
        matters = [
            {"slug": "solo", "path": "matter/solo.md",
             "frontmatter": {"name": "Solo"}, "mtime": 500.0},
        ]
        stubs = _make_stubs(cursor_state={}, matters=matters, tasks=[])
        result = asyncio.run(_run_workflow(stubs))
        assert result.matters_synced == 1
        assert result.tasks_synced == 0
        assert result.last_vault_mtime == 500.0


class TestIncrementalRun:
    def test_cursor_advances_and_filters(self):
        _reset_call_log()
        # Previous run already processed things at/before mtime=100
        cursor_state = {
            "last_vault_mtime": 100.0,
            "project_map": {"alpha": "prj-alpha"},
            "issue_map": {"t1": "iss-t1"},
        }
        matters = [
            # This matter has mtime=50 — before cursor, won't surface
            # from fetch_changed_matters (the stub filters by > since)
            {"slug": "alpha", "path": "matter/alpha.md",
             "frontmatter": {"name": "Alpha"}, "mtime": 50.0},
            # Beta is new
            {"slug": "beta", "path": "matter/beta.md",
             "frontmatter": {"name": "Beta"}, "mtime": 150.0},
        ]
        tasks = [
            # t1 pre-dates the cursor
            {"slug": "t1", "path": "task/t1.md",
             "frontmatter": {"name": "T1"},
             "matter_slug": "alpha", "mtime": 75.0},
            # t2 is new and belongs to beta
            {"slug": "t2", "path": "task/t2.md",
             "frontmatter": {"name": "T2"},
             "matter_slug": "beta", "mtime": 175.0},
        ]
        stubs = _make_stubs(
            cursor_state=cursor_state, matters=matters, tasks=tasks
        )
        result = asyncio.run(_run_workflow(stubs))

        # Only one matter + one task processed this run
        assert result.matters_synced == 1
        assert result.tasks_synced == 1
        assert result.tasks_skipped == 0
        assert result.errors == 0
        assert result.last_vault_mtime == 175.0

        save = [c for c in _CALL_LOG if c[0] == "save"][0][1]
        saved_map = save["project_map"]
        # Pre-existing map entries preserved + new ones added
        assert saved_map
        assert "alpha" in saved_map  # preserved
        assert saved_map["beta"] == "prj-beta"  # newly added


class TestMatterOrderingBeforeTasks:
    def test_matters_processed_before_tasks(self):
        _reset_call_log()
        matters = [{"slug": "z", "path": "matter/z.md",
                    "frontmatter": {"name": "Z"}, "mtime": 100.0}]
        tasks = [{"slug": "t", "path": "task/t.md",
                  "frontmatter": {"name": "T"},
                  "matter_slug": "z", "mtime": 90.0}]
        stubs = _make_stubs(cursor_state={}, matters=matters, tasks=tasks)
        asyncio.run(_run_workflow(stubs))
        # Verify matter sync happened before task sync in the call log
        order = [c[0] for c in _CALL_LOG if c[0] in ("sync_matter", "sync_task")]
        assert order == ["sync_matter", "sync_task"]


class TestTaskWithoutMatter:
    def test_skipped_not_counted_as_synced(self):
        _reset_call_log()
        tasks = [{"slug": "orphan", "path": "task/orphan.md",
                  "frontmatter": {"name": "Orphan"},
                  "matter_slug": None, "mtime": 300.0}]
        stubs = _make_stubs(cursor_state={}, matters=[], tasks=tasks)
        result = asyncio.run(_run_workflow(stubs))
        assert result.matters_synced == 0
        assert result.tasks_synced == 0
        assert result.tasks_skipped == 1
        # Cursor should NOT have advanced past the skipped task
        save = [c for c in _CALL_LOG if c[0] == "save"][0][1]
        assert save["last_vault_mtime"] == 0.0


class TestTaskWhoseMatterMissing:
    def test_task_referencing_unknown_matter_is_skipped(self):
        _reset_call_log()
        tasks = [{"slug": "orphan-fk", "path": "task/orphan-fk.md",
                  "frontmatter": {"name": "Orphan FK"},
                  "matter_slug": "unknown-matter", "mtime": 400.0}]
        stubs = _make_stubs(cursor_state={}, matters=[], tasks=tasks)
        result = asyncio.run(_run_workflow(stubs))
        assert result.tasks_skipped == 1
        assert result.tasks_synced == 0


class TestErrorHolding:
    def test_matter_activity_error_does_not_advance_cursor(self):
        _reset_call_log()
        matters = [
            {"slug": "works", "path": "matter/works.md",
             "frontmatter": {"name": "W"}, "mtime": 100.0},
            {"slug": "breaks", "path": "matter/breaks.md",
             "frontmatter": {"name": "B"}, "mtime": 200.0},
        ]
        stubs = _make_stubs(
            cursor_state={}, matters=matters, tasks=[],
            raise_on_matter="breaks",
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.matters_synced == 1
        assert result.errors == 1
        # Cursor holds at pre-run value because at least one record failed
        save = [c for c in _CALL_LOG if c[0] == "save"][0][1]
        assert save["last_vault_mtime"] == 0.0


class TestOutboundSignatureStore:
    """Forward-sync writes outbound signatures so B7 reverse-sync's
    suppression-window guard has something to match against. These tests
    exercise the store directly."""

    def test_round_trip(self, tmp_path):
        path = tmp_path / "outbound.json"
        sigs = {
            "plane-1": {"hash": "abc", "ts": 1000},
            "plane-2": {"hash": "def", "ts": 2000},
        }
        _save_outbound_sigs_to_disk(path, sigs)
        loaded = _load_outbound_sigs_from_disk(path)
        assert loaded == sigs

    def test_missing_file_returns_empty(self, tmp_path):
        assert _load_outbound_sigs_from_disk(tmp_path / "nope.json") == {}

    def test_corrupt_file_returns_empty(self, tmp_path):
        path = tmp_path / "c.json"
        path.write_text("{not json")
        assert _load_outbound_sigs_from_disk(path) == {}

    def test_malformed_entries_dropped(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text(
            '{"ok": {"hash": "a", "ts": 1}, '
            '"shape1": "not a dict", '
            '"shape2": {"hash": "only"}}'
        )
        loaded = _load_outbound_sigs_from_disk(path)
        assert loaded == {"ok": {"hash": "a", "ts": 1}}

    def test_fifo_eviction_above_cap(self, tmp_path):
        """Overflowing the store drops the OLDEST ts, keeps the newest."""
        path = tmp_path / "cap.json"
        # Build cap + 10 entries; older timestamps should be evicted.
        sigs = {
            f"id-{i}": {"hash": f"h{i}", "ts": i}
            for i in range(_OUTBOUND_SIGS_CAP + 10)
        }
        _save_outbound_sigs_to_disk(path, sigs)
        loaded = _load_outbound_sigs_from_disk(path)
        assert len(loaded) == _OUTBOUND_SIGS_CAP
        # Newest 1000 kept = ts in [10, cap+10)
        for key in loaded:
            ts = loaded[key]["ts"]
            assert ts >= 10

    def test_record_outbound_signature_writes_entry(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALFRED_DATA_DIR", str(tmp_path))
        from src.activities.plane_sync import _outbound_sigs_path

        payload = {"name": "X", "state_group": "started", "priority": "high"}
        _record_outbound_signature("plane-id-1", payload)

        loaded = _load_outbound_sigs_from_disk(_outbound_sigs_path())
        assert "plane-id-1" in loaded
        assert len(loaded["plane-id-1"]["hash"]) == 64  # sha256 hex

    def test_record_outbound_signature_noop_on_empty_id(
        self, tmp_path, monkeypatch
    ):
        """Empty plane_id must not create a spurious entry."""
        monkeypatch.setenv("ALFRED_DATA_DIR", str(tmp_path))
        from src.activities.plane_sync import _outbound_sigs_path
        _record_outbound_signature("", {"anything": "here"})
        assert not _outbound_sigs_path().exists()


class TestCursorPersistenceAcrossRuns:
    def test_two_sequential_runs_chain_correctly(self):
        """Run 1 syncs alpha+t1; run 2 sees only beta+t2 as new."""
        _reset_call_log()
        run1_matters = [{"slug": "alpha", "path": "matter/alpha.md",
                         "frontmatter": {"name": "Alpha"}, "mtime": 100.0}]
        run1_tasks = [{"slug": "t1", "path": "task/t1.md",
                       "frontmatter": {"name": "T1"},
                       "matter_slug": "alpha", "mtime": 150.0}]

        stubs1 = _make_stubs(
            cursor_state={}, matters=run1_matters, tasks=run1_tasks
        )
        r1 = asyncio.run(_run_workflow(stubs1))
        assert r1.last_vault_mtime == 150.0
        save1 = [c for c in _CALL_LOG if c[0] == "save"][-1][1]
        cursor_after_1 = save1

        _reset_call_log()
        run2_matters = run1_matters + [
            {"slug": "beta", "path": "matter/beta.md",
             "frontmatter": {"name": "Beta"}, "mtime": 300.0}
        ]
        run2_tasks = run1_tasks + [
            {"slug": "t2", "path": "task/t2.md",
             "frontmatter": {"name": "T2"},
             "matter_slug": "beta", "mtime": 400.0}
        ]
        # Run 2 starts with the cursor from run 1
        stubs2 = _make_stubs(
            cursor_state=cursor_after_1,
            matters=run2_matters,
            tasks=run2_tasks,
        )
        r2 = asyncio.run(_run_workflow(stubs2))
        # Only the new records counted
        assert r2.matters_synced == 1
        assert r2.tasks_synced == 1
        assert r2.last_vault_mtime == 400.0
