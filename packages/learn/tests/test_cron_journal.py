"""Tests for the cron-journal reconciler (#418).

Covers:
* Activity posts to the correct ctrl-api route.
* ctrl-api errors are classified and returned (never raise into Temporal retry).
* Feature flag defaults OFF; truthy values enable.
* Registration-time flag controls schedule creation vs deletion.
* Chosen interval is 6 hours (window=48h, cap=50 sessions/call).
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from temporalio.testing import ActivityEnvironment

from src.activities.cron_journal import (
    _flag_on,
    cron_journal_reconcile_is_enabled,
    reconcile_cron_journal,
)
from scripts.register_schedules import (
    CRON_JOURNAL_RECONCILE_INTERVAL,
    CRON_JOURNAL_RECONCILE_SCHEDULE_ID,
    CRON_JOURNAL_RECONCILE_WORKFLOW,
    _cron_journal_reconcile_enabled,
)

_ENDPOINT = "/api/v1/alfred-journal/reconcile-cron"


# ---------------------------------------------------------------------------
# Shared mock helpers
# ---------------------------------------------------------------------------

def _make_resp(status_code: int, json_body: dict | None = None) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.json.return_value = json_body or {}
    if status_code >= 400:
        req = httpx.Request("POST", f"http://ctrl-api:3100{_ENDPOINT}")
        resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            f"HTTP {status_code}", request=req, response=resp
        )
    else:
        resp.raise_for_status.return_value = None
    return resp


def _make_http_mock(status_code: int = 200, json_body: dict | None = None) -> tuple[Any, MagicMock]:
    mock_http = AsyncMock()
    mock_http.__aenter__ = AsyncMock(return_value=mock_http)
    mock_http.__aexit__ = AsyncMock(return_value=False)
    mock_http.post = AsyncMock(return_value=_make_resp(status_code, json_body))
    mock_cls = MagicMock(return_value=mock_http)
    return mock_cls, mock_http


# ---------------------------------------------------------------------------
# Feature flag
# ---------------------------------------------------------------------------

class TestFeatureFlag:
    def test_defaults_off(self, monkeypatch):
        monkeypatch.delenv("CRON_JOURNAL_RECONCILE_ENABLED", raising=False)
        assert _flag_on() is False

    def test_true_enables(self, monkeypatch):
        monkeypatch.setenv("CRON_JOURNAL_RECONCILE_ENABLED", "true")
        assert _flag_on() is True

    def test_one_enables(self, monkeypatch):
        monkeypatch.setenv("CRON_JOURNAL_RECONCILE_ENABLED", "1")
        assert _flag_on() is True

    def test_false_stays_off(self, monkeypatch):
        monkeypatch.setenv("CRON_JOURNAL_RECONCILE_ENABLED", "false")
        assert _flag_on() is False

    async def test_is_enabled_activity_false_by_default(self, monkeypatch):
        monkeypatch.delenv("CRON_JOURNAL_RECONCILE_ENABLED", raising=False)
        env = ActivityEnvironment()
        assert await env.run(cron_journal_reconcile_is_enabled) is False

    async def test_is_enabled_activity_true_when_set(self, monkeypatch):
        monkeypatch.setenv("CRON_JOURNAL_RECONCILE_ENABLED", "true")
        env = ActivityEnvironment()
        assert await env.run(cron_journal_reconcile_is_enabled) is True


# ---------------------------------------------------------------------------
# Activity: posts to the right route
# ---------------------------------------------------------------------------

class TestReconcileCronJournalRoute:
    async def test_posts_to_reconcile_cron_endpoint(self, monkeypatch):
        """Activity must POST to /api/v1/alfred-journal/reconcile-cron."""
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://ctrl-api:3100")
        monkeypatch.setenv("AAS_API_KEY", "test-key")

        http_cls, http_mock = _make_http_mock(200, {"journaled": 3, "skipped": 0})

        env = ActivityEnvironment()
        with patch("src.activities.cron_journal.httpx.AsyncClient", http_cls):
            result = await env.run(reconcile_cron_journal)

        http_mock.post.assert_called_once_with(_ENDPOINT)
        assert result == {"journaled": 3, "skipped": 0}

    async def test_sends_bearer_auth(self, monkeypatch):
        """AsyncClient must be initialised with Authorization header."""
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://ctrl-api:3100")
        monkeypatch.setenv("AAS_API_KEY", "my-secret-key")

        http_cls, _ = _make_http_mock(200, {})

        env = ActivityEnvironment()
        with patch("src.activities.cron_journal.httpx.AsyncClient", http_cls):
            await env.run(reconcile_cron_journal)

        call_kwargs = http_cls.call_args.kwargs
        assert call_kwargs.get("headers", {}).get("Authorization") == "Bearer my-secret-key"


# ---------------------------------------------------------------------------
# Activity: ctrl-api errors are logged and returned, not raised
# ---------------------------------------------------------------------------

class TestReconcileCronJournalErrors:
    async def test_http_500_returns_error_dict(self, monkeypatch):
        """Transient server error must be logged and returned, not raised."""
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://ctrl-api:3100")
        monkeypatch.setenv("AAS_API_KEY", "k")

        http_cls, _ = _make_http_mock(500)
        env = ActivityEnvironment()
        with patch("src.activities.cron_journal.httpx.AsyncClient", http_cls):
            result = await env.run(reconcile_cron_journal)

        assert result.get("ok") is False
        assert "error" in result

    async def test_http_422_returns_error_dict(self, monkeypatch):
        """Permanent HTTP error (422) must also be logged and returned."""
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://ctrl-api:3100")
        monkeypatch.setenv("AAS_API_KEY", "k")

        http_cls, _ = _make_http_mock(422)
        env = ActivityEnvironment()
        with patch("src.activities.cron_journal.httpx.AsyncClient", http_cls):
            result = await env.run(reconcile_cron_journal)

        assert result.get("ok") is False

    async def test_connect_error_returns_error_dict(self, monkeypatch):
        """Network-level failure must be logged and returned, not raised."""
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://ctrl-api:3100")
        monkeypatch.setenv("AAS_API_KEY", "k")

        mock_http = AsyncMock()
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)
        mock_http.post = AsyncMock(side_effect=httpx.ConnectError("refused"))
        http_cls = MagicMock(return_value=mock_http)

        env = ActivityEnvironment()
        with patch("src.activities.cron_journal.httpx.AsyncClient", http_cls):
            result = await env.run(reconcile_cron_journal)

        assert result.get("ok") is False
        assert "error" in result


# ---------------------------------------------------------------------------
# Schedule constants
# ---------------------------------------------------------------------------

class TestScheduleConstants:
    def test_interval_is_six_hours(self):
        """6-hour interval fits the endpoint constraints.

        Window=48h: a session missed just after one run waits ≤6h,
        leaving ≥42h of the window for the next pick-up.
        Cap=50/call: a busy tenant has ~5 deliver jobs → ~1.25/interval,
        far below the 50-session cap.
        """
        assert CRON_JOURNAL_RECONCILE_INTERVAL == timedelta(hours=6)

    def test_schedule_id(self):
        assert CRON_JOURNAL_RECONCILE_SCHEDULE_ID == "al-cron-journal-reconcile"

    def test_workflow_name(self):
        assert CRON_JOURNAL_RECONCILE_WORKFLOW == "CronJournalReconcileWorkflow"

    def test_registrar_flag_defaults_off(self, monkeypatch):
        """Registration-time flag must also default OFF."""
        monkeypatch.delenv("CRON_JOURNAL_RECONCILE_ENABLED", raising=False)
        assert _cron_journal_reconcile_enabled() is False
