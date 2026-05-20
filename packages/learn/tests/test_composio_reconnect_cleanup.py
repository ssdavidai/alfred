"""Tests for ComposioReconnectCleanupWorkflow + composio_reconnect activities.

The workflow is the Temporal-scheduled safety net for the Composio
reconnect ledger written by ctrl-api after PR #646. These tests cover:

* Activities (read/verify/delete/remove) in isolation via
  ``ActivityEnvironment``, with the Composio SDK calls stubbed at the
  ``_get_client`` layer so no network I/O happens.
* The full workflow via ``WorkflowEnvironment.start_time_skipping()``
  with stub activities registered under the same names — exercises the
  per-entry try/except boundary, the future-skip filter, and each of
  the four terminal outcomes (delete + ledger-remove, purge on 404,
  keep on INITIATED, keep on FAILED).
* Per-entry error isolation: one verify call raising must not strand
  the other ledger entries.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.testing import ActivityEnvironment, WorkflowEnvironment
from temporalio.worker import Worker

from src.activities.composio_reconnect import (
    _atomic_write_json,
    _normalize_entry,
    delete_old_connection,
    read_reconnect_ledger,
    remove_ledger_entry,
    verify_new_connection_active,
)
from src.workflows.composio_reconnect_cleanup import (
    ComposioReconnectCleanupWorkflow,
    ReconnectCleanupResult,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ledger_entry(
    *,
    old: str,
    new: str,
    cleanup_after_ms: int,
    toolkit: str = "gmail",
    user_id: str = "tenant-1",
    scheduled_at: int | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a ledger entry in the ctrl-api shape."""
    base: dict[str, Any] = {
        "old_connection_id": old,
        "new_connection_id": new,
        "toolkit": toolkit,
        "user_id": user_id,
        "scheduled_at": scheduled_at if scheduled_at is not None else int(time.time() * 1000),
        # ctrl-api writes ``cleanup_after``; we accept both names so we
        # mirror that here for round-trip realism.
        "cleanup_after": cleanup_after_ms,
    }
    if extra:
        base.update(extra)
    return base


# ---------------------------------------------------------------------------
# _normalize_entry
# ---------------------------------------------------------------------------


class TestNormalizeEntry:
    def test_full_entry_normalized(self):
        raw = _ledger_entry(old="o1", new="n1", cleanup_after_ms=1234)
        out = _normalize_entry(raw)
        assert out is not None
        assert out["old_connection_id"] == "o1"
        assert out["new_connection_id"] == "n1"
        assert out["cleanup_after_ms"] == 1234

    def test_accepts_cleanup_after_ms_alias(self):
        raw = {
            "old_connection_id": "o",
            "new_connection_id": "n",
            "cleanup_after_ms": 9999,
        }
        out = _normalize_entry(raw)
        assert out is not None
        assert out["cleanup_after_ms"] == 9999

    def test_missing_old_id_returns_none(self):
        assert _normalize_entry({"new_connection_id": "n"}) is None

    def test_missing_new_id_returns_none(self):
        assert _normalize_entry({"old_connection_id": "o"}) is None

    def test_non_dict_returns_none(self):
        assert _normalize_entry("nope") is None
        assert _normalize_entry(None) is None

    def test_garbage_cleanup_value_zeroed(self):
        out = _normalize_entry(
            {"old_connection_id": "o", "new_connection_id": "n", "cleanup_after": "abc"}
        )
        assert out is not None
        assert out["cleanup_after_ms"] == 0


# ---------------------------------------------------------------------------
# read_reconnect_ledger
# ---------------------------------------------------------------------------


class TestReadReconnectLedger:
    async def test_missing_file_returns_empty(self, monkeypatch, tmp_path):
        monkeypatch.setenv(
            "COMPOSIO_RECONNECT_LEDGER_PATH",
            str(tmp_path / "missing.json"),
        )
        env = ActivityEnvironment()
        out = await env.run(read_reconnect_ledger)
        assert out == []

    async def test_malformed_file_returns_empty(self, monkeypatch, tmp_path):
        path = tmp_path / "ledger.json"
        path.write_text("{not valid json")
        monkeypatch.setenv("COMPOSIO_RECONNECT_LEDGER_PATH", str(path))
        env = ActivityEnvironment()
        out = await env.run(read_reconnect_ledger)
        assert out == []

    async def test_non_array_file_returns_empty(self, monkeypatch, tmp_path):
        path = tmp_path / "ledger.json"
        path.write_text(json.dumps({"not": "an array"}))
        monkeypatch.setenv("COMPOSIO_RECONNECT_LEDGER_PATH", str(path))
        env = ActivityEnvironment()
        out = await env.run(read_reconnect_ledger)
        assert out == []

    async def test_drops_malformed_entries(self, monkeypatch, tmp_path):
        path = tmp_path / "ledger.json"
        path.write_text(json.dumps([
            _ledger_entry(old="o1", new="n1", cleanup_after_ms=100),
            {"only_old": "x"},  # malformed
            _ledger_entry(old="o2", new="n2", cleanup_after_ms=200),
        ]))
        monkeypatch.setenv("COMPOSIO_RECONNECT_LEDGER_PATH", str(path))
        env = ActivityEnvironment()
        out = await env.run(read_reconnect_ledger)
        assert len(out) == 2
        ids = {e["old_connection_id"] for e in out}
        assert ids == {"o1", "o2"}


# ---------------------------------------------------------------------------
# remove_ledger_entry
# ---------------------------------------------------------------------------


class TestRemoveLedgerEntry:
    async def test_removes_matching_entry(self, monkeypatch, tmp_path):
        path = tmp_path / "ledger.json"
        path.write_text(json.dumps([
            _ledger_entry(old="o1", new="n1", cleanup_after_ms=100),
            _ledger_entry(old="o2", new="n2", cleanup_after_ms=200),
        ]))
        monkeypatch.setenv("COMPOSIO_RECONNECT_LEDGER_PATH", str(path))
        env = ActivityEnvironment()

        removed = await env.run(remove_ledger_entry, "o1")
        assert removed is True

        # Re-read disk and verify only o2 remains
        with open(path) as fh:
            remaining = json.load(fh)
        assert len(remaining) == 1
        assert remaining[0]["old_connection_id"] == "o2"

    async def test_no_match_returns_false(self, monkeypatch, tmp_path):
        path = tmp_path / "ledger.json"
        path.write_text(json.dumps([
            _ledger_entry(old="o1", new="n1", cleanup_after_ms=100),
        ]))
        monkeypatch.setenv("COMPOSIO_RECONNECT_LEDGER_PATH", str(path))
        env = ActivityEnvironment()

        removed = await env.run(remove_ledger_entry, "no-such-id")
        assert removed is False
        # Original file unchanged
        with open(path) as fh:
            remaining = json.load(fh)
        assert len(remaining) == 1

    async def test_missing_file_returns_false(self, monkeypatch, tmp_path):
        monkeypatch.setenv(
            "COMPOSIO_RECONNECT_LEDGER_PATH",
            str(tmp_path / "no-file.json"),
        )
        env = ActivityEnvironment()
        removed = await env.run(remove_ledger_entry, "o1")
        assert removed is False

    async def test_atomic_write_round_trip(self, tmp_path):
        # Direct unit test for the atomic writer used by remove_ledger_entry.
        path = tmp_path / "x.json"
        _atomic_write_json(str(path), [{"a": 1}])
        with open(path) as fh:
            assert json.load(fh) == [{"a": 1}]


# ---------------------------------------------------------------------------
# verify_new_connection_active + delete_old_connection — Composio SDK stubbed
# ---------------------------------------------------------------------------


class _FakeAccount:
    """Stand-in for Composio's ConnectedAccountRetrieveResponse pydantic model."""
    def __init__(self, status: str):
        self.status = status


class _FakeConnectedAccounts:
    def __init__(
        self,
        *,
        get_returns: Any | None = None,
        get_raises: Exception | None = None,
        delete_raises: Exception | None = None,
    ):
        self.get_returns = get_returns
        self.get_raises = get_raises
        self.delete_raises = delete_raises
        self.delete_calls: list[str] = []

    def get(self, nanoid: str):
        if self.get_raises is not None:
            raise self.get_raises
        return self.get_returns

    def delete(self, nanoid: str):
        self.delete_calls.append(nanoid)
        if self.delete_raises is not None:
            raise self.delete_raises
        return {"id": nanoid, "deleted": True}


class _FakeClient:
    def __init__(self, accounts: _FakeConnectedAccounts):
        self.connected_accounts = accounts


class _NotFound(Exception):
    """Stand-in for a Composio NotFoundError-shaped exception.

    The real activity catches by class name lookup against the SDK's
    exceptions module; for tests we use the status_code fallback path
    by setting ``status_code = 404``.
    """
    status_code = 404


@pytest.fixture
def patch_composio_client(monkeypatch):
    """Return a helper that installs a fake Composio client + returns the spy."""
    def _install(accounts: _FakeConnectedAccounts) -> _FakeConnectedAccounts:
        fake_client = _FakeClient(accounts)
        # Patch the lazy getter rather than the singleton — keeps the
        # rest of the module's import surface intact.
        import src.integrations.composio_client as cc_mod
        monkeypatch.setattr(cc_mod, "_get_client", lambda: fake_client)
        return accounts
    return _install


class TestVerifyNewConnectionActive:
    async def test_returns_active_status(self, patch_composio_client):
        spy = patch_composio_client(_FakeConnectedAccounts(
            get_returns=_FakeAccount(status="ACTIVE"),
        ))
        env = ActivityEnvironment()
        out = await env.run(verify_new_connection_active, "new-1")
        assert out == {"status": "ACTIVE", "exists": True}

    async def test_uppercases_status(self, patch_composio_client):
        patch_composio_client(_FakeConnectedAccounts(
            get_returns=_FakeAccount(status="initiated"),
        ))
        env = ActivityEnvironment()
        out = await env.run(verify_new_connection_active, "new-1")
        assert out["status"] == "INITIATED"
        assert out["exists"] is True

    async def test_404_returns_exists_false(self, patch_composio_client):
        patch_composio_client(_FakeConnectedAccounts(
            get_raises=_NotFound("gone"),
        ))
        env = ActivityEnvironment()
        out = await env.run(verify_new_connection_active, "new-vanished")
        assert out == {"status": "", "exists": False}

    async def test_other_error_propagates(self, patch_composio_client):
        patch_composio_client(_FakeConnectedAccounts(
            get_raises=RuntimeError("composio is down"),
        ))
        env = ActivityEnvironment()
        with pytest.raises(Exception):
            await env.run(verify_new_connection_active, "new-x")


class TestDeleteOldConnection:
    async def test_happy_path(self, patch_composio_client):
        spy = patch_composio_client(_FakeConnectedAccounts())
        env = ActivityEnvironment()
        out = await env.run(delete_old_connection, "old-1")
        assert out is True
        assert spy.delete_calls == ["old-1"]

    async def test_404_treated_as_success(self, patch_composio_client):
        patch_composio_client(_FakeConnectedAccounts(
            delete_raises=_NotFound("already gone"),
        ))
        env = ActivityEnvironment()
        out = await env.run(delete_old_connection, "old-1")
        assert out is True

    async def test_other_error_propagates(self, patch_composio_client):
        patch_composio_client(_FakeConnectedAccounts(
            delete_raises=RuntimeError("composio is down"),
        ))
        env = ActivityEnvironment()
        with pytest.raises(Exception):
            await env.run(delete_old_connection, "old-1")


# ---------------------------------------------------------------------------
# Workflow execution with stub activities
# ---------------------------------------------------------------------------


_CALL_LOG: list[tuple[str, Any]] = []


def _reset_call_log() -> None:
    _CALL_LOG.clear()


def _make_stubs(
    *,
    ledger: list[dict[str, Any]],
    verify_outcomes: dict[str, dict[str, Any]] | None = None,
    verify_raises: dict[str, Exception] | None = None,
    delete_raises: dict[str, Exception] | None = None,
) -> list:
    """Build replacement activities registered under the production names.

    The workflow calls activities by name (via ``with workflow.unsafe.imports_passed_through()``
    + ``execute_activity(func)``). Stubbing under the same name short-
    circuits the production code paths and lets us drive every branch
    deterministically.
    """
    verify_outcomes = verify_outcomes or {}
    verify_raises = verify_raises or {}
    delete_raises = delete_raises or {}

    # Mutable copy so remove_ledger_entry stub can mutate it.
    ledger_state: list[dict[str, Any]] = [dict(e) for e in ledger]

    @activity.defn(name="read_reconnect_ledger")
    async def stub_read() -> list[dict[str, Any]]:
        _CALL_LOG.append(("read", None))
        # Return a normalized copy that matches what the production
        # activity would emit (cleanup_after_ms key).
        out = []
        for e in ledger_state:
            cleanup = e.get("cleanup_after_ms")
            if cleanup is None:
                cleanup = e.get("cleanup_after")
            out.append({
                "old_connection_id": e["old_connection_id"],
                "new_connection_id": e["new_connection_id"],
                "toolkit": e.get("toolkit", ""),
                "user_id": e.get("user_id", ""),
                "scheduled_at": int(e.get("scheduled_at") or 0),
                "cleanup_after_ms": int(cleanup or 0),
            })
        return out

    @activity.defn(name="verify_new_connection_active")
    async def stub_verify(new_id: str) -> dict[str, Any]:
        _CALL_LOG.append(("verify", new_id))
        if new_id in verify_raises:
            raise verify_raises[new_id]
        return verify_outcomes.get(new_id, {"status": "ACTIVE", "exists": True})

    @activity.defn(name="delete_old_connection")
    async def stub_delete(old_id: str) -> bool:
        _CALL_LOG.append(("delete", old_id))
        if old_id in delete_raises:
            raise delete_raises[old_id]
        return True

    @activity.defn(name="remove_ledger_entry")
    async def stub_remove(old_id: str) -> bool:
        _CALL_LOG.append(("remove", old_id))
        before = len(ledger_state)
        ledger_state[:] = [
            e for e in ledger_state if e["old_connection_id"] != old_id
        ]
        return len(ledger_state) < before

    return [stub_read, stub_verify, stub_delete, stub_remove], ledger_state


async def _run_workflow(stubs: list) -> ReconnectCleanupResult:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"reconnect-cleanup-test-{uuid.uuid4()}"
        # Disable the workflow class's deadlock detector for stub-heavy
        # tests where we add no artificial sleep — defaults are fine
        # but be explicit.
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[ComposioReconnectCleanupWorkflow],
            activities=stubs,
        )
        async with worker:
            result = await client.execute_workflow(
                ComposioReconnectCleanupWorkflow.run,
                id=f"reconnect-cleanup-test-run-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


# Convenience: a "clearly past" + "clearly future" cleanup_after.
_PAST_MS = 1_000  # 1970-ish
_FUTURE_MS = 9_999_999_999_999  # year ~2286


class TestEmptyLedger:
    def test_no_op(self):
        _reset_call_log()
        stubs, _ = _make_stubs(ledger=[])
        result = asyncio.run(_run_workflow(stubs))
        assert result.entries_total == 0
        assert result.deleted == []
        assert result.errors == []
        # Only the read happened
        assert [c[0] for c in _CALL_LOG] == ["read"]


class TestFutureSkip:
    def test_skips_entry_before_grace_elapses(self):
        _reset_call_log()
        stubs, ledger_state = _make_stubs(
            ledger=[
                _ledger_entry(old="o-future", new="n-future", cleanup_after_ms=_FUTURE_MS),
            ],
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.entries_total == 1
        assert result.entries_skipped_future == 1
        assert result.deleted == []
        # Verify must NOT have been called
        verbs = [c[0] for c in _CALL_LOG]
        assert "verify" not in verbs
        assert "delete" not in verbs
        assert "remove" not in verbs
        # Ledger entry still present
        assert len(ledger_state) == 1


class TestActiveDeletes:
    def test_active_new_triggers_delete_and_remove(self):
        _reset_call_log()
        stubs, ledger_state = _make_stubs(
            ledger=[
                _ledger_entry(old="o-active", new="n-active", cleanup_after_ms=_PAST_MS),
            ],
            verify_outcomes={"n-active": {"status": "ACTIVE", "exists": True}},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.entries_total == 1
        assert result.deleted == ["o-active"]
        assert result.errors == []
        # Workflow ordered: verify → delete → remove
        verbs = [c for c in _CALL_LOG if c[0] in {"verify", "delete", "remove"}]
        assert verbs == [
            ("verify", "n-active"),
            ("delete", "o-active"),
            ("remove", "o-active"),
        ]
        # Ledger now empty
        assert ledger_state == []


class TestInitiatedKeptAlone:
    def test_initiated_new_keeps_ledger_entry(self):
        _reset_call_log()
        stubs, ledger_state = _make_stubs(
            ledger=[
                _ledger_entry(old="o-init", new="n-init", cleanup_after_ms=_PAST_MS),
            ],
            verify_outcomes={"n-init": {"status": "INITIATED", "exists": True}},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.entries_total == 1
        assert result.kept_initiated == ["o-init"]
        assert result.deleted == []
        assert result.purged == []
        assert result.errors == []
        # No delete, no remove
        verbs = [c[0] for c in _CALL_LOG]
        assert "delete" not in verbs
        assert "remove" not in verbs
        # Ledger entry still present
        assert len(ledger_state) == 1


class TestFailedKeptAlone:
    def test_failed_new_keeps_ledger_entry(self):
        _reset_call_log()
        stubs, ledger_state = _make_stubs(
            ledger=[
                _ledger_entry(old="o-failed", new="n-failed", cleanup_after_ms=_PAST_MS),
            ],
            verify_outcomes={"n-failed": {"status": "FAILED", "exists": True}},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.kept_failed == ["o-failed"]
        assert result.deleted == []
        # Ledger entry still present
        assert len(ledger_state) == 1

    def test_expired_also_kept(self):
        _reset_call_log()
        stubs, ledger_state = _make_stubs(
            ledger=[
                _ledger_entry(old="o-exp", new="n-exp", cleanup_after_ms=_PAST_MS),
            ],
            verify_outcomes={"n-exp": {"status": "EXPIRED", "exists": True}},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.kept_failed == ["o-exp"]
        assert len(ledger_state) == 1


class TestPurgedOnVanishedNew:
    def test_404_on_new_purges_ledger(self):
        _reset_call_log()
        stubs, ledger_state = _make_stubs(
            ledger=[
                _ledger_entry(old="o-purge", new="n-gone", cleanup_after_ms=_PAST_MS),
            ],
            verify_outcomes={"n-gone": {"status": "", "exists": False}},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.purged == ["o-purge"]
        assert result.deleted == []
        # Delete must NOT have been called — there's no point if the new is gone
        verbs = [c[0] for c in _CALL_LOG]
        assert "delete" not in verbs
        # Ledger now empty
        assert ledger_state == []


class TestPerEntryErrorIsolation:
    def test_one_verify_failure_does_not_strand_other_entries(self):
        _reset_call_log()
        stubs, ledger_state = _make_stubs(
            ledger=[
                _ledger_entry(old="o-blip", new="n-blip", cleanup_after_ms=_PAST_MS),
                _ledger_entry(old="o-ok", new="n-ok", cleanup_after_ms=_PAST_MS),
            ],
            verify_outcomes={"n-ok": {"status": "ACTIVE", "exists": True}},
            verify_raises={"n-blip": RuntimeError("transient composio outage")},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.entries_total == 2
        # Healthy entry still got cleaned up
        assert result.deleted == ["o-ok"]
        # Failure recorded for the bad one
        assert any("n-blip" in e for e in result.errors)
        # Bad entry stayed in the ledger; good one was removed
        assert len(ledger_state) == 1
        assert ledger_state[0]["old_connection_id"] == "o-blip"

    def test_delete_failure_keeps_ledger_entry(self):
        _reset_call_log()
        stubs, ledger_state = _make_stubs(
            ledger=[
                _ledger_entry(old="o-deletefail", new="n-active", cleanup_after_ms=_PAST_MS),
            ],
            verify_outcomes={"n-active": {"status": "ACTIVE", "exists": True}},
            delete_raises={"o-deletefail": RuntimeError("composio delete failed")},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.deleted == []
        assert any("o-deletefail" in e for e in result.errors)
        # Ledger entry untouched — next tick will retry the whole flow
        assert len(ledger_state) == 1
