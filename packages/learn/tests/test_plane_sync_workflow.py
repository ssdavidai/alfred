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
import json
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
    """Plane project identifier derivation — see _project_identifier_for_slug.

    Post-PR #587, the identifier is `<3 alpha prefix, X-padded><2 base-36
    hash chars>` so distinct slugs cannot collide. Values are deterministic
    per slug but exact hash output isn't meaningful — assert shape + stability.
    """

    def _is_valid_identifier(self, ident: str) -> bool:
        import re
        return len(ident) == 5 and bool(re.fullmatch(r"[A-Z0-9]{5}", ident))

    def test_short_slug_pads_and_hashes(self):
        ident = _project_identifier_for_slug("cx")
        assert ident.startswith("CXX")
        assert self._is_valid_identifier(ident)

    def test_long_slug_preserves_prefix(self):
        ident = _project_identifier_for_slug("client-xylophone")
        assert ident.startswith("CLI")
        assert self._is_valid_identifier(ident)

    def test_strips_non_alphanumeric(self):
        ident = _project_identifier_for_slug("a-b_c.d")
        assert ident.startswith("ABC")
        assert self._is_valid_identifier(ident)

    def test_empty_falls_back_to_alfred_prefix(self):
        ident = _project_identifier_for_slug("")
        assert ident.startswith("ALF")
        assert self._is_valid_identifier(ident)

    def test_only_punctuation_falls_back_to_alfred_prefix(self):
        ident = _project_identifier_for_slug("---")
        assert ident.startswith("ALF")
        assert self._is_valid_identifier(ident)

    def test_stable_per_slug(self):
        # Same slug must produce the same identifier across calls
        assert _project_identifier_for_slug("family-life") == _project_identifier_for_slug("family-life")

    def test_distinct_slugs_distinct_identifiers(self):
        # The collision case that motivated this design: two slugs with
        # identical 5-char prefix under the old scheme must produce
        # distinct identifiers now.
        a = _project_identifier_for_slug("alfred-black-ai-butler-product")
        b = _project_identifier_for_slug("alfred-black-ai-butler-product-build")
        assert a != b
        assert a.startswith("ALF") and b.startswith("ALF")


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

    @activity.defn(name="list_changed_task_paths")
    async def stub_list_paths(since: float) -> list[dict[str, Any]]:
        _CALL_LOG.append(("list_paths", since))
        # Lightweight refs: path/slug/matter_slug/mtime only
        refs = [
            {
                "path": t.get("path"),
                "slug": t.get("slug"),
                "matter_slug": t.get("matter_slug"),
                "mtime": float(t.get("mtime") or 0.0),
            }
            for t in tasks
            if float(t.get("mtime") or 0.0) > since
        ]
        refs.sort(key=lambda r: r["mtime"])
        return refs

    # Index tasks by path for the batch fetcher
    tasks_by_path: dict[str, dict[str, Any]] = {
        str(t.get("path")): t for t in tasks if t.get("path")
    }

    @activity.defn(name="fetch_task_records_batch")
    async def stub_fetch_batch(paths: list[str]) -> list[dict[str, Any]]:
        _CALL_LOG.append(("fetch_batch", list(paths)))
        out: list[dict[str, Any]] = []
        for p in paths:
            t = tasks_by_path.get(p)
            if t is None:
                continue
            out.append(dict(t))
        return out

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
        label_cache: dict[str, dict[str, str]] | None = None,
    ) -> dict[str, str]:
        # Record the cache the workflow passed in so tests can assert
        # the perf-fix wiring is live (see TestLabelCacheWiring).
        _CALL_LOG.append(("sync_task", task["slug"], label_cache))
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

    @activity.defn(name="ensure_inbox_project")
    async def stub_inbox(project_map: dict[str, str]) -> dict[str, str]:
        _CALL_LOG.append(("inbox", None))
        return {"plane_id": "prj-inbox", "action": "created"}

    @activity.defn(name="preload_project_labels")
    async def stub_preload_labels(
        project_ids: list[str],
    ) -> dict[str, dict[str, str]]:
        _CALL_LOG.append(("preload_labels", list(project_ids)))
        # Return a plausible preload result — one or two labels per
        # project, so tests asserting cache contents have something
        # to look at.
        return {
            pid: {"alfred-managed": f"lbl-{pid}-managed"}
            for pid in project_ids
        }

    return [
        stub_enabled,
        stub_load,
        stub_save,
        stub_fetch_matters,
        stub_list_paths,
        stub_fetch_batch,
        stub_sync_matter,
        stub_sync_task,
        stub_inbox,
        stub_preload_labels,
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

        # Verify cursor was saved and project_map populated. The
        # workflow may emit multiple saves (interim matter save +
        # per-batch task saves, see #592 paginated fetch); we assert on
        # the FINAL save which carries the run's terminal state.
        save_calls = [c for c in _CALL_LOG if c[0] == "save"]
        assert len(save_calls) >= 1
        saved = save_calls[-1][1]
        assert saved["project_map"]["alpha"] == "prj-alpha"
        assert saved["project_map"]["beta"] == "prj-beta"
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

        save = [c for c in _CALL_LOG if c[0] == "save"][-1][1]
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
        save = [c for c in _CALL_LOG if c[0] == "save"][-1][1]
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
    def test_matter_activity_error_holds_cursor_below_failed_record(self):
        """With per-batch cursor advancement (#592), partial progress
        IS preserved: the cursor lands at the LAST SUCCESSFUL matter's
        mtime, not at the pre-run value. The failing matter has a
        higher mtime, so the next run will still re-discover it via
        ``fetch_changed_matters(since=100)`` and retry. This is a
        semantics change vs the legacy behavior that pinned the
        cursor at since=0 on any error — see PR #592.
        """
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
        # Cursor sits at the last-successful matter's mtime (100). The
        # failing matter (mtime=200) will be re-discovered next tick
        # by fetch_changed_matters(since=100) and retried. The
        # successful "works" entry is also still in project_map so
        # the retry won't double-create it.
        save = [c for c in _CALL_LOG if c[0] == "save"][-1][1]
        assert save["last_vault_mtime"] == 100.0
        assert save["project_map"]["works"] == "prj-works"
        assert "breaks" not in save["project_map"]


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


# ---------------------------------------------------------------------------
# Rich-payload + label-cache wiring — the perf/correctness PR's asserts
# ---------------------------------------------------------------------------


class TestRichPayloadReachesTaskActivity:
    """The workflow must hand the full enriched task dict (with body +
    resolved matter_slug) to ``sync_task_to_plane``. A regression that
    drops the body would silently hollow every Plane card."""

    def test_body_and_frontmatter_propagate(self):
        """Capture what sync_task_to_plane received and assert the
        enriched shape is intact."""
        received: list[dict] = []

        @activity.defn(name="plane_sync_is_enabled")
        async def ena() -> bool:
            return True

        @activity.defn(name="load_plane_sync_state")
        async def load() -> dict:
            return {
                "last_vault_mtime": 0.0,
                "project_map": {"m1": "prj-1"},
                "issue_map": {},
            }

        @activity.defn(name="save_plane_sync_state")
        async def save(state: dict) -> None:
            return None

        @activity.defn(name="fetch_changed_matters")
        async def fm(since: float) -> list[dict]:
            return []

        ALPHA_RECORD = {
            "slug": "alpha",
            "path": "task/alpha.md",
            "frontmatter": {
                "name": "Alpha task",
                "status": "todo",
                "priority": "high",
                "due_date": "2026-05-15",
                "alfred_tags": ["finance", "urgent"],
                "description": "short desc",
            },
            "matter_slug": "m1",
            "body": "# Alpha task\n\nThe full body content.",
            "mtime": 100.0,
        }

        @activity.defn(name="list_changed_task_paths")
        async def lp(since: float) -> list[dict]:
            return [{
                "path": ALPHA_RECORD["path"],
                "slug": ALPHA_RECORD["slug"],
                "matter_slug": ALPHA_RECORD["matter_slug"],
                "mtime": ALPHA_RECORD["mtime"],
            }]

        @activity.defn(name="fetch_task_records_batch")
        async def fb(paths: list[str]) -> list[dict]:
            return [
                ALPHA_RECORD for p in paths if p == ALPHA_RECORD["path"]
            ]

        @activity.defn(name="sync_matter_to_plane")
        async def sm(matter: dict, pm: dict) -> dict:
            return {"slug": matter["slug"], "plane_id": "", "action": "skip"}

        @activity.defn(name="sync_task_to_plane")
        async def st(
            task: dict,
            project_map: dict,
            issue_map: dict,
            label_cache: dict | None = None,
        ) -> dict:
            received.append({
                "task": task,
                "project_map": project_map,
                "label_cache": label_cache,
            })
            return {
                "slug": task["slug"],
                "plane_id": f"iss-{task['slug']}",
                "action": "create",
                "project_id": project_map.get(task.get("matter_slug")),
            }

        @activity.defn(name="ensure_inbox_project")
        async def ei(pm: dict) -> dict:
            return {"plane_id": "prj-inbox", "action": "created"}

        @activity.defn(name="preload_project_labels")
        async def pl(pids: list[str]) -> dict:
            return {p: {"existing-label": f"lbl-{p}"} for p in pids}

        stubs = [ena, load, save, fm, lp, fb, sm, st, ei, pl]
        result = asyncio.run(_run_workflow(stubs))
        assert result.tasks_synced == 1
        assert len(received) == 1
        task = received[0]["task"]
        # Body made it through untouched
        assert task["body"] == "# Alpha task\n\nThe full body content."
        # Frontmatter preserved with all the new fields
        fm_got = task["frontmatter"]
        assert fm_got["priority"] == "high"
        assert fm_got["due_date"] == "2026-05-15"
        assert fm_got["alfred_tags"] == ["finance", "urgent"]
        # Matter slug resolved and project map carries real mapping
        assert task["matter_slug"] == "m1"
        assert received[0]["project_map"]["m1"] == "prj-1"


class TestLabelCacheWiring:
    """The preload_project_labels → sync_task_to_plane handoff is a
    perf-critical path. These tests guarantee the cache is actually
    computed and threaded through — a silent regression here would
    add hundreds of label-lookup round-trips back in."""

    def test_preload_called_once_per_run(self):
        _reset_call_log()
        matters = [{"slug": "m", "path": "matter/m.md",
                    "frontmatter": {"name": "M"}, "mtime": 100.0}]
        tasks = [
            {"slug": "t1", "path": "task/t1.md",
             "frontmatter": {"name": "T1"},
             "matter_slug": "m", "mtime": 150.0},
            {"slug": "t2", "path": "task/t2.md",
             "frontmatter": {"name": "T2"},
             "matter_slug": "m", "mtime": 160.0},
            {"slug": "t3", "path": "task/t3.md",
             "frontmatter": {"name": "T3"},
             "matter_slug": "m", "mtime": 170.0},
        ]
        stubs = _make_stubs(cursor_state={}, matters=matters, tasks=tasks)
        asyncio.run(_run_workflow(stubs))
        preload_calls = [c for c in _CALL_LOG if c[0] == "preload_labels"]
        # ONE preload call for the whole run, not three
        assert len(preload_calls) == 1
        # Unique projects = Inbox + matter project 'm'
        called_with = set(preload_calls[0][1])
        assert "prj-m" in called_with

    def test_preload_not_called_when_no_tasks(self):
        """Matter-only run skips the label preload — nothing to cache."""
        _reset_call_log()
        matters = [{"slug": "m", "path": "matter/m.md",
                    "frontmatter": {"name": "M"}, "mtime": 100.0}]
        stubs = _make_stubs(cursor_state={}, matters=matters, tasks=[])
        asyncio.run(_run_workflow(stubs))
        preload_calls = [c for c in _CALL_LOG if c[0] == "preload_labels"]
        assert preload_calls == []

    def test_cache_reaches_sync_task(self):
        """The cache produced by preload is the same object handed to
        each sync_task_to_plane call — assert it's not being re-built
        per task."""
        _reset_call_log()
        matters = [{"slug": "m", "path": "matter/m.md",
                    "frontmatter": {"name": "M"}, "mtime": 100.0}]
        tasks = [
            {"slug": "t1", "path": "task/t1.md",
             "frontmatter": {"name": "T1"},
             "matter_slug": "m", "mtime": 150.0},
            {"slug": "t2", "path": "task/t2.md",
             "frontmatter": {"name": "T2"},
             "matter_slug": "m", "mtime": 160.0},
        ]
        stubs = _make_stubs(cursor_state={}, matters=matters, tasks=tasks)
        asyncio.run(_run_workflow(stubs))
        # The sync_task log entries now carry the cache as the third
        # tuple element — both calls should have received a non-None dict
        sync_calls = [c for c in _CALL_LOG if c[0] == "sync_task"]
        assert len(sync_calls) == 2
        for call in sync_calls:
            label_cache = call[2]
            assert label_cache is not None
            assert isinstance(label_cache, dict)
            # The preload stub returns alfred-managed entries per project
            assert "prj-m" in label_cache
            assert "alfred-managed" in label_cache["prj-m"]

    def test_unique_project_set_deduped(self):
        """Five tasks in one project = one entry in the preload set,
        not five. Duplicates must be dropped before the activity call."""
        _reset_call_log()
        matters = [{"slug": "m", "path": "matter/m.md",
                    "frontmatter": {"name": "M"}, "mtime": 100.0}]
        tasks = [
            {"slug": f"t{i}", "path": f"task/t{i}.md",
             "frontmatter": {"name": f"T{i}"},
             "matter_slug": "m", "mtime": 150.0 + i}
            for i in range(5)
        ]
        stubs = _make_stubs(cursor_state={}, matters=matters, tasks=tasks)
        asyncio.run(_run_workflow(stubs))
        preload_call = [c for c in _CALL_LOG if c[0] == "preload_labels"][0]
        # Project set should be deduped — all 5 tasks resolved to the
        # same matter, so exactly 1 project in the preload set.
        project_set = preload_call[1]
        assert len(project_set) == len(set(project_set))
        assert project_set == ["prj-m"]

    def test_preload_failure_falls_back_gracefully(self):
        """If preload raises, the task loop still runs — it just passes
        an empty cache and sync_task_to_plane falls back to per-task
        label fetch (stubbed here)."""
        @activity.defn(name="plane_sync_is_enabled")
        async def ena() -> bool:
            return True

        @activity.defn(name="load_plane_sync_state")
        async def load() -> dict:
            return {
                "last_vault_mtime": 0.0,
                "project_map": {"m": "prj-m"},
                "issue_map": {},
            }

        @activity.defn(name="save_plane_sync_state")
        async def save(state: dict) -> None:
            return None

        @activity.defn(name="fetch_changed_matters")
        async def fm(since: float) -> list[dict]:
            return []

        T_RECORD = {
            "slug": "t",
            "path": "task/t.md",
            "frontmatter": {"name": "T"},
            "matter_slug": "m",
            "body": "",
            "mtime": 100.0,
        }

        @activity.defn(name="list_changed_task_paths")
        async def lp(since: float) -> list[dict]:
            return [{
                "path": T_RECORD["path"],
                "slug": T_RECORD["slug"],
                "matter_slug": T_RECORD["matter_slug"],
                "mtime": T_RECORD["mtime"],
            }]

        @activity.defn(name="fetch_task_records_batch")
        async def fb(paths: list[str]) -> list[dict]:
            return [T_RECORD for p in paths if p == T_RECORD["path"]]

        @activity.defn(name="sync_matter_to_plane")
        async def sm(m: dict, pm: dict) -> dict:
            return {"slug": m["slug"], "plane_id": "", "action": "skip"}

        received_caches: list = []

        @activity.defn(name="sync_task_to_plane")
        async def st(t: dict, pm: dict, im: dict, lc: dict | None = None) -> dict:
            received_caches.append(lc)
            return {"slug": t["slug"], "plane_id": "i", "action": "create"}

        @activity.defn(name="ensure_inbox_project")
        async def ei(pm: dict) -> dict:
            return {"plane_id": "prj-inbox", "action": "created"}

        @activity.defn(name="preload_project_labels")
        async def pl_raise(pids: list[str]) -> dict:
            # Temporal wraps activity exceptions; the workflow catches
            # them with a broad except and continues with empty cache.
            raise RuntimeError("simulated preload outage")

        stubs = [ena, load, save, fm, lp, fb, sm, st, ei, pl_raise]
        result = asyncio.run(_run_workflow(stubs))
        # Task still synced despite preload failure
        assert result.tasks_synced == 1
        # Cache handed to sync_task was the empty-fallback dict
        assert received_caches == [{}]


# ---------------------------------------------------------------------------
# Archive cascade — vault task with `archived: true` deletes the Plane issue
# ---------------------------------------------------------------------------


class TestArchiveCascadeWorkflow:
    """Workflow-level assertions for the archive cascade. When the activity
    returns ``action="archived"``, the workflow must drop the slug from
    ``issue_map`` before the save, count it under ``tasks_archived``, and
    advance the cursor past the record (archives are completed work, not
    skips)."""

    def test_archived_task_removes_from_issue_map(self):
        _reset_call_log()
        cursor_state = {
            "last_vault_mtime": 50.0,
            "project_map": {"alpha": "prj-alpha"},
            "issue_map": {"t1": "iss-t1"},
        }
        tasks = [{
            "slug": "t1",
            "path": "task/t1.md",
            "frontmatter": {"name": "T1", "archived": True},
            "matter_slug": "alpha",
            "mtime": 200.0,
        }]
        stubs = _make_stubs(
            cursor_state=cursor_state,
            matters=[],
            tasks=tasks,
            task_outcomes={
                "t1": {"slug": "t1", "plane_id": "", "action": "archived"},
            },
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.tasks_archived == 1
        assert result.tasks_synced == 0
        assert result.tasks_skipped == 0
        assert result.errors == 0
        # Cursor DID advance past the archive
        assert result.last_vault_mtime == 200.0

        save = [c for c in _CALL_LOG if c[0] == "save"][-1][1]
        # Slug pruned from issue_map
        assert "t1" not in save["issue_map"]
        # But project_map entries preserved (matters aren't affected)
        assert save["project_map"]["alpha"] == "prj-alpha"

    def test_archived_task_without_prior_mapping_is_counted(self):
        """An archived task that was never synced before — the activity
        returns archived with empty plane_id, the workflow still counts
        it under tasks_archived and advances the cursor."""
        _reset_call_log()
        tasks = [{
            "slug": "never-synced",
            "path": "task/never-synced.md",
            "frontmatter": {"name": "Fresh", "archived": True},
            "matter_slug": None,
            "mtime": 300.0,
        }]
        stubs = _make_stubs(
            cursor_state={},
            matters=[],
            tasks=tasks,
            task_outcomes={
                "never-synced": {
                    "slug": "never-synced",
                    "plane_id": "",
                    "action": "archived",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.tasks_archived == 1
        assert result.tasks_skipped == 0
        assert result.last_vault_mtime == 300.0
        save = [c for c in _CALL_LOG if c[0] == "save"][-1][1]
        assert "never-synced" not in save["issue_map"]

    def test_archived_action_does_not_add_to_issue_map(self):
        """Even if the activity returned a plane_id for some reason
        alongside action=archived, the workflow must not write it into
        issue_map — the issue is being deleted, not created."""
        _reset_call_log()
        cursor_state = {
            "last_vault_mtime": 0.0,
            "project_map": {"alpha": "prj-alpha"},
            "issue_map": {},
        }
        tasks = [{
            "slug": "t-ghost",
            "path": "task/t-ghost.md",
            "frontmatter": {"name": "Ghost", "archived": True},
            "matter_slug": "alpha",
            "mtime": 150.0,
        }]
        stubs = _make_stubs(
            cursor_state=cursor_state,
            matters=[],
            tasks=tasks,
            task_outcomes={
                "t-ghost": {
                    "slug": "t-ghost",
                    # Deliberately set to a non-empty value to catch
                    # regressions where the workflow would erroneously
                    # index an archived outcome.
                    "plane_id": "iss-ghost",
                    "action": "archived",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.tasks_archived == 1
        save = [c for c in _CALL_LOG if c[0] == "save"][-1][1]
        assert "t-ghost" not in save["issue_map"]


# ---------------------------------------------------------------------------
# Archive cascade — activity-level assertions (sync_task_to_plane short-circuit)
# ---------------------------------------------------------------------------


class TestArchiveCascadeActivity:
    """Activity-level assertions for the archive cascade — exercises
    ``sync_task_to_plane`` directly with a fake PlaneClient to confirm
    the DELETE path is invoked exactly once and no create/update is
    attempted for an archived task.
    """

    def _run_activity(
        self,
        *,
        task: dict,
        project_map: dict,
        issue_map: dict,
        monkeypatch,
        fake_client,
    ):
        from src.activities import plane_sync as ps
        monkeypatch.setattr(ps, "_plane_client_from_env", lambda: fake_client)
        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        return asyncio.run(
            env.run(ps.sync_task_to_plane, task, project_map, issue_map, None)
        )

    def test_archived_task_with_mapping_calls_delete(self, monkeypatch):
        calls: list[tuple[str, tuple]] = []

        class FakeClient:
            async def delete_issue(self, project_id, issue_id):
                calls.append(("delete_issue", (project_id, issue_id)))

            async def create_issue(self, *a, **kw):
                calls.append(("create_issue", (a, kw)))
                raise AssertionError("create_issue must not be called for archived task")

            async def update_issue(self, *a, **kw):
                calls.append(("update_issue", (a, kw)))
                raise AssertionError("update_issue must not be called for archived task")

            async def close(self):
                pass

        out = self._run_activity(
            task={
                "slug": "t1",
                "frontmatter": {"archived": True},
                "matter_slug": "alpha",
                "body": "",
            },
            project_map={"alpha": "prj-alpha"},
            issue_map={"t1": "iss-t1"},
            monkeypatch=monkeypatch,
            fake_client=FakeClient(),
        )
        assert out == {"slug": "t1", "plane_id": "", "action": "archived"}
        assert calls == [("delete_issue", ("prj-alpha", "iss-t1"))]

    def test_archived_task_no_mapping_is_silent(self, monkeypatch):
        calls: list[tuple[str, tuple]] = []

        class FakeClient:
            async def delete_issue(self, *a, **kw):
                calls.append(("delete_issue", (a, kw)))
                raise AssertionError("delete should not fire without existing_id")

            async def create_issue(self, *a, **kw):
                calls.append(("create_issue", (a, kw)))
                raise AssertionError("create should not fire for archived task")

            async def close(self):
                pass

        out = self._run_activity(
            task={
                "slug": "never-synced",
                "frontmatter": {"archived": True},
                "matter_slug": None,
                "body": "",
            },
            project_map={},
            issue_map={},
            monkeypatch=monkeypatch,
            fake_client=FakeClient(),
        )
        assert out == {"slug": "never-synced", "plane_id": "", "action": "archived"}
        assert calls == []

    def test_archived_task_delete_404_treated_as_success(self, monkeypatch):
        """If the Plane issue is already gone (404 on delete), the
        activity must still return archived — it's the state we want."""
        import httpx

        deleted_calls: list = []

        class FakeClient:
            async def delete_issue(self, project_id, issue_id):
                deleted_calls.append((project_id, issue_id))
                # Simulate "already deleted in Plane"
                req = httpx.Request("DELETE", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError("gone", request=req, response=resp)

            async def close(self):
                pass

        out = self._run_activity(
            task={
                "slug": "t-404",
                "frontmatter": {"archived": True},
                "matter_slug": "alpha",
                "body": "",
            },
            project_map={"alpha": "prj-alpha"},
            issue_map={"t-404": "iss-gone"},
            monkeypatch=monkeypatch,
            fake_client=FakeClient(),
        )
        assert out == {"slug": "t-404", "plane_id": "", "action": "archived"}
        assert deleted_calls == [("prj-alpha", "iss-gone")]

    def test_archived_task_delete_other_http_error_raises(self, monkeypatch):
        """Non-404 errors on delete should propagate — we want the
        workflow's retry policy to handle a genuine Plane outage."""
        import httpx

        class FakeClient:
            async def delete_issue(self, project_id, issue_id):
                req = httpx.Request("DELETE", "http://fake/")
                resp = httpx.Response(500, request=req)
                raise httpx.HTTPStatusError("oops", request=req, response=resp)

            async def close(self):
                pass

        from src.activities import plane_sync as ps
        monkeypatch.setattr(ps, "_plane_client_from_env", lambda: FakeClient())

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        try:
            asyncio.run(
                env.run(
                    ps.sync_task_to_plane,
                    {
                        "slug": "t",
                        "frontmatter": {"archived": True},
                        "matter_slug": "alpha",
                        "body": "",
                    },
                    {"alpha": "prj-alpha"},
                    {"t": "iss-t"},
                    None,
                )
            )
        except httpx.HTTPStatusError as exc:
            assert exc.response.status_code == 500
        else:
            raise AssertionError("expected 500 to propagate")


# ---------------------------------------------------------------------------
# 404-on-update = cross-project move OR genuine delete
# ---------------------------------------------------------------------------
#
# A 404 from PATCH /projects/<pid>/issues/<iid> means the issue isn't
# in project <pid>. The common cause (>99% of tenant-a's cascade) is a
# cross-project move: ``related_matters`` changed on a vault task, so
# forward-sync now routes it to a different project — but Plane still
# holds the issue under the OLD project. Before the tenant-a hotfix the
# 404 handler auto-archived the vault task, blast-radiusing ~175 tasks
# in one run.
#
# New behaviour (fix/plane-sync-no-404-archive):
#   1. Probe every OTHER project in project_map for the issue.
#   2. If found → DELETE it from the stale project + return
#      action="stale_dropped". Next tick re-creates fresh in the
#      correct project.
#   3. If not found anywhere OR the search itself raises → still
#      return "stale_dropped". The archive helper is NEVER called
#      from this path. Vault stays the source of truth.


class TestStaleDroppedActivity:
    """Activity-level assertions for the new 404 behaviour. The helper
    ``_archive_vault_task_from_plane_delete`` must NEVER be invoked
    from sync_task_to_plane's 404 branch — that's the whole point of
    the fix. The helper stays alive because reconciliation still uses
    it; a separate test in this file guards its contract."""

    @staticmethod
    def _archive_tripwire(monkeypatch, ps):
        """Install a monkeypatch that raises if the archive helper
        fires. Every test in this class must keep this tripwire green.
        """
        async def must_not_fire(slug, path):
            raise AssertionError(
                "_archive_vault_task_from_plane_delete must NOT be "
                "called from the 404-on-update branch (tenant-a cascade "
                "regression guard)"
            )
        monkeypatch.setattr(
            ps, "_archive_vault_task_from_plane_delete", must_not_fire,
        )

    def test_404_with_issue_in_other_project_deletes_stale_and_drops(
        self, monkeypatch,
    ):
        """The cross-project-move case. Issue lives in project B but
        forward-sync is PATCHing project A. Activity must find the
        issue in B, DELETE it from B, and return stale_dropped."""
        import httpx

        from src.activities import plane_sync as ps

        self._archive_tripwire(monkeypatch, ps)

        deleted: list[tuple[str, str]] = []
        get_calls: list[tuple[str, str]] = []

        class FakeClient:
            async def update_issue(self, project_id, issue_id, body):
                # 404 on the project forward-sync thinks it belongs to
                req = httpx.Request("PATCH", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError(
                    "gone", request=req, response=resp,
                )

            async def get_issue(self, project_id, issue_id):
                get_calls.append((project_id, issue_id))
                # Found in project B ("prj-beta")
                if project_id == "prj-beta":
                    return {"id": issue_id, "project": project_id}
                # Not in project C
                req = httpx.Request("GET", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError(
                    "not here", request=req, response=resp,
                )

            async def delete_issue(self, project_id, issue_id):
                deleted.append((project_id, issue_id))

            async def create_issue(self, *a, **kw):
                raise AssertionError(
                    "create_issue must not fire for stale_dropped path"
                )

            async def resolve_state_id(self, pid, group):
                return None

            async def ensure_labels(self, pid, names):
                return []

            async def close(self):
                pass

            async def _post(self, *a, **kw):
                return {"id": "lbl-x"}

            _proj = lambda self, pid: f"/proj/{pid}"  # noqa: E731

        monkeypatch.setattr(ps, "_plane_client_from_env", lambda: FakeClient())

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        out = asyncio.run(
            env.run(
                ps.sync_task_to_plane,
                {
                    "slug": "moved-task",
                    "path": "task/moved-task.md",
                    "frontmatter": {"name": "Moved"},
                    "matter_slug": "alpha",
                    "body": "",
                },
                {
                    "alpha": "prj-alpha",
                    "beta": "prj-beta",
                    "gamma": "prj-gamma",
                },
                {"moved-task": "iss-moved"},
                {"prj-alpha": {}},
            )
        )
        assert out == {
            "slug": "moved-task",
            "plane_id": "",
            "action": "stale_dropped",
        }
        # The issue was deleted from the project Plane actually holds it in.
        assert deleted == [("prj-beta", "iss-moved")]
        # The current project (alpha) is probed exactly once — the
        # pre-PATCH staleness check (introduced after this test was
        # written; see plane_sync.py:_filter_stale_fields). The
        # cross-project SEARCH that follows the 404 must NOT redundantly
        # probe alpha again, hence "exactly once" not "more than once".
        probed_pids = [c[0] for c in get_calls]
        assert probed_pids.count("prj-alpha") == 1, probed_pids
        # The issue_id under probe is always the stale one.
        assert all(c[1] == "iss-moved" for c in get_calls)

    def test_404_with_issue_not_in_any_project_returns_stale_dropped(
        self, monkeypatch,
    ):
        """Genuine deletion case: issue isn't in any known project.
        Activity must return stale_dropped — NOT auto-archive."""
        import httpx

        from src.activities import plane_sync as ps

        self._archive_tripwire(monkeypatch, ps)

        class FakeClient:
            async def update_issue(self, project_id, issue_id, body):
                req = httpx.Request("PATCH", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError(
                    "gone", request=req, response=resp,
                )

            async def get_issue(self, project_id, issue_id):
                # 404 everywhere we look
                req = httpx.Request("GET", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError(
                    "not here", request=req, response=resp,
                )

            async def delete_issue(self, *a, **kw):
                raise AssertionError(
                    "delete_issue must not fire when issue is not found"
                )

            async def create_issue(self, *a, **kw):
                raise AssertionError(
                    "create_issue must not fire for stale_dropped path"
                )

            async def resolve_state_id(self, pid, group):
                return None

            async def ensure_labels(self, pid, names):
                return []

            async def close(self):
                pass

            async def _post(self, *a, **kw):
                return {"id": "lbl-x"}

            _proj = lambda self, pid: f"/proj/{pid}"  # noqa: E731

        monkeypatch.setattr(ps, "_plane_client_from_env", lambda: FakeClient())

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        out = asyncio.run(
            env.run(
                ps.sync_task_to_plane,
                {
                    "slug": "gone-forever",
                    "path": "task/gone-forever.md",
                    "frontmatter": {"name": "Gone"},
                    "matter_slug": "alpha",
                    "body": "",
                },
                {"alpha": "prj-alpha", "beta": "prj-beta"},
                {"gone-forever": "iss-ghost"},
                {"prj-alpha": {}},
            )
        )
        assert out == {
            "slug": "gone-forever",
            "plane_id": "",
            "action": "stale_dropped",
        }

    def test_cross_project_search_transport_error_falls_back_to_stale_dropped(
        self, monkeypatch,
    ):
        """If the cross-project search 500s / times out, the activity
        must fall back to stale_dropped — never re-raise into an
        archive cascade."""
        import httpx

        from src.activities import plane_sync as ps

        self._archive_tripwire(monkeypatch, ps)

        class FakeClient:
            async def update_issue(self, project_id, issue_id, body):
                req = httpx.Request("PATCH", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError(
                    "gone", request=req, response=resp,
                )

            async def get_issue(self, project_id, issue_id):
                # Simulate a 500 from Plane on the probe
                req = httpx.Request("GET", "http://fake/")
                resp = httpx.Response(500, request=req)
                raise httpx.HTTPStatusError(
                    "server err", request=req, response=resp,
                )

            async def delete_issue(self, *a, **kw):
                raise AssertionError(
                    "delete_issue must not fire when search fails"
                )

            async def create_issue(self, *a, **kw):
                raise AssertionError(
                    "create_issue must not fire for stale_dropped path"
                )

            async def resolve_state_id(self, pid, group):
                return None

            async def ensure_labels(self, pid, names):
                return []

            async def close(self):
                pass

            async def _post(self, *a, **kw):
                return {"id": "lbl-x"}

            _proj = lambda self, pid: f"/proj/{pid}"  # noqa: E731

        monkeypatch.setattr(ps, "_plane_client_from_env", lambda: FakeClient())

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        out = asyncio.run(
            env.run(
                ps.sync_task_to_plane,
                {
                    "slug": "flaky",
                    "path": "task/flaky.md",
                    "frontmatter": {"name": "Flaky"},
                    "matter_slug": "alpha",
                    "body": "",
                },
                {"alpha": "prj-alpha", "beta": "prj-beta"},
                {"flaky": "iss-flaky"},
                {"prj-alpha": {}},
            )
        )
        assert out == {
            "slug": "flaky",
            "plane_id": "",
            "action": "stale_dropped",
        }

    def test_cross_project_search_timeout_falls_back_to_stale_dropped(
        self, monkeypatch,
    ):
        """httpx.TimeoutException from get_issue must not abort the
        sync into an archive — fall back to stale_dropped."""
        import httpx

        from src.activities import plane_sync as ps

        self._archive_tripwire(monkeypatch, ps)

        class FakeClient:
            async def update_issue(self, project_id, issue_id, body):
                req = httpx.Request("PATCH", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError(
                    "gone", request=req, response=resp,
                )

            async def get_issue(self, project_id, issue_id):
                raise httpx.TimeoutException("probe timed out")

            async def delete_issue(self, *a, **kw):
                raise AssertionError("delete_issue must not fire")

            async def create_issue(self, *a, **kw):
                raise AssertionError("create_issue must not fire")

            async def resolve_state_id(self, pid, group):
                return None

            async def ensure_labels(self, pid, names):
                return []

            async def close(self):
                pass

            async def _post(self, *a, **kw):
                return {"id": "lbl-x"}

            _proj = lambda self, pid: f"/proj/{pid}"  # noqa: E731

        monkeypatch.setattr(ps, "_plane_client_from_env", lambda: FakeClient())

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        out = asyncio.run(
            env.run(
                ps.sync_task_to_plane,
                {
                    "slug": "timeout",
                    "path": "task/timeout.md",
                    "frontmatter": {"name": "Timeout"},
                    "matter_slug": "alpha",
                    "body": "",
                },
                {"alpha": "prj-alpha", "beta": "prj-beta"},
                {"timeout": "iss-timeout"},
                {"prj-alpha": {}},
            )
        )
        assert out == {
            "slug": "timeout",
            "plane_id": "",
            "action": "stale_dropped",
        }

    def test_non_404_error_still_raises(self, monkeypatch):
        """500/403/503 on update should still propagate — those aren't
        deletions and we want the retry policy to handle them."""
        import httpx

        from src.activities import plane_sync as ps

        self._archive_tripwire(monkeypatch, ps)

        for status in (500, 503, 403):
            class FakeClient:
                def __init__(self, s):
                    self._status = s

                async def update_issue(self, project_id, issue_id, body):
                    req = httpx.Request("PATCH", "http://fake/")
                    resp = httpx.Response(self._status, request=req)
                    raise httpx.HTTPStatusError(
                        "oops", request=req, response=resp,
                    )

                async def get_issue(self, *a, **kw):
                    raise AssertionError(
                        "cross-project search must not fire for non-404"
                    )

                async def resolve_state_id(self, pid, group):
                    return None

                async def ensure_labels(self, pid, names):
                    return []

                async def close(self):
                    pass

                async def _post(self, *a, **kw):
                    return {"id": "lbl-x"}

                _proj = lambda self, pid: f"/proj/{pid}"  # noqa: E731

            fake = FakeClient(status)
            monkeypatch.setattr(ps, "_plane_client_from_env", lambda f=fake: f)

            from temporalio.testing import ActivityEnvironment
            env = ActivityEnvironment()
            try:
                asyncio.run(
                    env.run(
                        ps.sync_task_to_plane,
                        {
                            "slug": "t",
                            "path": "task/t.md",
                            "frontmatter": {"name": "T"},
                            "matter_slug": "alpha",
                            "body": "",
                        },
                        {"alpha": "prj-alpha"},
                        {"t": "iss-t"},
                        {"prj-alpha": {}},
                    )
                )
            except httpx.HTTPStatusError as exc:
                assert exc.response.status_code == status
            else:
                raise AssertionError(
                    f"expected {status} to propagate"
                )

    def test_stale_issue_delete_failure_still_returns_stale_dropped(
        self, monkeypatch,
    ):
        """Even if the DELETE of the stale issue fails, the activity
        still returns stale_dropped so the slug gets dropped from
        issue_map. Reconciliation will clean up the orphan later."""
        import httpx

        from src.activities import plane_sync as ps

        self._archive_tripwire(monkeypatch, ps)

        class FakeClient:
            async def update_issue(self, project_id, issue_id, body):
                req = httpx.Request("PATCH", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError(
                    "gone", request=req, response=resp,
                )

            async def get_issue(self, project_id, issue_id):
                if project_id == "prj-beta":
                    return {"id": issue_id}
                req = httpx.Request("GET", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError("", request=req, response=resp)

            async def delete_issue(self, project_id, issue_id):
                # Delete itself fails
                raise RuntimeError("network down mid-delete")

            async def create_issue(self, *a, **kw):
                raise AssertionError("create_issue must not fire")

            async def resolve_state_id(self, pid, group):
                return None

            async def ensure_labels(self, pid, names):
                return []

            async def close(self):
                pass

            async def _post(self, *a, **kw):
                return {"id": "lbl-x"}

            _proj = lambda self, pid: f"/proj/{pid}"  # noqa: E731

        monkeypatch.setattr(ps, "_plane_client_from_env", lambda: FakeClient())

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        out = asyncio.run(
            env.run(
                ps.sync_task_to_plane,
                {
                    "slug": "delete-fails",
                    "path": "task/delete-fails.md",
                    "frontmatter": {"name": "Df"},
                    "matter_slug": "alpha",
                    "body": "",
                },
                {"alpha": "prj-alpha", "beta": "prj-beta"},
                {"delete-fails": "iss-df"},
                {"prj-alpha": {}},
            )
        )
        assert out == {
            "slug": "delete-fails",
            "plane_id": "",
            "action": "stale_dropped",
        }


class TestFindIssueInOtherProjects:
    """Unit tests for the cross-project search helper."""

    def test_excludes_current_project(self, monkeypatch):
        import httpx

        from src.activities import plane_sync as ps

        probed: list[str] = []

        class FakeClient:
            async def get_issue(self, project_id, issue_id):
                probed.append(project_id)
                req = httpx.Request("GET", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError("", request=req, response=resp)

        result = asyncio.run(
            ps._find_issue_in_other_projects(
                FakeClient(),
                issue_id="iss-x",
                current_project_id="prj-alpha",
                project_map={
                    "alpha": "prj-alpha",
                    "beta": "prj-beta",
                    "gamma": "prj-gamma",
                },
            )
        )
        assert result is None
        # Current project is excluded
        assert "prj-alpha" not in probed
        assert set(probed) == {"prj-beta", "prj-gamma"}

    def test_deduplicates_project_ids(self, monkeypatch):
        import httpx

        from src.activities import plane_sync as ps

        probed: list[str] = []

        class FakeClient:
            async def get_issue(self, project_id, issue_id):
                probed.append(project_id)
                req = httpx.Request("GET", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError("", request=req, response=resp)

        # Two slugs pointing at the same plane_id — should probe it once
        asyncio.run(
            ps._find_issue_in_other_projects(
                FakeClient(),
                issue_id="iss-x",
                current_project_id="prj-current",
                project_map={
                    "one": "prj-dup",
                    "two": "prj-dup",
                    "three": "prj-other",
                },
            )
        )
        assert probed.count("prj-dup") == 1
        assert probed.count("prj-other") == 1

    def test_returns_project_id_on_first_hit(self, monkeypatch):
        from src.activities import plane_sync as ps

        class FakeClient:
            async def get_issue(self, project_id, issue_id):
                if project_id == "prj-target":
                    return {"id": issue_id, "project": project_id}
                import httpx
                req = httpx.Request("GET", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError("", request=req, response=resp)

        result = asyncio.run(
            ps._find_issue_in_other_projects(
                FakeClient(),
                issue_id="iss-y",
                current_project_id="prj-current",
                project_map={
                    "a": "prj-a",
                    "b": "prj-target",
                    "c": "prj-c",
                },
            )
        )
        assert result == "prj-target"


class TestArchiveHelperContract:
    """The ``_archive_vault_task_from_plane_delete`` helper is NO LONGER
    called from sync_task_to_plane's 404 branch (see TestStaleDroppedActivity
    for that guard). But plane_reconciliation still calls it when it
    confirms against the vault record that a task is genuinely meant to
    be archived. Pin its behaviour here so a future refactor doesn't
    accidentally change the frontmatter shape reconciliation depends on.
    """

    def test_archive_helper_writes_expected_frontmatter(self, monkeypatch):
        """The helper must set archived=true, status=cancelled,
        archived_at (ISO timestamp), archived_reason — and nothing more."""
        from src.activities import plane_sync as ps

        captured: list[tuple[str, dict]] = []

        class FakeVaultClient:
            def __init__(self, *a, **kw):
                pass

            async def patch_frontmatter(self, path, updates):
                captured.append((path, dict(updates)))

            async def close(self):
                pass

        monkeypatch.setattr(ps, "VaultClient", FakeVaultClient)

        asyncio.run(
            ps._archive_vault_task_from_plane_delete(
                "some-task", "task/some-task.md",
            )
        )
        assert len(captured) == 1
        path, updates = captured[0]
        assert path == "task/some-task.md"
        assert updates["archived"] is True
        assert updates["status"] == "cancelled"
        assert updates["archived_reason"] == "plane_delete_detected_via_404"
        # archived_at should be an ISO-8601 timestamp (UTC)
        archived_at = updates["archived_at"]
        assert isinstance(archived_at, str)
        assert "T" in archived_at
        # parseable back via fromisoformat
        from datetime import datetime
        parsed = datetime.fromisoformat(archived_at)
        assert parsed.tzinfo is not None


class TestArchivedByPlaneWorkflow:
    """Legacy workflow-level test. The activity no longer returns
    ``action="archived_by_plane"`` — 404s now resolve to stale_dropped.
    We keep this branch in the workflow (and this test) for wire
    compatibility with in-flight workflows carrying the old action
    value across the deploy. On the next deploy every run reports
    zero in this counter."""

    def test_archived_by_plane_drops_from_map_and_counts(self):
        _reset_call_log()
        cursor_state = {
            "last_vault_mtime": 50.0,
            "project_map": {"alpha": "prj-alpha"},
            "issue_map": {"t-rest-gone": "iss-gone"},
        }
        tasks = [{
            "slug": "t-rest-gone",
            "path": "task/t-rest-gone.md",
            "frontmatter": {"name": "Gone"},
            "matter_slug": "alpha",
            "mtime": 200.0,
        }]
        stubs = _make_stubs(
            cursor_state=cursor_state,
            matters=[],
            tasks=tasks,
            task_outcomes={
                "t-rest-gone": {
                    "slug": "t-rest-gone",
                    "plane_id": "",
                    "action": "archived_by_plane",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.tasks_archived_by_plane == 1
        assert result.tasks_archived == 0
        assert result.tasks_synced == 0
        assert result.errors == 0
        # Cursor DID advance
        assert result.last_vault_mtime == 200.0
        save = [c for c in _CALL_LOG if c[0] == "save"][-1][1]
        assert "t-rest-gone" not in save["issue_map"]


class TestStaleDroppedWorkflow:
    """Workflow-level assertion for the new 404 path. When the activity
    returns ``action="stale_dropped"`` (either cross-project move
    cleaned up, or issue not found anywhere), the workflow must drop
    the slug from ``issue_map``, count it under ``tasks_stale_dropped``,
    and advance the cursor. Vault task is NOT archived.
    """

    def test_stale_dropped_drops_from_map_and_counts(self):
        _reset_call_log()
        cursor_state = {
            "last_vault_mtime": 50.0,
            "project_map": {
                "alpha": "prj-alpha",
                "beta": "prj-beta",
            },
            "issue_map": {"t-moved": "iss-moved"},
        }
        tasks = [{
            "slug": "t-moved",
            "path": "task/t-moved.md",
            "frontmatter": {"name": "Moved"},
            "matter_slug": "beta",
            "mtime": 200.0,
        }]
        stubs = _make_stubs(
            cursor_state=cursor_state,
            matters=[],
            tasks=tasks,
            task_outcomes={
                "t-moved": {
                    "slug": "t-moved",
                    "plane_id": "",
                    "action": "stale_dropped",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.tasks_stale_dropped == 1
        assert result.tasks_archived_by_plane == 0
        assert result.tasks_archived == 0
        assert result.tasks_synced == 0
        assert result.errors == 0
        # Cursor DID advance — the stale_dropped is a completed unit
        # of work (the slug was removed + next tick will re-create)
        assert result.last_vault_mtime == 200.0
        save = [c for c in _CALL_LOG if c[0] == "save"][-1][1]
        # Slug pruned from issue_map so the next forward-sync tick
        # creates a fresh Plane issue in the correct project.
        assert "t-moved" not in save["issue_map"]
        # project_map entries preserved — matters aren't affected
        assert save["project_map"]["alpha"] == "prj-alpha"
        assert save["project_map"]["beta"] == "prj-beta"

    def test_stale_dropped_counter_default_zero(self):
        """Sanity: fresh result starts at zero for the new counter."""
        result = PlaneSyncResult()
        assert result.tasks_stale_dropped == 0


# ---------------------------------------------------------------------------
# Paginated task fetch (#592) — workflow-level coverage of the two-stage
# ``list_changed_task_paths`` → ``fetch_task_records_batch`` flow,
# per-batch cursor advancement, and backward-compat for normal-sized
# vaults that fit into one batch.
# ---------------------------------------------------------------------------


class TestPaginatedTaskFetch:
    """Workflow-level guarantees for the #592 fix.

    These tests pin the new pagination behaviour so a future refactor
    can't silently regress to the single-shot ``fetch_changed_tasks``
    pattern that overflowed Temporal's 2 MB activity-result ceiling on
    example-owner's vault (~2545 tasks).
    """

    def test_empty_result_no_changes_since_cursor(self):
        """No matters AND no task changes since cursor → workflow runs
        cleanly, list_paths fires once and returns nothing, no batches
        are processed, but a final cursor save still happens."""
        _reset_call_log()
        cursor = {
            "last_vault_mtime": 1_000.0,
            "project_map": {"alpha": "prj-alpha"},
            "issue_map": {},
        }
        # Tasks list is empty after the cursor filter
        stubs = _make_stubs(cursor_state=cursor, matters=[], tasks=[])
        result = asyncio.run(_run_workflow(stubs))

        assert result.started is True
        assert result.matters_synced == 0
        assert result.tasks_synced == 0
        assert result.task_batches == 0
        assert result.errors == 0
        # list_changed_task_paths fired exactly once
        assert sum(1 for c in _CALL_LOG if c[0] == "list_paths") == 1
        # No batch fetches happened (no refs to chunk)
        assert sum(1 for c in _CALL_LOG if c[0] == "fetch_batch") == 0
        # The catch-all final save still fires so the cursor file
        # always reflects the latest state.
        save_calls = [c for c in _CALL_LOG if c[0] == "save"]
        assert len(save_calls) >= 1
        assert save_calls[-1][1]["last_vault_mtime"] == 1_000.0

    def test_single_batch_fits_in_one_chunk(self):
        """50 tasks → one batch, one fetch, all syncs land in the
        terminal cursor."""
        _reset_call_log()
        matters = [{"slug": "m", "path": "matter/m.md",
                    "frontmatter": {"name": "M"}, "mtime": 100.0}]
        tasks = [
            {"slug": f"t{i}", "path": f"task/t{i}.md",
             "frontmatter": {"name": f"T{i}"},
             "matter_slug": "m", "mtime": 200.0 + i}
            for i in range(50)
        ]
        stubs = _make_stubs(cursor_state={}, matters=matters, tasks=tasks)
        result = asyncio.run(_run_workflow(stubs))

        assert result.matters_synced == 1
        assert result.tasks_synced == 50
        assert result.task_batches == 1
        assert result.errors == 0
        # Exactly one batch fetch with all 50 paths
        batch_calls = [c for c in _CALL_LOG if c[0] == "fetch_batch"]
        assert len(batch_calls) == 1
        assert len(batch_calls[0][1]) == 50

    def test_multiple_batches_chunks_at_size_100(self):
        """300 tasks → 3 batches of 100 each. Per-batch save semantics
        mean we observe at least 3 save calls during task processing
        (matter interim save also fires, plus the final catch-all)."""
        _reset_call_log()
        matters = [{"slug": "m", "path": "matter/m.md",
                    "frontmatter": {"name": "M"}, "mtime": 100.0}]
        tasks = [
            {"slug": f"t{i:03d}", "path": f"task/t{i:03d}.md",
             "frontmatter": {"name": f"T{i}"},
             "matter_slug": "m", "mtime": 200.0 + i}
            for i in range(300)
        ]
        stubs = _make_stubs(cursor_state={}, matters=matters, tasks=tasks)
        result = asyncio.run(_run_workflow(stubs))

        assert result.matters_synced == 1
        assert result.tasks_synced == 300
        assert result.task_batches == 3
        assert result.errors == 0

        batch_calls = [c for c in _CALL_LOG if c[0] == "fetch_batch"]
        assert len(batch_calls) == 3
        # Each batch should be exactly 100 paths (300 = 3 × 100)
        assert [len(c[1]) for c in batch_calls] == [100, 100, 100]

        # Saves: 1 interim matter + 3 per-batch + 1 final catch-all = 5
        save_calls = [c for c in _CALL_LOG if c[0] == "save"]
        assert len(save_calls) >= 4  # interim + 3 batch + final
        # Terminal cursor advanced past the last task
        assert save_calls[-1][1]["last_vault_mtime"] == 200.0 + 299

    def test_per_batch_cursor_advancement_on_mid_run_failure(self):
        """If a sync_task call fails mid-batch, the cursor advances
        to the LAST successful batch's mtime (not all the way to the
        failing one) and the workflow stops processing further
        batches. Next run picks up from where the cursor advanced."""
        _reset_call_log()
        # 250 tasks → 3 batches (100, 100, 50). The 200th task (index
        # 199, in batch 2) fails. Batch 1 should advance the cursor to
        # the last task in batch 1 (mtime 200.0 + 99); batch 2 should
        # NOT advance because batch_errors=True; batch 3 is deferred.
        matters = [{"slug": "m", "path": "matter/m.md",
                    "frontmatter": {"name": "M"}, "mtime": 100.0}]
        failing_slug = "t199"
        tasks = [
            {"slug": f"t{i}", "path": f"task/t{i}.md",
             "frontmatter": {"name": f"T{i}"},
             "matter_slug": "m", "mtime": 200.0 + i}
            for i in range(250)
        ]
        stubs = _make_stubs(
            cursor_state={}, matters=matters, tasks=tasks,
            raise_on_task=failing_slug,
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.matters_synced == 1
        assert result.errors >= 1
        # Batch 1 (100 tasks) succeeded; batch 2 had an error (1 task
        # failed but the rest of the batch still processed); batch 3
        # was deferred. So batches actually processed = 2.
        assert result.task_batches == 2
        # No batch 3 fetch happened
        batch_calls = [c for c in _CALL_LOG if c[0] == "fetch_batch"]
        assert len(batch_calls) == 2

        # Final cursor: we held at the end of batch 1 (mtime = 200.0 +
        # 99 = 299) because batch 2 had errors. Batch 3 wasn't even
        # fetched, so its records will be re-discovered on the next
        # tick by list_changed_task_paths.
        save_calls = [c for c in _CALL_LOG if c[0] == "save"]
        # First save is the interim matter save (mtime 100), second
        # is batch 1 (mtime 299), third is batch 2 (held at 299
        # because of the error), fourth is the final catch-all.
        assert any(s[1]["last_vault_mtime"] == 200.0 + 99 for s in save_calls)
        # Final cursor should NOT have advanced past batch 1 because
        # batch 2 errored.
        assert save_calls[-1][1]["last_vault_mtime"] == 200.0 + 99

    def test_normal_sized_vault_unchanged_behavior(self):
        """Backward-compat guard: a 'normal' tenant (5 matters, 20
        tasks) goes through the new pipeline without any visible
        behavior change vs the legacy single-shot path. All tasks
        sync, cursor advances cleanly to the latest task mtime, no
        batch overflow."""
        _reset_call_log()
        matters = [
            {"slug": f"m{i}", "path": f"matter/m{i}.md",
             "frontmatter": {"name": f"M{i}"}, "mtime": 100.0 + i}
            for i in range(5)
        ]
        tasks = [
            {"slug": f"t{i}", "path": f"task/t{i}.md",
             "frontmatter": {"name": f"T{i}"},
             "matter_slug": f"m{i % 5}", "mtime": 200.0 + i}
            for i in range(20)
        ]
        stubs = _make_stubs(cursor_state={}, matters=matters, tasks=tasks)
        result = asyncio.run(_run_workflow(stubs))

        assert result.matters_synced == 5
        assert result.tasks_synced == 20
        assert result.task_batches == 1  # 20 tasks fits in one batch
        assert result.errors == 0
        # Cursor at the latest task mtime
        save_calls = [c for c in _CALL_LOG if c[0] == "save"]
        assert save_calls[-1][1]["last_vault_mtime"] == 200.0 + 19


class TestPaginationActivities:
    """Activity-level coverage for the new ``list_changed_task_paths``
    + ``fetch_task_records_batch`` activities. Exercises the real
    activity functions with a fake vault HTTP client so the lightweight
    /heavy-batch contract is pinned without spinning up a worker."""

    def test_list_changed_task_paths_filters_by_mtime(
        self, monkeypatch,
    ):
        """The list activity must filter records by mtime > since,
        return only the lightweight 4-field shape, and sort ascending."""
        from src.activities import plane_sync as ps

        records = [
            {"path": "task/old.md", "name": "Old",
             "frontmatter": {"created": "2026-01-01T00:00:00"}},
            {"path": "task/mid.md", "name": "Mid",
             "frontmatter": {"created": "2026-04-15T00:00:00",
                             "matter": "alpha"}},
            {"path": "task/new.md", "name": "New",
             "frontmatter": {"updated": "2026-04-20T00:00:00",
                             "related_matters": ["beta"]}},
        ]

        class FakeHttp:
            async def get(self, url, params=None):
                # Sanity: workflow asks for preview=0 to keep the
                # response cheap.
                assert params is not None
                assert params.get("preview") == 0

                class FakeResp:
                    status_code = 200
                    def raise_for_status(self): pass
                    def json(self): return {"results": records}
                return FakeResp()

        class FakeVaultClient:
            def __init__(self, *a, **kw):
                self._client = FakeHttp()

            async def close(self):
                pass

        monkeypatch.setattr(ps, "VaultClient", FakeVaultClient)

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        # Use the mtime of the "old" record + 1 so only mid + new surface
        old_mtime = ps._iso_to_epoch("2026-01-01T00:00:00")
        out = asyncio.run(env.run(ps.list_changed_task_paths, old_mtime + 1))

        assert len(out) == 2
        slugs = [r["slug"] for r in out]
        assert "old" not in slugs
        assert "mid" in slugs
        assert "new" in slugs
        # Sorted ascending by mtime
        assert out[0]["mtime"] <= out[1]["mtime"]
        # Lightweight shape — no frontmatter, no body
        for ref in out:
            assert set(ref.keys()) == {"path", "slug", "matter_slug", "mtime"}
        # matter_slug resolution still works
        mid = next(r for r in out if r["slug"] == "mid")
        assert mid["matter_slug"] == "alpha"
        new = next(r for r in out if r["slug"] == "new")
        assert new["matter_slug"] == "beta"

    def test_fetch_task_records_batch_returns_full_shape(
        self, monkeypatch,
    ):
        """The batch activity must return the same TaskRecord shape
        that the legacy fetch_changed_tasks emitted, so the downstream
        sync_task_to_plane consumer is unchanged."""
        from src.activities import plane_sync as ps

        get_calls: list[str] = []

        class FakeHttp:
            async def get(self, url):
                get_calls.append(url)

                class FakeResp:
                    status_code = 200
                    def raise_for_status(self): pass
                    def json(self_inner):
                        # Echo a synthesised record per path
                        path = url.split("/api/v1/vault/records/")[-1]
                        slug = path.rsplit("/", 1)[-1].replace(".md", "")
                        return {
                            "path": path,
                            "frontmatter": {
                                "name": f"Task {slug}",
                                "created": "2026-04-20T00:00:00",
                                "matter": "alpha",
                            },
                            "body": f"# {slug}\n\nbody content",
                        }
                return FakeResp()

        class FakeVaultClient:
            def __init__(self, *a, **kw):
                self._client = FakeHttp()

            async def close(self):
                pass

        monkeypatch.setattr(ps, "VaultClient", FakeVaultClient)

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        out = asyncio.run(
            env.run(
                ps.fetch_task_records_batch,
                ["task/a.md", "task/b.md", "task/c.md"],
            )
        )
        assert len(out) == 3
        # Issued one HTTP GET per path
        assert len(get_calls) == 3
        for rec in out:
            # Full TaskRecord shape
            assert set(rec.keys()) == {
                "slug", "path", "frontmatter", "matter_slug", "body", "mtime",
            }
            assert rec["matter_slug"] == "alpha"
            assert rec["body"].startswith("# ")

    def test_fetch_task_records_batch_drops_404s(self, monkeypatch):
        """A path that 404s mid-batch (race with deletion) gets
        silently dropped rather than aborting the whole batch."""
        import httpx

        from src.activities import plane_sync as ps

        class FakeHttp:
            async def get(self, url):
                # 404 only for the second path
                if "/missing.md" in url:
                    class FakeResp:
                        status_code = 404
                        def raise_for_status(self_inner):
                            req = httpx.Request("GET", url)
                            resp = httpx.Response(404, request=req)
                            raise httpx.HTTPStatusError(
                                "gone", request=req, response=resp,
                            )
                        def json(self_inner): return {}
                    return FakeResp()
                # Otherwise return a normal record
                class OkResp:
                    status_code = 200
                    def raise_for_status(self_inner): pass
                    def json(self_inner):
                        path = url.split("/api/v1/vault/records/")[-1]
                        return {
                            "path": path,
                            "frontmatter": {
                                "created": "2026-04-20T00:00:00",
                            },
                            "body": "ok",
                        }
                return OkResp()

        class FakeVaultClient:
            def __init__(self, *a, **kw):
                self._client = FakeHttp()

            async def close(self):
                pass

        monkeypatch.setattr(ps, "VaultClient", FakeVaultClient)

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        out = asyncio.run(
            env.run(
                ps.fetch_task_records_batch,
                ["task/a.md", "task/missing.md", "task/c.md"],
            )
        )
        # Two records survived; the 404 was dropped silently
        assert len(out) == 2
        assert {r["slug"] for r in out} == {"a", "c"}

    def test_fetch_task_records_batch_empty_paths_short_circuits(
        self, monkeypatch,
    ):
        """An empty paths list must return [] without touching the
        vault HTTP client at all."""
        from src.activities import plane_sync as ps

        class TripwireClient:
            def __init__(self, *a, **kw):
                raise AssertionError(
                    "VaultClient must not be constructed for empty paths"
                )

        monkeypatch.setattr(ps, "VaultClient", TripwireClient)

        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        out = asyncio.run(env.run(ps.fetch_task_records_batch, []))
        assert out == []

    def test_task_fetch_batch_size_constant(self):
        """Pin the batch size so the workflow's per-call payload
        budget stays predictable."""
        from src.activities.plane_sync import TASK_FETCH_BATCH_SIZE
        # 100 keeps per-batch payload bounded at ~3.2 MB in the
        # worst case (frontmatter + 30 KB body cap × 100). Typical
        # records are ~2 KB so a real batch is more like 200 KB.
        assert TASK_FETCH_BATCH_SIZE == 100


# ---------------------------------------------------------------------------
# Staleness check (forward-sync conflict resolution)
# ---------------------------------------------------------------------------


class TestStalenessCheck:
    """Forward sync used to blind-PATCH every field regardless of whether
    Plane held a newer value, which silently overwrote Sir's Plane-side
    edits during reverse-sync delays. These tests pin the new staleness
    filter that runs before update_issue.
    """

    def _run_activity(
        self,
        *,
        task: dict,
        project_map: dict,
        issue_map: dict,
        fake_client,
        monkeypatch,
    ):
        from src.activities import plane_sync as ps
        monkeypatch.setattr(ps, "_plane_client_from_env", lambda: fake_client)
        # Bypass label-cache fetch: it's tested elsewhere and would
        # require a separate fake; for staleness tests we only care
        # about the get_issue → filter → maybe-update path.
        monkeypatch.setattr(
            ps, "_resolve_labels_with_cache",
            _AsyncReturn([])
        )
        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        return asyncio.run(
            env.run(
                ps.sync_task_to_plane, task, project_map, issue_map, None,
            )
        )

    def test_plane_newer_with_diverging_status_drops_status_field(
        self, monkeypatch, tmp_path,
    ):
        """The exact scenario Sir hit: Plane shows Done (state group
        completed), vault still says todo because reverse-sync hasn't
        landed the close yet. Without the staleness filter we'd PATCH
        state=todo and stomp Sir's close. WITH the filter, the state
        field is dropped from the PATCH.
        """
        from src.activities import plane_sync as ps
        # Point outbound signature storage at a clean tmpfile so we
        # don't pick up signatures from earlier tests.
        sig_path = tmp_path / "sigs.json"
        monkeypatch.setattr(ps, "_outbound_sigs_path", lambda: sig_path)

        update_calls: list[dict] = []

        class FakeClient:
            async def get_issue(self, project_id, issue_id):
                # Plane's API shape: state is a UUID string.
                # updated_at is much newer than any of our (absent)
                # signatures.
                return {
                    "id": issue_id,
                    "name": "pavilion",
                    "state": "DONE-STATE-UUID",
                    "priority": "none",
                    "updated_at": "2026-05-04T12:00:00.000000Z",
                    "labels": [],
                    "assignees": [],
                }

            async def update_issue(self, project_id, issue_id, body):
                update_calls.append({"project_id": project_id, "issue_id": issue_id, "body": body})
                return {}

            async def resolve_state_id(self, project_id, state_group):
                return None

            async def close(self):
                pass

        out = self._run_activity(
            task={
                "slug": "pavilion",
                "frontmatter": {
                    "name": "pavilion",
                    "status": "todo",  # vault says todo
                    "priority": "none",
                },
                "matter_slug": "alpha",
                "body": "",
            },
            project_map={"alpha": "prj-alpha"},
            issue_map={"pavilion": "iss-pavilion"},
            fake_client=FakeClient(),
            monkeypatch=monkeypatch,
        )

        # Assert the activity reported it deferred the field rather than
        # silently sending the stomp. update_issue should NOT have been
        # called (Plane is newer on every field that diverges).
        assert update_calls == [], (
            f"update_issue must not be called when Plane is newer; got {update_calls}"
        )
        assert out["action"] in ("skipped_no_diff", "deferred_by_staleness"), out

    def test_plane_matches_vault_skips_update(self, monkeypatch, tmp_path):
        """If Plane already has the same values, no PATCH should fire —
        the no-diff short-circuit is faster than a noop network round
        trip.
        """
        from src.activities import plane_sync as ps
        sig_path = tmp_path / "sigs.json"
        monkeypatch.setattr(ps, "_outbound_sigs_path", lambda: sig_path)

        update_calls: list[dict] = []

        class FakeClient:
            async def get_issue(self, project_id, issue_id):
                return {
                    "id": issue_id,
                    "name": "pavilion",
                    "state": None,
                    "priority": "none",
                    "updated_at": "2026-05-04T12:00:00.000000Z",
                    "labels": [],
                    "assignees": [],
                }

            async def update_issue(self, project_id, issue_id, body):
                update_calls.append({"body": body})
                return {}

            async def resolve_state_id(self, project_id, state_group):
                return None

            async def close(self):
                pass

        out = self._run_activity(
            task={
                "slug": "pavilion",
                "frontmatter": {"name": "pavilion", "priority": "none"},
                "matter_slug": "alpha",
                "body": "",
            },
            project_map={"alpha": "prj-alpha"},
            issue_map={"pavilion": "iss-pavilion"},
            fake_client=FakeClient(),
            monkeypatch=monkeypatch,
        )
        assert update_calls == [], (
            f"update_issue should not fire when no diff; got {update_calls}"
        )
        assert out["action"] in ("skipped_no_diff", "deferred_by_staleness"), out

    def test_our_recent_signature_allows_push_through(self, monkeypatch, tmp_path):
        """When our most recent outbound signature for the issue is at
        least as recent as Plane's updated_at, we own the state and the
        update_issue call MUST go through (this is the "echo" / round-
        trip case — without this carve-out we'd never push anything).
        """
        from src.activities import plane_sync as ps
        sig_path = tmp_path / "sigs.json"
        monkeypatch.setattr(ps, "_outbound_sigs_path", lambda: sig_path)

        # Seed an outbound signature 1s AFTER plane.updated_at.
        plane_updated_iso = "2026-05-04T12:00:00.000000Z"
        plane_updated_ms = ps._parse_plane_updated_at_ms(plane_updated_iso)
        assert plane_updated_ms is not None
        sig_payload = {"sig-issue": {"hash": "x", "ts": plane_updated_ms + 1000}}
        sig_path.write_text(json.dumps(sig_payload))

        update_calls: list[dict] = []

        class FakeClient:
            async def get_issue(self, project_id, issue_id):
                return {
                    "id": issue_id,
                    "name": "different-name-on-plane",  # diverges from vault
                    "state": "OLD-STATE",
                    "priority": "none",
                    "updated_at": plane_updated_iso,
                    "labels": [],
                    "assignees": [],
                }

            async def update_issue(self, project_id, issue_id, body):
                update_calls.append({"body": body})
                return {}

            async def resolve_state_id(self, project_id, state_group):
                return None

            async def close(self):
                pass

        out = self._run_activity(
            task={
                "slug": "renamed",
                "frontmatter": {"name": "new-vault-name", "priority": "none"},
                "matter_slug": "alpha",
                "body": "",
            },
            project_map={"alpha": "prj-alpha"},
            issue_map={"renamed": "sig-issue"},
            fake_client=FakeClient(),
            monkeypatch=monkeypatch,
        )
        assert len(update_calls) == 1, (
            f"update_issue must fire when our signature is authoritative; got {update_calls}"
        )


class _AsyncReturn:
    """Tiny coroutine helper for monkeypatching async functions in tests."""
    def __init__(self, value):
        self._value = value

    async def __call__(self, *args, **kwargs):
        return self._value
