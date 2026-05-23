"""Onboarding robustness — Phase 4 / Lane II, Commit 1.

Credit-aware degrade. Each LLM-calling onboarding activity wraps its core
``_call_llm`` and routes a 402 / credit-exhaustion failure through
``_handle_llm_degraded``:

  * logs ``WARNING: stage=<name> activity=<name> degraded — 402 (credits exhausted)``
  * appends the stage name to ``onboard.json["degraded_stages"]``
  * RETURNS a partial-result sentinel — does NOT raise.

No Temporal retry-burn on a credit wall; non-credit errors still raise so
Temporal can ride out transients.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment


def _seed_onboard(
    tmp_path: Path,
    *,
    facts: list[dict] | None = None,
    patterns: list[dict] | None = None,
) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(json.dumps({
        "user_id": "u-1",
        "stage": "metadata",
        "progress": {"current_day": 0, "total_days": 0,
                     "facts_count": 0, "patterns_count": 0},
        "facts": facts or [],
        "patterns": patterns or [],
        "emails": [{"date": "2026-05-20", "from": "x@y.com", "to": "u@v.com",
                    "subject": "s", "snippet": "hi"}],
        "user_md": "# User\n\nJane Doe.",
        "soul_md": "# Soul\n\nAddress as Sir.",
        "automations": [],
        "brief": "",
    }))
    return str(path)


def _mk_402() -> httpx.HTTPStatusError:
    """402 HTTPStatusError as raised by ``onboarding_v3._call_llm``'s
    ``resp.raise_for_status()`` when heavy-Hermes returns 402."""
    req = httpx.Request("POST", "http://hermes/v1/responses")
    resp = httpx.Response(status_code=402, request=req,
                          json={"error": {"message": "insufficient credits"}})
    return httpx.HTTPStatusError("402", request=req, response=resp)


def _run_activity(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper")
    async def _wrapper() -> Any:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


# --- helper classifier --------------------------------------------------


def test_handle_llm_degraded_recognizes_httpx_402(tmp_path) -> None:
    from src.activities.onboarding_v3 import _handle_llm_degraded

    onboard_path = _seed_onboard(tmp_path)
    result = _handle_llm_degraded("facts", onboard_path, _mk_402())
    assert result is not None
    data = json.loads(Path(onboard_path).read_text())
    assert data.get("degraded_stages") == ["facts"]


def test_handle_llm_degraded_recognizes_billing_marker(tmp_path) -> None:
    """A non-HTTP error whose message carries a billing marker is a degrade —
    that's how ``_call_clerk`` surfaces a 200-with-billing-text failure."""
    from src.activities.onboarding_v3 import _handle_llm_degraded

    onboard_path = _seed_onboard(tmp_path)
    exc = RuntimeError("Clerk LLM billing error: insufficient credits")
    assert _handle_llm_degraded("patterns", onboard_path, exc) is not None
    data = json.loads(Path(onboard_path).read_text())
    assert "patterns" in data.get("degraded_stages", [])


def test_handle_llm_degraded_passes_through_non_402(tmp_path) -> None:
    """A non-billing exception returns None — caller MUST re-raise."""
    from src.activities.onboarding_v3 import _handle_llm_degraded

    onboard_path = _seed_onboard(tmp_path)
    assert _handle_llm_degraded(
        "facts", onboard_path, TimeoutError("slow"),
    ) is None
    data = json.loads(Path(onboard_path).read_text())
    assert "degraded_stages" not in data


def test_handle_llm_degraded_appends_unique(tmp_path) -> None:
    from src.activities.onboarding_v3 import _handle_llm_degraded

    onboard_path = _seed_onboard(tmp_path)
    _handle_llm_degraded("facts", onboard_path, _mk_402())
    _handle_llm_degraded("facts", onboard_path, _mk_402())
    data = json.loads(Path(onboard_path).read_text())
    assert data.get("degraded_stages") == ["facts"]


def test_handle_llm_degraded_multiple_stages(tmp_path) -> None:
    from src.activities.onboarding_v3 import _handle_llm_degraded

    onboard_path = _seed_onboard(tmp_path)
    for stage in ("facts", "patterns", "personalize"):
        _handle_llm_degraded(stage, onboard_path, _mk_402())
    data = json.loads(Path(onboard_path).read_text())
    assert data.get("degraded_stages") == ["facts", "patterns", "personalize"]


# --- per-activity wiring -----------------------------------------------


def test_extract_facts_opus_402_degrades_no_raise(tmp_path, monkeypatch) -> None:
    from src.activities.onboarding_v3 import extract_facts_opus

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    with patch("src.activities.onboarding_v3._call_llm",
               new=AsyncMock(side_effect=_mk_402())):
        result = _run_activity(lambda: extract_facts_opus(onboard))
    assert result.get("degraded") is True
    data = json.loads(Path(onboard).read_text())
    assert "facts" in data.get("degraded_stages", [])
    assert data.get("facts", []) == []


def test_discover_patterns_opus_402_degrades_no_raise(tmp_path, monkeypatch) -> None:
    from src.activities.onboarding_v3 import discover_patterns_opus

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path, facts=[
        {"category": "professional", "fact": "Runs LLC", "confidence": "high"},
    ])
    with patch("src.activities.onboarding_v3._call_llm",
               new=AsyncMock(side_effect=_mk_402())):
        result = _run_activity(lambda: discover_patterns_opus(onboard))
    assert result.get("degraded") is True
    data = json.loads(Path(onboard).read_text())
    assert "patterns" in data.get("degraded_stages", [])


def test_personalize_opus_402_degrades_no_raise(tmp_path, monkeypatch) -> None:
    from src.activities.onboarding_v3 import personalize_opus

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path, facts=[
        {"category": "professional", "fact": "Runs LLC", "confidence": "high"},
    ])
    with patch("src.activities.onboarding_v3._call_llm",
               new=AsyncMock(side_effect=_mk_402())):
        result = _run_activity(lambda: personalize_opus(onboard))
    assert result.get("degraded") is True
    data = json.loads(Path(onboard).read_text())
    assert "personalize" in data.get("degraded_stages", [])


def test_write_brief_and_opportunities_opus_402_degrades_no_raise(
    tmp_path, monkeypatch,
) -> None:
    """The 3-attempt retry loop also degrades on 402: one detection in the
    loop is enough — no re-roll against an empty wallet."""
    from src.activities.onboarding_v3 import write_brief_and_opportunities_opus

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path, facts=[
        {"category": "professional", "fact": "Runs LLC", "confidence": "high"},
    ])
    with patch("src.activities.onboarding_v3._call_llm",
               new=AsyncMock(side_effect=_mk_402())):
        result = _run_activity(
            lambda: write_brief_and_opportunities_opus(onboard),
        )
    assert result.get("degraded") is True
    data = json.loads(Path(onboard).read_text())
    assert "brief" in data.get("degraded_stages", [])


def test_non_402_still_raises(tmp_path, monkeypatch) -> None:
    """A transient (non-billing) error inside ``_call_llm`` still raises out
    of the activity — Temporal's retry loop owns transients."""
    from src.activities.onboarding_v3 import extract_facts_opus

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path)
    with patch("src.activities.onboarding_v3._call_llm",
               new=AsyncMock(side_effect=TimeoutError("slow"))):
        with pytest.raises(Exception):
            _run_activity(lambda: extract_facts_opus(onboard))
    data = json.loads(Path(onboard).read_text())
    assert "facts" not in data.get("degraded_stages", [])
