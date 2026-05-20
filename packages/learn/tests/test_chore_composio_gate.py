"""#S1-3 — call_composio must enforce a generated-code safety gate.

A generated chore is LLM-authored Python and ``call_composio`` dispatched ANY
Composio action — including destructive writes — with no enforcement; the
quarantine dry-run was an unenforced convention. These tests pin the real
gate: destructive actions block or dry-run-simulate unless confirmed.
"""
from __future__ import annotations

import asyncio

import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities import chore_actions
from src.activities.chore_actions import (
    ChoreActionBlocked,
    _is_destructive_action,
    call_composio,
)


def _run_activity(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper")
    async def _wrapper():
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


class _DispatchSpy:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, endpoint, method="GET", body=None, query=None):
        self.calls.append((body.get("action"), body.get("arguments", {})))
        return {"ok": True, "dispatched": body.get("action")}


class TestClassification:
    @pytest.mark.parametrize("action", [
        "GMAIL_SEND_EMAIL", "GOOGLECALENDAR_CREATE_EVENT", "NOTION_DELETE_PAGE",
        "GITHUB_UPDATE_ISSUE", "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
    ])
    def test_destructive_actions_flagged(self, action):
        assert _is_destructive_action(action) is True

    @pytest.mark.parametrize("action", [
        "GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_FIND_EVENT", "NOTION_GET_PAGE",
        "GITHUB_LIST_ISSUES",
    ])
    def test_read_only_actions_not_flagged(self, action):
        assert _is_destructive_action(action) is False


class TestGate:
    def test_destructive_unconfirmed_is_blocked(self, monkeypatch):
        spy = _DispatchSpy()
        monkeypatch.setattr(chore_actions, "call_self", spy)
        with pytest.raises(ChoreActionBlocked):
            _run_activity(lambda: call_composio(
                "GMAIL_SEND_EMAIL", {"to": "x@y.com", "body": "hi"}
            ))
        # Nothing reached the dispatcher.
        assert spy.calls == []

    def test_destructive_dry_run_does_not_dispatch(self, monkeypatch):
        spy = _DispatchSpy()
        monkeypatch.setattr(chore_actions, "call_self", spy)
        result = _run_activity(lambda: call_composio(
            "GMAIL_SEND_EMAIL", {"to": "x@y.com"}, dry_run=True
        ))
        assert spy.calls == []
        assert result.get("dry_run") is True
        assert result.get("dispatched") is False

    def test_destructive_confirmed_dispatches(self, monkeypatch):
        spy = _DispatchSpy()
        monkeypatch.setattr(chore_actions, "call_self", spy)
        result = _run_activity(lambda: call_composio(
            "GMAIL_SEND_EMAIL", {"to": "x@y.com"}, confirm=True
        ))
        assert spy.calls == [("GMAIL_SEND_EMAIL", {"to": "x@y.com"})]
        assert result.get("ok") is True

    def test_read_only_passes_without_confirm(self, monkeypatch):
        spy = _DispatchSpy()
        monkeypatch.setattr(chore_actions, "call_self", spy)
        result = _run_activity(lambda: call_composio(
            "GMAIL_FETCH_EMAILS", {"max_results": 5}
        ))
        assert spy.calls == [("GMAIL_FETCH_EMAILS", {"max_results": 5})]
        assert result.get("ok") is True

    def test_dry_run_wins_over_confirm(self, monkeypatch):
        """Quarantine dry_run must NOT dispatch even with confirm=True."""
        spy = _DispatchSpy()
        monkeypatch.setattr(chore_actions, "call_self", spy)
        result = _run_activity(lambda: call_composio(
            "NOTION_DELETE_PAGE", {}, confirm=True, dry_run=True))
        assert spy.calls == [] and result.get("dry_run") is True
