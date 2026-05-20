"""PR-1 / bug #2 — mark_observations_processed must flip the status in
state.db (Store 2), not the vault.

The old code PATCHed a vault path equal to the observation's ULID (which is not
a vault record), so the 'processed' flip never landed and ReflectionWorkflow
re-fed the identical 'unprocessed' set to Opus every night. The fix routes the
mark through StateClient.update_observation. These tests assert state.db is
written and the vault is NOT touched.
"""
from __future__ import annotations

from src.activities.vault import mark_observations_processed


class _FakeStateClient:
    calls: list[tuple[str, dict]] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def update_observation(self, observation_id, **kwargs):
        _FakeStateClient.calls.append((observation_id, kwargs))


class _FakeVaultClient:
    touched: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def read_record(self, path):
        _FakeVaultClient.touched.append(("read", path))
        return {"content": ""}

    async def update_record(self, path, content):
        _FakeVaultClient.touched.append(("update", path))

    async def close(self):
        pass


async def test_mark_observations_processed_writes_state_db_not_vault(monkeypatch):
    _FakeStateClient.calls = []
    _FakeVaultClient.touched = []
    monkeypatch.setattr("src.utils.signal_state.StateClient", _FakeStateClient)
    monkeypatch.setattr("src.activities.vault.VaultClient", _FakeVaultClient)

    await mark_observations_processed(
        [{"id": "01ABC", "path": "01ABC"}, {"id": "01DEF", "path": "01DEF"}]
    )

    assert ("01ABC", {"status": "processed"}) in _FakeStateClient.calls
    assert ("01DEF", {"status": "processed"}) in _FakeStateClient.calls
    assert _FakeVaultClient.touched == [], "must not write the vault for the mark"
