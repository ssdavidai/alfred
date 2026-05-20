"""Tests for the #54 mark-before-dispatch double-fire fix in
``route_signal_action`` (``src/activities/signal_actions.py``).

The bug (pre-existing latent, not a #37 regression): the agent dispatch
(``dispatch_action_to_agent``) ran BEFORE the terminal ``routed_agent``
status write. The idempotency guard only early-returned once the status
was terminal, so a run that died or was retried *between* a successful
dispatch and the status write re-entered with the signal still
``action_pending`` — the guard missed and the agent was dispatched a
second time (a second real ``POST /v1/runs``).

The fix marks the signal ``dispatching`` BEFORE the dispatch and extends
the guard to early-return on ``dispatching``. These tests prove:

  1. A re-entry while the signal is ``dispatching`` does NOT re-dispatch.
  2. The happy path still marks ``dispatching`` strictly before the
     dispatch and advances to ``routed_agent`` afterwards.
  3. The terminal-status guard (``routed_agent``) still holds.
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

import src.activities.signal_actions as sa
import src.utils.signal_state as signal_state


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _FakeStateDb:
    """A stateful in-memory stand-in for the state.db ``signal`` table.

    Backs ``read_signal_record`` / ``set_signal_status`` so the
    idempotency guard reads exactly what a prior step wrote — the whole
    point of the test is the ordering of those reads/writes.
    """

    def __init__(self, signal_id: str, frontmatter: dict[str, Any]) -> None:
        self.signal_id = signal_id
        self.frontmatter = dict(frontmatter)
        # Ordered log of every status write, for ordering assertions.
        self.status_writes: list[str] = []

    async def read_signal_record(
        self, signal_ref: str, *, config: Any = None
    ) -> Optional[dict[str, Any]]:
        if signal_ref != self.signal_id:
            return None
        return {
            "path": self.signal_id,
            "id": self.signal_id,
            "type": "signal",
            "frontmatter": dict(self.frontmatter),
        }

    async def set_signal_status(
        self,
        signal_ref: str,
        status: str,
        *,
        applied_at: str | None = None,
        audit_record_ref: str | None = None,
        config: Any = None,
    ) -> None:
        assert signal_ref == self.signal_id
        self.frontmatter["status"] = status
        if applied_at is not None:
            self.frontmatter["applied_at"] = applied_at
        if audit_record_ref is not None:
            self.frontmatter["audit_record_path"] = audit_record_ref
        self.status_writes.append(status)


class _FakeVaultClient:
    """Minimal VaultClient — only ``read_record`` (for decision_origin)."""

    def __init__(self, config: Any) -> None:
        self._records: dict[str, dict[str, Any]] = {}

    async def read_record(self, path: str) -> dict[str, Any]:
        return self._records.get(path, {"frontmatter": {}})

    async def close(self) -> None:
        return None


class _DispatchCounter:
    """Counts real agent dispatches and records the status at dispatch time."""

    def __init__(self, fake_db: _FakeStateDb) -> None:
        self.calls = 0
        self.status_at_dispatch: list[str] = []
        self._db = fake_db

    async def __call__(
        self,
        action_proposal: dict[str, Any],
        target_path: str | None,
        matched_instinct_path: str,
        source_signal_path: str = "",
        principal_note: str = "",
    ) -> dict[str, Any]:
        self.calls += 1
        # Snapshot the status the moment the agent is dispatched — this
        # is what proves the mark-before-dispatch ordering.
        self.status_at_dispatch.append(
            str(self._db.frontmatter.get("status") or "")
        )
        return {
            "outcome_signal_path": "signal/agent-outcome-test",
            "agent_response_summary": "done",
        }


# ---------------------------------------------------------------------------
# Fixture wiring
# ---------------------------------------------------------------------------


def _action_signal_frontmatter(status: str) -> dict[str, Any]:
    """A minimal effect=action signal whose decision_origin forces the
    AGENT path (principal_delegate_override) so the test does not depend
    on instinct matching / discretion thresholds."""
    return {
        "type": "signal",
        "status": status,
        "effect": "action",
        "decision_required": True,
        "decision_origin": "decision/2026-05-19-delegate-test.md",
        "action_proposal": {
            "what": "Send Sir a telegram reminder",
            "suggested_actor": "alfred",
        },
        "target_kind": None,
        "target_confidence": 0.0,
        "effect_confidence": 0.99,
    }


def _install(monkeypatch, fake_db: _FakeStateDb, dispatcher: _DispatchCounter):
    """Patch every external seam ``route_signal_action`` reaches for."""
    # signal_state seam (function-body imports resolve from this module).
    monkeypatch.setattr(
        signal_state, "read_signal_record", fake_db.read_signal_record
    )
    monkeypatch.setattr(
        signal_state, "set_signal_status", fake_db.set_signal_status
    )
    # VaultClient — function-body import is ``from src.utils.vault_client
    # import VaultClient``; patch on that module.
    import src.utils.vault_client as vc_mod

    monkeypatch.setattr(vc_mod, "VaultClient", _FakeVaultClient)

    # load_config — function-body import ``from src.config import load_config``.
    import src.config as cfg_mod

    monkeypatch.setattr(cfg_mod, "load_config", lambda: object())

    # The decision_origin record must read as intent=delegate so the
    # principal-delegate override fires (AGENT path, bypasses tiers).
    async def _fake_read_record(self, path: str) -> dict[str, Any]:
        if path == "decision/2026-05-19-delegate-test.md":
            return {"frontmatter": {"intent": "delegate", "note": "do it now"}}
        return {"frontmatter": {}}

    monkeypatch.setattr(_FakeVaultClient, "read_record", _fake_read_record)

    # Module-level seams on signal_actions itself.
    monkeypatch.setattr(sa, "dispatch_action_to_agent", dispatcher)

    async def _fake_audit(**kwargs: Any) -> str:
        return "event/signal-action-test.md"

    monkeypatch.setattr(sa, "_emit_signal_action_audit", _fake_audit)

    async def _fake_load_instincts() -> list[Any]:
        return []

    monkeypatch.setattr(sa, "_load_active_instincts", _fake_load_instincts)

    # env: env-veto must not downgrade live→shadow. principal-delegate
    # overrides shadow anyway, but keep the test explicit.
    monkeypatch.setenv(sa.SIGNAL_ACTION_LIVE_MODE_ENV, "live")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_happy_path_marks_dispatching_before_dispatch(monkeypatch):
    """A first, clean run dispatches exactly once, and the signal is
    marked ``dispatching`` strictly BEFORE the agent dispatch and ends
    at the terminal ``routed_agent``."""
    fake_db = _FakeStateDb("sig-001", _action_signal_frontmatter("action_pending"))
    dispatcher = _DispatchCounter(fake_db)
    _install(monkeypatch, fake_db, dispatcher)

    result = asyncio.run(sa.route_signal_action("sig-001", "live"))

    assert dispatcher.calls == 1, "agent must be dispatched exactly once"
    # The status the dispatcher saw at dispatch time must be 'dispatching'
    # — proof the mark landed BEFORE the POST /v1/runs.
    assert dispatcher.status_at_dispatch == ["dispatching"]
    # Ordering of status writes: dispatching THEN routed_agent.
    assert fake_db.status_writes == ["dispatching", "routed_agent"]
    assert result["signal_status"] == "routed_agent"
    assert result["chosen_path"] == "agent"


def test_reentry_while_dispatching_does_not_redispatch(monkeypatch):
    """THE #54 REGRESSION GUARD. A run that crashed AFTER the
    ``dispatching`` mark but BEFORE the terminal status write re-enters
    with the signal still ``dispatching`` — the guard must early-return
    and NOT dispatch the agent a second time."""
    # Signal state as a crashed run left it: marked dispatching, no
    # terminal write, agent already dispatched once in the dead run.
    fake_db = _FakeStateDb("sig-002", _action_signal_frontmatter("dispatching"))
    fake_db.frontmatter["applied_at"] = "2026-05-19T10:00:00+00:00"
    dispatcher = _DispatchCounter(fake_db)
    _install(monkeypatch, fake_db, dispatcher)

    result = asyncio.run(sa.route_signal_action("sig-002", "live"))

    assert dispatcher.calls == 0, (
        "re-entry while dispatching MUST NOT re-fire the agent — "
        "this is the double-fire bug #54 closes"
    )
    assert fake_db.status_writes == [], "no status write on the guard skip"
    assert result["signal_status"] == "dispatching"
    assert result["skip_reason"] == "already_routed"
    assert result["decision_reason"] == "idempotency_guard"


def test_reentry_while_routed_agent_does_not_redispatch(monkeypatch):
    """The original (post-2026-05-12) terminal-status guard still holds:
    a re-entry on an already ``routed_agent`` signal does not dispatch."""
    fake_db = _FakeStateDb("sig-003", _action_signal_frontmatter("routed_agent"))
    dispatcher = _DispatchCounter(fake_db)
    _install(monkeypatch, fake_db, dispatcher)

    result = asyncio.run(sa.route_signal_action("sig-003", "live"))

    assert dispatcher.calls == 0
    assert result["signal_status"] == "routed_agent"
    assert result["skip_reason"] == "already_routed"


def test_two_runs_simulating_crash_window_dispatch_once(monkeypatch):
    """End-to-end window simulation: run #1 marks ``dispatching``,
    dispatches, then 'crashes' before the terminal write; run #2 is the
    retry. Across BOTH runs the agent must be dispatched exactly once."""
    fake_db = _FakeStateDb("sig-004", _action_signal_frontmatter("action_pending"))
    dispatcher = _DispatchCounter(fake_db)
    _install(monkeypatch, fake_db, dispatcher)

    # --- Run #1: crash injected immediately after the dispatch returns,
    #     before the step-9 terminal status write. ---
    real_dispatch = dispatcher.__call__

    class _CrashAfterDispatch(Exception):
        pass

    async def _dispatch_then_crash(*args: Any, **kwargs: Any) -> dict[str, Any]:
        out = await real_dispatch(*args, **kwargs)
        # The dispatch (POST /v1/runs) succeeded; the signal is marked
        # 'dispatching'. Now die before routed_agent is written —
        # exactly the double-fire window.
        raise _CrashAfterDispatch()

    monkeypatch.setattr(sa, "dispatch_action_to_agent", _dispatch_then_crash)

    try:
        asyncio.run(sa.route_signal_action("sig-004", "live"))
    except _CrashAfterDispatch:
        pass

    assert dispatcher.calls == 1
    assert fake_db.frontmatter["status"] == "dispatching", (
        "after the crash the signal is stranded in 'dispatching' — "
        "the visible, sweepable stuck state"
    )

    # --- Run #2: the Temporal retry. The signal is still 'dispatching'.
    #     The guard must catch it; no second dispatch. ---
    monkeypatch.setattr(sa, "dispatch_action_to_agent", dispatcher)
    result = asyncio.run(sa.route_signal_action("sig-004", "live"))

    assert dispatcher.calls == 1, (
        "across the crash + retry the agent was dispatched exactly "
        "ONCE — the #54 fix closed the double-fire window"
    )
    assert result["signal_status"] == "dispatching"
    assert result["skip_reason"] == "already_routed"
