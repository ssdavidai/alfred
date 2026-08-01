"""Regression tests for #366 — the retired OpenClaw envelope.

`chore_actions._workers_spawn_subagent`, `tasks.execute_task` and
`tasks._llm_evaluate_consequentials` never got the Hermes-native
POST /v1/responses migration that `clerk._call_clerk` received in #20/#46.
They still POSTed `sessions_spawn` / `sessions_history` to
``http://hermes:18790/tools/invoke`` — a 404 on every call — which
silently killed the LLM step in 10 of 13 live user-chores and all
TaskRunner AI-task execution on home.

These tests pin the new transport: everything routes through
``clerk._call_clerk`` and the retired envelope is gone from the code.
"""
from __future__ import annotations

import asyncio
import json
import pathlib

import pytest

from src.activities import chore_actions as ca
from src.activities import tasks as tasks_mod
from src.activities import clerk as clerk_mod

SRC = pathlib.Path(__file__).resolve().parents[1] / "src"


def _patch_clerk(monkeypatch, reply: str | Exception):
    calls: list[dict] = []

    async def fake_call_clerk(prompt, raw=False, agent_id=None):
        calls.append({"prompt": prompt, "raw": raw, "agent_id": agent_id})
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(clerk_mod, "_call_clerk", fake_call_clerk)
    return calls


class TestWorkersSpawnSubagent:
    def test_returns_clerk_text(self, monkeypatch):
        calls = _patch_clerk(monkeypatch, "final answer")
        out = asyncio.run(
            ca._workers_spawn_subagent(agent_id="chore-x", prompt="do the thing")
        )
        assert out == "final answer"
        assert calls[0]["raw"] is True
        assert calls[0]["agent_id"] == "chore-x"

    def test_failure_returns_empty_string_contract(self, monkeypatch):
        """Chore callers all handle '' — a dead gateway must not throw here,
        but it must also no longer be SILENT (logged at warning)."""
        _patch_clerk(monkeypatch, RuntimeError("gateway down"))
        out = asyncio.run(
            ca._workers_spawn_subagent(agent_id="chore-x", prompt="p")
        )
        assert out == ""

    def test_legacy_timeout_kwargs_still_accepted(self, monkeypatch):
        _patch_clerk(monkeypatch, "ok")
        out = asyncio.run(
            ca._workers_spawn_subagent(
                agent_id="a", prompt="p", run_timeout_s=5, poll_timeout_s=5
            )
        )
        assert out == "ok"


class TestExecuteTask:
    def test_parses_final_json(self, monkeypatch):
        reply = json.dumps(
            {"status": "completed", "output": "did it", "summary": "done",
             "follow_up_tasks": []}
        )
        calls = _patch_clerk(monkeypatch, reply)
        result = asyncio.run(
            tasks_mod.execute_task({"title": "T", "agent_id": "exec-1"}, "ctx")
        )
        assert result["status"] == "completed"
        assert result["summary"] == "done"
        assert calls[0]["agent_id"] == "exec-1"
        assert "ctx" in calls[0]["prompt"]

    def test_empty_output_is_error_result(self, monkeypatch):
        _patch_clerk(monkeypatch, "   ")
        result = asyncio.run(tasks_mod.execute_task({"title": "T"}, "ctx"))
        assert result["status"] == "error"

    def test_clerk_exception_propagates(self, monkeypatch):
        """Auth/billing failures must reach Temporal's retry classifier,
        not be swallowed into a fake 'timeout' result."""
        _patch_clerk(monkeypatch, RuntimeError("boom"))
        with pytest.raises(RuntimeError):
            asyncio.run(tasks_mod.execute_task({"title": "T"}, "ctx"))


class TestLlmEvaluateConsequentials:
    def test_extracts_follow_ups(self, monkeypatch):
        reply = json.dumps({"follow_up_tasks": [{"title": "F", "owner": "human"}]})
        _patch_clerk(monkeypatch, reply)

        class _Cfg:
            clerk_agent_id = "learn-clerk"

        out = asyncio.run(
            tasks_mod._llm_evaluate_consequentials(_Cfg(), {"title": "T"}, {"summary": "s"})
        )
        assert out == [{"title": "F", "owner": "human"}]


def test_retired_envelope_is_gone_from_fixed_modules():
    """#366 guard: the retired OpenClaw envelope must not reappear in the
    two migrated modules. (plane_alfred_triggers still carries it — dormant
    Plane code, tracked under #374's cleanup, deliberately not asserted.)"""
    for mod in ("activities/tasks.py", "activities/chore_actions.py"):
        source = (SRC / mod).read_text()
        assert '"tool": "sessions_spawn"' not in source, mod
        assert '"tool": "sessions_history"' not in source, mod
        assert "/tools/invoke\"" not in source.replace("f\"{base}", "\""), mod
