"""F34 — boot reconciler drops orphaned chore-* Temporal schedules.

A reset/re-onboard rewrites the user-chores .py + vault chore record but
Temporal schedules persist in Temporal's own store, leaving orphan
chore-<slug> schedules whose workflow class is unregistered (504 churn).
reconcile_chore_schedules deletes chore-* schedules whose slug has no
backing artifact (no .py AND no vault chore record); any backing keeps it
and only the chore- prefix is swept.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import scripts.register_schedules as mod


def _client_with_schedules(ids: list[str]):
    client = MagicMock()
    handle = MagicMock()
    handle.delete = AsyncMock()
    client.get_schedule_handle = MagicMock(return_value=handle)

    def _aiter():
        async def _gen():
            for sid in ids:
                yield MagicMock(id=sid)

        return _gen()

    # Mirror the real temporalio SDK: Client.list_schedules is an
    # ``async def`` that returns a ScheduleAsyncIterator, so calling it
    # yields a coroutine that must be awaited before ``async for``. An
    # AsyncMock returns a coroutine resolving to its return_value, which
    # is exactly that shape — so the un-awaited call would raise here.
    client.list_schedules = AsyncMock(side_effect=lambda: _aiter())
    return client, handle


def test_orphan_chore_schedule_is_deleted():
    client, handle = _client_with_schedules(
        ["chore-neoterra-prep-brief", "chore-watch-subscriptions", "al-judgment"]
    )
    # Only watch-subscriptions has a backing artifact.
    deleted = asyncio.run(
        mod.reconcile_chore_schedules(client, live_slugs={"watch-subscriptions"})
    )
    assert deleted == 1
    client.get_schedule_handle.assert_called_once_with("chore-neoterra-prep-brief")
    handle.delete.assert_awaited_once()


def test_non_chore_schedules_are_never_touched():
    # Built-in al-*/plane/steward schedules are never swept, and a backed
    # chore (money-day in live_slugs) is kept.
    client, handle = _client_with_schedules(
        ["al-judgment", "al-steward-sweep", "chore-money-day"]
    )
    deleted = asyncio.run(
        mod.reconcile_chore_schedules(client, live_slugs={"money-day"})
    )
    assert deleted == 0
    handle.delete.assert_not_awaited()


def test_list_failure_is_safe_noop():
    client = MagicMock()
    client.list_schedules = MagicMock(side_effect=RuntimeError("temporal down"))
    # Must not raise — a transient list failure skips reconciliation.
    assert asyncio.run(mod.reconcile_chore_schedules(client, live_slugs=set())) == 0


def test_delete_failure_does_not_abort_remaining():
    client, handle = _client_with_schedules(["chore-a", "chore-b"])
    handle.delete = AsyncMock(side_effect=[RuntimeError("blip"), None])
    # First delete failed, second succeeded → 1 counted, no exception.
    assert asyncio.run(mod.reconcile_chore_schedules(client, live_slugs=set())) == 1


def test_collect_live_slugs_unions_records_and_py(monkeypatch, tmp_path):
    # user-chores .py stems (snake_case) → slugified.
    (tmp_path / "morning_briefing.py").write_text("# chore\n")
    (tmp_path / "watch_subscriptions.py").write_text("# chore\n")
    monkeypatch.setattr(mod, "_USER_CHORES_DIR", str(tmp_path))

    async def _fake_vault_slugs():
        # F34b: _vault_chore_slugs now returns (slugs, ok).
        return {"money-day", "watch-subscriptions"}, True

    monkeypatch.setattr(mod, "_vault_chore_slugs", _fake_vault_slugs)
    slugs, ok = asyncio.run(mod._collect_live_chore_slugs())
    # Union of slugified .py stems + vault chore record slugs.
    assert ok is True
    assert "morning-briefing" in slugs
    assert "watch-subscriptions" in slugs
    assert "money-day" in slugs


# F34b — over-deletion bug (read "results" not "records"; SKIP all deletion
# when the authoritative vault read fails) + the recreate restorer.


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise mod.httpx.HTTPStatusError(
                "boom", request=None, response=None,
            )


class _FakeAsyncClient:
    """Async-context-manager stand-in for httpx.AsyncClient."""

    def __init__(self, *, get_result=None, get_exc=None, **_kwargs):
        self._get_result = get_result
        self._get_exc = get_exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, *_args, **_kwargs):
        if self._get_exc is not None:
            raise self._get_exc
        return self._get_result


def _patch_httpx(monkeypatch, *, get_result=None, get_exc=None):
    def _factory(*args, **kwargs):
        return _FakeAsyncClient(get_result=get_result, get_exc=get_exc, **kwargs)

    monkeypatch.setattr(mod.httpx, "AsyncClient", _factory)


def test_vault_chore_slugs_reads_results_key(monkeypatch):
    # The real ctrl-api contract: {"results": [...], "count": N}. The old
    # code read "records" and silently collected NOTHING (HTTP 200, no
    # exception). This asserts the correct key is read.
    payload = {
        "results": [
            {"path": "chore/money-day.md"},
            {"path": "chore/weekly-neoterra-consulting-digest.md"},
        ],
        "count": 2,
    }
    _patch_httpx(monkeypatch, get_result=_FakeResponse(payload))
    slugs, ok = asyncio.run(mod._vault_chore_slugs())
    assert ok is True
    assert slugs == {"money-day", "weekly-neoterra-consulting-digest"}


def test_vault_chore_slugs_failure_reports_not_ok(monkeypatch):
    # Network error → ok=False, empty slugs (caller must SKIP, not delete).
    _patch_httpx(monkeypatch, get_exc=RuntimeError("ctrl-api down"))
    slugs, ok = asyncio.run(mod._vault_chore_slugs())
    assert ok is False
    assert slugs == set()


def test_reconcile_skips_all_deletion_when_vault_read_fails(monkeypatch):
    # SAFETY: when the authoritative vault backing read fails, reconcile
    # must delete NOTHING — even if non-matching .py stems are present.
    # This is the over-deletion guard.
    client, handle = _client_with_schedules(
        ["chore-watch-subscriptions-and-payment-infrastructure", "chore-money-day"]
    )

    async def _fake_collect():
        # vault read failed → ok=False; .py stem present but non-matching.
        return {"watch-subscriptions"}, False

    monkeypatch.setattr(mod, "_collect_live_chore_slugs", _fake_collect)
    deleted = asyncio.run(mod.reconcile_chore_schedules(client))
    assert deleted == 0
    handle.delete.assert_not_awaited()


def test_reconcile_deletes_only_true_orphans_on_successful_read():
    # A successful vault read returning ONLY money-day → the true orphan is
    # deleted and the backed chore is KEPT.
    client, handle = _client_with_schedules(
        ["chore-money-day", "chore-some-true-orphan"]
    )
    deleted = asyncio.run(
        mod.reconcile_chore_schedules(
            client, live_slugs={"money-day"}, backing_ok=True
        )
    )
    assert deleted == 1
    client.get_schedule_handle.assert_called_once_with("chore-some-true-orphan")
    handle.delete.assert_awaited_once()


# ---------------------------------------------------------------------------
# F34b — recreate_missing_chore_schedules: restore legit schedules that were
# deleted but whose vault chore record still exists.
# ---------------------------------------------------------------------------


def _recreate_client(existing_ids: list[str]):
    """Client whose create_schedule rejects already-existing ids."""
    client = MagicMock()
    created: list[str] = []

    async def _create(schedule_id, schedule, *a, **kw):
        if schedule_id in existing_ids:
            raise RuntimeError(f"schedule with this ID is already exists: {schedule_id}")
        created.append(schedule_id)

    client.create_schedule = AsyncMock(side_effect=_create)
    return client, created


def _vault_list_response(records: list[dict]):
    return _FakeResponse({"results": records, "count": len(records)})


def test_recreate_creates_missing_schedule(monkeypatch):
    rec = {
        "path": "chore/money-day.md",
        "frontmatter": {
            "status": "active",
            "schedule": "0 6 * * 2",
            "template": "weekly_money_day",
            "params": '{"preview_only":false,"channel":"last"}',
        },
    }
    _patch_httpx(monkeypatch, get_result=_vault_list_response([rec]))
    client, created = _recreate_client(existing_ids=[])
    n = asyncio.run(mod.recreate_missing_chore_schedules(client))
    assert n == 1
    assert created == ["chore-money-day"]
    args, kwargs = client.create_schedule.call_args
    assert args[0] == "chore-money-day"


def test_recreate_is_idempotent_for_existing_schedule(monkeypatch):
    rec = {
        "path": "chore/money-day.md",
        "frontmatter": {
            "status": "active",
            "schedule": "0 6 * * 2",
            "workflow_class_name": "WeeklyMoneyDayBriefWorkflow",
            "params": "",
        },
    }
    _patch_httpx(monkeypatch, get_result=_vault_list_response([rec]))
    # Schedule already exists → create raises already-exists → skipped, no
    # double-count, no exception.
    client, created = _recreate_client(existing_ids=["chore-money-day"])
    n = asyncio.run(mod.recreate_missing_chore_schedules(client))
    assert n == 0
    assert created == []


def test_recreate_skips_briefing_duplicate(monkeypatch):
    rec = {
        "path": "chore/morning-briefing.md",
        "frontmatter": {
            "status": "active",
            "schedule": "0 5 * * *",
            "workflow_class_name": "BriefingWorkflow",
            "params": "",
        },
    }
    _patch_httpx(monkeypatch, get_result=_vault_list_response([rec]))
    client, created = _recreate_client(existing_ids=[])
    n = asyncio.run(mod.recreate_missing_chore_schedules(client))
    assert n == 0
    assert created == []
    client.create_schedule.assert_not_called()


def test_recreate_skips_paused_records(monkeypatch):
    rec = {
        "path": "chore/dormant-thing.md",
        "frontmatter": {
            "status": "paused",
            "schedule": "0 6 * * 2",
            "workflow_class_name": "WeeklyMoneyDayBriefWorkflow",
            "params": "",
        },
    }
    _patch_httpx(monkeypatch, get_result=_vault_list_response([rec]))
    client, created = _recreate_client(existing_ids=[])
    n = asyncio.run(mod.recreate_missing_chore_schedules(client))
    assert n == 0
    client.create_schedule.assert_not_called()
