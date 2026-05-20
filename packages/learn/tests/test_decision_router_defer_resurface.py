"""#5 — a defer with intent to resurface must never be lost.

The defer branch of ``route_decision`` flips the needs_attention card to
``status=skipped``. Resurface-time parsing previously ran *after* the skip
flip in a log-only try/except, so if the clerk couldn't parse a concrete time
(or failed), the card was left ``skipped`` with NO ``resurface_at`` — the
hourly DeferResurfaceWorkflow only resurfaces ``skipped`` records that carry a
``resurface_at``, so the card vanished forever.

The fix resolves the resurface time FIRST, stamps it before the skip flip,
and falls back to a default horizon when a noted defer can't be parsed. A
note-less defer stays a deliberate dismiss (no resurface).
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

import httpx

import src.activities.decision_router as dr
import src.activities.defer_resurface as defer_mod


class _Resp:
    def __init__(self, payload: Any = None) -> None:
        self._payload = payload or {}

    def json(self) -> Any:
        return self._payload

    def raise_for_status(self) -> None:
        return None


class _FakeClient:
    def __init__(self, order: list[str]) -> None:
        self.order = order

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    async def post(self, url: str, **k: Any) -> _Resp:
        if "/skip" in url:
            self.order.append("skip")
            return _Resp({"audit_record_path": "event/skip.md"})
        raise AssertionError(f"unexpected POST {url}")

    async def patch(self, url: str, **k: Any) -> _Resp:
        return _Resp({"ok": True})


class _Cfg:
    alfred_ctrl_url = "http://ctrl-test:3100"


def _defer(note: str) -> dict[str, Any]:
    return {
        "id": "2026-05-20-defer-test",
        "intent": "defer",
        "source": "needs_attention",
        "source_record": "needs_attention/card123.md",
        "note": note,
        "state": "open",
        "side_effects": {},
    }


def _install(monkeypatch, parse_result, *, parse_raises=False):
    """Wire fakes; return (run_fn, stamps, order)."""
    order: list[str] = []
    stamps: list[dict[str, Any]] = []

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _FakeClient(order))
    import src.config as cfg_mod

    monkeypatch.setattr(cfg_mod, "load_config", lambda: _Cfg())
    monkeypatch.setenv("AAS_API_KEY", "test-key")

    import src.activities.decision_observations as dobs

    async def _fake_extract(d):  # noqa: ANN001
        return {"observation_path": ""}

    monkeypatch.setattr(dobs, "extract_observation_from_decision", _fake_extract)

    async def _parse(note, *a, **k):  # noqa: ANN001
        if parse_raises:
            raise RuntimeError("clerk exploded")
        return parse_result

    async def _stamp(na_id, resurface_at, defer_note):  # noqa: ANN001
        order.append("stamp")
        stamps.append({"na_id": na_id, "resurface_at": resurface_at})
        return {"ok": True, "resurface_at": resurface_at}

    monkeypatch.setattr(defer_mod, "parse_resurface_time", _parse)
    monkeypatch.setattr(defer_mod, "stamp_resurface_on_needs_attention", _stamp)
    return stamps, order


def test_parseable_time_stamps_resurface_before_skip(monkeypatch):
    stamps, order = _install(
        monkeypatch,
        {"resurface_at": "2026-05-25T09:00:00+00:00", "reasoning": "next week"},
    )
    result = asyncio.run(dr.route_decision(_defer("remind me next week")))
    assert [s["resurface_at"] for s in stamps] == ["2026-05-25T09:00:00+00:00"]
    assert result["side_effects"]["resurface_at"] == "2026-05-25T09:00:00+00:00"
    # The #5 ordering invariant: stamp the resurface BEFORE the skip flip.
    assert order == ["stamp", "skip"]


def test_unparseable_time_falls_back_not_lost(monkeypatch):
    """The bug: a noted defer the clerk can't time-parse must still get a
    resurface_at (default horizon) so the card is not a permanent skip."""
    stamps, _ = _install(
        monkeypatch, {"resurface_at": None, "reasoning": "non-time-bearing"}
    )
    asyncio.run(dr.route_decision(_defer("deal with this later")))
    assert len(stamps) == 1
    ra = datetime.fromisoformat(stamps[0]["resurface_at"].replace("Z", "+00:00"))
    assert ra > datetime.now(timezone.utc)


def test_parse_exception_falls_back_not_lost(monkeypatch):
    stamps, _ = _install(monkeypatch, None, parse_raises=True)
    asyncio.run(dr.route_decision(_defer("circle back soon")))
    assert len(stamps) == 1


def test_note_less_defer_is_deliberate_dismiss(monkeypatch):
    stamps, order = _install(monkeypatch, {"resurface_at": None})
    asyncio.run(dr.route_decision(_defer("")))
    assert stamps == []
    assert order == ["skip"]
