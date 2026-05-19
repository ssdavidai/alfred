"""Tests for the #55 mark-before-dispatch double-fire fix in
``route_decision`` (``src/activities/decision_router.py``).

The bug (pre-existing latent, same class as #54's ``route_signal_action``
hole): the ``intent=delegate`` path POSTed the real agent dispatch
(``POST /api/v1/admin/needs-attention/{na_id}/dispatch``) and only *then*
PATCHed the decision to ``state=executing`` — the state the
``state != "open"`` entry guard relies on. A run that died or was retried
*between* a successful dispatch POST and that PATCH re-entered with the
decision still ``state=open`` — the guard missed and the agent was
dispatched a SECOND time. ``_ROUTE_RETRY`` (maximum_attempts=3) plus the
60-second cadence both re-present the same decision, so Temporal only
*partially* masked it.

The fix marks the decision ``state=dispatching`` BEFORE the dispatch POST
and extends the entry guard to early-return on ``dispatching``. These
tests prove:

  1. The happy path marks ``dispatching`` strictly before the dispatch
     POST and advances to ``executing`` afterwards.
  2. A re-entry while the decision is ``dispatching`` does NOT re-dispatch.
  3. The crash window: run #1 marks ``dispatching``, dispatches, then
     crashes before the ``executing`` PATCH; run #2 (the retry) finds
     the decision ``dispatching`` and does not re-dispatch — exactly-once
     across the crash.
  4. A pre-dispatch mark-write failure re-raises BEFORE the dispatch, so
     no agent run happens on a failed mark.

``dispatching`` must be distinct from ``executing``: ``check_decision_outcomes``
polls only ``executing`` decisions. Test (5) confirms a ``dispatching``
decision is not what that poller queries.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Optional
from unittest.mock import patch

import httpx

import src.activities.decision_router as dr


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _FakeResponse:
    """Tiny httpx.Response stand-in."""

    def __init__(self, status_code: int, payload: Any = None) -> None:
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

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
    """AsyncContextManager httpx.AsyncClient stand-in for ctrl-api.

    Holds a mutable ``decision_state`` so a PATCH that writes ``state``
    is visible to the dispatch POST that follows — the ordering is the
    whole point of the test. Records an ordered ``calls`` log.
    """

    def __init__(
        self,
        decision_state: str,
        *,
        fail_patch_state: Optional[str] = None,
        dispatch_hook: Any = None,
    ) -> None:
        # Mutable — a PATCH {"state": ...} updates this in place.
        self.decision_state = decision_state
        # If set to a state value, a PATCH that writes that exact state
        # raises (simulates a ctrl-api blip on the pre-dispatch mark).
        self.fail_patch_state = fail_patch_state
        # Optional coroutine fn called the moment a dispatch POST lands —
        # used to inject a crash exactly in the double-fire window.
        self._dispatch_hook = dispatch_hook
        self.calls: list[dict[str, Any]] = []

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    async def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"method": "GET", "url": url, **kwargs})
        raise AssertionError(f"unexpected GET {url}")

    async def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"method": "POST", "url": url, **kwargs})
        if "/dispatch" in url:
            if self._dispatch_hook is not None:
                await self._dispatch_hook()
            return _FakeResponse(
                200,
                {
                    "audit_record_path": "event/needs-attention-dispatch.md",
                    "re_routed_signal": "signal/2026-05-19-rearmed.md",
                },
            )
        raise AssertionError(f"unexpected POST {url}")

    async def patch(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"method": "PATCH", "url": url, **kwargs})
        body = kwargs.get("json") or {}
        if "/api/v1/decisions/" in url and isinstance(body, dict):
            new_state = body.get("state")
            if new_state is not None:
                if (
                    self.fail_patch_state is not None
                    and new_state == self.fail_patch_state
                ):
                    raise httpx.ConnectError("ctrl-api blip on state mark")
                self.decision_state = str(new_state)
        return _FakeResponse(200, {"ok": True})

    # --- assertion helpers -------------------------------------------------

    def dispatch_count(self) -> int:
        return sum(
            1
            for c in self.calls
            if c["method"] == "POST" and "/dispatch" in c["url"]
        )

    def ordered_ops(self) -> list[str]:
        """A compact ordered trace: 'mark:<state>' for a decision PATCH
        that sets state, 'dispatch' for the dispatch POST."""
        ops: list[str] = []
        for c in self.calls:
            if (
                c["method"] == "PATCH"
                and "/api/v1/decisions/" in c["url"]
            ):
                body = c.get("json") or {}
                if isinstance(body, dict) and "state" in body:
                    ops.append(f"mark:{body['state']}")
            elif c["method"] == "POST" and "/dispatch" in c["url"]:
                ops.append("dispatch")
        return ops


class _FakeConfig:
    alfred_ctrl_url = "http://ctrl-test:3100"


def _delegate_decision(state: str = "open") -> dict[str, Any]:
    """A needs_attention / intent=delegate decision with NO time-bearing
    note — so route_decision takes the dispatch-now branch (not the
    scheduled branch)."""
    return {
        "id": "2026-05-19-delegate-test",
        "intent": "delegate",
        "source": "needs_attention",
        "source_record": "needs_attention/abc123.md",
        "source_headline": "Reply to the client about pricing",
        "note": "",
        "matter_ref": "",
        "state": state,
        "side_effects": {},
    }


def _install(monkeypatch, fake_client: _FakeClient) -> None:
    """Patch every external seam route_decision reaches for."""
    # _http() builds httpx.AsyncClient(...) — return our fake.
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda *a, **k: fake_client
    )
    # _http() also calls load_config() for the base_url.
    import src.config as cfg_mod

    monkeypatch.setattr(cfg_mod, "load_config", lambda: _FakeConfig())
    monkeypatch.setenv("AAS_API_KEY", "test-key")

    # The post-routing observation extraction is best-effort and does
    # its own httpx + vault writes — stub it out so the test is hermetic.
    import src.activities.decision_observations as dobs

    async def _fake_extract(decision: dict[str, Any]) -> dict[str, Any]:
        return {"observation_path": ""}

    monkeypatch.setattr(dobs, "extract_observation_from_decision", _fake_extract)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_happy_path_marks_dispatching_before_dispatch(monkeypatch):
    """A first, clean run dispatches exactly once, and the decision is
    marked ``dispatching`` strictly BEFORE the agent dispatch POST and
    ends at ``executing``."""
    fake = _FakeClient("open")
    _install(monkeypatch, fake)

    result = asyncio.run(dr.route_decision(_delegate_decision("open")))

    assert fake.dispatch_count() == 1, "agent must be dispatched exactly once"
    # The ordered trace must be: mark dispatching -> dispatch -> mark
    # executing. The pre-dispatch mark is the #55 fix.
    assert fake.ordered_ops() == [
        "mark:dispatching",
        "dispatch",
        "mark:executing",
    ]
    assert result["next_state"] == "executing"
    assert "needs_attention.dispatch" in result["actions"]


def test_reentry_while_dispatching_does_not_redispatch(monkeypatch):
    """THE #55 REGRESSION GUARD. A run that crashed AFTER the
    ``dispatching`` mark but BEFORE the ``executing`` PATCH re-enters
    with the decision still ``dispatching`` — the guard must early-return
    and NOT dispatch the agent a second time."""
    fake = _FakeClient("dispatching")
    _install(monkeypatch, fake)

    result = asyncio.run(dr.route_decision(_delegate_decision("dispatching")))

    assert fake.dispatch_count() == 0, (
        "re-entry while dispatching MUST NOT re-fire the agent — "
        "this is the double-fire bug #55 closes"
    )
    assert fake.calls == [], "no ctrl-api calls at all on the guard skip"
    assert result["skipped"] is True
    assert result["reason"] == "state=dispatching"


def test_reentry_while_executing_does_not_redispatch(monkeypatch):
    """The pre-existing terminal-ish guard still holds: a re-entry on an
    already ``executing`` decision does not dispatch."""
    fake = _FakeClient("executing")
    _install(monkeypatch, fake)

    result = asyncio.run(dr.route_decision(_delegate_decision("executing")))

    assert fake.dispatch_count() == 0
    assert result["skipped"] is True
    assert result["reason"] == "state=executing"


def test_two_runs_simulating_crash_window_dispatch_once(monkeypatch):
    """End-to-end window simulation: run #1 marks ``dispatching``,
    dispatches, then 'crashes' before the ``executing`` PATCH; run #2 is
    the Temporal retry. Across BOTH runs the agent is dispatched exactly
    once."""

    class _CrashAfterDispatch(Exception):
        pass

    async def _crash() -> None:
        # The dispatch POST has landed and the decision is marked
        # 'dispatching'. Die before the 'executing' PATCH — exactly the
        # double-fire window.
        raise _CrashAfterDispatch()

    fake = _FakeClient("open", dispatch_hook=_crash)
    _install(monkeypatch, fake)

    # --- Run #1: crashes in the window. ---
    try:
        asyncio.run(dr.route_decision(_delegate_decision("open")))
    except _CrashAfterDispatch:
        pass

    assert fake.dispatch_count() == 1
    assert fake.decision_state == "dispatching", (
        "after the crash the decision is stranded in 'dispatching' — "
        "the visible, sweepable stuck state"
    )

    # --- Run #2: the retry. The decision is still 'dispatching' (a real
    #     re-list by the workflow would carry that state). The guard must
    #     catch it; no second dispatch. ---
    result = asyncio.run(
        dr.route_decision(_delegate_decision(fake.decision_state))
    )

    assert fake.dispatch_count() == 1, (
        "across the crash + retry the agent was dispatched exactly "
        "ONCE — the #55 fix closed the double-fire window"
    )
    assert result["skipped"] is True
    assert result["reason"] == "state=dispatching"


def test_pre_dispatch_mark_failure_reraises_before_dispatch(monkeypatch):
    """A ctrl-api failure on the pre-dispatch ``dispatching`` mark
    re-raises BEFORE the dispatch POST — so a failed mark never leaves an
    agent dispatched without the guard in place. Temporal then retries
    the whole activity from a clean ``open`` state."""
    fake = _FakeClient("open", fail_patch_state="dispatching")
    _install(monkeypatch, fake)

    raised = False
    try:
        asyncio.run(dr.route_decision(_delegate_decision("open")))
    except httpx.HTTPError:
        raised = True

    assert raised, "a failed pre-dispatch mark must re-raise"
    assert fake.dispatch_count() == 0, (
        "no agent dispatch may happen when the pre-dispatch mark failed"
    )


def test_dispatching_state_is_distinct_from_executing(monkeypatch):
    """``check_decision_outcomes`` polls only ``state=executing``
    decisions. Confirm the new pre-dispatch state is NOT ``executing`` —
    a decision stranded in ``dispatching`` must be invisible to the
    outcome poller so it cannot be waited on forever."""
    fake = _FakeClient("open")
    _install(monkeypatch, fake)

    asyncio.run(dr.route_decision(_delegate_decision("open")))

    ops = fake.ordered_ops()
    pre_dispatch_marks = ops[: ops.index("dispatch")]
    assert pre_dispatch_marks == ["mark:dispatching"]
    assert "mark:executing" not in pre_dispatch_marks, (
        "the pre-dispatch mark must NOT be 'executing' — "
        "check_decision_outcomes polls executing decisions and would "
        "wait forever on a decision whose dispatch never landed"
    )
