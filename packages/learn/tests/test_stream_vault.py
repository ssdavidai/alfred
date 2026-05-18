"""Tests for ambient-capture forward-defense (#650, #651).

Covers two interlocked behaviours added in PR #650/#651:

- ``speaker_attribution: ambient`` is set on every Omi conversation
  unless diarization positively identifies Sir as the only speaker.
  Non-Omi streams must NOT carry the ``speaker_attribution`` key.
- Auto-discovered entity records (org/person/location) start at
  ``status: provisional`` and only promote to ``status: active`` once
  a *second distinct* stream mentions them. Already-active entities are
  never demoted.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.stream_vault import (  # noqa: E402
    _build_vault_content,
    _compute_omi_speaker_attribution,
    _resolve_source_type,
    apply_two_strike_promotion,
)
from src.utils.entity_promotion import (  # noqa: E402
    PROMOTION_THRESHOLD,
    initial_status_for_auto_discovery,
    is_provisional_entity_type,
    merge_mentioned_streams,
    next_status,
    should_promote_provisional,
)


# ---------------------------------------------------------------------------
# #650 — speaker_attribution=ambient on Omi conversations
# ---------------------------------------------------------------------------

def _omi_event(**raw_overrides) -> dict:
    raw = {
        "date": "2026-04-25",
        "time_range": "10:00-10:30",
        "languages": ["en"],
        "text": "Some captured speech.",
    }
    raw.update(raw_overrides)
    return {
        "stream_type": "omi-audio",
        "source_ref": "omi-audio:uid-1:1714000000",
        "received_at": "2026-04-25T10:00:00+00:00",
        "stream_id": "omi-stream-1",
        "raw": raw,
        "metadata": {"uid": "uid-1", "parser": "omi", "languages": ["en"]},
    }


def test_omi_event_always_gets_ambient_attribution_without_diarization() -> None:
    event = _omi_event()
    content = _build_vault_content(
        name="Omi conversation",
        event=event,
        body="Some captured speech.",
        tags=["omi-audio"],
        record_type="conversation",
    )
    assert "speaker_attribution: ambient" in content
    assert "possession_evidence: false" in content


def test_omi_event_with_segments_but_no_speaker_ids_is_ambient() -> None:
    # Segments present but no speaker_id field — still ambient.
    event = _omi_event(segments=[{"text": "hi"}, {"text": "there"}])
    content = _build_vault_content(
        name="Omi conversation",
        event=event,
        body="hi there",
        tags=["omi-audio"],
        record_type="conversation",
    )
    assert "speaker_attribution: ambient" in content
    assert "possession_evidence: false" in content


def test_omi_event_with_diarization_proving_owner_is_owner() -> None:
    event = _omi_event(
        segments=[
            {"speaker_id": "spk-owner", "text": "good morning"},
            {"speaker_id": "spk-owner", "text": "shall we begin"},
        ],
        owner_id="spk-owner",
    )
    content = _build_vault_content(
        name="Omi conversation",
        event=event,
        body="good morning",
        tags=["omi-audio"],
        record_type="conversation",
    )
    assert "speaker_attribution: owner" in content
    assert "possession_evidence: true" in content


def test_omi_event_with_mixed_speakers_is_ambient() -> None:
    event = _omi_event(
        segments=[
            {"speaker_id": "spk-owner", "text": "hi"},
            {"speaker_id": "spk-other", "text": "hi back"},
        ],
        owner_id="spk-owner",
    )
    content = _build_vault_content(
        name="Omi conversation",
        event=event,
        body="hi",
        tags=["omi-audio"],
        record_type="conversation",
    )
    assert "speaker_attribution: ambient" in content
    assert "possession_evidence: false" in content


def test_compute_speaker_attribution_unit() -> None:
    # No segments at all → ambient.
    assert _compute_omi_speaker_attribution(None, "owner") == "ambient"
    assert _compute_omi_speaker_attribution([], "owner") == "ambient"
    # No owner id → can't compare → ambient.
    assert _compute_omi_speaker_attribution(
        [{"speaker_id": "x"}], None,
    ) == "ambient"
    # Segments without speaker_id key → ambient.
    assert _compute_omi_speaker_attribution(
        [{"text": "hi"}], "owner",
    ) == "ambient"
    # All-owner segments → owner.
    assert _compute_omi_speaker_attribution(
        [{"speaker_id": "owner"}, {"speaker_id": "owner"}], "owner",
    ) == "owner"
    # Any non-owner segment → ambient.
    assert _compute_omi_speaker_attribution(
        [{"speaker_id": "owner"}, {"speaker_id": "guest"}], "owner",
    ) == "ambient"


def test_non_omi_streams_have_no_speaker_attribution() -> None:
    """Calendar / Gmail / Slack / etc. must NOT carry the ambient flag.

    The flag is Omi-pipeline specific. Polluting non-ambient streams with
    it would mislead downstream enrichment about whether the content was
    overheard vs first-party.
    """
    for stream_type, raw in [
        ("gmail", {"subject": "hi", "from": "a@b.c", "snippet": "hello"}),
        ("calendar", {"start": {"dateTime": "2026-04-25T10:00:00Z"},
                      "end": {"dateTime": "2026-04-25T11:00:00Z"},
                      "summary": "Meeting"}),
        ("slack", {"text": "hello", "channel": "general"}),
        ("github", {"action": "opened", "repo": "x/y", "actor": "z"}),
        ("voice-call", {"transcript": [], "from": "+1", "to": "+2"}),
    ]:
        event = {
            "stream_type": stream_type,
            "received_at": "2026-04-25T10:00:00+00:00",
            "raw": raw,
            "metadata": {},
        }
        content = _build_vault_content(
            name="Test record",
            event=event,
            body="body",
            tags=[stream_type],
            record_type="event",
        )
        assert "speaker_attribution" not in content, (
            f"{stream_type} stream leaked speaker_attribution into "
            f"frontmatter — only Omi should carry it"
        )
        assert "possession_evidence" not in content, (
            f"{stream_type} stream leaked possession_evidence into "
            f"frontmatter — only Omi should carry it"
        )


# ---------------------------------------------------------------------------
# #651 — two-strike promotion for auto-discovered entities
# ---------------------------------------------------------------------------

def test_provisional_types_cover_org_person_location() -> None:
    assert is_provisional_entity_type("org")
    assert is_provisional_entity_type("person")
    assert is_provisional_entity_type("location")
    # Other types are not gated.
    assert not is_provisional_entity_type("event")
    assert not is_provisional_entity_type("conversation")
    assert not is_provisional_entity_type("matter")
    assert not is_provisional_entity_type("task")


def test_initial_status_provisional_for_entities_active_for_others() -> None:
    assert initial_status_for_auto_discovery("org") == "provisional"
    assert initial_status_for_auto_discovery("person") == "provisional"
    assert initial_status_for_auto_discovery("location") == "provisional"
    assert initial_status_for_auto_discovery("event") == "active"
    assert initial_status_for_auto_discovery("matter") == "active"


def test_merge_streams_dedups_and_caps() -> None:
    merged, added = merge_mentioned_streams(["a"], "b")
    assert merged == ["a", "b"]
    assert added is True
    # Re-adding existing → no change.
    merged, added = merge_mentioned_streams(["a", "b"], "a")
    assert merged == ["a", "b"]
    assert added is False
    # Empty new id → no change.
    merged, added = merge_mentioned_streams(["a"], "")
    assert merged == ["a"]
    assert added is False
    # Missing existing → list of one.
    merged, added = merge_mentioned_streams(None, "a")
    assert merged == ["a"]
    assert added is True


def test_should_promote_threshold() -> None:
    # Below threshold → no promotion.
    assert not should_promote_provisional("provisional", ["a"])
    # At threshold → promote.
    assert should_promote_provisional("provisional", ["a", "b"])
    # Already active → not "promote" (it's stable).
    assert not should_promote_provisional("active", ["a", "b", "c"])
    # Threshold uses *distinct* streams (set semantics).
    assert not should_promote_provisional("provisional", ["a", "a"])


def test_next_status_never_demotes_active() -> None:
    assert next_status("active", []) == "active"
    assert next_status("active", ["x"]) == "active"
    # Provisional below threshold stays provisional.
    assert next_status("provisional", ["a"]) == "provisional"
    # Crosses threshold → active.
    assert next_status("provisional", ["a", "b"]) == "active"
    # Missing status defaults to provisional posture.
    assert next_status(None, []) == "provisional"


def test_new_auto_discovered_org_starts_provisional() -> None:
    """First stream mention of a brand-new org → provisional + tracked."""
    delta = apply_two_strike_promotion(
        record_type="org",
        existing_frontmatter=None,
        new_stream_id="omi-stream-1",
    )
    assert delta["status"] == "provisional"
    assert delta["mentioned_by_streams"] == ["omi-stream-1"]


def test_same_org_mentioned_by_second_distinct_stream_promotes() -> None:
    """Second distinct stream mention → flips to active, list grows."""
    existing = {
        "status": "provisional",
        "mentioned_by_streams": ["omi-stream-1"],
    }
    delta = apply_two_strike_promotion(
        record_type="org",
        existing_frontmatter=existing,
        new_stream_id="gmail-stream-2",
    )
    assert delta["status"] == "active"
    assert delta["mentioned_by_streams"] == ["omi-stream-1", "gmail-stream-2"]


def test_existing_active_org_stays_active_just_appends_stream() -> None:
    """Already-promoted entity: stay active, append new stream id."""
    existing = {
        "status": "active",
        "mentioned_by_streams": ["omi-stream-1", "gmail-stream-2"],
    }
    delta = apply_two_strike_promotion(
        record_type="org",
        existing_frontmatter=existing,
        new_stream_id="github-stream-3",
    )
    # status not in delta — it didn't change.
    assert "status" not in delta
    assert delta["mentioned_by_streams"] == [
        "omi-stream-1", "gmail-stream-2", "github-stream-3",
    ]


def test_active_org_seeing_repeat_stream_is_noop() -> None:
    """Already-active entity, same stream as before → empty delta."""
    existing = {
        "status": "active",
        "mentioned_by_streams": ["omi-stream-1"],
    }
    delta = apply_two_strike_promotion(
        record_type="org",
        existing_frontmatter=existing,
        new_stream_id="omi-stream-1",
    )
    assert delta == {}


def test_provisional_entity_seeing_same_stream_twice_does_not_promote() -> None:
    """Single stream mentioning twice doesn't fake a corroboration."""
    existing = {
        "status": "provisional",
        "mentioned_by_streams": ["omi-stream-1"],
    }
    delta = apply_two_strike_promotion(
        record_type="org",
        existing_frontmatter=existing,
        new_stream_id="omi-stream-1",
    )
    # No change — same stream, no promotion.
    assert delta == {}


def test_non_provisional_record_type_returns_empty_delta() -> None:
    """Two-strike rule does NOT apply to events / matters / tasks / etc."""
    for record_type in ("event", "conversation", "matter", "task", "note"):
        delta = apply_two_strike_promotion(
            record_type=record_type,
            existing_frontmatter=None,
            new_stream_id="any-stream",
        )
        assert delta == {}, (
            f"{record_type} should be exempt from the provisional gate"
        )


def test_promotion_threshold_is_two() -> None:
    """Document the threshold so it can't drift silently."""
    assert PROMOTION_THRESHOLD == 2


def test_person_entity_follows_same_two_strike_rule() -> None:
    delta = apply_two_strike_promotion(
        record_type="person",
        existing_frontmatter={
            "status": "provisional",
            "mentioned_by_streams": ["sms-stream-1"],
        },
        new_stream_id="gmail-stream-2",
    )
    assert delta["status"] == "active"


def test_location_entity_follows_same_two_strike_rule() -> None:
    delta = apply_two_strike_promotion(
        record_type="location",
        existing_frontmatter=None,
        new_stream_id="calendar-stream-1",
    )
    assert delta["status"] == "provisional"
    assert delta["mentioned_by_streams"] == ["calendar-stream-1"]


# ---------------------------------------------------------------------------
# _resolve_source_type — content vs transport classification
# ---------------------------------------------------------------------------
# Regression coverage for the david-tenant bug where 359 gmail records were
# typed as ``gcal`` because the puller passes ``Stream.type`` (== "scheduled"
# for every pull-mode stream) as ``stream_type``, and "scheduled" used to
# be in the calendar allowlist. Fix: trust ``source_ref`` prefix first.

def test_gmail_pull_with_scheduled_stream_type_classifies_as_gmail() -> None:
    event = {
        "stream_type": "scheduled",
        "source_ref": "gmail:19d5455a67ffb649",
        "raw": {"from": "rj@example.com", "subject": "Fwd: Specs"},
        "metadata": {"event_type": "email"},
    }
    assert _resolve_source_type(event, legacy_record_type="event") == "gmail"


def test_gcal_pull_with_scheduled_stream_type_classifies_as_gcal() -> None:
    event = {
        "stream_type": "scheduled",
        "source_ref": "gcal:abc123",
        "raw": {"start": {"dateTime": "2026-05-13T10:00:00Z"},
                "end": {"dateTime": "2026-05-13T11:00:00Z"}},
    }
    assert _resolve_source_type(event, legacy_record_type="event") == "gcal"


def test_gcal_pull_without_source_ref_falls_back_to_start_end_heuristic() -> None:
    # No source_ref prefix; rely on raw.start + raw.end to classify.
    event = {
        "stream_type": "scheduled",
        "source_ref": "",
        "raw": {"start": {"dateTime": "2026-05-13T10:00:00Z"},
                "end": {"dateTime": "2026-05-13T11:00:00Z"}},
    }
    assert _resolve_source_type(event, legacy_record_type="event") == "gcal"


def test_scheduled_stream_type_alone_does_not_mean_gcal() -> None:
    # Bare "scheduled" with no other signal → falls through to "generic",
    # NOT "gcal" (that was the old bug).
    event = {
        "stream_type": "scheduled",
        "source_ref": "",
        "raw": {},
        "metadata": {},
    }
    assert _resolve_source_type(event, legacy_record_type="event") == "generic"


def test_slack_pull_with_source_ref_classifies_as_slack() -> None:
    event = {
        "stream_type": "scheduled",
        "source_ref": "slack:C123:msg-456",
        "raw": {"text": "hi"},
    }
    assert _resolve_source_type(event, legacy_record_type="event") == "slack"


def test_legitimate_calendar_stream_type_still_classifies_as_gcal() -> None:
    # The non-"scheduled" calendar aliases must still work.
    event = {"stream_type": "google-calendar", "raw": {}}
    assert _resolve_source_type(event, legacy_record_type="event") == "gcal"
    event = {"stream_type": "calendar", "raw": {}}
    assert _resolve_source_type(event, legacy_record_type="event") == "gcal"
