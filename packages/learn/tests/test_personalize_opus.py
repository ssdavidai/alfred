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
        "facts": [{"category": "professional", "fact": "Runs Example LLC", "confidence": "high"}],
        "patterns": [{"name": "tuesday-stripe-reviews", "description": "Reviews Stripe stats"}],
    }))
    return str(path)


_GOOD_OPUS_RESPONSE = json.dumps({
    "user_md": "# User Profile\n\nSir runs Example LLC.",
    "soul_md": "# Alfred's Soul\n\nAddress him as Sir.",
    "memory_md": "# Memory Index\n\n[[Sam Lee]] — partner.",
    "tools_md": "# Suggested Tools\n\nWeekly Stripe digest.",
    "rules_md": "# Standing Rules\n\n- Protect quiet hours.",
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


def _mock_client_per_file(status_by_filename: dict[str, int]):
    """Return a client whose PUT status depends on the workspace filename
    in the request URL (``/api/v1/admin/workspace/<filename>``)."""
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None

    async def _put(url, *args, **kwargs):
        filename = url.rsplit("/", 1)[-1]
        return _make_response(status_by_filename.get(filename, 200))

    client.put = AsyncMock(side_effect=_put)
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

        assert sorted(result["files_written"]) == ["MEMORY.md", "RULES.md", "SOUL.md", "TOOLS.md", "USER.md"]
        assert client.put.await_count == 5


class TestPersonalizeOpusPartialFailure:
    """#BUG-2 — a transient failure on a non-load-bearing file (MEMORY /
    TOOLS / RULES) must NOT abort the whole onboarding before
    awaiting_verification. Only USER.md / SOUL.md are load-bearing."""

    def test_memory_failure_does_not_abort(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AAS_API_KEY", "test-token")
        onboard = _write_onboard(tmp_path)
        client = _mock_client_per_file({"MEMORY.md": 500})

        with patch("src.activities.onboarding_v3._call_llm",
                   new=AsyncMock(return_value=_GOOD_OPUS_RESPONSE)), \
             patch("httpx.AsyncClient", return_value=client):
            result = _run_activity(lambda: personalize_opus(onboard))

        # USER + SOUL (load-bearing) plus TOOLS + RULES all wrote; MEMORY failed.
        assert sorted(result["files_written"]) == ["RULES.md", "SOUL.md", "TOOLS.md", "USER.md"]
        assert "MEMORY.md" in result.get("files_failed", [])
        # All 5 writes were attempted — failure of one didn't short-circuit.
        assert client.put.await_count == 5

    def test_tools_and_rules_failure_does_not_abort(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AAS_API_KEY", "test-token")
        onboard = _write_onboard(tmp_path)
        client = _mock_client_per_file({"TOOLS.md": 502, "RULES.md": 503})

        with patch("src.activities.onboarding_v3._call_llm",
                   new=AsyncMock(return_value=_GOOD_OPUS_RESPONSE)), \
             patch("httpx.AsyncClient", return_value=client):
            result = _run_activity(lambda: personalize_opus(onboard))

        assert sorted(result["files_written"]) == ["MEMORY.md", "SOUL.md", "USER.md"]
        assert sorted(result.get("files_failed", [])) == ["RULES.md", "TOOLS.md"]

    def test_soul_failure_still_raises(self, tmp_path, monkeypatch):
        """SOUL.md is load-bearing: its failure must still abort + retry."""
        monkeypatch.setenv("AAS_API_KEY", "test-token")
        onboard = _write_onboard(tmp_path)
        client = _mock_client_per_file({"SOUL.md": 500})

        with patch("src.activities.onboarding_v3._call_llm",
                   new=AsyncMock(return_value=_GOOD_OPUS_RESPONSE)), \
             patch("httpx.AsyncClient", return_value=client):
            with pytest.raises(RuntimeError, match="SOUL.md"):
                _run_activity(lambda: personalize_opus(onboard))
        # All writes attempted before raising so we collect every failure.
        assert client.put.await_count == 5


class TestPersonalizeOpusJsonParse:
    """#BUG-6 — personalize_opus must use the hardened, string-aware JSON
    parser. The naive brace-counter mis-tracks depth when a value contains
    literal ``{``/``}`` (e.g. a TOOLS template mentioning ``{userId}``) and
    gives up on mild truncation, dropping all five files."""

    def test_literal_braces_in_values_parse(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AAS_API_KEY", "test-token")
        onboard = _write_onboard(tmp_path)
        # tools_md value mentions a brace placeholder — the naive counter
        # would treat ``{userId}`` as a nested object and desync depth.
        raw = json.dumps({
            "user_md": "# User Profile\n\nSir runs Example LLC.",
            "soul_md": "# Alfred's Soul\n\nAddress him as Sir.",
            "memory_md": "# Memory Index\n\n[[Sam Lee]] — partner.",
            "tools_md": "# Tools\n\nDigest endpoint /api/users/{userId}/summary {scope}.",
            "rules_md": "# Standing Rules\n\n- Protect quiet hours.",
        })
        # Wrap in prose + a code fence AND add trailing prose that itself
        # contains braces — the greedy ``\{...\}`` regex would over-match to
        # the trailing brace and fail to parse; the string-aware scanner
        # recovers the real object.
        wrapped = (
            f"Here are the files:\n```json\n{raw}\n```\n"
            "Let me know if {anything} needs changing."
        )
        client = _mock_client_with_response(_make_response(200, '{"ok":true}'))

        with patch("src.activities.onboarding_v3._call_llm",
                   new=AsyncMock(return_value=wrapped)), \
             patch("httpx.AsyncClient", return_value=client):
            result = _run_activity(lambda: personalize_opus(onboard))

        assert sorted(result["files_written"]) == [
            "MEMORY.md", "RULES.md", "SOUL.md", "TOOLS.md", "USER.md"
        ]

    def test_mild_truncation_recovers_load_bearing(self, tmp_path, monkeypatch):
        """A response truncated mid-rules (max_tokens) must still yield the
        complete leading files rather than parsing to zero files."""
        monkeypatch.setenv("AAS_API_KEY", "test-token")
        onboard = _write_onboard(tmp_path)
        # Valid up to rules_md, then cut off mid-string with no closer.
        truncated = (
            '{\n'
            '  "user_md": "# User Profile\\n\\nSir runs Example LLC.",\n'
            '  "soul_md": "# Alfred\'s Soul\\n\\nAddress him as Sir.",\n'
            '  "memory_md": "# Memory Index\\n\\n[[Sam Lee]] partner.",\n'
            '  "tools_md": "# Tools\\n\\nWeekly Stripe digest.",\n'
            '  "rules_md": "# Standing Rules\\n\\n- Protect quiet ho'
        )
        client = _mock_client_with_response(_make_response(200, '{"ok":true}'))

        with patch("src.activities.onboarding_v3._call_llm",
                   new=AsyncMock(return_value=truncated)), \
             patch("httpx.AsyncClient", return_value=client):
            result = _run_activity(lambda: personalize_opus(onboard))

        # The load-bearing files survived truncation.
        assert "USER.md" in result["files_written"]
        assert "SOUL.md" in result["files_written"]
