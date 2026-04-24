"""Tests for stream_puller activities — cross-tenant ingest guard.

The guard rejects events at ingest time whose Google-shaped identity claim
(currently only Calendar's `self: true` attendee) doesn't match the tenant's
OWNER_EMAIL. Defense-in-depth for the #408-class cross-tenant leak pattern.
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.pull import (  # noqa: E402
    _event_belongs_to_owner,
    _extract_claimed_email,
    _resolve_owner_email,
    ingest_events,
)


# ---------------------------------------------------------------------------
# _extract_claimed_email — pure string extraction, no env/fs
# ---------------------------------------------------------------------------


def test_extract_claimed_email_returns_self_attendee() -> None:
    event = {
        "id": "evt1",
        "attendees": [
            {"email": "external@example.com", "self": False},
            {"email": "owner@tenant.test", "self": True},
        ],
    }
    assert _extract_claimed_email(event) == "owner@tenant.test"


def test_extract_claimed_email_missing_attendees_returns_empty() -> None:
    # External calendar invite where the API response didn't even include
    # an attendees list — no identity claim.
    assert _extract_claimed_email({"id": "e", "summary": "hi"}) == ""


def test_extract_claimed_email_no_self_flag_returns_empty() -> None:
    event = {
        "attendees": [
            {"email": "a@example.com"},
            {"email": "b@example.com"},
        ],
    }
    assert _extract_claimed_email(event) == ""


def test_extract_claimed_email_non_dict_is_safe() -> None:
    assert _extract_claimed_email(None) == ""
    assert _extract_claimed_email("not-a-dict") == ""
    assert _extract_claimed_email([1, 2, 3]) == ""


# ---------------------------------------------------------------------------
# _event_belongs_to_owner — composes extraction + owner comparison
# ---------------------------------------------------------------------------


def test_belongs_to_owner_self_true_matches() -> None:
    event = {"attendees": [{"email": "owner@tenant.test", "self": True}]}
    assert _event_belongs_to_owner(event, "owner@tenant.test") is True


def test_belongs_to_owner_self_true_mismatches_rejects() -> None:
    event = {"attendees": [{"email": "other@different.test", "self": True}]}
    assert _event_belongs_to_owner(event, "owner@tenant.test") is False


def test_belongs_to_owner_no_identity_claim_accepts() -> None:
    # External meeting invite — owner is an attendee but not `self: true`
    # from their Google's view (this particular fetch came from elsewhere).
    # No identity claim → accept. This is the "don't false-reject" case.
    event = {
        "attendees": [
            {"email": "host@somewhere.test"},
            {"email": "owner@tenant.test"},
        ],
    }
    assert _event_belongs_to_owner(event, "owner@tenant.test") is True


def test_belongs_to_owner_case_insensitive_match() -> None:
    event = {"attendees": [{"email": "Alfred@Lumberjack.SO", "self": True}]}
    assert _event_belongs_to_owner(event, "alfred@lumberjack.so") is True


def test_belongs_to_owner_non_dict_raw_accepts() -> None:
    # Defensive: parser handed us something weird — don't block.
    assert _event_belongs_to_owner(None, "owner@tenant.test") is True
    assert _event_belongs_to_owner("raw-string", "owner@tenant.test") is True


# ---------------------------------------------------------------------------
# _resolve_owner_email — env + onboard.json fallback
# ---------------------------------------------------------------------------


def test_resolve_owner_email_env_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OWNER_EMAIL", "From-ENV@Tenant.Test")
    assert _resolve_owner_email() == "from-env@tenant.test"


def test_resolve_owner_email_env_empty_tries_onboard(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("OWNER_EMAIL", raising=False)
    onboard = tmp_path / "onboard.json"
    onboard.write_text(json.dumps({"owner_email": "from-json@tenant.test"}))
    monkeypatch.setenv("ONBOARD_PATH", str(onboard))
    assert _resolve_owner_email() == "from-json@tenant.test"


def test_resolve_owner_email_both_missing_returns_empty(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("OWNER_EMAIL", raising=False)
    # Point at a non-existent path
    monkeypatch.setenv("ONBOARD_PATH", str(tmp_path / "does-not-exist.json"))
    assert _resolve_owner_email() == ""


# ---------------------------------------------------------------------------
# ingest_events — end-to-end behaviour of the guard
# ---------------------------------------------------------------------------


class _FakeIngestClient:
    """Stand-in for the httpx AsyncClient returned by _ctrl_client.

    Accepts any POST /api/v1/streams/ingest and returns 201 by default.
    Records the body so assertions can verify what was / wasn't ingested.
    """

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def __aenter__(self) -> "_FakeIngestClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    async def post(self, url: str, json: dict[str, Any]) -> MagicMock:
        self.calls.append({"url": url, "json": json})
        resp = MagicMock()
        resp.status_code = 201
        resp.json = MagicMock(return_value={"status": "created"})
        return resp


def _calendar_event(email: str, *, self_flag: bool = True, event_id: str = "cal1") -> dict:
    """Build a Composio-shaped calendar event item with a single self attendee."""
    return {
        "id": event_id,
        "summary": "Team standup",
        "attendees": [{"email": email, "self": self_flag}],
    }


def _wrap_composio(item: dict) -> dict:
    """Wrap an event dict in the shape composio_pull returns.

    The composio parser unwraps ``{data: {response_data: {events: [...]}}}``.
    """
    return {"data": {"response_data": {"events": [item]}}}


@pytest.fixture
def fake_client(monkeypatch: pytest.MonkeyPatch) -> _FakeIngestClient:
    client = _FakeIngestClient()
    monkeypatch.setattr("src.activities.pull._ctrl_client", lambda _cfg: client)
    monkeypatch.setattr("src.activities.pull.load_config", lambda: MagicMock())
    return client


@pytest.mark.asyncio
async def test_ingest_accepts_matching_self_attendee(
    monkeypatch: pytest.MonkeyPatch, fake_client: _FakeIngestClient
) -> None:
    monkeypatch.setenv("OWNER_EMAIL", "owner@tenant.test")
    raw = _wrap_composio(_calendar_event("owner@tenant.test"))
    result = await ingest_events("s1", "calendar", "composio", [raw])
    assert result == {"ingested": 1, "rejected": 0}
    assert len(fake_client.calls) == 1


@pytest.mark.asyncio
async def test_ingest_rejects_wrong_self_attendee(
    monkeypatch: pytest.MonkeyPatch, fake_client: _FakeIngestClient, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("OWNER_EMAIL", "owner@tenant.test")
    raw = _wrap_composio(_calendar_event("OTHER-TENANT@example.com"))
    with caplog.at_level(logging.WARNING, logger="alfred-learn"):
        result = await ingest_events("s1", "calendar", "composio", [raw])
    assert result == {"ingested": 0, "rejected": 1}
    # Nothing was POSTed to ctrl-api.
    assert fake_client.calls == []
    # And we logged the rejection so operators can spot contamination.
    assert any("REJECTED cross-tenant event" in rec.message for rec in caplog.records)


@pytest.mark.asyncio
async def test_ingest_accepts_events_with_no_identity_claim(
    monkeypatch: pytest.MonkeyPatch, fake_client: _FakeIngestClient
) -> None:
    # External meeting — no `self: true` attendee. The guard must not
    # false-reject these or we'd drop legitimate calendar data.
    monkeypatch.setenv("OWNER_EMAIL", "owner@tenant.test")
    event = {
        "id": "ext1",
        "summary": "Dinner with Alice",
        "attendees": [
            {"email": "alice@external.test"},
            {"email": "bob@external.test"},
        ],
    }
    raw = _wrap_composio(event)
    result = await ingest_events("s1", "calendar", "composio", [raw])
    assert result == {"ingested": 1, "rejected": 0}
    assert len(fake_client.calls) == 1


@pytest.mark.asyncio
async def test_ingest_owner_email_unset_accepts_everything(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    fake_client: _FakeIngestClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Provisioning-time bug fallback: no OWNER_EMAIL anywhere →
    # accept all events + log a warning. Don't block onboarding.
    monkeypatch.delenv("OWNER_EMAIL", raising=False)
    monkeypatch.setenv("ONBOARD_PATH", str(tmp_path / "missing.json"))
    raw = _wrap_composio(_calendar_event("literally-anyone@elsewhere.test"))
    with caplog.at_level(logging.WARNING, logger="alfred-learn"):
        result = await ingest_events("s1", "calendar", "composio", [raw])
    assert result == {"ingested": 1, "rejected": 0}
    assert any("OWNER_EMAIL unset" in rec.message for rec in caplog.records)


@pytest.mark.asyncio
async def test_ingest_case_insensitive_owner_match(
    monkeypatch: pytest.MonkeyPatch, fake_client: _FakeIngestClient
) -> None:
    # Google occasionally normalises capitalisation differently than how
    # the operator typed OWNER_EMAIL. Must match case-insensitively.
    monkeypatch.setenv("OWNER_EMAIL", "Alfred@Lumberjack.SO")
    raw = _wrap_composio(_calendar_event("alfred@lumberjack.so"))
    result = await ingest_events("s1", "calendar", "composio", [raw])
    assert result == {"ingested": 1, "rejected": 0}


@pytest.mark.asyncio
async def test_ingest_non_google_streams_unaffected(
    monkeypatch: pytest.MonkeyPatch, fake_client: _FakeIngestClient
) -> None:
    # Slack / GitHub / Notion items carry no `self: true` attendee shape,
    # so the guard is a no-op for them. A Slack message should always
    # pass regardless of whose mailbox/workspace it came from.
    monkeypatch.setenv("OWNER_EMAIL", "owner@tenant.test")
    slack_item = {
        "data": {
            "response_data": {
                "messages": [
                    {"id": "m1", "text": "hello", "ts": "1700000000.000100"}
                ],
            },
        },
    }
    result = await ingest_events("s1", "slack", "composio", [slack_item])
    assert result == {"ingested": 1, "rejected": 0}
    assert len(fake_client.calls) == 1
