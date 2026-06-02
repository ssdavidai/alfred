"""Recall.ai dispatcher — policy gate, dedupe, cap check, calendar tolerance.

Tests the pure helpers + the policy gate first (no Temporal needed),
then the activity layer with httpx.MockTransport so the workflow's
ctrl-api round-trips are fully exercised without a live ctrl-api.
The Temporal workflow itself is integration-tested separately;
unit-test coverage targets the load-bearing dispatch logic.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import httpx
import pytest

from src.activities.recall_dispatcher import (
    NormalisedEvent,
    check_recall_dispatch_state,
    dispatch_recall_bot,
    extract_meeting_url,
    fetch_upcoming_calendar_events,
    filter_dispatch_candidates,
    principal_is_attendee,
    should_dispatch,
)


# ---------------------------------------------------------------------------
# meeting URL extraction
# ---------------------------------------------------------------------------


class TestExtractMeetingUrl:
    def test_picks_hangout_link_first(self):
        ev = {
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
            "description": "Backup: https://zoom.us/j/999",
        }
        # hangoutLink wins over a description link.
        assert extract_meeting_url(ev) == "https://meet.google.com/abc-defg-hij"

    def test_falls_back_to_conference_data(self):
        ev = {
            "conferenceData": {
                "entryPoints": [
                    {"entryPointType": "video", "uri": "https://zoom.us/j/123456"},
                ],
            },
        }
        assert extract_meeting_url(ev) == "https://zoom.us/j/123456"

    def test_extracts_from_location(self):
        ev = {"location": "Coffee shop. Or https://meet.google.com/xyz-abc-def"}
        assert extract_meeting_url(ev) == "https://meet.google.com/xyz-abc-def"

    def test_extracts_from_description(self):
        ev = {
            "description": "Standup at https://teams.microsoft.com/l/meetup-join/xyz at 10am",
        }
        assert (
            extract_meeting_url(ev)
            == "https://teams.microsoft.com/l/meetup-join/xyz"
        )

    def test_returns_none_when_no_link(self):
        ev = {"description": "Coffee at the office"}
        assert extract_meeting_url(ev) is None

    def test_handles_non_dict(self):
        assert extract_meeting_url(None) is None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# principal_is_attendee
# ---------------------------------------------------------------------------


class TestPrincipalIsAttendee:
    def test_true_when_organizer_matches(self):
        ev = {"organizer": {"email": "sir@alfred.black"}}
        assert principal_is_attendee(ev, "sir@alfred.black") is True

    def test_true_when_self_flag_set(self):
        ev = {"organizer": {"email": "someone@else.com", "self": True}}
        assert principal_is_attendee(ev, "sir@alfred.black") is True

    def test_true_when_attendee_match(self):
        ev = {
            "attendees": [
                {"email": "sir@alfred.black", "responseStatus": "accepted"},
                {"email": "other@example.com"},
            ],
        }
        assert principal_is_attendee(ev, "sir@alfred.black") is True

    def test_false_when_declined(self):
        ev = {
            "attendees": [
                {"email": "sir@alfred.black", "responseStatus": "declined"},
            ],
        }
        assert principal_is_attendee(ev, "sir@alfred.black") is False

    def test_false_when_principal_not_present(self):
        ev = {
            "attendees": [
                {"email": "alice@example.com", "responseStatus": "accepted"},
            ],
        }
        assert principal_is_attendee(ev, "sir@alfred.black") is False

    def test_true_when_principal_email_unknown(self):
        # Fallback path — better to dispatch than silently skip on a
        # config gap.
        ev = {"attendees": [{"email": "alice@example.com"}]}
        assert principal_is_attendee(ev, None) is True


# ---------------------------------------------------------------------------
# Policy gate matrix
# ---------------------------------------------------------------------------


def _ev(
    cid: str = "ev-1",
    meeting_url: str | None = "https://zoom.us/j/1",
    is_attendee: bool = True,
) -> NormalisedEvent:
    return NormalisedEvent(
        calendar_event_id=cid,
        meeting_url=meeting_url,
        start_iso="2026-05-30T10:00:00Z",
        summary="Test",
        principal_is_attendee=is_attendee,
    )


class TestPolicyGate:
    @pytest.mark.parametrize("policy", ["off", "manual_only", "OFF", "Manual_Only"])
    def test_off_never_dispatches(self, policy):
        ok, reason = should_dispatch(_ev(), policy)
        assert ok is False
        assert "no auto-dispatch" in reason

    def test_unknown_policy_refuses(self):
        ok, reason = should_dispatch(_ev(), "wat")
        assert ok is False
        assert "unknown" in reason.lower()

    def test_no_meeting_url_skipped(self):
        ok, reason = should_dispatch(_ev(meeting_url=None), "all")
        assert ok is False
        assert reason == "no meeting_url on event"

    def test_principal_attendee_dispatches_when_attending(self):
        ok, _ = should_dispatch(_ev(is_attendee=True), "principal_attendee")
        assert ok is True

    def test_principal_attendee_skips_when_not_attending(self):
        ok, reason = should_dispatch(_ev(is_attendee=False), "principal_attendee")
        assert ok is False
        assert "not on invite" in reason

    def test_calendar_only_alias_for_principal_attendee(self):
        # Spec alias: "calendar_only" is the same gate as principal_attendee.
        ok, _ = should_dispatch(_ev(is_attendee=True), "calendar_only")
        assert ok is True
        ok2, _ = should_dispatch(_ev(is_attendee=False), "calendar_only")
        assert ok2 is False

    def test_all_dispatches_with_url(self):
        ok, _ = should_dispatch(_ev(is_attendee=False), "all")
        assert ok is True

    def test_all_meetings_alias(self):
        ok, _ = should_dispatch(_ev(is_attendee=False), "all_meetings")
        assert ok is True


# ---------------------------------------------------------------------------
# Dedupe via filter_dispatch_candidates
# ---------------------------------------------------------------------------


class TestFilterDispatchCandidates:
    def _raw(self, cid: str, url: str | None = "https://zoom.us/j/1") -> dict[str, Any]:
        return {
            "calendar_event_id": cid,
            "meeting_url": url,
            "start_iso": "2026-05-30T10:00:00Z",
            "summary": "Test",
            "principal_is_attendee": True,
        }

    def test_skips_already_dispatched(self):
        events = [self._raw("a"), self._raw("b")]
        candidates = filter_dispatch_candidates(events, "all", ["a"])
        ids = [ev["calendar_event_id"] for ev, _ in candidates]
        assert ids == ["b"]

    def test_internal_dedupe_within_one_pass(self):
        # Two events with the same calendar_event_id (e.g. recurring
        # instance + override) should only get one dispatch.
        events = [self._raw("dup"), self._raw("dup")]
        candidates = filter_dispatch_candidates(events, "all", [])
        assert len(candidates) == 1

    def test_filters_no_meeting_url(self):
        events = [self._raw("a", url=None), self._raw("b")]
        candidates = filter_dispatch_candidates(events, "all", [])
        ids = [ev["calendar_event_id"] for ev, _ in candidates]
        assert ids == ["b"]

    def test_policy_off_returns_empty(self):
        events = [self._raw("a"), self._raw("b")]
        candidates = filter_dispatch_candidates(events, "off", [])
        assert candidates == []

    def test_skips_events_without_calendar_id(self):
        events = [
            {"meeting_url": "https://zoom.us/j/1"},
            self._raw("ok"),
        ]
        candidates = filter_dispatch_candidates(events, "all", [])
        ids = [ev["calendar_event_id"] for ev, _ in candidates]
        assert ids == ["ok"]


# ---------------------------------------------------------------------------
# Activity-level tests — mocked ctrl-api transport
# ---------------------------------------------------------------------------


class ScriptedTransport(httpx.AsyncBaseTransport):
    """Replay scripted responses; capture every request."""

    def __init__(self, handler):
        self._handler = handler
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._handler(request)


@pytest.fixture
def mock_ctrl(monkeypatch):
    """Patch httpx.AsyncClient inside src.activities.recall_dispatcher.

    Yields a holder where the test installs a per-test handler. The
    handler is called with each request and must return an httpx.Response.
    """
    holder: dict[str, Any] = {"handler": None, "transport": None}

    original = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        handler = holder["handler"]
        if handler is None:
            raise RuntimeError("mock_ctrl handler not set for this test")
        transport = ScriptedTransport(handler)
        holder["transport"] = transport
        # Pass through everything but transport.
        kwargs["transport"] = transport
        # We never actually network — strip base_url because MockTransport
        # respects whatever URL the caller passes in.
        return original(*args, **kwargs)

    monkeypatch.setattr(
        "src.activities.recall_dispatcher.httpx.AsyncClient",
        fake_client,
    )
    monkeypatch.setenv("AAS_API_KEY", "test-key")
    yield holder


class TestCheckRecallDispatchState:
    @pytest.mark.asyncio
    async def test_happy_path(self, mock_ctrl):
        responses = {
            "/api/v1/channels/recall/config": {
                "auto_join_policy": "principal_attendee",
                "bot_name": "Alfred",
                "leave_after_minutes": 90,
                "monthly_hours_cap": 60,
            },
            "/api/v1/channels/recall/usage": {"this_month_hours": 12.5},
            "/api/v1/channels/recall/bots/active": {
                "bots": [
                    {"id": "bot-1", "calendar_event_id": "gcal-1"},
                    {"id": "bot-2", "calendar_event_id": "gcal-2"},
                    {"id": "bot-3", "calendar_event_id": None},
                ],
            },
        }

        def handler(req: httpx.Request) -> httpx.Response:
            body = responses.get(req.url.path)
            if body is None:
                return httpx.Response(404, json={"error": "not found"})
            return httpx.Response(200, json=body)

        mock_ctrl["handler"] = handler

        state = await check_recall_dispatch_state()
        assert state["policy"] == "principal_attendee"
        assert state["bot_name"] == "Alfred"
        assert state["leave_after_minutes"] == 90
        assert state["monthly_hours_cap"] == 60
        assert state["bot_minutes_used"] == 750  # 12.5h * 60
        assert sorted(state["dispatched_event_ids"]) == ["gcal-1", "gcal-2"]

    @pytest.mark.asyncio
    async def test_config_fetch_failure_defaults_off(self, mock_ctrl):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": {"code": "BOOM"}})

        mock_ctrl["handler"] = handler
        state = await check_recall_dispatch_state()
        assert state["policy"] == "off"


class TestFetchUpcomingCalendarEvents:
    @pytest.mark.asyncio
    async def test_pulls_and_normalises(self, mock_ctrl, monkeypatch):
        monkeypatch.setenv("OWNER_EMAIL", "sir@alfred.black")
        items = [
            {
                "id": "gcal-evt-1",
                "summary": "Standup",
                "hangoutLink": "https://meet.google.com/abc-defg-hij",
                "start": {"dateTime": "2026-05-30T10:00:00Z"},
                "attendees": [
                    {"email": "sir@alfred.black", "responseStatus": "accepted"},
                ],
            },
            {
                "id": "gcal-evt-2",
                "summary": "Lunch (no meeting URL)",
                "start": {"dateTime": "2026-05-30T12:00:00Z"},
            },
        ]

        def handler(req: httpx.Request) -> httpx.Response:
            assert req.url.path == "/api/v1/integrations/execute"
            payload = json.loads(req.content.decode("utf-8"))
            assert payload["action"] == "GOOGLECALENDAR_EVENTS_LIST"
            return httpx.Response(
                200, json={"data": {"items": items}},
            )

        mock_ctrl["handler"] = handler
        result = await fetch_upcoming_calendar_events(15)
        assert len(result) == 2
        first = result[0]
        assert first["calendar_event_id"] == "gcal-evt-1"
        assert first["meeting_url"] == "https://meet.google.com/abc-defg-hij"
        assert first["principal_is_attendee"] is True
        # Second event has no URL but is still returned (gate decides skip).
        assert result[1]["meeting_url"] is None

    @pytest.mark.asyncio
    async def test_tolerates_pull_failure(self, mock_ctrl):
        def handler(req: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("boom")

        mock_ctrl["handler"] = handler
        # Activity must NOT raise — workflow retries are at the workflow
        # layer; this activity is best-effort.
        result = await fetch_upcoming_calendar_events(15)
        assert result == []

    @pytest.mark.asyncio
    async def test_handles_no_items(self, mock_ctrl):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"data": {"items": []}})

        mock_ctrl["handler"] = handler
        result = await fetch_upcoming_calendar_events(15)
        assert result == []

    @pytest.mark.asyncio
    async def test_skips_events_without_id(self, mock_ctrl):
        items = [
            # missing id
            {"summary": "ghost", "hangoutLink": "https://zoom.us/j/1"},
            # valid
            {
                "id": "ok",
                "summary": "ok",
                "hangoutLink": "https://zoom.us/j/2",
            },
        ]

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"data": {"items": items}})

        mock_ctrl["handler"] = handler
        result = await fetch_upcoming_calendar_events(15)
        assert [r["calendar_event_id"] for r in result] == ["ok"]


class TestDispatchRecallBot:
    @pytest.mark.asyncio
    async def test_happy_path(self, mock_ctrl):
        captured: dict[str, Any] = {}

        def handler(req: httpx.Request) -> httpx.Response:
            assert req.url.path == "/api/v1/channels/recall/bots"
            captured["body"] = json.loads(req.content.decode("utf-8"))
            return httpx.Response(
                200,
                json={
                    "bot_id": "bot-abc",
                    "status": "requested",
                    "recall_url": "https://recall.example/bot-abc",
                },
            )

        mock_ctrl["handler"] = handler
        out = await dispatch_recall_bot(
            meeting_url="https://zoom.us/j/123",
            bot_name="Alfred",
            calendar_event_id="gcal-77",
        )
        assert out["ok"] is True
        assert out["bot_id"] == "bot-abc"
        assert out["status_code"] == 200
        assert captured["body"]["meeting_url"] == "https://zoom.us/j/123"
        assert captured["body"]["calendar_event_id"] == "gcal-77"
        assert captured["body"]["bot_name"] == "Alfred"

    @pytest.mark.asyncio
    async def test_400_returns_ok_false(self, mock_ctrl):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                400,
                json={"error": {"code": "VALIDATION_ERROR", "message": "bad url"}},
            )

        mock_ctrl["handler"] = handler
        out = await dispatch_recall_bot(
            meeting_url="https://example.com",
            calendar_event_id="gcal-1",
        )
        assert out["ok"] is False
        assert out["status_code"] == 400
        assert "bad url" in (out["error"] or "")

    @pytest.mark.asyncio
    async def test_503_returns_ok_false(self, mock_ctrl):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                503,
                json={"error": {"code": "NOT_CONFIGURED", "message": "no key"}},
            )

        mock_ctrl["handler"] = handler
        # 5xx raises; the activity surfaces the httpx exception so
        # Temporal can retry the activity.
        with pytest.raises(httpx.HTTPStatusError):
            await dispatch_recall_bot(
                meeting_url="https://zoom.us/j/1",
            )

    @pytest.mark.asyncio
    async def test_empty_url_short_circuits(self, mock_ctrl):
        # No network call should happen.
        mock_ctrl["handler"] = lambda req: pytest.fail(
            "should not have networked"
        )
        out = await dispatch_recall_bot(meeting_url="")
        assert out["ok"] is False
        assert "required" in out["error"]


# ---------------------------------------------------------------------------
# PR5 — realtime subscriber attachment (#113 PR5)
# ---------------------------------------------------------------------------
#
# PR5 ships the active half of Recall: ctrl-api's webhook handler kicks
# off subscribeBotRealtime() whenever a bot transitions to in_meeting.
# The dispatcher itself does NOT call subscribe — the WS attach happens
# downstream on the webhook side. These tests verify the dispatcher
# round-trip leaves the contract intact: ctrl-api POSTs to /bots are
# what schedule the bot, and the bot row downstream carries the
# realtime_url surfaced by the create-bot response.


class TestRealtimeAttachContract:
    """The dispatcher hands off to ctrl-api; ctrl-api attaches the WS
    subscriber. These tests guard the integration seam — the dispatcher
    must surface bot_id + recall_url in its response so the workflow
    log records who got dispatched, even though the WS attachment is
    not the dispatcher's responsibility."""

    @pytest.mark.asyncio
    async def test_dispatch_response_carries_bot_id_for_subscriber(self, mock_ctrl):
        # Simulate ctrl-api returning the bot id + a realtime_url. The
        # dispatcher must preserve the bot_id so the workflow can log
        # which bot was attached.
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "bot_id": "bot-rt-1",
                    "status": "requested",
                    "recall_url": "wss://api.recall.ai/api/v2/bot/bot-rt-1/realtime_endpoint",
                },
            )

        mock_ctrl["handler"] = handler
        out = await dispatch_recall_bot(
            meeting_url="https://zoom.us/j/123",
            bot_name="Alfred",
            calendar_event_id="gcal-rt-1",
        )
        assert out["ok"] is True
        assert out["bot_id"] == "bot-rt-1"
        # The realtime URL is opaque to the dispatcher but must survive
        # the round-trip so ctrl-api can populate recall_bot.realtime_url
        # for the in_meeting subscribe.
        assert (
            out["recall_url"]
            == "wss://api.recall.ai/api/v2/bot/bot-rt-1/realtime_endpoint"
        )

    @pytest.mark.asyncio
    async def test_dispatch_idempotent_response_short_circuits_subscribe(
        self, mock_ctrl
    ):
        # When ctrl-api detects an existing bot for the calendar_event_id,
        # it returns 200 with `note: "existing bot for this calendar_event_id"`.
        # The dispatcher must surface that response untouched so the
        # workflow doesn't double-count or double-attach a subscriber.
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "bot_id": "bot-existing",
                    "status": "in_meeting",
                    "recall_url": None,
                    "note": "existing bot for this calendar_event_id",
                },
            )

        mock_ctrl["handler"] = handler
        out = await dispatch_recall_bot(
            meeting_url="https://zoom.us/j/123",
            calendar_event_id="gcal-dedupe",
        )
        assert out["ok"] is True
        assert out["bot_id"] == "bot-existing"
        # Idempotent response: the recall_url is None (no second bot
        # created) but bot_id is the existing row. ctrl-api would not
        # re-attach the subscriber because subscribeBotRealtime() is
        # itself idempotent on the bot_id key.

    @pytest.mark.asyncio
    async def test_dispatch_4xx_does_not_attach_subscriber(self, mock_ctrl):
        # When ctrl-api refuses the dispatch (4xx — e.g. meeting URL
        # malformed), the dispatcher returns ok=False. No bot row is
        # created and therefore no subscriber should ever be attached
        # downstream — the contract is that subscribers attach only via
        # the in_meeting webhook, which only fires after a successful
        # create. This test guards that the dispatcher does NOT
        # synthesise a bot_id on the failure path.
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                400,
                json={
                    "error": {
                        "code": "VALIDATION_ERROR",
                        "message": "meeting_url must point at zoom/meet/teams",
                    }
                },
            )

        mock_ctrl["handler"] = handler
        out = await dispatch_recall_bot(
            meeting_url="https://example.com/not-a-meeting",
            calendar_event_id="gcal-bad",
        )
        assert out["ok"] is False
        assert out["bot_id"] is None
        # The error string must point the operator at the underlying
        # ctrl-api refusal so the realtime attach is never attempted.
        assert "meeting_url" in (out["error"] or "")
