"""Gap 3 — `_load_active_instincts` must include unconfirmed instincts.

Symptom on home.alfred.black: all 31 live instincts have
``status="unconfirmed"`` (they haven't been promoted to ``active`` by Sir
yet). ``_load_active_instincts`` was filtering ``client.list_records(...,
status="active")``, so it returned ``[]`` — every signal got
``matched_instinct=null``.

The fix is to drop the ``status=`` kwarg entirely. Safety: the
discretion gate (signal_actions ~line 1825) already routes
low-observation-count instincts through HUMAN because
``get_discretion_threshold(<5 obs) = 0.95``, so loading unconfirmed
instincts here cannot cause autonomous misfires.

Test strategy: assert ``_load_active_instincts`` returns whatever the
vault client returned, regardless of status filter — i.e. that the
loader does not request a ``status="active"`` slice. Mirror the same
contract for ``rebuild_intuition_index`` in vault.py.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest


# ---------------------------------------------------------------------------
# Fake VaultClient — records every list_records call so we can pin the kwargs.
# ---------------------------------------------------------------------------


class _CapturingVaultClient:
    """A fake VaultClient that captures list_records kwargs.

    On a real live tenant the call ``list_records("instinct",
    status="active")`` returns ``[]`` because all instincts are
    ``unconfirmed``. We mimic that by returning ``[]`` when status is
    pinned, and the full set when it isn't — so the test fails RED on
    the unfixed code (which passes ``status="active"`` and gets nothing).
    """

    instances: list["_CapturingVaultClient"] = []

    def __init__(self, config: Any) -> None:
        self.calls: list[dict[str, Any]] = []
        _CapturingVaultClient.instances.append(self)

    async def list_records(self, record_type: str, **kwargs: Any) -> list[dict[str, Any]]:
        self.calls.append({"type": record_type, **kwargs})
        if record_type != "instinct":
            return []
        # Simulate live home.alfred.black: 3 unconfirmed instincts.
        unconfirmed = [
            {
                "path": f"instinct/test-unconfirmed-{i}.md",
                "frontmatter": {
                    "type": "instinct",
                    "name": f"test-unconfirmed-{i}",
                    "status": "unconfirmed",
                },
            }
            for i in range(3)
        ]
        # If the caller pins status="active", return nothing (matches live).
        if kwargs.get("status") == "active":
            return []
        # Otherwise return everything — the loader should now see all 3.
        return list(unconfirmed)

    async def write_record(self, record_type: str, name: str, content: str) -> str:
        return f"{record_type}/{name}.md"

    async def close(self) -> None:
        return None


@pytest.fixture(autouse=True)
def _reset_capture() -> None:
    _CapturingVaultClient.instances.clear()
    yield
    _CapturingVaultClient.instances.clear()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_load_active_instincts_returns_unconfirmed(monkeypatch):
    """_load_active_instincts must NOT filter by status=active.

    RED on unfixed code: loader passes ``status="active"`` and the fake
    returns ``[]`` (mirroring the live tenant). After the fix the loader
    drops the kwarg and the unconfirmed instincts surface.
    """
    import src.activities.signal_actions as sa
    import src.utils.vault_client as vc_mod
    import src.config as cfg_mod

    monkeypatch.setattr(vc_mod, "VaultClient", _CapturingVaultClient)
    monkeypatch.setattr(sa, "VaultClient", _CapturingVaultClient, raising=False)
    monkeypatch.setattr(cfg_mod, "load_config", lambda: object())
    # Bypass module-level TTL cache between tests.
    sa._INSTINCTS_CACHE["loaded_at"] = None
    sa._INSTINCTS_CACHE["data"] = []

    records = asyncio.run(sa._load_active_instincts(force=True))

    assert _CapturingVaultClient.instances, "VaultClient was never constructed"
    last_calls = _CapturingVaultClient.instances[-1].calls
    assert last_calls, "list_records was never called"
    call = last_calls[0]
    assert call["type"] == "instinct"
    assert "status" not in call, (
        "loader must NOT pin status=active — all live instincts are "
        f"unconfirmed; got call kwargs={call!r}"
    )
    assert len(records) == 3, (
        f"loader must surface the unconfirmed instincts; got {records!r}"
    )


def test_rebuild_intuition_index_includes_unconfirmed(monkeypatch):
    """rebuild_intuition_index must also drop status=active.

    Same Gap 3 root cause in a second call site. The index page on
    /instincts was empty for the same reason.
    """
    import src.activities.vault as vault_mod
    import src.config as cfg_mod

    monkeypatch.setattr(vault_mod, "VaultClient", _CapturingVaultClient)
    monkeypatch.setattr(cfg_mod, "load_config", lambda: object())

    asyncio.run(vault_mod.rebuild_intuition_index())

    assert _CapturingVaultClient.instances, "VaultClient was never constructed"
    # Find the instinct call — the activity may make more than one.
    instinct_calls = [
        c for inst in _CapturingVaultClient.instances for c in inst.calls
        if c["type"] == "instinct"
    ]
    assert instinct_calls, "list_records('instinct') was never called"
    for c in instinct_calls:
        assert "status" not in c, (
            "rebuild_intuition_index must NOT pin status=active; "
            f"got kwargs={c!r}"
        )
