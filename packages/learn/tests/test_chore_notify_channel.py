"""Tests for `send_chore_notification` — per-chore destination routing (#498).

Covers:
  - Chore with ``notify_channel: slack:<id>`` → ``channel="slack", to="<id>"``
    (NOT ``channel="<id>"``, which would fall to the default case in
    alfredDeliver.ts:deliverByChannel and produce a no-delivery error)
  - Chore without ``notify_channel`` → both ``channel`` and ``to`` absent
  - Bare value with no ``platform:`` separator → treated as unset (falls through)
  - Unknown platform → treated as unset
  - Resolved destination recorded in chore body (run notes)
  - HTTP error raises so Temporal can retry (no longer swallowed)
  - Explicit 4th positional arg overrides frontmatter value

All tests run through ``ActivityEnvironment`` and mock httpx + VaultClient
so no network or filesystem calls are made.
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
        req = httpx.Request("POST", "http://ctrl-api/api/v1/alfred-deliver")
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


def _posted_body(http_mock: MagicMock) -> dict:
    return http_mock.post.call_args.kwargs.get("json", {})


# ---------------------------------------------------------------------------
# 1. notify_channel with valid platform:id → correct field split in POST body
# ---------------------------------------------------------------------------

class TestValidChannelFieldSplit:
    def test_slack_channel_splits_into_channel_and_to(self) -> None:
        """slack:C0123456789 → channel='slack', to='C0123456789' (not channel=id)."""
        vc_factory, _ = _vault_factory(notify_channel="slack:C0123456789")
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(send_chore_notification, "test-chore", "session", "msg")

        body = _posted_body(http_mock)
        assert body.get("channel") == "slack"
        assert body.get("to") == "C0123456789"
        assert body.get("solicited") == 0, "chore notify must stamp solicited=0 (#580)"
        assert result["delivered"] is True
        assert result["destination"] == "slack:C0123456789"

    def test_telegram_channel_splits_correctly(self) -> None:
        """telegram:-1001234567 → channel='telegram', to='-1001234567'."""
        vc_factory, _ = _vault_factory(notify_channel="telegram:-1001234567")
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(send_chore_notification, "test-chore", "session", "msg")

        body = _posted_body(http_mock)
        assert body.get("channel") == "telegram"
        assert body.get("to") == "-1001234567"
        assert body.get("solicited") == 0, "chore notify must stamp solicited=0 (#580)"
        assert result["destination"] == "telegram:-1001234567"

    def test_email_channel_splits_correctly(self) -> None:
        """email:user@example.com → channel='email', to='user@example.com'."""
        vc_factory, _ = _vault_factory(notify_channel="email:user@example.com")
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(send_chore_notification, "test-chore", "session", "msg")

        body = _posted_body(http_mock)
        assert body.get("channel") == "email"
        assert body.get("to") == "user@example.com"
        assert body.get("solicited") == 0, "chore notify must stamp solicited=0 (#580)"

    def test_session_id_never_forwarded(self) -> None:
        """The dead session_id param must NOT appear in the POST body."""
        vc_factory, _ = _vault_factory(notify_channel=None)
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                _run(send_chore_notification, "test-chore", "main", "msg")

        body = _posted_body(http_mock)
        assert "session_id" not in body


# ---------------------------------------------------------------------------
# 2. No notify_channel → both channel and to absent (ctrl-api decides)
# ---------------------------------------------------------------------------

class TestNoChannelConfigured:
    def test_channel_and_to_absent_when_no_notify_channel(self) -> None:
        """When the chore has no notify_channel, ctrl-api home default is used."""
        vc_factory, _ = _vault_factory(notify_channel=None)
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(send_chore_notification, "test-chore", "main", "msg")

        body = _posted_body(http_mock)
        assert "channel" not in body
        assert "to" not in body
        assert body.get("solicited") == 0, "chore notify must stamp solicited=0 (#580)"
        assert result["destination"] == "auto"
        assert result["delivered"] is True

    def test_vault_read_error_falls_back_to_auto(self) -> None:
        """Vault read failure → proceed without channel (auto)."""
        failing_vc = MagicMock()
        failing_vc.read_record = AsyncMock(side_effect=Exception("vault down"))
        failing_vc.close = AsyncMock(return_value=None)
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", lambda _: failing_vc):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(send_chore_notification, "test-chore", "main", "msg")

        body = _posted_body(http_mock)
        assert "channel" not in body
        assert "to" not in body
        assert result["destination"] == "auto"


# ---------------------------------------------------------------------------
# 3. Bare values (no separator) are treated as unset — never guessed
# ---------------------------------------------------------------------------

class TestBareValueFallsThrough:
    def test_bare_id_no_platform_treated_as_unset(self) -> None:
        """A raw id with no 'platform:' prefix falls through to auto.

        Guessing the platform from an id's shape would send a Telegram id to
        Slack or vice versa.  Treat as unset instead.
        """
        vc_factory, _ = _vault_factory(notify_channel="C0123456789")  # no prefix
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(send_chore_notification, "test-chore", "main", "msg")

        body = _posted_body(http_mock)
        assert "channel" not in body
        assert "to" not in body
        assert result["destination"] == "auto"

    def test_unknown_platform_treated_as_unset(self) -> None:
        """An unrecognised platform name is not forwarded."""
        vc_factory, _ = _vault_factory(notify_channel="discord:some-id")
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(send_chore_notification, "test-chore", "main", "msg")

        body = _posted_body(http_mock)
        assert "channel" not in body
        assert "to" not in body
        assert result["destination"] == "auto"


# ---------------------------------------------------------------------------
# 4. Destination recorded in chore body (run notes)
# ---------------------------------------------------------------------------

class TestDestinationAuditTrail:
    def test_destination_appended_when_channel_set(self) -> None:
        """Run log appends 'destination=slack:C0123456789' when channel set."""
        vc_factory, vc = _vault_factory(notify_channel="slack:C0123456789")
        http_cls, _ = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                _run(send_chore_notification, "test-chore", "main", "msg")

        update_calls = " ".join(str(c) for c in vc.update_record.call_args_list)
        assert "destination=slack:C0123456789" in update_calls

    def test_destination_appended_as_auto_when_no_channel(self) -> None:
        """Run log appends 'destination=auto' when no notify_channel."""
        vc_factory, vc = _vault_factory(notify_channel=None)
        http_cls, _ = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                _run(send_chore_notification, "test-chore", "main", "msg")

        update_calls = " ".join(str(c) for c in vc.update_record.call_args_list)
        assert "destination=auto" in update_calls


# ---------------------------------------------------------------------------
# 5. HTTP errors raise so Temporal can retry (no longer swallowed)
# ---------------------------------------------------------------------------

class TestHttpErrorPropagation:
    def test_http_4xx_raises(self) -> None:
        """Non-2xx from ctrl-api raises httpx.HTTPStatusError (Temporal retries)."""
        vc_factory, _ = _vault_factory(notify_channel=None)
        http_cls, _ = _make_http_mock(424)

        with pytest.raises(httpx.HTTPStatusError):
            with patch("src.activities.chore_actions.VaultClient", vc_factory):
                with patch("httpx.AsyncClient", http_cls):
                    _run(send_chore_notification, "test-chore", "main", "msg")


# ---------------------------------------------------------------------------
# 6. Explicit 4th positional arg overrides frontmatter
# ---------------------------------------------------------------------------

class TestExplicitChannelArgOverridesFrontmatter:
    def test_4th_arg_wins_over_frontmatter(self) -> None:
        """When notify_channel is passed as 4th positional arg, it takes precedence."""
        # Frontmatter says "slack:FRONTMATTER" but arg should win
        vc_factory, vc = _vault_factory(notify_channel="slack:FRONTMATTER")
        http_cls, http_mock = _make_http_mock(200)

        with patch("src.activities.chore_actions.VaultClient", vc_factory):
            with patch("httpx.AsyncClient", http_cls):
                result = _run(
                    send_chore_notification,
                    "test-chore",
                    "ignored-session",
                    "hello",
                    "telegram:-9999",
                )

        body = _posted_body(http_mock)
        assert body.get("channel") == "telegram"
        assert body.get("to") == "-9999"
        assert result["destination"] == "telegram:-9999"
        # Frontmatter read is skipped when 4th arg is provided
        vc.read_record.assert_not_called()
