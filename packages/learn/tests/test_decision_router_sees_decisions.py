"""F31 — the router must *see* open decisions and fan out their effects.

Root cause (C18/F1): ``POST /api/v1/decisions`` wrote ``decision/*.md``
without ``indexVaultWrite()``, so the ``vault_index`` reader behind
``GET /api/v1/decisions`` returned nothing — ``list_decisions_by_state
("open")`` got ``[]`` and the router logged ``opens=0`` every tick, so
defer-resurface / delegate-dispatch / Do-spawn / noise side-effects never
fired. F1 (Lane I) now indexes decisions on write per C18.

These tests pin the learn side of the contract: given a ctrl response
that now carries decision rows, ``list_decisions_by_state`` returns them
(opens non-zero), and each intent routes to its side-effect endpoint.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx

import src.activities.decision_router as dr


class _Resp:
    def __init__(self, payload: Any = None, status_code: int = 200) -> None:
        self._payload = payload or {}
        self.status_code = status_code

    def json(self) -> Any:
        return self._payload

    def raise_for_status(self) -> None:
        return None


class _FakeClient:
    def __init__(self, calls: list[tuple[str, str, dict]], list_payload: dict) -> None:
        self.calls = calls
        self.list_payload = list_payload

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    async def get(self, url: str, **k: Any) -> _Resp:
        self.calls.append(("GET", url, {}))
        return _Resp(self.list_payload)

    async def post(self, url: str, **k: Any) -> _Resp:
        self.calls.append(("POST", url, k.get("json") or {}))
        return _Resp({"audit_record_path": "event/x.md", "path": "to_do/t.md",
                      "re_routed_signal": "SIG123"})

    async def patch(self, url: str, **k: Any) -> _Resp:
        self.calls.append(("PATCH", url, k.get("json") or {}))
        return _Resp({"ok": True})


class _Cfg:
    alfred_ctrl_url = "http://ctrl-test:3100"


def _install(monkeypatch, list_payload: dict) -> list[tuple[str, str, dict]]:
    calls: list[tuple[str, str, dict]] = []
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda *a, **k: _FakeClient(calls, list_payload)
    )
    import src.config as cfg_mod
    monkeypatch.setattr(cfg_mod, "load_config", lambda: _Cfg())
    monkeypatch.setenv("AAS_API_KEY", "test-key")

    import src.activities.decision_observations as dobs

    async def _fake_extract(d):  # noqa: ANN001
        return {"observation_path": ""}

    monkeypatch.setattr(dobs, "extract_observation_from_decision", _fake_extract)
    return calls


def test_list_decisions_by_state_returns_indexed_rows(monkeypatch):
    """Post-F1, the vault_index reader returns rows — opens is non-zero."""
    rows = [
        {"id": "d1", "intent": "take_mine", "source": "needs_attention",
         "source_record": "needs_attention/a.md", "state": "open"},
        {"id": "d2", "intent": "done", "source": "needs_attention",
         "source_record": "needs_attention/b.md", "state": "open"},
    ]
    calls = _install(monkeypatch, {"decisions": rows, "count": 2})
    opens = asyncio.run(dr.list_decisions_by_state("open"))
    assert len(opens) == 2, "router must see the now-indexed decisions"
    # It queried the vault_index reader scoped to state=open.
    get = [c for c in calls if c[0] == "GET"][0]
    assert "/api/v1/decisions?state=open" in get[1]


def test_empty_decisions_payload_yields_no_opens(monkeypatch):
    """Defensive: a missing/empty list never raises; opens is just empty."""
    calls = _install(monkeypatch, {"decisions": [], "count": 0})
    opens = asyncio.run(dr.list_decisions_by_state("open"))
    assert opens == []


def test_take_mine_fans_out_to_todo_spawn(monkeypatch):
    """The Do / take_mine side-effect spawns a to_do (Backstage queue)."""
    calls = _install(monkeypatch, {})
    dec = {"id": "d1", "intent": "take_mine", "source": "needs_attention",
           "source_record": "needs_attention/a.md",
           "source_headline": "Pay the invoice", "state": "open",
           "side_effects": {}}
    asyncio.run(dr.route_decision(dec))
    assert [c for c in calls if c[0] == "POST" and c[1] == "/api/v1/todos"], calls


def test_delegate_marks_dispatching_then_dispatches(monkeypatch):
    """Delegate (no time note) re-arms the signal via the dispatch route."""
    calls = _install(monkeypatch, {})
    dec = {"id": "d1", "intent": "delegate", "source": "needs_attention",
           "source_record": "needs_attention/a.md", "note": "",
           "state": "open", "side_effects": {}}
    result = asyncio.run(dr.route_decision(dec))
    # Mark-before-dispatch guard PATCHes state=dispatching, then dispatch.
    assert any(
        c[0] == "PATCH" and c[2].get("state") == "dispatching" for c in calls
    ), calls
    assert any(
        c[0] == "POST" and "/dispatch" in c[1] for c in calls
    ), calls
    assert result["next_state"] == "executing"
