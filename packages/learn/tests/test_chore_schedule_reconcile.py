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
        return {"money-day", "watch-subscriptions"}

    monkeypatch.setattr(mod, "_vault_chore_slugs", _fake_vault_slugs)
    slugs = asyncio.run(mod._collect_live_chore_slugs())
    # Union of slugified .py stems + vault chore record slugs.
    assert "morning-briefing" in slugs
    assert "watch-subscriptions" in slugs
    assert "money-day" in slugs
