"""Tests for #414: route_decision retires terminally when the source
needs_attention card returns 404 on the done/dispatch/skip action POST.

The bug: if the card was deleted after a decision was minted, the
action POST returns 404, resp.raise_for_status() raised, and Temporal
retried every 60-second DecisionRouter tick forever. A deleted card is
not a transient condition; retrying cannot restore it.

The fix: catch httpx.HTTPStatusError where status_code == 404 on the
three concrete action endpoints (done/dispatch/skip), PATCH the decision
terminal (state=completed, side_effects.decision_router=source_card_missing),
write a best-effort audit row, and return — no raise. 5xx and other
non-404 errors still raise so Temporal can retry real infrastructure blips.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

import src.activities.decision_router as dr


# ---------------------------------------------------------------------------
# Shared test doubles
# ---------------------------------------------------------------------------

class _Resp:
    def __init__(self, status_code: int, payload: Any = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> Any:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"status {self.status_code}",
                request=httpx.Request("GET", "http://test"),
                response=httpx.Response(self.status_code),
            )


class _FakeClient:
    """Minimal fake httpx.AsyncClient that records all calls.

    ``action_status`` controls what the action-endpoint POST returns.
    ``mark_status`` controls what the pre-dispatch PATCH returns.
    """

    def __init__(
        self,
        *,
        action_status: int = 200,
        mark_status: int = 200,
    ) -> None:
        self.action_status = action_status
        self.mark_status = mark_status
        self.calls: list[tuple[str, str]] = []  # (method, url)
        self.patches: list[dict[str, Any]] = []

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *a: Any) -> None:
        pass

    async def get(self, url: str, **_: Any) -> _Resp:
        self.calls.append(("GET", url))
        # _accept_hours_proposal_if_any GETs the source_record card;
        # return 404 so it no-ops for these tests.
        return _Resp(404)

    async def post(self, url: str, **_: Any) -> _Resp:
        self.calls.append(("POST", url))
        if url.endswith("/api/v1/state/audit"):
            return _Resp(200)
        # Action endpoints
        return _Resp(self.action_status, {
            "audit_record_path": "event/na.md",
            "re_routed_signal": "signal/abc.md",
        })

    async def patch(self, url: str, *, json: Any = None, **_: Any) -> _Resp:
        self.calls.append(("PATCH", url))
        body = json or {}
        if "/api/v1/decisions/" in url:
            if isinstance(body, dict) and body.get("state") == "dispatching":
                return _Resp(self.mark_status)
            self.patches.append(body)
        return _Resp(200)

    def retire_patches(self) -> list[dict[str, Any]]:
        return [p for p in self.patches if p.get("state") == "completed"]

    def action_calls(self) -> list[str]:
        return [url for (m, url) in self.calls if m == "POST" and
                any(a in url for a in ("/done", "/dispatch", "/skip"))]

    def audit_calls(self) -> list[str]:
        return [url for (m, url) in self.calls if m == "POST" and
                "state/audit" in url]


class _FakeConfig:
    alfred_ctrl_url = "http://ctrl-test:3100"


def _install(monkeypatch: Any, fake_client: _FakeClient) -> None:
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fake_client)
    import src.config as cfg_mod
    monkeypatch.setattr(cfg_mod, "load_config", lambda: _FakeConfig())
    monkeypatch.setenv("AAS_API_KEY", "test-key")
    import src.activities.decision_observations as dobs
    async def _noop(d: Any) -> dict:
        return {}
    monkeypatch.setattr(dobs, "extract_observation_from_decision", _noop)


def _decision(intent: str, state: str = "open") -> dict[str, Any]:
    return {
        "id": "2026-08-10-test",
        "intent": intent,
        "source": "needs_attention",
        "source_record": "needs_attention/deleted-card.md",
        "source_headline": "Test card",
        "note": "",
        "matter_ref": "",
        "task_ref": "",
        "state": state,
        "side_effects": {},
    }


# ---------------------------------------------------------------------------
# 404 → terminal, no re-raise (done / skip / dispatch)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("intent", ["done", "defer", "delegate"])
def test_404_retires_decision_and_does_not_raise(monkeypatch, intent):
    """A 404 on the action POST must NOT raise; the decision must be
    retired (state=completed, side_effects.decision_router=source_card_missing)."""
    fake = _FakeClient(action_status=404, mark_status=200)
    _install(monkeypatch, fake)

    result = asyncio.run(dr.route_decision(_decision(intent)))

    # Activity must return cleanly — no exception.
    assert result["next_state"] == "completed"
    assert result["actions"] == ["source_card_missing"]
    assert result["side_effects"]["decision_router"] == "source_card_missing"
    assert "retired_at" in result["side_effects"]

    # The retire PATCH must have fired.
    assert len(fake.retire_patches()) == 1
    rp = fake.retire_patches()[0]
    assert rp["state"] == "completed"
    assert rp["side_effects"]["decision_router"] == "source_card_missing"


@pytest.mark.parametrize("intent", ["done", "defer", "delegate"])
def test_404_writes_audit_row(monkeypatch, intent):
    """The audit row must be written so the retirement is searchable."""
    fake = _FakeClient(action_status=404)
    _install(monkeypatch, fake)

    asyncio.run(dr.route_decision(_decision(intent)))

    assert len(fake.audit_calls()) >= 1, (
        "at least one audit POST must fire on a source_card_missing retire"
    )


# ---------------------------------------------------------------------------
# 5xx still raises so Temporal can retry transient failures
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("intent", ["done", "defer", "delegate"])
def test_5xx_reraises(monkeypatch, intent):
    """A 500 from the action endpoint is a transient failure; the activity
    must raise so Temporal retries it."""
    fake = _FakeClient(action_status=500)
    _install(monkeypatch, fake)

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(dr.route_decision(_decision(intent)))

    # No retire PATCH must fire — the 500 is retryable.
    assert len(fake.retire_patches()) == 0


# ---------------------------------------------------------------------------
# 200 behaves exactly as before (happy path regression)
# ---------------------------------------------------------------------------

def test_200_done_completes_normally(monkeypatch):
    """A 200 response on the done action must advance the decision to
    completed and not trigger any source_card_missing logic."""
    fake = _FakeClient(action_status=200)
    _install(monkeypatch, fake)

    result = asyncio.run(dr.route_decision(_decision("done")))

    assert result["next_state"] == "completed"
    assert "source_card_missing" not in result["actions"]
    assert result["side_effects"].get("decision_router") != "source_card_missing"


# ---------------------------------------------------------------------------
# Distinguish source_card_missing from a normal completion
# ---------------------------------------------------------------------------

def test_source_card_missing_distinguishable_from_normal_completion(monkeypatch):
    """A retired decision carries side_effects.decision_router=source_card_missing.
    A normally-completed decision does NOT carry that key — so the two are
    distinguishable in the audit trail."""
    fake_404 = _FakeClient(action_status=404)
    _install(monkeypatch, fake_404)
    retired = asyncio.run(dr.route_decision(_decision("done")))

    fake_200 = _FakeClient(action_status=200)
    _install(monkeypatch, fake_200)
    completed = asyncio.run(dr.route_decision(_decision("done")))

    assert retired["side_effects"]["decision_router"] == "source_card_missing"
    assert completed["side_effects"].get("decision_router") != "source_card_missing"
