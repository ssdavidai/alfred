"""Tests for `send_chore_notification` — per-chore destination routing (#498).

Covers:
  - Chore with ``notify_channel`` in frontmatter → ``channel`` key in POST body
  - Chore without ``notify_channel`` → ``channel`` key absent from POST body
  - Resolved destination recorded in chore body (run notes)
  - HTTP error raises so Temporal can retry (no longer swallowed)
  - Explicit 4th positional arg overrides frontmatter value

All tests run through ``ActivityEnvironment`` and mock httpx + VaultClient
so no network or filesystem calls are made.  Pattern follows the rest of
the learn test suite: ``asyncio.run(env.run(fn, *args))``.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from temporalio.testing import ActivityEnvironment

from src.activities.chore_actions import send_chore_notification


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _mock_httpx_response(status_code: int = 200) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    if status_code >= 400:
        req = httpx.Request("POST", "http://ctrl-api/api/v1/notifications")
        resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            f"HTTP {status_code}", request=req, response=resp
        )
    else:
        resp.raise_for_status.return_value = None
    return resp


def _make_http_mock(status_code: int = 200) -> tuple[Any, MagicMock]:
    """Return (mock class, inner mock with .post captured)."""
    mock_http = AsyncMock()
    mock_http.__aenter__ = AsyncMock(return_value=mock_http)
    mock_http.__aexit__ = AsyncMock(return_value=False)
    mock_http.post = AsyncMock(return_value=_mock_httpx_response(status_code))
    mock_cls = MagicMock(return_value=mock_http)
    return mock_cls, mock_http


def _vault_factory(notify_channel: str | None = None) -> tuple[Any, MagicMock]:
    """Return (factory callable, inner VaultClient mock)."""
    record = {
        "frontmatter": {"notify_channel": notify_channel} if notify_channel else {},
        "body": "",
    }
    vc = MagicMock()
    vc.read_record = AsyncMock(return_value=record)
    vc.update_record = AsyncMock(return_value=None)
    vc.close = AsyncMock(return_value=None)
    return (lambda _cfg: vc), vc


def _run(fn: Any, *args: Any) -> Any:
    env = ActivityEnvironment()
    return asyncio.run(env.run(fn, *args))


# ---------------------------------------------------------------------------
# 1. Explicit channel from chore frontmatter is forwarded to ctrl-api
# ---------------------------------------------------------------------------

class TestExplicitChannelInFrontmatter:
    def test_notify_channel_forwarded_in_post_body(self) -> None:
        """When the chore record has notify_channel, it appears as ``channel``."""
        vc_factory, vc = _vault_factory(notify_channel="slack-home-123")
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(send_chore_notification, "test-chore", "session", "msg")

        call_kwargs = http_mock.post.call_args
        body = call_kwargs.kwargs.get("json", {})
        assert body.get("channel") == "slack-home-123"
        assert result["delivered"] is True
        assert result["destination"] == "slack-home-123"
        assert result["http_status"] == 200
        assert result["error"] is None

    def test_session_id_not_forwarded_in_post_body(self) -> None:
        """The dead session_id param must NOT appear in the POST body."""
        vc_factory, _ = _vault_factory(notify_channel=None)
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                _run(send_chore_notification, "test-chore", "main", "msg")

        call_kwargs = http_mock.post.call_args
        body = call_kwargs.kwargs.get("json", {})
        assert "session_id" not in body


# ---------------------------------------------------------------------------
# 2. Chore without notify_channel — channel key absent from POST body
# ---------------------------------------------------------------------------

class TestNoChannelConfigured:
    def test_channel_key_absent_when_no_notify_channel(self) -> None:
        """ctrl-api home-channel default is not overridden when no channel declared."""
        vc_factory, _ = _vault_factory(notify_channel=None)
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(send_chore_notification, "test-chore", "main", "msg")

        call_kwargs = http_mock.post.call_args
        body = call_kwargs.kwargs.get("json", {})
        assert "channel" not in body
        assert result["destination"] == "auto"
        assert result["delivered"] is True

    def test_vault_read_error_falls_back_to_auto(self) -> None:
        """If the vault read fails, we proceed without a channel (auto)."""
        failing_vc = MagicMock()
        failing_vc.read_record = AsyncMock(side_effect=Exception("vault down"))
        failing_vc.close = AsyncMock(return_value=None)
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", lambda _: failing_vc):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(send_chore_notification, "test-chore", "main", "msg")

        call_kwargs = http_mock.post.call_args
        body = call_kwargs.kwargs.get("json", {})
        assert "channel" not in body
        assert result["destination"] == "auto"


# ---------------------------------------------------------------------------
# 3. Destination recorded in chore body (run notes)
# ---------------------------------------------------------------------------

class TestDestinationAuditTrail:
    def test_destination_appended_to_chore_body_with_channel(self) -> None:
        """Run log appends 'destination=<channel>' when notify_channel is set."""
        vc_factory, vc = _vault_factory(notify_channel="slack-home-123")
        http_cls, _ = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                _run(send_chore_notification, "test-chore", "main", "msg")

        update_calls = " ".join(str(c) for c in vc.update_record.call_args_list)
        assert "destination=slack-home-123" in update_calls

    def test_destination_appended_to_chore_body_when_auto(self) -> None:
        """Run log appends 'destination=auto' when no notify_channel."""
        vc_factory, vc = _vault_factory(notify_channel=None)
        http_cls, _ = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                _run(send_chore_notification, "test-chore", "main", "msg")

        update_calls = " ".join(str(c) for c in vc.update_record.call_args_list)
        assert "destination=auto" in update_calls


# ---------------------------------------------------------------------------
# 4. HTTP errors raise so Temporal can retry (no longer swallowed)
# ---------------------------------------------------------------------------

class TestHttpErrorPropagation:
    def test_http_4xx_raises(self) -> None:
        """Non-2xx from ctrl-api must raise httpx.HTTPStatusError."""
        vc_factory, _ = _vault_factory(notify_channel=None)
        http_cls, _ = _make_http_mock(424)

        with pytest.raises(httpx.HTTPStatusError):
            with patch("src.activities.chore_actions.VaultClient", vc_factory):
                with patch("httpx.AsyncClient", http_cls):
                    _run(send_chore_notification, "test-chore", "main", "msg")


# ---------------------------------------------------------------------------
# 5. Explicit 4th positional arg overrides frontmatter
# ---------------------------------------------------------------------------

class TestExplicitChannelArgOverridesFrontmatter:
    def test_4th_arg_wins_over_frontmatter(self) -> None:
        """When notify_channel is passed as 4th positional arg, it takes precedence."""
        # Frontmatter says "frontmatter-ch" but arg should win
        vc_factory, vc = _vault_factory(notify_channel="frontmatter-ch")
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(
                    send_chore_notification,
                    "test-chore",
                    "ignored-session",
                    "hello",
                    "caller-override-ch",
                )

        call_kwargs = http_mock.post.call_args
        body = call_kwargs.kwargs.get("json", {})
        assert body.get("channel") == "caller-override-ch"
        assert result["destination"] == "caller-override-ch"
        # Frontmatter read is skipped when 4th arg is provided
        vc.read_record.assert_not_called()
