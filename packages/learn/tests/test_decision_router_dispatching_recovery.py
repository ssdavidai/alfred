"""Stuck-``dispatching`` recovery for DecisionRouterWorkflow.

Live incident 2026-05-25: Sir clicked Delegate on "Decide whether to
close Slack" at 07:23:41 UTC with a note "send me a reminder about
this on Telegram right now". The decision card stayed at
``state=dispatching`` for 45+ minutes.

Root cause: ``route_decision`` activity called with
``start_to_close_timeout=timedelta(seconds=60)``. The delegate branch
calls ``dispatch_action_to_agent`` which posts to Hermes workers
``/v1/runs`` — a clerk call that takes 60–180s typical. The activity
times out at 60s, the decision record stays at ``state=dispatching``
with ``agent_dispatched`` either ``true`` (clerk completed but the
final ``executing`` PATCH never landed) or ``null`` (clerk was still
running when the activity died). ``DecisionRouterWorkflow.run`` then
only lists ``state=open|reversed|executing`` decisions, so a stuck-
dispatching card is invisible forever. The #55 mark-before-dispatch
idempotency guard makes the perpetual stuck state inescapable.

Fix A (covered by other tests): the ``route_decision`` activity
timeout is bumped to 1000s.

Fix B (this file): the workflow adds a recovery pass. For every
``state=dispatching`` decision whose ``created`` is older than 10
minutes:

  1. If ``side_effects.agent_dispatched`` is ``true`` → PATCH state to
     ``executing`` (the agent did run, but the final state-write got
     dropped; ``check_decision_outcomes`` will now pick it up).
  2. Else → PATCH state to ``open`` so the next tick re-routes
     (treats the dispatch as crashed; the #55 idempotency assumes
     ``dispatching`` is a recent thing, so we reset the state).
  3. Audit-log the recovery so we know how often it fires.

Decisions younger than 10 minutes are left alone — they may still be
in flight on a slow clerk.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

import httpx
import pytest

import src.activities.decision_router as dr


# ---------------------------------------------------------------------------
# Test doubles
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
        # Return decisions whose state matches the query string.
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
        return _Resp({"id": "audit-recovery-1"})


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
) -> dict[str, Any]:
    created = datetime.now(timezone.utc) - timedelta(minutes=age_minutes)
    side_effects: dict[str, Any] = {}
    if agent_dispatched is True:
        side_effects["agent_dispatched"] = True
    elif agent_dispatched is False:
        side_effects["agent_dispatched"] = False
    return {
        "id": decision_id,
        "intent": "delegate",
        "source": "needs_attention",
        "source_record": f"needs_attention/{decision_id}.md",
        "source_headline": "Decide whether to close Slack",
        "note": "",
        "state": "dispatching",
        "side_effects": side_effects,
        "created": _iso(created.replace(tzinfo=None)),
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_recovery_skips_recent_dispatching(monkeypatch):
    """A ``state=dispatching`` decision created 30s ago is still in
    flight — the recovery pass MUST NOT touch it."""
    dec = _dispatching("recent", age_minutes=0.5)
    fake = _FakeClient([dec])
    _install(monkeypatch, fake)

    result = asyncio.run(dr.recover_stuck_dispatching())

    # No state-write PATCH against this decision id.
    patches = [
        c for c in fake.calls
        if c[0] == "PATCH"
        and "/api/v1/decisions/recent" in c[1]
        and "state" in (c[2] or {})
    ]
    assert patches == [], (
        f"recent dispatching decision must not be touched, got {patches}"
    )
    assert result["recovered"] == 0
    assert result["scanned"] == 1


def test_recovery_resets_old_dispatching_without_dispatch_to_open(monkeypatch):
    """A ``state=dispatching`` decision older than 10 minutes whose
    ``side_effects.agent_dispatched`` is False/missing is treated as a
    crashed dispatch — PATCHed back to ``state=open`` so the next tick
    re-routes."""
    dec = _dispatching("crashed", age_minutes=15, agent_dispatched=False)
    fake = _FakeClient([dec])
    _install(monkeypatch, fake)

    result = asyncio.run(dr.recover_stuck_dispatching())

    # The recovery PATCH set state=open.
    state_patches = [
        c for c in fake.calls
        if c[0] == "PATCH"
        and "/api/v1/decisions/crashed" in c[1]
        and (c[2] or {}).get("state") == "open"
    ]
    assert state_patches, (
        f"a crashed-dispatch old dispatching MUST PATCH to state=open, "
        f"got {fake.calls}"
    )
    assert result["recovered"] == 1
    assert result["reset_to_open"] == 1
    assert result["promoted_to_executing"] == 0


def test_recovery_promotes_old_dispatching_with_dispatch_to_executing(monkeypatch):
    """A ``state=dispatching`` decision older than 10 minutes whose
    ``side_effects.agent_dispatched`` is ``true`` had a successful
    dispatch but the final ``executing`` PATCH was dropped — the
    recovery PATCH stamps ``state=executing`` so the outcome poller
    picks it up."""
    dec = _dispatching("dispatched-but-stuck", age_minutes=15, agent_dispatched=True)
    fake = _FakeClient([dec])
    _install(monkeypatch, fake)

    result = asyncio.run(dr.recover_stuck_dispatching())

    state_patches = [
        c for c in fake.calls
        if c[0] == "PATCH"
        and "/api/v1/decisions/dispatched-but-stuck" in c[1]
        and (c[2] or {}).get("state") == "executing"
    ]
    assert state_patches, (
        f"old dispatching with agent_dispatched=True MUST PATCH to "
        f"state=executing, got {fake.calls}"
    )
    assert result["recovered"] == 1
    assert result["reset_to_open"] == 0
    assert result["promoted_to_executing"] == 1


def test_recovery_emits_audit_entry(monkeypatch):
    """Every recovery PATCH writes an audit row via
    ``POST /api/v1/state/audit`` so we can count how often this fires
    in production."""
    dec = _dispatching("audited", age_minutes=15, agent_dispatched=False)
    fake = _FakeClient([dec])
    _install(monkeypatch, fake)

    asyncio.run(dr.recover_stuck_dispatching())

    audit_posts = [
        c for c in fake.calls
        if c[0] == "POST" and "/api/v1/state/audit" in c[1]
    ]
    assert audit_posts, (
        f"recovery must emit an audit row, got {fake.calls}"
    )
    body = audit_posts[0][2]
    # The body shape matches state_client.append_audit's payload.
    assert body.get("action_type") in ("state-change", "decision_router.recovery")
    assert body.get("actor") == "decision_router"
    assert "audited" in (body.get("summary") or "") or (
        body.get("target_path") and "audited" in body["target_path"]
    )


def _read_workflow_source() -> str:
    """Resolve workflows/decision_router.py relative to the package root
    so the test is robust to pytest's cwd (repo root vs packages/learn)."""
    import importlib
    import pathlib
    import src.workflows.decision_router as wf_mod
    importlib.reload(wf_mod)  # noqa: ERA001  (no-op safety against stale cache)
    return pathlib.Path(wf_mod.__file__).read_text(encoding="utf-8")


def test_workflow_timeout_for_route_decision_is_1000s():
    """Fix A — the ``route_decision`` activity must be invoked with a
    1000-second start_to_close_timeout, sized to comfortably absorb
    the 900s clerk ceiling (matches signal_router's
    ``route_signal_action`` envelope at workflows/signal_router.py:366)."""
    import re

    text = _read_workflow_source()

    # Find the route_decision execute_activity block — the only call to
    # the delegate-dispatch-bearing activity. Its start_to_close_timeout
    # must be 1000s.
    m = re.search(
        r"execute_activity\(\s*route_decision,.*?start_to_close_timeout=timedelta\(seconds=(\d+)\)",
        text,
        flags=re.DOTALL,
    )
    assert m is not None, (
        "could not find route_decision activity invocation in workflow"
    )
    assert m.group(1) == "1000", (
        f"route_decision activity must use 1000s timeout to absorb "
        f"the Hermes clerk dispatch (≤900s); found seconds={m.group(1)}"
    )


def test_workflow_runs_recovery_pass(monkeypatch):
    """Integration-ish: the workflow body must call
    ``recover_stuck_dispatching`` so a stuck card cannot stay invisible
    forever. We check this textually rather than spinning up a Temporal
    test harness (parity with how other Lane II tests pin workflow
    shape — see test_workflow_timeout_for_route_decision_is_1000s)."""
    text = _read_workflow_source()
    assert "recover_stuck_dispatching" in text, (
        "DecisionRouterWorkflow must call recover_stuck_dispatching"
    )
