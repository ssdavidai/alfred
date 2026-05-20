"""#B2 — the onboarding First-Brief vault write must SURFACE a failure.

FAILURE-MODES Brief, S1: ``write_brief_opus`` / ``write_brief_and_
opportunities_opus`` wrapped the ctrl-api vault POST in ``except: pass``
(and ``except: …warning``) AND never checked the response status — so a
422 promotion-contract rejection left the brief unpersisted while the
activity still returned a success dict and the workflow reported ``done``.

These tests assert a non-2xx write now RAISES out of the activity (so the
Temporal stage retries / surfaces) instead of looking like success, while
a healthy 2xx still returns the success dict.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment


def _make_brief_onboard(tmp_path: Path) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(
        json.dumps(
            {
                "facts": [{"category": "professional", "fact": "Runs LLC",
                           "confidence": "high"}],
                "patterns": [{"name": "p1", "description": "stats Tuesdays"}],
                "user_md": "# User\n\nJane Doe.",
                "soul_md": "# Soul\n\nAddress as Sir.",
            }
        )
    )
    return str(path)


def _client(status_code: int, text: str = ""):
    """httpx.AsyncClient stand-in whose POST returns the given status."""
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None

    async def _post(url: str, **kwargs: Any):
        return type("R", (), {"status_code": status_code, "text": text,
                              "is_success": 200 <= status_code < 300})()

    client.post = AsyncMock(side_effect=_post)
    return client


def _run_activity(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper")
    async def _wrapper() -> Any:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


# One opportunity that passes ChoreOpportunity validation so the activity
# reaches its own vault write (does not fall back to write_brief_opus).
_GOOD_BRIEF_AND_OPPS = json.dumps({
    "brief": "Sir, welcome. At your disposal.",
    "opportunities": [{
        "id": "track-stripe-stats", "name": "Track Stripe stats",
        "description": "Pull a weekly Stripe revenue digest.",
        "goal": "Keep Sir informed of revenue trends.",
        "trigger": {"kind": "cron", "hint": "weekly on Tuesday"},
        "data_sources": ["stripe"], "frequency_hint": "weekly",
        "notify_when": "always", "tags": ["finance"],
    }],
})


def test_write_brief_opus_raises_on_non_2xx(tmp_path, monkeypatch) -> None:
    from src.activities.onboarding_v3 import write_brief_opus

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _make_brief_onboard(tmp_path)
    with patch(
        "src.activities.onboarding_v3._call_llm",
        new=AsyncMock(return_value="Sir, welcome. At your disposal."),
    ), patch("httpx.AsyncClient",
             return_value=_client(422, "PROMOTION_CONTRACT_VIOLATION")):
        with pytest.raises(Exception) as ei:
            _run_activity(lambda: write_brief_opus(onboard))
    assert "brief" in str(ei.value).lower() or "422" in str(ei.value)


def test_write_brief_and_opportunities_opus_raises_on_non_2xx(
    tmp_path, monkeypatch
) -> None:
    from src.activities.onboarding_v3 import write_brief_and_opportunities_opus

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _make_brief_onboard(tmp_path)
    with patch(
        "src.activities.onboarding_v3._call_llm",
        new=AsyncMock(return_value=_GOOD_BRIEF_AND_OPPS),
    ), patch("httpx.AsyncClient", return_value=_client(422)):
        with pytest.raises(Exception):
            _run_activity(lambda: write_brief_and_opportunities_opus(onboard))


def test_write_brief_opus_succeeds_on_2xx(tmp_path, monkeypatch) -> None:
    """A healthy 2xx write still returns the success dict — the new
    surfacing must not introduce a false positive."""
    from src.activities.onboarding_v3 import write_brief_opus

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _make_brief_onboard(tmp_path)
    with patch(
        "src.activities.onboarding_v3._call_llm",
        new=AsyncMock(return_value="Sir, welcome. At your disposal."),
    ), patch("httpx.AsyncClient", return_value=_client(201)):
        result = _run_activity(lambda: write_brief_opus(onboard))
    assert result.get("brief_length", 0) > 0
