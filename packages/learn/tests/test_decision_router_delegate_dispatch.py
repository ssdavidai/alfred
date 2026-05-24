"""Tests for the post-#216 delegate-dispatch gap (#218).

Lane I shipped commit ``c551c00`` (merged as ``3949200``) on 2026-05-24 to
fix the delegate-dispatch runaway loop: when ctrl-api's
``dispatchSignalToAgent()`` mints the re-routed signal in state.db it now
sets ``status=routed_agent`` (terminal) instead of ``status=unrouted``.
That kills the loop where SignalRouterWorkflow re-picked the signal up
every 2 minutes and re-fired the agent (10+ dispatches per single
Delegate click).

The side-effect is the gap this test+fix closes. Before #216, the agent
was actually invoked by ``signal_actions.route_signal_action``'s
``principal_delegate_override`` branch (signal_actions.py ~1858-2006),
which called ``dispatch_action_to_agent``. With the re-routed signal now
terminal at mint, ``SignalRouterWorkflow.run``'s ``status='unrouted'``
filter never picks it up — so the principal_delegate_override branch
never runs, and ``dispatch_action_to_agent`` never fires. Net effect in
isolation: zero agent dispatches per Delegate click. Wallet stops
bleeding (good); Delegate has no behavior (bad).

DecisionRouter is the right place to fire ``dispatch_action_to_agent``
now — it's the workflow that owns ``intent=delegate`` decisions. This
file proves:

  1. RED: pre-fix, a delegate decision route does NOT call
     ``dispatch_action_to_agent``.
  2. GREEN: post-fix, exactly one call is made and the dispatch result
     is stamped onto the decision's ``side_effects`` (so a re-tick of
     the workflow sees ``agent_dispatched=true`` and skips).
  3. Idempotency: a second ``route_decision`` call on the now-stamped
     decision (which would happen if the workflow re-listed it) does
     NOT re-fire the dispatch — the existing ``state=dispatching``
     and ``state=executing`` guards plus the ``side_effects.agent_dispatched``
     marker cover this.
  4. The dispatch fires AFTER the ctrl-api ``/dispatch`` POST so the
     re-routed signal ULID is known and passed as ``source_signal_path``
     (matching the upstream contract that
     ``check_decision_outcomes`` reads).
  5. A dispatch failure DOES NOT block the decision from advancing —
     the decision still flips to ``executing`` (so the outcome poller
     can pick up any outcome that does eventually land) and
     ``side_effects.agent_dispatch_error`` is stamped for observability.
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional
from unittest.mock import AsyncMock

import httpx

import src.activities.decision_router as dr
import src.activities.signal_actions as sa


# ---------------------------------------------------------------------------
# Test doubles — minimal ctrl-api fake + dispatch counter
# ---------------------------------------------------------------------------


class _FakeResponse:
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
    """Ctrl-api stand-in. Mutates ``decision_state`` on PATCH so the
    dispatching guard works across the two-PATCH (open→dispatching→executing)
    sequence ``route_decision`` performs on the delegate path."""

    def __init__(
        self,
        decision_state: str,
        *,
        re_routed_signal: str = "01H_REARMED_FAKE_ULID",
        side_effects_seen: Optional[dict[str, Any]] = None,
    ) -> None:
        self.decision_state = decision_state
        self.re_routed_signal = re_routed_signal
        # Track side_effects body the activity stamps in PATCH.
        self.side_effects_seen: dict[str, Any] = side_effects_seen or {}
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
            return _FakeResponse(
                200,
                {
                    "audit_record_path": "event/needs-attention-dispatch.md",
                    "re_routed_signal": self.re_routed_signal,
                },
            )
        raise AssertionError(f"unexpected POST {url}")

    async def patch(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"method": "PATCH", "url": url, **kwargs})
        body = kwargs.get("json") or {}
        if "/api/v1/decisions/" in url and isinstance(body, dict):
            new_state = body.get("state")
            if new_state is not None:
                self.decision_state = str(new_state)
            new_se = body.get("side_effects")
            if isinstance(new_se, dict):
                self.side_effects_seen.update(new_se)
        return _FakeResponse(200, {"ok": True})

    def dispatch_endpoint_count(self) -> int:
        return sum(
            1
            for c in self.calls
            if c["method"] == "POST" and "/dispatch" in c["url"]
        )


class _FakeConfig:
    alfred_ctrl_url = "http://ctrl-test:3100"


def _delegate_decision(
    state: str = "open",
    *,
    synchronous_flip: bool = True,
    side_effects: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """A needs_attention / intent=delegate decision with NO time-bearing
    note — so route_decision takes the dispatch-now branch (not the
    scheduled branch). ``synchronous_flip=true`` mirrors the legacy
    POST /api/v1/decisions path (the common Delegate-click shape)."""
    se = dict(side_effects or {})
    se.setdefault("synchronous_flip", synchronous_flip)
    return {
        "id": "2026-05-24-delegate-218",
        "intent": "delegate",
        "source": "needs_attention",
        "source_record": "needs_attention/abc218.md",
        "source_headline": "Reply to the client about pricing",
        "note": "",
        "matter_ref": "",
        "state": state,
        "side_effects": se,
    }


def _install(monkeypatch, fake_client: _FakeClient, dispatcher: AsyncMock) -> None:
    """Patch every external seam route_decision reaches for."""
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fake_client)
    import src.config as cfg_mod

    monkeypatch.setattr(cfg_mod, "load_config", lambda: _FakeConfig())
    monkeypatch.setenv("AAS_API_KEY", "test-key")

    # The post-routing observation extractor is best-effort and does
    # its own httpx + vault writes — stub it out so the test is hermetic.
    import src.activities.decision_observations as dobs

    async def _fake_extract(decision: dict[str, Any]) -> dict[str, Any]:
        return {"observation_path": ""}

    monkeypatch.setattr(dobs, "extract_observation_from_decision", _fake_extract)

    # Replace the agent-dispatch activity on the decision_router module
    # so the test asserts directly on it. The fix imports
    # dispatch_action_to_agent at module import time (so the activity is
    # registered with the Temporal worker); we patch the module-attr
    # the activity body looks up.
    monkeypatch.setattr(dr, "dispatch_action_to_agent", dispatcher)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_delegate_fires_dispatch_action_to_agent_exactly_once(monkeypatch):
    """RED→GREEN for #218. A first, clean Delegate-click route MUST
    call ``dispatch_action_to_agent`` exactly once and stamp the result
    onto the decision's ``side_effects``."""
    fake = _FakeClient("open")
    dispatcher = AsyncMock(
        return_value={
            "outcome_signal_path": "01H_OUTCOME_ULID",
            "agent_response_summary": "Sent the reply to the client.",
        }
    )
    _install(monkeypatch, fake, dispatcher)

    result = asyncio.run(dr.route_decision(_delegate_decision("open")))

    # 1. dispatch_action_to_agent was called exactly once.
    assert dispatcher.await_count == 1, (
        "DecisionRouter must fire dispatch_action_to_agent on a delegate "
        "decision now that Lane I's #216 severed signal_router's "
        "principal_delegate_override path"
    )

    # 2. The dispatch fired AFTER the ctrl-api /dispatch POST (so the
    #    re-routed signal ULID was known and could be passed as
    #    source_signal_path).
    assert fake.dispatch_endpoint_count() == 1
    call_kwargs = dispatcher.await_args.kwargs
    assert call_kwargs.get("source_signal_path") == fake.re_routed_signal

    # 3. The decision's side_effects carry an ``agent_dispatched`` marker
    #    so a re-tick of DecisionRouterWorkflow sees "already dispatched"
    #    and skips. ``agent_outcome_signal`` carries the outcome signal
    #    path that ``check_decision_outcomes`` will later match against
    #    its agent_outcome-source-typed signal pool.
    assert result["side_effects"].get("agent_dispatched") is True
    assert (
        result["side_effects"].get("agent_outcome_signal")
        == "01H_OUTCOME_ULID"
    )
    # The dispatch should be reflected on the final decision PATCH too
    # (so a workflow that re-lists this decision sees the marker).
    assert fake.side_effects_seen.get("agent_dispatched") is True

    # 4. Decision ends at state=executing (so check_decision_outcomes
    #    can pick up the outcome signal when it lands).
    assert result["next_state"] == "executing"
    assert "agent.dispatched" in result["actions"]


def test_delegate_retick_does_not_redispatch(monkeypatch):
    """Idempotency: if DecisionRouterWorkflow ever re-presents a
    delegate decision that already carries ``side_effects.agent_dispatched=true``
    (e.g. a workflow re-list saw the executing PATCH but the activity
    is replayed against the same record), the dispatch MUST NOT re-fire.

    The state guard (``state != "open"``) already covers the common case
    (the decision moves to ``executing`` after the first route). But a
    decision that landed back in state=open through some other path
    (manual ops, retry from an earlier checkpoint) with ``agent_dispatched``
    already set MUST also be safe — this is the belt to the state guard's
    suspenders."""
    fake = _FakeClient("open")
    dispatcher = AsyncMock(
        return_value={
            "outcome_signal_path": "01H_OUTCOME_ULID",
            "agent_response_summary": "(already dispatched once)",
        }
    )
    _install(monkeypatch, fake, dispatcher)

    decision = _delegate_decision(
        "open",
        side_effects={
            "synchronous_flip": True,
            "agent_dispatched": True,
            "agent_outcome_signal": "01H_OUTCOME_PRIOR",
        },
    )
    result = asyncio.run(dr.route_decision(decision))

    assert dispatcher.await_count == 0, (
        "a delegate decision already stamped agent_dispatched=true MUST "
        "NOT re-fire dispatch_action_to_agent on a re-tick"
    )
    # Prior outcome stays — we did not clobber it.
    assert (
        result["side_effects"].get("agent_outcome_signal")
        == "01H_OUTCOME_PRIOR"
    )


def test_delegate_state_dispatching_skips_all(monkeypatch):
    """The pre-dispatch ``state=dispatching`` mark (#55) still wins over
    the new agent-dispatch path. A re-entry while ``dispatching`` does
    NOT touch the dispatch endpoint AND does NOT call the agent."""
    fake = _FakeClient("dispatching")
    dispatcher = AsyncMock()
    _install(monkeypatch, fake, dispatcher)

    result = asyncio.run(dr.route_decision(_delegate_decision("dispatching")))

    assert dispatcher.await_count == 0
    assert fake.dispatch_endpoint_count() == 0
    assert result["skipped"] is True
    assert result["reason"] == "state=dispatching"


def test_delegate_dispatch_failure_does_not_block_decision_advance(monkeypatch):
    """If ``dispatch_action_to_agent`` raises, the decision MUST still
    advance to ``state=executing`` so the outcome poller can pick up any
    outcome signal that does eventually land (the ctrl-api /dispatch POST
    already stamped ``decision_origin`` on the re-routed signal — the
    audit trail survives even if the in-process clerk call failed). An
    error marker is stamped on side_effects for observability."""
    fake = _FakeClient("open")
    dispatcher = AsyncMock(side_effect=RuntimeError("clerk timeout"))
    _install(monkeypatch, fake, dispatcher)

    result = asyncio.run(dr.route_decision(_delegate_decision("open")))

    assert dispatcher.await_count == 1
    # Decision still advanced to executing.
    assert result["next_state"] == "executing"
    # Error captured.
    err = result["side_effects"].get("agent_dispatch_error")
    assert isinstance(err, str) and "clerk timeout" in err
    # ``agent_dispatched`` is NOT set (the dispatch failed) so a future
    # ops re-trigger CAN re-fire if desired.
    assert result["side_effects"].get("agent_dispatched") is not True
    assert "agent.dispatch_failed" in result["actions"]


def test_module_seam_is_present_for_worker_registration(monkeypatch):
    """Smoke check: the dispatch_action_to_agent symbol must be importable
    from src.activities.decision_router (the activity body does a
    module-level import so the Temporal worker registration in
    src/worker.py already covers it — but the test confirms the import
    plumbing is wired so a typo doesn't ship)."""
    assert getattr(dr, "dispatch_action_to_agent", None) is not None
    # It should be the same callable as the canonical export.
    assert dr.dispatch_action_to_agent is sa.dispatch_action_to_agent
