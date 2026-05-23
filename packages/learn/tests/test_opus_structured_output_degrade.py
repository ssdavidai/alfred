"""Opus stages opt into structured output + persona override + degrade-on-empty.

Lane II / harden Commit 2. Wires every onboarding ``_opus`` activity into
the Commit-1 ``_call_llm`` extensions AND closes the silent-empty-parse
gap that left ``/verify`` empty in production.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

from temporalio import activity
from temporalio.testing import ActivityEnvironment


def _seed_onboard(tmp_path: Path) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(json.dumps({
        "user_id": "u-1", "stage": "metadata",
        "progress": {"current_day": 0, "total_days": 0,
                     "facts_count": 0, "patterns_count": 0},
        "facts": [{"category": "p", "fact": "x", "confidence": "high"}],
        "patterns": [{"type": "work", "name": "n", "description": "d"}],
        "emails": [{"date": "2026-05-20", "from": "x@y.com", "to": "u@v.com",
                    "subject": "s", "snippet": "hi"}],
        "user_md": "# U", "soul_md": "# S",
        "automations": [], "brief": "",
    }))
    return str(path)


def _run(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_wrap")
    async def _wrapper() -> Any:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


def _capture(return_text: str = "{}"):
    captured: dict[str, Any] = {"calls": []}

    async def _se(*args, **kwargs):
        captured["calls"].append({"args": args, "kwargs": kwargs})
        return return_text

    return AsyncMock(side_effect=_se), captured


def _no_http():
    """Block any real HTTP — activities try to write to ctrl-api."""
    p = patch("src.activities.onboarding_v3.httpx.AsyncClient")
    m = p.start()
    m.side_effect = Exception("no HTTP")
    return p


# --- structured-output wiring -------------------------------------------


def test_extract_facts_opus_wires_json_object_and_persona_override(
    tmp_path, monkeypatch,
) -> None:
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    valid = json.dumps({
        "facts": [{"category": "p", "fact": "x", "confidence": "high"}],
        "key_identity_facts": [{"field": "name", "value": "J", "display": "F"}],
    })
    mock, captured = _capture(return_text=valid)
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: extract_facts_opus(onboard))
    kw = captured["calls"][0]["kwargs"]
    assert kw.get("response_format") == {"type": "json_object"}
    assert kw.get("instructions")
    assert "json" in kw["instructions"].lower() or "extract" in kw["instructions"].lower()


def test_discover_patterns_opus_wires_json_object_and_persona_override(
    tmp_path, monkeypatch,
) -> None:
    from src.activities.onboarding_v3 import discover_patterns_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    valid = json.dumps({"patterns": [{"type": "w", "name": "n", "description": "d"}]})
    mock, captured = _capture(return_text=valid)
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: discover_patterns_opus(onboard))
    kw = captured["calls"][0]["kwargs"]
    assert kw.get("response_format") == {"type": "json_object"}
    assert kw.get("instructions")


def test_personalize_opus_wires_json_object_and_persona_override(
    tmp_path, monkeypatch,
) -> None:
    from src.activities.onboarding_v3 import personalize_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    valid = json.dumps({
        "user_md": "# U", "soul_md": "# S", "memory_md": "# M",
        "tools_md": "# T", "rules_md": "# R",
        "rules": {"household": ["q"]},
        "soul": {"values": "x" * 50, "tone_preferences": "y" * 50,
                 "what_i_care_about": "z" * 50},
    })
    mock, captured = _capture(return_text=valid)
    p = _no_http()
    try:
        with patch("src.activities.onboarding_v3._call_llm", new=mock):
            try:
                _run(lambda: personalize_opus(onboard))
            except Exception:
                pass
    finally:
        p.stop()
    kw = captured["calls"][0]["kwargs"]
    assert kw.get("response_format") == {"type": "json_object"}
    assert kw.get("instructions")


def test_write_brief_opus_passes_persona_override(
    tmp_path, monkeypatch,
) -> None:
    """Brief is plain prose — response_format optional, but persona
    override MUST kill the 33k Alfred frame."""
    from src.activities.onboarding_v3 import write_brief_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    mock, captured = _capture(return_text="Sir, welcome.\n\nAt your disposal.")
    p = _no_http()
    try:
        with patch("src.activities.onboarding_v3._call_llm", new=mock):
            try:
                _run(lambda: write_brief_opus(onboard))
            except Exception:
                pass
    finally:
        p.stop()
    kw = captured["calls"][0]["kwargs"]
    assert kw.get("instructions")


def test_write_brief_and_opportunities_opus_wires_json_object(
    tmp_path, monkeypatch,
) -> None:
    from src.activities.onboarding_v3 import write_brief_and_opportunities_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    valid = json.dumps({
        "brief": "Sir, welcome.\nAt your disposal.",
        "opportunities": [{
            "id": "watch-subs", "name": "Watch subs", "description": "w",
            "goal": "g", "trigger": {"kind": "cron", "hint": "w"},
            "data_sources": ["event"], "frequency_hint": "weekly",
            "notify_when": "n", "tags": ["financial"],
        }],
    })
    mock, captured = _capture(return_text=valid)
    p = _no_http()
    try:
        with patch("src.activities.onboarding_v3._call_llm", new=mock):
            try:
                _run(lambda: write_brief_and_opportunities_opus(onboard))
            except Exception:
                pass
    finally:
        p.stop()
    kw = captured["calls"][0]["kwargs"]
    assert kw.get("response_format") == {"type": "json_object"}
    assert kw.get("instructions")


# --- degrade-on-empty-parse (the real production failure) ----------------


def test_extract_facts_opus_parse_failure_marks_degraded(
    tmp_path, monkeypatch,
) -> None:
    """62-char production failure: parser returns {} but no exception —
    activity must mark ``facts`` degraded."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    garbage = "I cannot return JSON for this request. Please try again. xxxxx"
    assert len(garbage) == 62
    with patch("src.activities.onboarding_v3._call_llm",
               new=AsyncMock(return_value=garbage)):
        result = _run(lambda: extract_facts_opus(onboard))
    assert isinstance(result, dict)
    assert "facts" in json.loads(Path(onboard).read_text()).get("degraded_stages", [])


def test_discover_patterns_opus_parse_failure_marks_degraded(
    tmp_path, monkeypatch,
) -> None:
    from src.activities.onboarding_v3 import discover_patterns_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    with patch("src.activities.onboarding_v3._call_llm",
               new=AsyncMock(return_value="not json")):
        _run(lambda: discover_patterns_opus(onboard))
    assert "patterns" in json.loads(Path(onboard).read_text()).get("degraded_stages", [])


def test_personalize_opus_parse_failure_marks_degraded(
    tmp_path, monkeypatch,
) -> None:
    from src.activities.onboarding_v3 import personalize_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    p = _no_http()
    try:
        with patch("src.activities.onboarding_v3._call_llm",
                   new=AsyncMock(return_value="not json")):
            _run(lambda: personalize_opus(onboard))
    finally:
        p.stop()
    assert "personalize" in json.loads(Path(onboard).read_text()).get("degraded_stages", [])


# --- alias normalisation reaches the Opus stages --------------------------


def test_extract_facts_opus_accepts_aliased_identity_facts(
    tmp_path, monkeypatch,
) -> None:
    """``identityFacts`` (alias) is normalised to ``key_identity_facts``."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    aliased = json.dumps({
        "facts": [{"category": "p", "fact": "x", "confidence": "high"}],
        "identityFacts": [{"field": "name", "value": "Jane", "display": "Full name"}],
    })
    with patch("src.activities.onboarding_v3._call_llm",
               new=AsyncMock(return_value=aliased)):
        _run(lambda: extract_facts_opus(onboard))
    data = json.loads(Path(onboard).read_text())
    assert data.get("key_identity_facts") == [
        {"field": "name", "value": "Jane", "display": "Full name"},
    ]
    assert "facts" not in data.get("degraded_stages", [])
