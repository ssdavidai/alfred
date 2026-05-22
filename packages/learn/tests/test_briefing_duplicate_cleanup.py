"""F33c — sweep the duplicate generated morning_briefing chore.

Now that the brief is a built-in (F33a), the Opus-generated
morning_briefing chore (a .py, a chore-morning-briefing Temporal schedule,
and a chore/morning-briefing.md vault record) is a duplicate that
re-implements and races the built-in. F34's orphan reconciler won't touch
it (it HAS backing artifacts), so a targeted cleanup removes all three at
register-schedules boot. Idempotent — a clean tenant has nothing to do.
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


def test_deletes_briefing_chore_schedule(monkeypatch):
    client, handle = _client_with_schedules(
        ["chore-morning-briefing", "chore-watch-subscriptions", "al-judgment"]
    )
    monkeypatch.setattr(mod, "_remove_briefing_chore_files_and_record",
                        AsyncMock(return_value=None))
    deleted = asyncio.run(mod.delete_duplicate_briefing_chore(client))
    assert deleted >= 1
    client.get_schedule_handle.assert_called_once_with("chore-morning-briefing")
    handle.delete.assert_awaited_once()


def test_underscore_slug_variant_also_matched(monkeypatch):
    client, handle = _client_with_schedules(["chore-morning_briefing"])
    monkeypatch.setattr(mod, "_remove_briefing_chore_files_and_record",
                        AsyncMock(return_value=None))
    deleted = asyncio.run(mod.delete_duplicate_briefing_chore(client))
    assert deleted >= 1
    handle.delete.assert_awaited_once()


def test_no_briefing_chore_is_noop(monkeypatch):
    client, handle = _client_with_schedules(["chore-watch-subscriptions"])
    monkeypatch.setattr(mod, "_remove_briefing_chore_files_and_record",
                        AsyncMock(return_value=None))
    deleted = asyncio.run(mod.delete_duplicate_briefing_chore(client))
    assert deleted == 0
    handle.delete.assert_not_awaited()


def test_list_failure_is_safe(monkeypatch):
    client = MagicMock()
    client.list_schedules = MagicMock(side_effect=RuntimeError("temporal down"))
    monkeypatch.setattr(mod, "_remove_briefing_chore_files_and_record",
                        AsyncMock(return_value=None))
    # Must not raise; still attempts the file/record cleanup once.
    deleted = asyncio.run(mod.delete_duplicate_briefing_chore(client))
    assert deleted == 0


def test_removes_py_and_vault_record(monkeypatch, tmp_path):
    # The .py removal targets the user-chores dir.
    (tmp_path / "morning_briefing.py").write_text("# generated brief chore\n")
    monkeypatch.setattr(mod, "_USER_CHORES_DIR", str(tmp_path))

    calls: list[str] = []

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def delete(self, url):
            calls.append(url)
            return MagicMock(status_code=200)

    monkeypatch.setattr(
        mod.httpx, "AsyncClient", lambda *a, **k: _Client()
    )
    asyncio.run(mod._remove_briefing_chore_files_and_record())
    # .py is gone.
    assert not (tmp_path / "morning_briefing.py").exists()
    # vault record delete was attempted for both slug variants.
    assert any("chore/morning-briefing.md" in c for c in calls)
