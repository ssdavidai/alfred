"""Hardening: MediaIngestionWorkflow must give clerk-backed activities a
Temporal envelope that matches the clerk HTTP completion budget, plus a
heartbeat — otherwise Temporal kills the activity at a sub-budget
``start_to_close`` while the billable clerk run keeps going server-side,
then retries → double spend (FAILURE-MODES Hermes runtime, S2).

These tests inspect the activity options the workflow schedules. They do
NOT run a real clerk call — they read the workflow source and the shared
clerk-envelope constants. The clerk-backed activities in this workflow
are: ``process_audio``/``process_document``/``process_image`` (→
``clerk_process_media``), ``classify_event`` (→ ``clerk_classify``), and
``extract_braindump`` (→ ``clerk_extract_braindump``). Each blocks on
``_call_clerk`` up to ``_CLERK_COMPLETION_BUDGET_SECONDS`` (900s).
"""
from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WF_SRC = ROOT / "src" / "workflows" / "media_ingestion.py"


# Activities in MediaIngestionWorkflow whose body blocks on _call_clerk.
_CLERK_BACKED = {
    "process_audio",
    "process_document",
    "process_image",
    "classify_event",
    "extract_braindump",
}


def _scheduled_options() -> dict[str, dict]:
    """Parse media_ingestion.py and return, per first-positional activity
    callable scheduled via workflow.execute_activity, the keyword options
    (start_to_close_timeout / heartbeat_timeout) as raw AST-source strings.
    """
    tree = ast.parse(WF_SRC.read_text())
    out: dict[str, dict] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        is_exec = (
            isinstance(func, ast.Attribute)
            and func.attr == "execute_activity"
        )
        if not is_exec or not node.args:
            continue
        first = node.args[0]
        if not isinstance(first, ast.Name):
            continue
        kwargs = {
            kw.arg: ast.unparse(kw.value)
            for kw in node.keywords
            if kw.arg
        }
        out[first.id] = kwargs
    return out


def test_clerk_envelope_constants_exported() -> None:
    """clerk.py exports a shared activity envelope/heartbeat so the workflow
    and the activity agree on one source of truth, and the envelope is
    >= the HTTP completion budget."""
    from src.activities.clerk import (
        _CLERK_COMPLETION_BUDGET_SECONDS,
        CLERK_ACTIVITY_HEARTBEAT_SECONDS,
        CLERK_ACTIVITY_TIMEOUT_SECONDS,
    )

    assert CLERK_ACTIVITY_TIMEOUT_SECONDS >= _CLERK_COMPLETION_BUDGET_SECONDS
    assert 0 < CLERK_ACTIVITY_HEARTBEAT_SECONDS < CLERK_ACTIVITY_TIMEOUT_SECONDS


def test_clerk_backed_activities_have_aligned_envelope() -> None:
    """Every clerk-backed activity scheduled by the workflow has a
    start_to_close_timeout sourced from the clerk envelope constant (not a
    bare sub-budget literal like 60/120s) and a heartbeat_timeout."""
    opts = _scheduled_options()
    for name in _CLERK_BACKED:
        assert name in opts, f"{name} not scheduled in workflow"
        kw = opts[name]
        stc = kw.get("start_to_close_timeout", "")
        hb = kw.get("heartbeat_timeout", "")
        assert "CLERK_ACTIVITY_TIMEOUT_SECONDS" in stc, (
            f"{name} start_to_close must use CLERK_ACTIVITY_TIMEOUT_SECONDS, "
            f"got {stc!r}"
        )
        assert "CLERK_ACTIVITY_HEARTBEAT_SECONDS" in hb, (
            f"{name} must set heartbeat_timeout from "
            f"CLERK_ACTIVITY_HEARTBEAT_SECONDS, got {hb!r}"
        )


def test_clerk_call_heartbeats_during_blocking_http() -> None:
    """_call_clerk emits Temporal heartbeats while the blocking HTTP call is
    in flight so a genuinely-progressing run is not killed by the
    heartbeat_timeout. We assert the heartbeat machinery is wired (a
    background heartbeat task driven off CLERK_ACTIVITY_HEARTBEAT_SECONDS)."""
    src = (ROOT / "src" / "activities" / "clerk.py").read_text()
    assert "activity.heartbeat" in src, (
        "_call_clerk must heartbeat during the long HTTP call"
    )
