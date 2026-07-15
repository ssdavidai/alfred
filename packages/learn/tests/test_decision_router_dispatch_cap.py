"""Dead-letter cap on ``recover_stuck_dispatching`` (issue #282).

Live incident 2026-07-15 (``office-ac-quiet-mode``): a delegate decision
whose dispatch could never succeed looped forever. Every ~60s
``DecisionRouterWorkflow`` ran the recovery pass, which reset the
``state=dispatching`` / ``agent_dispatched=false`` decision back to
``open``; the next tick re-dispatched, failed, marked ``dispatching``
again — re-firing the action and re-notifying the principal each cycle,
with no cap.

Fix (this file exercises it): the ``agent_dispatched=false`` branch of
``recover_stuck_dispatching`` now counts resurrections in
``side_effects.dispatch_attempts``. While ``attempts <
MAX_DISPATCH_ATTEMPTS`` it resets to ``open`` as before (stamping the
counter). Once ``attempts >= MAX_DISPATCH_ATTEMPTS`` it PATCHes the
decision to the terminal ``failed`` dead-letter state (NOT open),
stamps ``dead_lettered_at`` + ``dead_letter_reason``, and emits exactly
one surfacing audit with ``source=decision_router.dead_letter``. Because
a ``failed`` decision no longer appears in the ``?state=dispatching``
sweep, that surfacing fires exactly once by construction.

The ``agent_dispatched=true`` → ``executing`` branch is a legitimate
promotion and is NOT capped.

Test doubles mirror ``test_decision_router_dispatching_recovery.py`` so
this lane does not depend on Lane I (ctrl-api ``failed`` state) being
merged — the fake ctrl endpoint accepts any PATCH.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

import src.activities.decision_router as dr


# ---------------------------------------------------------------------------
# Test doubles (parity with test_decision_router_dispatching_recovery.py)
# ---------------------------------------------------------------------------


class _Resp:
    def __init__(self, payload: Any = None, status_code: int = 200) -> None:
        self._payload = payload or {}
        self.status_code = status_code

    def json(self) -> Any:
        return self._payload

    def raise_for_status(self) -> None:
        return None


class _FakeClient:
    """One client per logical unit of work; records every call."""

    def __init__(self, decisions: list[dict[str, Any]]) -> None:
        self.decisions = decisions
        self.calls: list[tuple[str, str, dict]] = []

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    async def get(self, url: str, **k: Any) -> _Resp:
        self.calls.append(("GET", url, {}))
        if "/api/v1/decisions?state=" in url:
            state = url.split("state=", 1)[1].split("&", 1)[0]
            rows = [d for d in self.decisions if d.get("state") == state]
            return _Resp({"decisions": rows, "count": len(rows)})
        return _Resp({})

    async def patch(self, url: str, **k: Any) -> _Resp:
        self.calls.append(("PATCH", url, k.get("json") or {}))
        return _Resp({"ok": True})

    async def post(self, url: str, **k: Any) -> _Resp:
        self.calls.append(("POST", url, k.get("json") or {}))
        return _Resp({"id": "audit-1"})


class _Cfg:
    alfred_ctrl_url = "http://ctrl-test:3100"


def _install(monkeypatch, fake: _FakeClient) -> None:
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fake)
    import src.config as cfg_mod
    monkeypatch.setattr(cfg_mod, "load_config", lambda: _Cfg())
    monkeypatch.setenv("AAS_API_KEY", "test-key")


def _iso(dt: datetime) -> str:
    return dt.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _dispatching(
    decision_id: str,
    *,
    age_minutes: float,
    agent_dispatched: bool | None = None,
    dispatch_attempts: int | None = None,
) -> dict[str, Any]:
    created = datetime.now(timezone.utc) - timedelta(minutes=age_minutes)
    side_effects: dict[str, Any] = {}
    if agent_dispatched is True:
        side_effects["agent_dispatched"] = True
    elif agent_dispatched is False:
        side_effects["agent_dispatched"] = False
    if dispatch_attempts is not None:
        side_effects["dispatch_attempts"] = dispatch_attempts
    return {
        "id": decision_id,
        "intent": "delegate",
        "source": "needs_attention",
        "source_record": f"needs_attention/{decision_id}.md",
        "source_headline": "office AC quiet mode",
        "note": "",
        "state": "dispatching",
        "side_effects": side_effects,
        "created": _iso(created.replace(tzinfo=None)),
    }


def _state_patches(fake: _FakeClient, decision_id: str) -> list[dict]:
    return [
        c[2]
        for c in fake.calls
        if c[0] == "PATCH"
        and f"/api/v1/decisions/{decision_id}" in c[1]
    ]


def _dead_letter_audits(fake: _FakeClient) -> list[dict]:
    return [
        c[2]
        for c in fake.calls
        if c[0] == "POST"
        and "/api/v1/state/audit" in c[1]
        and (c[2] or {}).get("source") == "decision_router.dead_letter"
    ]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_first_reset_stamps_dispatch_attempts_1(monkeypatch):
    """A crashed dispatching decision with no prior counter → reset to
    ``open`` with ``side_effects.dispatch_attempts=1`` and a
    ``last_dispatch_at`` timestamp. Not dead-lettered yet."""
    monkeypatch.setattr(dr, "MAX_DISPATCH_ATTEMPTS", 3)
    dec = _dispatching("ac-quiet", age_minutes=15, agent_dispatched=False)
    fake = _FakeClient([dec])
    _install(monkeypatch, fake)

    result = asyncio.run(dr.recover_stuck_dispatching())

    patches = _state_patches(fake, "ac-quiet")
    assert len(patches) == 1, f"expected one PATCH, got {patches}"
    body = patches[0]
    assert body.get("state") == "open", body
    se = body.get("side_effects") or {}
    assert se.get("dispatch_attempts") == 1, se
    assert isinstance(se.get("last_dispatch_at"), str) and se["last_dispatch_at"], se
    # Not dead-lettered.
    assert "dead_lettered_at" not in se, se
    assert result["reset_to_open"] == 1
    assert result["dead_lettered"] == 0
    assert _dead_letter_audits(fake) == []


def test_crossover_to_failed_at_max_minus_one(monkeypatch):
    """A crashed dispatching decision already at
    ``dispatch_attempts=MAX-1`` → the next recover crosses the cap and
    PATCHes to ``state=failed`` (NOT open), stamps ``dead_lettered_at`` +
    ``dead_letter_reason``, and emits exactly ONE dead_letter audit."""
    monkeypatch.setattr(dr, "MAX_DISPATCH_ATTEMPTS", 3)
    dec = _dispatching(
        "ac-quiet",
        age_minutes=15,
        agent_dispatched=False,
        dispatch_attempts=2,  # MAX - 1
    )
    fake = _FakeClient([dec])
    _install(monkeypatch, fake)

    result = asyncio.run(dr.recover_stuck_dispatching())

    patches = _state_patches(fake, "ac-quiet")
    assert len(patches) == 1, f"expected one PATCH, got {patches}"
    body = patches[0]
    assert body.get("state") == "failed", (
        f"MAX-th resurrection must dead-letter to failed, not open: {body}"
    )
    se = body.get("side_effects") or {}
    assert se.get("dispatch_attempts") == 3, se
    assert isinstance(se.get("dead_lettered_at"), str) and se["dead_lettered_at"], se
    assert "MAX_DISPATCH_ATTEMPTS" in (se.get("dead_letter_reason") or ""), se

    # Exactly one dead_letter audit, naming the decision + reason.
    dl = _dead_letter_audits(fake)
    assert len(dl) == 1, f"expected exactly ONE dead_letter audit, got {dl}"
    summary = dl[0].get("summary") or ""
    assert "ac-quiet" in summary, summary
    assert dl[0].get("action_type") == "state-change", dl[0]

    assert result["dead_lettered"] == 1
    assert result["reset_to_open"] == 0


def test_agent_dispatched_true_still_promotes_uncapped(monkeypatch):
    """The ``agent_dispatched=true`` branch is a legitimate promotion:
    it still PATCHes to ``executing`` and is NEVER capped or
    dead-lettered — even with a high dispatch_attempts count present."""
    monkeypatch.setattr(dr, "MAX_DISPATCH_ATTEMPTS", 3)
    dec = _dispatching(
        "dispatched-stuck",
        age_minutes=15,
        agent_dispatched=True,
        dispatch_attempts=99,  # irrelevant — this branch is uncapped
    )
    fake = _FakeClient([dec])
    _install(monkeypatch, fake)

    result = asyncio.run(dr.recover_stuck_dispatching())

    patches = _state_patches(fake, "dispatched-stuck")
    assert len(patches) == 1, f"expected one PATCH, got {patches}"
    assert patches[0].get("state") == "executing", patches[0]
    assert result["promoted_to_executing"] == 1
    assert result["dead_lettered"] == 0
    assert _dead_letter_audits(fake) == []


def test_return_dict_includes_dead_lettered_count(monkeypatch):
    """The return dict carries the ``dead_lettered`` counter alongside
    the existing observability fields."""
    monkeypatch.setattr(dr, "MAX_DISPATCH_ATTEMPTS", 3)
    dec = _dispatching(
        "ac-quiet",
        age_minutes=15,
        agent_dispatched=False,
        dispatch_attempts=2,
    )
    fake = _FakeClient([dec])
    _install(monkeypatch, fake)

    result = asyncio.run(dr.recover_stuck_dispatching())

    for key in (
        "scanned",
        "recovered",
        "reset_to_open",
        "promoted_to_executing",
        "dead_lettered",
    ):
        assert key in result, f"return dict missing {key}: {result}"
    assert result["dead_lettered"] == 1


def test_resolve_max_dispatch_attempts_defensive(monkeypatch):
    """The env resolver falls back to 3 on unset/garbage and floors at 1."""
    monkeypatch.delenv("DECISION_MAX_DISPATCH_ATTEMPTS", raising=False)
    assert dr._resolve_max_dispatch_attempts() == 3

    monkeypatch.setenv("DECISION_MAX_DISPATCH_ATTEMPTS", "not-a-number")
    assert dr._resolve_max_dispatch_attempts() == 3

    monkeypatch.setenv("DECISION_MAX_DISPATCH_ATTEMPTS", "0")
    assert dr._resolve_max_dispatch_attempts() == 1  # floored

    monkeypatch.setenv("DECISION_MAX_DISPATCH_ATTEMPTS", "5")
    assert dr._resolve_max_dispatch_attempts() == 5
