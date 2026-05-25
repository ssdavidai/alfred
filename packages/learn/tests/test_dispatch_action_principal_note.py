"""Regression: dispatch_action_to_agent must honour ``principal_note``.

The 2026-05-25 Wyoming repro of the EDITH failure: Sir clicked Delegate on
a needs_attention card, his note read "send me a reminder about this on
Telegram right now in a dm", but the legacy_prompt path in
``dispatch_action_to_agent`` only used ``action_proposal.what`` (the
auto-extracted signal headline) — Sir's note was silently dropped. The
agent then "researched" the underlying topic and never sent a Telegram
message.

This file proves:

  1. PRINCIPAL_NOTE PATH — when ``principal_note`` is non-empty, the prompt
     sent to ``_call_clerk`` contains Sir's note verbatim AND describes the
     auto-extracted ``what`` as context only ("Signal: …").
  2. AUTONOMOUS PATH — when ``principal_note`` is empty (instinct-triggered
     autonomous dispatch), the legacy prompt remains the same as before
     (no behavioural drift for the existing autonomous flow).
  3. The prompt names ``alfred__notify_principal`` so the agent knows
     which tool sends Telegram/Slack/email. Without this hint gpt-5.4-mini
     reliably fails to pick the right tool from a 5-app catalog.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

import src.activities.signal_actions as sa
import src.activities.clerk as clerk_mod
import src.utils.vault_client as vault_client_mod


class _FakeVaultClient:
    def __init__(self, *_a, **_kw): pass
    async def read_record(self, _path): return None
    async def close(self): return None


@pytest.fixture(autouse=True)
def _no_real_vault(monkeypatch):
    """Stub the VaultClient so the instinct lookup never tries the network."""
    monkeypatch.setattr(vault_client_mod, "VaultClient", _FakeVaultClient)


class _PromptCaptured(BaseException):
    """Aborts dispatch_action_to_agent right after the prompt is captured.

    BaseException (not Exception) so the activity's broad try/except wrappers
    don't swallow it — we want a clean unwind back to the test body.
    """
    pass


@pytest.fixture
def captured(monkeypatch):
    """Replace _call_clerk with a recorder that aborts the rest of the
    activity (which would otherwise try to POST to ctrl-api and a real
    Hermes endpoint). The prompt is what we care about.

    ``dispatch_action_to_agent`` imports ``_call_clerk`` lazily inside its
    body (``from src.activities.clerk import _call_clerk``), so the patch
    has to land on the source module — patching ``sa._call_clerk`` would
    miss the lazy bind.
    """
    box: dict[str, Any] = {}

    async def fake(prompt, raw=False, agent_id=None, **_):
        box["prompt"] = prompt
        box["agent_id"] = agent_id
        raise _PromptCaptured()

    monkeypatch.setattr(clerk_mod, "_call_clerk", fake)
    return box


def _run_and_capture_prompt(captured, **kwargs) -> str:
    try:
        asyncio.run(sa.dispatch_action_to_agent(**kwargs))
    except _PromptCaptured:
        pass
    assert "prompt" in captured, "fake _call_clerk was never invoked"
    return captured["prompt"]


@pytest.fixture(autouse=True)
def _stub_outcome_writers(monkeypatch):
    """Stub the post-dispatch ctrl-api writes so the test stays unit-local."""
    async def _noop(*_a, **_kw): return {"ok": True}
    for name in ("_write_agent_outcome_signal", "_record_dispatch_audit"):
        if hasattr(sa, name):
            monkeypatch.setattr(sa, name, _noop)


def _action_proposal() -> dict[str, Any]:
    return {
        "what": "File the Wyoming annual report before the deadline.",
        "suggested_actor": "human",
        "due_at": "2026-06-01",
    }


def test_principal_note_becomes_canonical_task_in_legacy_prompt(captured):
    """The principal's note must be the agent's task, not action_what."""
    prompt = _run_and_capture_prompt(
        captured,
        action_proposal=_action_proposal(),
        target_path="task/wyoming.md",
        matched_instinct_path="",
        source_signal_path="signal/abc.md",
        principal_note="send me a reminder about this on Telegram right now in a dm",
    )

    # Sir's note is in the prompt — and framed as the canonical task.
    assert "send me a reminder about this on Telegram right now in a dm" in prompt
    assert "canonical prompt" in prompt or "execute exactly this" in prompt

    # action_what appears, but as context — not as the task.
    assert "File the Wyoming annual report" in prompt
    assert "Signal:" in prompt  # the "context only" marker

    # The tool that sends Telegram is named explicitly so the agent picks it.
    assert "notify_principal" in prompt


def test_autonomous_dispatch_unchanged_when_principal_note_absent(captured):
    """No principal_note → legacy autonomous prompt unchanged."""
    prompt = _run_and_capture_prompt(
        captured,
        action_proposal=_action_proposal(),
        target_path="task/wyoming.md",
        matched_instinct_path="",
        source_signal_path="signal/abc.md",
        # principal_note defaults to ""
    )

    # Action header (autonomous shape)
    assert "Action: File the Wyoming annual report" in prompt
    # No principal-note framing
    assert "canonical prompt" not in prompt
    assert "Telegram" not in prompt  # no instruction to message Sir


def test_principal_note_short_form_still_carried_through(captured):
    """Defensive: even a 4-word note must reach the prompt verbatim."""
    prompt = _run_and_capture_prompt(
        captured,
        action_proposal=_action_proposal(),
        target_path=None,
        matched_instinct_path="",
        source_signal_path="",
        principal_note="ping me on telegram",
    )
    assert "ping me on telegram" in prompt
