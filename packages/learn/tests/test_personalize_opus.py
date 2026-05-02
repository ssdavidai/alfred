"""Tests for personalize_opus workspace-write error surfacing.

Regression test for #677: a non-200 response from the workspace endpoint
must fail the activity, not be silently swallowed.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities.onboarding_v3 import personalize_opus


def _run_activity(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper")
    async def _wrapper() -> dict:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


def _write_onboard(tmp_path: Path) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(json.dumps({
        "facts": [{"category": "professional", "fact": "Runs Ugly Code LLC", "confidence": "high"}],
        "patterns": [{"name": "tuesday-stripe-reviews", "description": "Reviews Stripe stats"}],
    }))
    return str(path)


_GOOD_OPUS_RESPONSE = json.dumps({
    "user_md": "# User Profile\n\nDavid runs Ugly Code LLC.",
    "soul_md": "# Alfred's Soul\n\nAddress him as Sir.",
    "memory_md": "# Memory Index\n\n[[Eszter]] — partner.",
    "tools_md": "# Suggested Tools\n\nWeekly Stripe digest.",
})


def _make_response(status_code: int, text: str = ""):
    return type("R", (), {
        "status_code": status_code,
        "text": text,
        "is_success": 200 <= status_code < 300,
    })()


def _mock_client_with_response(response):
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.put = AsyncMock(return_value=response)
    return client


class TestPersonalizeOpusWorkspaceWrites:
    def test_workspace_500_raises(self, tmp_path, monkeypatch):
        """A 5xx workspace response must surface as a RuntimeError so
        Temporal retries and the activity does not appear to succeed with
        on-disk files missing."""
        monkeypatch.setenv("AAS_API_KEY", "test-token")
        onboard = _write_onboard(tmp_path)
        client = _mock_client_with_response(_make_response(500, "internal server error"))

        with patch("src.activities.onboarding_v3._call_llm",
                   new=AsyncMock(return_value=_GOOD_OPUS_RESPONSE)), \
             patch("httpx.AsyncClient", return_value=client):
            with pytest.raises(RuntimeError, match="USER.md write failed status=500"):
                _run_activity(lambda: personalize_opus(onboard))

    def test_workspace_403_raises(self, tmp_path, monkeypatch):
        """A 4xx (auth/allowlist) response must surface, not be swallowed."""
        monkeypatch.setenv("AAS_API_KEY", "test-token")
        onboard = _write_onboard(tmp_path)
        client = _mock_client_with_response(_make_response(403, "forbidden"))

        with patch("src.activities.onboarding_v3._call_llm",
                   new=AsyncMock(return_value=_GOOD_OPUS_RESPONSE)), \
             patch("httpx.AsyncClient", return_value=client):
            with pytest.raises(RuntimeError, match="status=403"):
                _run_activity(lambda: personalize_opus(onboard))

    def test_workspace_3xx_raises(self, tmp_path, monkeypatch):
        """A 3xx redirect from a load balancer or proxy must surface as a
        failure — httpx.AsyncClient defaults follow_redirects=False, so a 302
        is not transparently followed and would otherwise leave files
        unwritten while the activity reports success."""
        monkeypatch.setenv("AAS_API_KEY", "test-token")
        onboard = _write_onboard(tmp_path)
        client = _mock_client_with_response(_make_response(302, "Found"))

        with patch("src.activities.onboarding_v3._call_llm",
                   new=AsyncMock(return_value=_GOOD_OPUS_RESPONSE)), \
             patch("httpx.AsyncClient", return_value=client):
            with pytest.raises(RuntimeError, match="status=302"):
                _run_activity(lambda: personalize_opus(onboard))

    def test_happy_path_returns_written_files(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AAS_API_KEY", "test-token")
        onboard = _write_onboard(tmp_path)
        client = _mock_client_with_response(_make_response(200, '{"ok":true}'))

        with patch("src.activities.onboarding_v3._call_llm",
                   new=AsyncMock(return_value=_GOOD_OPUS_RESPONSE)), \
             patch("httpx.AsyncClient", return_value=client):
            result = _run_activity(lambda: personalize_opus(onboard))

        assert sorted(result["files_written"]) == ["MEMORY.md", "SOUL.md", "TOOLS.md", "USER.md"]
        assert client.put.await_count == 4
