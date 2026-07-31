"""Regression tests for scheduled-dispatch terminal handling (#313).

A scheduled decision whose source `needs_attention` card has been deleted
can never dispatch: `/api/v1/admin/needs-attention/:id/dispatch` answers 404
forever. Before the fix the activity swallowed the error and `continue`d, so
the decision stayed `state=scheduled` and was re-tried on every 15-minute
tick — permanent retry noise that buried genuinely new dispatch failures.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx

from src.activities import scheduled_dispatch as sd


class _Ok:
    def __init__(self, payload: dict | None = None) -> None:
        self._payload = payload or {}
        self.status_code = 200

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        return None


class _FakeClient:
    """Minimal stand-in for the httpx.AsyncClient built by ``_http()``."""

    def __init__(self, scheduled: list[dict], dispatch_status: int) -> None:
        self._scheduled = scheduled
        self._dispatch_status = dispatch_status
        self.patches: list[tuple[str, dict]] = []
        self.dispatch_calls = 0

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *_exc) -> bool:
        return False

    async def get(self, url: str):
        return _Ok({"decisions": self._scheduled})

    async def post(self, url: str, json: dict | None = None):
        self.dispatch_calls += 1
        req = httpx.Request("POST", f"http://ctrl{url}")
        resp = httpx.Response(self._dispatch_status, request=req)
        raise httpx.HTTPStatusError(
            f"{self._dispatch_status}", request=req, response=resp
        )

    async def patch(self, url: str, json: dict | None = None):
        self.patches.append((url, json or {}))
        return _Ok({})


def _due_decision() -> dict:
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    return {
        "id": "dec-1",
        "execute_at": past,
        "source": "needs_attention",
        "source_record": "needs_attention/2026-05-12T07-26-31Z-37a9b2e6.md",
        "note": "send Adam Wednesday morning",
        "side_effects": {"prior": "kept"},
    }


async def test_missing_source_card_retires_decision(monkeypatch):
    """404 from dispatch → decision is flipped terminal, not retried."""
    fake = _FakeClient([_due_decision()], dispatch_status=404)
    monkeypatch.setattr(sd, "_http", lambda: fake)

    out = await sd.fire_due_scheduled_dispatches()

    assert out["fired"] == 0
    assert out["retired"] == 1

    assert len(fake.patches) == 1, "expected exactly one terminal PATCH"
    url, body = fake.patches[0]
    assert url == "/api/v1/decisions/dec-1"
    # `state=scheduled` is the scan filter, so any other state removes the
    # decision from the eligible set permanently.
    assert body["state"] == "completed"
    assert body["side_effects"]["scheduled_dispatch"] == "source_card_missing"
    assert "retired_at" in body["side_effects"]
    # pre-existing side effects must be preserved, not clobbered
    assert body["side_effects"]["prior"] == "kept"


async def test_transient_dispatch_failure_is_not_retired(monkeypatch):
    """A 503 is transient — the decision stays eligible for the next tick."""
    fake = _FakeClient([_due_decision()], dispatch_status=503)
    monkeypatch.setattr(sd, "_http", lambda: fake)

    out = await sd.fire_due_scheduled_dispatches()

    assert out["fired"] == 0
    assert out["retired"] == 0
    assert fake.patches == [], "transient failure must not retire the decision"
