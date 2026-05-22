"""F32 — a "Done" click must close the underlying task, not just re-flip NA.

Live symptom (#6): clicking Done on a needs_attention card flips the card
to ``status=done`` but the underlying task/matter it was about stays open
forever — ``route_decision``'s done branch only touched the NA status.

The fix: when ``intent=done`` on a needs_attention card AND the decision
carries a ``task_ref`` (the desk card stamps the linked task path), the
router also PATCHes that task to a closed status. Best-effort: a failed
task close logs but does not roll back the NA flip. A done with no
``task_ref`` is unchanged (nothing to close).
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
    def __init__(self, calls: list[tuple[str, str, dict]]) -> None:
        self.calls = calls

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    async def post(self, url: str, **k: Any) -> _Resp:
        self.calls.append(("POST", url, k.get("json") or {}))
        return _Resp({"audit_record_path": "event/done.md"})

    async def patch(self, url: str, **k: Any) -> _Resp:
        self.calls.append(("PATCH", url, k.get("json") or {}))
        return _Resp({"ok": True})


class _Cfg:
    alfred_ctrl_url = "http://ctrl-test:3100"


def _install(monkeypatch) -> list[tuple[str, str, dict]]:
    calls: list[tuple[str, str, dict]] = []
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _FakeClient(calls))
    import src.config as cfg_mod
    monkeypatch.setattr(cfg_mod, "load_config", lambda: _Cfg())
    monkeypatch.setenv("AAS_API_KEY", "test-key")

    import src.activities.decision_observations as dobs

    async def _fake_extract(d):  # noqa: ANN001
        return {"observation_path": ""}

    monkeypatch.setattr(dobs, "extract_observation_from_decision", _fake_extract)
    return calls


def _done(task_ref: str = "") -> dict[str, Any]:
    return {
        "id": "2026-05-22-done-test",
        "intent": "done",
        "source": "needs_attention",
        "source_record": "needs_attention/card123.md",
        "task_ref": task_ref,
        "note": "handled it",
        "state": "open",
        # synchronous_flip False so the router does the NA done POST itself.
        "side_effects": {},
    }


def test_done_with_task_ref_closes_the_task(monkeypatch):
    calls = _install(monkeypatch)
    asyncio.run(dr.route_decision(_done(task_ref="task/reply-client.md")))
    # The linked task is PATCHed to a closed status.
    task_patches = [
        c for c in calls
        if c[0] == "PATCH" and "/vault/records/task/reply-client.md" in c[1]
    ]
    assert task_patches, f"expected a task close PATCH, got {calls}"
    set_body = task_patches[0][2].get("set") or {}
    assert set_body.get("status") in ("done", "closed")


def test_done_without_task_ref_closes_nothing(monkeypatch):
    calls = _install(monkeypatch)
    asyncio.run(dr.route_decision(_done(task_ref="")))
    # No task PATCH when there's nothing linked.
    assert not [
        c for c in calls if c[0] == "PATCH" and "/vault/records/task/" in c[1]
    ]


def test_done_task_close_failure_does_not_break_routing(monkeypatch):
    calls = _install(monkeypatch)

    class _FailOnTaskPatch(_FakeClient):
        async def patch(self, url: str, **k: Any) -> _Resp:
            self.calls.append(("PATCH", url, k.get("json") or {}))
            if "/vault/records/task/" in url:
                raise httpx.HTTPError("boom")
            return _Resp({"ok": True})

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _FailOnTaskPatch(calls))
    # Must not raise — the NA flip + decision completion still happen.
    result = asyncio.run(dr.route_decision(_done(task_ref="task/x.md")))
    assert result["next_state"] == "completed"
