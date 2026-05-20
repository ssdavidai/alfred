"""Tests for the hourly Plane reconciliation workflow + activity.

The reconciliation workflow detects Plane issues deleted via the REST API
(which Plane 1.3.0 does NOT emit webhooks for) by comparing the forward-sync
``issue_map`` against the live Plane issue set. Stale entries → archive
the vault task + drop the map entry.

Coverage:
* Stale slug detection (plane_id not in live set → flagged).
* Vault task archived via the shared helper.
* No-op when every map entry matches Plane.
* Empty project_map = immediate no-op.
* Workflow-level assertions: activity-return counters plumbed through
  into ``PlaneReconciliationResult``.
* Feature flag off → started=False, no activity call.
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


# ---------------------------------------------------------------------------
# Activity-level tests (exercise the real reconcile_plane_deletes)
# ---------------------------------------------------------------------------


class TestReconcileActivityStaleDetection:
    """Stale detection: issue_map entry whose plane_id isn't in the live
    set triggers the archive path."""

    def _run(self, monkeypatch, *, cursor_state, live_ids, vault_records=None):
        """Drive reconcile_plane_deletes with in-memory fakes.

        ``vault_records`` is {path: frontmatter_dict} — missing paths 404.
        Returns (result_counters, captured_archives, cursor_written).
        """
        from src.activities import plane_reconciliation as pr
        from src.activities import plane_sync as ps

        # --- cursor I/O --------------------------------------------------
        cursor_payload = json.dumps(cursor_state)
        tmp_cursor: dict[str, str] = {"contents": cursor_payload}

        def fake_cursor_path(*a, **kw):
            # Path-like stub returning a sentinel; actual I/O intercepted below.
            class StubPath:
                def __str__(self):
                    return "/tmp/fake_cursor.json"
                parent = None
                name = "fake_cursor.json"
                def exists(self):
                    return tmp_cursor["contents"] is not None
                def open(self, mode="r", encoding=None):
                    from io import StringIO
                    return StringIO(tmp_cursor["contents"])
            return StubPath()

        def fake_load_cursor(path):
            raw = json.loads(tmp_cursor["contents"])
            return {
                "last_vault_mtime": float(raw.get("last_vault_mtime", 0.0) or 0.0),
                "project_map": dict(raw.get("project_map") or {}),
                "issue_map": dict(raw.get("issue_map") or {}),
            }

        cursor_writes: list[str] = []

        def fake_atomic_write(path, payload):
            cursor_writes.append(payload)
            tmp_cursor["contents"] = payload

        monkeypatch.setattr(pr, "_cursor_path", fake_cursor_path)
        monkeypatch.setattr(pr, "_load_cursor_from_disk", fake_load_cursor)
        monkeypatch.setattr(pr, "_atomic_write", fake_atomic_write)

        # --- Plane client fake ------------------------------------------
        class FakePlaneClient:
            workspace_slug = "ws"
            async def _get_client(self):
                return self
            async def close(self):
                pass
            async def get(self, path, params=None):  # used by _list_project_issues
                # Return a response-like object
                class Resp:
                    status_code = 200
                    headers = {}
                    def json(_self):
                        # Emit every live id once, flat list shape (the
                        # simplest pagination branch). Filter by project_id
                        # embedded in path so different projects hand back
                        # different subsets.
                        for pid in cursor_state.get("project_map", {}).values():
                            if f"/projects/{pid}/" in path:
                                return [
                                    {"id": uid} for uid in live_ids.get(pid, [])
                                ]
                        return []
                    def raise_for_status(_self):
                        pass
                return Resp()

        monkeypatch.setattr(
            pr, "_plane_client_from_env", lambda: FakePlaneClient()
        )

        # --- Vault client fake ------------------------------------------
        archive_calls: list[tuple[str, str]] = []

        async def fake_archive(slug, path):
            archive_calls.append((slug, path))

        monkeypatch.setattr(
            ps, "_archive_vault_task_from_plane_delete", fake_archive,
        )
        # Also patch the symbol the reconciliation module imports at load.
        monkeypatch.setattr(
            pr, "_archive_vault_task_from_plane_delete", fake_archive,
        )

        class FakeVaultClient:
            def __init__(self, *a, **kw):
                pass
            async def close(self):
                pass
            async def read_record(self, path):
                if vault_records and path in vault_records:
                    return {"frontmatter": dict(vault_records[path])}
                import httpx
                req = httpx.Request("GET", "http://fake/")
                resp = httpx.Response(404, request=req)
                raise httpx.HTTPStatusError(
                    "not found", request=req, response=resp,
                )

        monkeypatch.setattr(pr, "VaultClient", FakeVaultClient)

        # Speed up the activity — disable the per-page throttle.
        monkeypatch.setattr(pr, "_THROTTLE_SECONDS", 0.0)

        # Skip the delay in asyncio.sleep paths that the test doesn't need.
        async def fast_sleep(s):
            return
        monkeypatch.setattr(pr.asyncio, "sleep", fast_sleep)

        # --- Run ---------------------------------------------------------
        from temporalio.testing import ActivityEnvironment
        env = ActivityEnvironment()
        counters = asyncio.run(env.run(pr.reconcile_plane_deletes))
        return counters, archive_calls, cursor_writes

    def test_stale_slug_detected_and_archived(self, monkeypatch):
        cursor = {
            "last_vault_mtime": 500.0,
            "project_map": {"alpha": "prj-alpha"},
            "issue_map": {
                "still-here": "iss-live",
                "rest-deleted": "iss-gone",
            },
        }
        live = {"prj-alpha": ["iss-live"]}  # iss-gone missing
        vault = {
            "task/rest-deleted.md": {"name": "Gone", "archived": False},
        }
        counters, archives, writes = self._run(
            monkeypatch,
            cursor_state=cursor,
            live_ids=live,
            vault_records=vault,
        )
        assert counters["stale_map_entries"] == 1
        assert counters["vault_archived"] == 1
        assert counters["projects_scanned"] == 1
        assert archives == [("rest-deleted", "task/rest-deleted.md")]
        # Cursor written — issue_map no longer contains 'rest-deleted'
        assert len(writes) == 1
        written = json.loads(writes[0])
        assert "rest-deleted" not in written["issue_map"]
        assert written["issue_map"]["still-here"] == "iss-live"
        # project_map + last_vault_mtime preserved
        assert written["project_map"] == {"alpha": "prj-alpha"}
        assert written["last_vault_mtime"] == 500.0

    def test_all_entries_match_is_noop(self, monkeypatch):
        cursor = {
            "last_vault_mtime": 123.0,
            "project_map": {"alpha": "prj-alpha"},
            "issue_map": {"a": "iss-1", "b": "iss-2"},
        }
        live = {"prj-alpha": ["iss-1", "iss-2"]}
        counters, archives, writes = self._run(
            monkeypatch,
            cursor_state=cursor,
            live_ids=live,
            vault_records={},
        )
        assert counters["stale_map_entries"] == 0
        assert counters["vault_archived"] == 0
        assert archives == []
        # Cursor still written (atomic write is unconditional, preserves state)
        assert len(writes) == 1
        written = json.loads(writes[0])
        assert written["issue_map"] == {"a": "iss-1", "b": "iss-2"}

    def test_empty_project_map_short_circuits(self, monkeypatch):
        cursor = {
            "last_vault_mtime": 0.0,
            "project_map": {},
            "issue_map": {},
        }
        counters, archives, writes = self._run(
            monkeypatch,
            cursor_state=cursor,
            live_ids={},
            vault_records={},
        )
        assert counters["projects_scanned"] == 0
        assert counters["plane_issues_found"] == 0
        assert archives == []
        # No cursor written — nothing to do.
        assert writes == []

    def test_idempotent_second_run_noop(self, monkeypatch):
        """Running twice back-to-back with the same state + live set
        should archive nothing the second time (already pruned)."""
        cursor = {
            "last_vault_mtime": 100.0,
            "project_map": {"alpha": "prj-alpha"},
            "issue_map": {"gone": "iss-gone"},
        }
        live = {"prj-alpha": []}  # gone is gone
        vault = {"task/gone.md": {"name": "G", "archived": False}}
        c1, a1, w1 = self._run(
            monkeypatch,
            cursor_state=cursor,
            live_ids=live,
            vault_records=vault,
        )
        assert c1["vault_archived"] == 1
        assert a1 == [("gone", "task/gone.md")]
        # Second run: now the cursor has issue_map already pruned + the
        # vault record already archived. Feed the written state back in
        # and observe zero-op.
        written = json.loads(w1[0])
        c2, a2, w2 = self._run(
            monkeypatch,
            cursor_state=written,
            live_ids=live,
            vault_records={"task/gone.md": {"name": "G", "archived": True}},
        )
        assert c2["stale_map_entries"] == 0
        assert c2["vault_archived"] == 0
        assert a2 == []

    def test_already_archived_vault_task_is_pruned_only(self, monkeypatch):
        """If the vault task is already archived (e.g. forward-sync beat
        us to it), the reconciler must prune the map entry but not
        re-archive or error."""
        cursor = {
            "last_vault_mtime": 0.0,
            "project_map": {"alpha": "prj-alpha"},
            "issue_map": {"ghost": "iss-ghost"},
        }
        live = {"prj-alpha": []}
        vault = {"task/ghost.md": {"name": "G", "archived": True}}
        counters, archives, writes = self._run(
            monkeypatch,
            cursor_state=cursor,
            live_ids=live,
            vault_records=vault,
        )
        assert counters["stale_map_entries"] == 1
        assert counters["vault_archived"] == 0  # NOT re-archived
        assert archives == []  # archive helper NOT called
        written = json.loads(writes[0])
        assert "ghost" not in written["issue_map"]


# ---------------------------------------------------------------------------
# Workflow-level tests (stub the activity; verify result wiring + flag)
# ---------------------------------------------------------------------------


_CALL_LOG: list[tuple[str, Any]] = []


def _reset_call_log() -> None:
    _CALL_LOG.clear()


async def _run_workflow(stubs: list):
    from src.workflows.plane_reconciliation import PlaneReconciliationWorkflow

    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"plane-recon-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[PlaneReconciliationWorkflow],
            activities=stubs,
        )
        async with worker:
            return await client.execute_workflow(
                PlaneReconciliationWorkflow.run,
                id=f"plane-recon-test-run-{uuid.uuid4()}",
                task_queue=tq,
            )


class TestReconciliationWorkflow:
    def test_feature_flag_off_short_circuits(self):
        _reset_call_log()

        @activity.defn(name="plane_reconciliation_is_enabled")
        async def ena() -> bool:
            _CALL_LOG.append(("enabled", False))
            return False

        @activity.defn(name="reconcile_plane_deletes")
        async def rec() -> dict:
            _CALL_LOG.append(("reconcile", None))
            raise AssertionError("reconcile must not fire when flag is off")

        result = asyncio.run(_run_workflow([ena, rec]))
        assert result.started is False
        assert "PLANE_SYNC_ENABLED" in result.skipped_reason
        assert [c[0] for c in _CALL_LOG] == ["enabled"]

    def test_counters_plumb_through(self):
        _reset_call_log()

        @activity.defn(name="plane_reconciliation_is_enabled")
        async def ena() -> bool:
            return True

        @activity.defn(name="reconcile_plane_deletes")
        async def rec() -> dict:
            return {
                "projects_scanned": 3,
                "plane_issues_found": 42,
                "map_entries_checked": 50,
                "stale_map_entries": 2,
                "vault_archived": 2,
                "errors": 0,
                "early_exit": False,
            }

        result = asyncio.run(_run_workflow([ena, rec]))
        assert result.started is True
        assert result.projects_scanned == 3
        assert result.plane_issues_found == 42
        assert result.map_entries_checked == 50
        assert result.stale_map_entries == 2
        assert result.vault_archived == 2
        assert result.errors == 0
        assert result.early_exit is False

    def test_early_exit_flag_surfaces(self):
        @activity.defn(name="plane_reconciliation_is_enabled")
        async def ena() -> bool:
            return True

        @activity.defn(name="reconcile_plane_deletes")
        async def rec() -> dict:
            return {
                "projects_scanned": 100,
                "plane_issues_found": 10_001,
                "map_entries_checked": 0,
                "stale_map_entries": 0,
                "vault_archived": 0,
                "errors": 0,
                "early_exit": True,
            }

        result = asyncio.run(_run_workflow([ena, rec]))
        assert result.early_exit is True
        assert result.plane_issues_found == 10_001

    def test_defaults_when_activity_omits_fields(self):
        """If the activity returns a sparse dict (e.g. short-circuit on
        empty project_map), the workflow should surface zeros — no
        KeyError, no AttributeError."""
        @activity.defn(name="plane_reconciliation_is_enabled")
        async def ena() -> bool:
            return True

        @activity.defn(name="reconcile_plane_deletes")
        async def rec() -> dict:
            return {}  # sparse

        result = asyncio.run(_run_workflow([ena, rec]))
        assert result.started is True
        assert result.projects_scanned == 0
        assert result.stale_map_entries == 0
        assert result.vault_archived == 0
        assert result.errors == 0
        assert result.early_exit is False
