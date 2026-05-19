"""Tests for the Composio parser's Google Calendar event handling.

The composio parser feeds every pull through ``_item_to_event``. Until this
fix it extracted ``received_at`` from gmail-shaped fields only — top-level
``date`` / ``created_at`` / ``messageTimestamp``. Google Calendar events
have NONE of those at the top level; the event's actual occurrence time
lives under ``start.dateTime`` (timed) or ``start.date`` (all-day). The
parser therefore fell through to ``datetime.now()`` and stamped every
calendar event with the fetch time.

Live consequence on david 2026-05-19: when Composio's ``syncToken`` reset
triggered a full backfill of the past-30/future-90d window, ~3.5k historic
gcal events came back with ``received_at = <fetch time>``. The brief's
14-day age cutoff (PR #932) is keyed on signal ``ts``, which the
extractor populates from ``received_at`` via ``signal_extracted_at``.
Stale events like "Eszter Feb 8 fashion show" landed in the morning brief
with a fresh row id and a 2026-05-18 timestamp.

These tests pin the fix: gcal events round-trip their occurrence time as
``received_at`` so the same event re-fetched produces the same slug and
the brief filter excludes events whose start is outside the configured
freshness window.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.parsers.composio import _gcal_event_start_iso, _item_to_event, parse  # noqa: E402


# ---------------------------------------------------------------------------
# _gcal_event_start_iso — pure extraction
# ---------------------------------------------------------------------------


def test_gcal_event_start_iso_prefers_datetime() -> None:
    """Timed events: ``start.dateTime`` wins over ``start.date`` (both valid)."""
    item = {
        "id": "evt1",
        "start": {
            "dateTime": "2025-02-08T17:00:00+01:00",
            "date": "2025-02-08",  # never set in real timed events; defensive
            "timeZone": "Europe/Budapest",
        },
    }
    assert _gcal_event_start_iso(item) == "2025-02-08T17:00:00+01:00"


def test_gcal_event_start_iso_falls_back_to_date_for_all_day() -> None:
    """All-day events: only ``start.date`` is set."""
    item = {
        "id": "evt2",
        "start": {"date": "2025-02-08"},
    }
    assert _gcal_event_start_iso(item) == "2025-02-08"


def test_gcal_event_start_iso_returns_empty_when_no_start() -> None:
    """Non-calendar items (gmail messages, notion pages) have no ``start``."""
    assert _gcal_event_start_iso({"id": "x", "subject": "hello"}) == ""


def test_gcal_event_start_iso_returns_empty_when_start_is_not_dict() -> None:
    """Defensive: a malformed payload must not raise."""
    assert _gcal_event_start_iso({"id": "x", "start": "broken"}) == ""
    assert _gcal_event_start_iso({"id": "x", "start": None}) == ""


def test_gcal_event_start_iso_strips_whitespace() -> None:
    """Stray whitespace from upstream JSON gets cleaned, not preserved."""
    item = {"start": {"dateTime": "  2025-02-08T17:00:00+01:00  "}}
    assert _gcal_event_start_iso(item) == "2025-02-08T17:00:00+01:00"


def test_gcal_event_start_iso_ignores_empty_strings() -> None:
    """Empty string in start.dateTime falls through to start.date."""
    item = {"start": {"dateTime": "", "date": "2025-02-08"}}
    assert _gcal_event_start_iso(item) == "2025-02-08"


# ---------------------------------------------------------------------------
# _item_to_event — received_at comes from the gcal start, not datetime.now
# ---------------------------------------------------------------------------


def test_item_to_event_stamps_gcal_start_as_received_at() -> None:
    """A historic gcal event keeps its occurrence time as ``received_at``.

    This is the core of the stale-brief fix: without it, a Feb-8-2025
    event re-fetched after a syncToken reset on 2026-05-18 lands in the
    JSONL with ``received_at = 2026-05-18T...``, then in the brief as a
    "fresh" decision-required signal. With it, the brief's 14-day cutoff
    correctly excludes the event.
    """
    item = {
        "id": "bpoij60a6hra58e3qd2q9q7tpo",
        "summary": "Jon a csalad",
        "start": {"date": "2025-02-08"},
        "end": {"date": "2025-02-09"},
        "attendees": [
            {"email": "owner@tenant.test", "self": True},
            {"email": "external@example.com"},
        ],
    }
    event = _item_to_event(item)
    assert event.received_at == "2025-02-08"


def test_item_to_event_uses_gcal_datetime_for_timed_event() -> None:
    """Timed event: tz-aware ``dateTime`` is preserved verbatim."""
    item = {
        "id": "evt-timed",
        "summary": "Talk with David (M. Brennan Sweeney)",
        "start": {
            "dateTime": "2025-01-30T18:00:00+01:00",
            "timeZone": "Europe/Budapest",
        },
        "end": {"dateTime": "2025-01-30T18:30:00+01:00"},
    }
    event = _item_to_event(item)
    assert event.received_at == "2025-01-30T18:00:00+01:00"


def test_item_to_event_falls_through_to_now_when_no_start_or_dates() -> None:
    """Non-calendar item without any timestamp still gets ``datetime.now``.

    Behaviour parity check: the fix MUST NOT change the fallback for
    non-calendar items that legitimately have no date field. (Tested
    via "is recent" rather than equality to avoid clock drift.)
    """
    item = {
        "id": "raw-x",
        "summary": "no dates anywhere",
    }
    event = _item_to_event(item)
    parsed = datetime.fromisoformat(event.received_at)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    age_seconds = (datetime.now(timezone.utc) - parsed).total_seconds()
    assert 0 <= age_seconds < 60


def test_item_to_event_gmail_messagetimestamp_still_wins_over_gcal_start() -> None:
    """A hybrid payload prefers the gmail-style top-level fields first.

    Realistic only as a defensive check — Composio doesn't combine gmail
    and gcal shapes in one item — but the ordering must stay deterministic
    so a future toolkit that exposes ``date`` AND ``start.dateTime`` keeps
    the gmail branch's existing behaviour.
    """
    item = {
        "id": "x",
        "date": "2024-12-01T00:00:00Z",
        "start": {"dateTime": "2025-02-08T17:00:00+01:00"},
    }
    event = _item_to_event(item)
    assert event.received_at == "2024-12-01T00:00:00Z"


# ---------------------------------------------------------------------------
# Idempotency — same event re-parsed produces the same source_ref +
# received_at, which is what allows downstream slug + dedup paths to
# treat re-fetches as no-ops.
# ---------------------------------------------------------------------------


def test_same_gcal_event_reparsed_yields_same_source_ref_and_received_at() -> None:
    """Two parses of the same gcal event item produce identical ParsedEvent
    fields used downstream for dedup.

    The slug at ``stream_vault._event_slug`` is
    ``sha256(source_ref)[:12] + "-" + received_at[:10]``. Pinning both
    values here is what makes a syncToken reset idempotent at the vault
    layer: same event_id → same source_ref, same start.date →
    same received_at[:10] → same slug → vault overwrite, not new file.
    """
    item = {
        "id": "stable-event-id",
        "summary": "Kitti divatbemutato",
        "start": {"date": "2025-02-08"},
        "end": {"date": "2025-02-09"},
    }
    a = _item_to_event(item)
    b = _item_to_event(dict(item))  # shallow copy — same content, distinct dict
    assert a.source_ref == b.source_ref == "composio:stable-event-id"
    assert a.received_at == b.received_at == "2025-02-08"


def test_parse_wraps_gcal_events_list_response_preserving_start_dates() -> None:
    """End-to-end through ``parse()`` on a realistic Composio gcal response.

    Composio's ``GOOGLECALENDAR_EVENTS_LIST`` returns
    ``{data: {response_data: {items: [...]}}}``. The parser walks the
    wrapper, lands on ``items``, and runs ``_item_to_event`` per item.
    """
    raw = {
        "data": {
            "response_data": {
                "items": [
                    {
                        "id": "evt-a",
                        "summary": "Past event",
                        "start": {"date": "2025-02-08"},
                    },
                    {
                        "id": "evt-b",
                        "summary": "Future event",
                        "start": {"dateTime": "2026-08-01T10:00:00+02:00"},
                    },
                ]
            }
        }
    }
    events = parse(raw)
    assert len(events) == 2
    assert events[0].source_ref == "composio:evt-a"
    assert events[0].received_at == "2025-02-08"
    assert events[1].source_ref == "composio:evt-b"
    assert events[1].received_at == "2026-08-01T10:00:00+02:00"
