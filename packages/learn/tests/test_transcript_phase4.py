"""Tests for Steward Phase 4 (#840) transcript-intake activities.

Covers the three pieces that don't depend on Vexa or Clerk being live:

  1. ``extract_meet_native_id`` — Google Meet URL extraction across the
     four conferenceData / hangoutLink / location / description shapes.
  2. ``is_sir_attendee`` — owner-attendance gate.
  3. ``_validate_extracted_actions`` — strict-JSON schema enforcement on
     LLM responses (mirrors the steward.evaluate_state validator).
  4. ``apply_transcript_action`` — Steward signal emission to
     ``streams/steward-signals.jsonl`` with the canonical
     ``transcript:action_candidate`` kind.

We do NOT exercise vexa_join_meeting / vexa_get_transcript /
extract_actions_from_transcript here — those depend on live Vexa + Clerk
and live behind their own integration tests in Phase 5.
"""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any

import pytest

from src.activities.transcript import (
    _validate_extracted_actions,
    _looks_like_empty_actions_envelope,
    apply_transcript_action,
    extract_meet_native_id,
    is_sir_attendee,
)


# ---------------------------------------------------------------------------
# extract_meet_native_id
# ---------------------------------------------------------------------------

class TestExtractMeetNativeId:
    def test_canonical_conference_data_video_entry(self) -> None:
        evt = {
            "conferenceData": {
                "entryPoints": [
                    {
                        "entryPointType": "video",
                        "uri": "https://meet.google.com/abc-defg-hij",
                    }
                ],
            },
        }
        url, native = extract_meet_native_id(evt)
        assert url == "https://meet.google.com/abc-defg-hij"
        assert native == "abc-defg-hij"

    def test_video_entry_preferred_over_phone(self) -> None:
        evt = {
            "conferenceData": {
                "entryPoints": [
                    {"entryPointType": "phone", "uri": "tel:+1234567890"},
                    {
                        "entryPointType": "video",
                        "uri": "https://meet.google.com/zyx-wvu-tsr",
                    },
                ],
            },
        }
        _, native = extract_meet_native_id(evt)
        assert native == "zyx-wvu-tsr"

    def test_hangout_link_fallback(self) -> None:
        evt = {"hangoutLink": "https://meet.google.com/foo-bar-baz"}
        url, native = extract_meet_native_id(evt)
        assert native == "foo-bar-baz"
        assert "meet.google.com" in url

    def test_location_field(self) -> None:
        evt = {"location": "https://meet.google.com/xx-yyy-zzz"}
        _, native = extract_meet_native_id(evt)
        assert native == "xx-yyy-zzz"

    def test_description_field(self) -> None:
        evt = {
            "description": "Join us at https://meet.google.com/aaa-bbbb-ccc — see you soon!",
        }
        _, native = extract_meet_native_id(evt)
        assert native == "aaa-bbbb-ccc"

    def test_no_meet_link(self) -> None:
        evt = {"summary": "1:1 with Alex", "description": "in-person at HQ"}
        url, native = extract_meet_native_id(evt)
        assert url == ""
        assert native == ""

    def test_zoom_link_does_not_match(self) -> None:
        evt = {"location": "https://us02web.zoom.us/j/12345"}
        url, native = extract_meet_native_id(evt)
        assert url == ""
        assert native == ""


# ---------------------------------------------------------------------------
# is_sir_attendee
# ---------------------------------------------------------------------------

class TestIsSirAttendee:
    def test_explicit_attendee_match_case_insensitive(self) -> None:
        evt = {
            "attendees": [
                {"email": "alex@vendor.com"},
                {"email": "DAVID@SZABOSTUBAN.COM"},
            ],
        }
        assert is_sir_attendee(evt, "david@szabostuban.com") is True

    def test_explicit_attendee_mismatch(self) -> None:
        evt = {"attendees": [{"email": "alex@vendor.com"}]}
        assert is_sir_attendee(evt, "david@szabostuban.com") is False

    def test_solo_event_via_creator(self) -> None:
        evt = {"creator": {"email": "david@szabostuban.com"}}
        assert is_sir_attendee(evt, "david@szabostuban.com") is True

    def test_solo_event_via_organizer(self) -> None:
        evt = {"organizer": {"email": "david@szabostuban.com"}}
        assert is_sir_attendee(evt, "david@szabostuban.com") is True

    def test_empty_owner_assumes_yes(self) -> None:
        # Operator hasn't pinned ownership — assume yes (otherwise we'd
        # silently drop every meeting on a tenant whose env is
        # mis-configured).
        evt = {"attendees": [{"email": "alex@vendor.com"}]}
        assert is_sir_attendee(evt, "") is True


# ---------------------------------------------------------------------------
# _validate_extracted_actions
# ---------------------------------------------------------------------------

class TestValidateExtractedActions:
    def test_valid_create_task(self) -> None:
        raw = {
            "actions": [
                {
                    "action_type": "create_task",
                    "parent_matter": "matter/sales-q2.md",
                    "title": "Send pricing tier proposal",
                    "body": "Alex committed to receiving the proposal by Friday.",
                    "confidence": 0.85,
                    "evidence_speaker": "Alex",
                    "evidence_quote": "Can you send the pricing tier breakdown by Friday?",
                }
            ]
        }
        out = _validate_extracted_actions(raw)
        assert len(out) == 1
        assert out[0]["action_type"] == "create_task"
        assert out[0]["parent_matter"] == "matter/sales-q2.md"
        assert out[0]["confidence"] == 0.85

    def test_valid_update_task(self) -> None:
        raw = {
            "actions": [
                {
                    "action_type": "update_task",
                    "parent_matter": "matter/inbox.md",
                    "target_path": "task/pavilion-delivery.md",
                    "patch": {"state": "done"},
                    "confidence": 0.9,
                    "evidence_speaker": "David",
                    "evidence_quote": "The pavilion arrived yesterday.",
                }
            ]
        }
        out = _validate_extracted_actions(raw)
        assert len(out) == 1
        assert out[0]["action_type"] == "update_task"
        assert out[0]["target_path"] == "task/pavilion-delivery.md"
        assert out[0]["patch"] == {"state": "done"}

    def test_valid_comment_on_matter(self) -> None:
        raw = {
            "actions": [
                {
                    "action_type": "comment_on_matter",
                    "parent_matter": "matter/competitive-positioning.md",
                    "body": "Alex flagged that competitor X is dropping prices.",
                    "confidence": 0.6,
                }
            ]
        }
        out = _validate_extracted_actions(raw)
        assert len(out) == 1
        assert out[0]["action_type"] == "comment_on_matter"

    def test_drops_unknown_action_type(self) -> None:
        raw = {
            "actions": [
                {"action_type": "fire_employee", "title": "x", "body": "y"}
            ]
        }
        out = _validate_extracted_actions(raw)
        assert out == []

    def test_drops_create_task_missing_title(self) -> None:
        raw = {
            "actions": [
                {
                    "action_type": "create_task",
                    "parent_matter": "matter/inbox.md",
                    "body": "Some body",
                    "confidence": 0.7,
                }
            ]
        }
        out = _validate_extracted_actions(raw)
        assert out == []

    def test_drops_update_task_missing_patch(self) -> None:
        raw = {
            "actions": [
                {
                    "action_type": "update_task",
                    "parent_matter": "matter/inbox.md",
                    "target_path": "task/foo.md",
                    "patch": {},
                    "confidence": 0.7,
                }
            ]
        }
        out = _validate_extracted_actions(raw)
        assert out == []

    def test_clamps_confidence(self) -> None:
        raw = {
            "actions": [
                {
                    "action_type": "create_task",
                    "parent_matter": "matter/inbox.md",
                    "title": "t",
                    "body": "b",
                    "confidence": 5.0,
                },
                {
                    "action_type": "create_task",
                    "parent_matter": "matter/inbox.md",
                    "title": "t2",
                    "body": "b2",
                    "confidence": -3.0,
                },
            ]
        }
        out = _validate_extracted_actions(raw)
        assert out[0]["confidence"] == 1.0
        assert out[1]["confidence"] == 0.0

    def test_normalises_parent_matter_path(self) -> None:
        raw = {
            "actions": [
                {
                    "action_type": "create_task",
                    "parent_matter": "sales-q2",
                    "title": "t",
                    "body": "b",
                    "confidence": 0.5,
                },
            ]
        }
        out = _validate_extracted_actions(raw)
        assert out[0]["parent_matter"] == "matter/sales-q2.md"

    def test_handles_non_dict_input(self) -> None:
        assert _validate_extracted_actions("not a dict") == []
        assert _validate_extracted_actions(None) == []
        assert _validate_extracted_actions(["actions"]) == []
        assert _validate_extracted_actions({"actions": "not a list"}) == []

    def test_caps_at_max_candidates(self) -> None:
        raw = {
            "actions": [
                {
                    "action_type": "create_task",
                    "parent_matter": "matter/inbox.md",
                    "title": f"t{i}",
                    "body": f"b{i}",
                    "confidence": 0.5,
                }
                for i in range(50)
            ]
        }
        out = _validate_extracted_actions(raw)
        assert len(out) <= 30  # _MAX_CANDIDATES_PER_TRANSCRIPT


class TestEmptyActionsEnvelope:
    def test_well_formed_empty(self) -> None:
        assert _looks_like_empty_actions_envelope({"actions": []}) is True

    def test_non_empty_envelope(self) -> None:
        assert (
            _looks_like_empty_actions_envelope({"actions": [{"x": 1}]}) is False
        )

    def test_malformed_returns_false(self) -> None:
        assert _looks_like_empty_actions_envelope("string") is False
        assert _looks_like_empty_actions_envelope({"oops": []}) is False
        assert _looks_like_empty_actions_envelope({"actions": "not a list"}) is False


# ---------------------------------------------------------------------------
# apply_transcript_action — emits Steward signals
# ---------------------------------------------------------------------------

class _FakeConfig:
    def __init__(self, alfred_data_dir: str) -> None:
        self.alfred_data_dir = alfred_data_dir
        self.streams_dir = os.path.join(alfred_data_dir, "streams")


class TestApplyTranscriptAction:
    @pytest.mark.asyncio
    async def test_create_task_emits_signal(self, tmp_path: Any, monkeypatch: Any) -> None:
        monkeypatch.setenv("ALFRED_DATA_DIR", str(tmp_path))
        from src.activities import transcript as t_mod
        # Force load_config to read the env var we just set.
        monkeypatch.setattr(t_mod, "load_config", lambda: _FakeConfig(str(tmp_path)))

        action = {
            "action_type": "create_task",
            "parent_matter": "matter/sales-q2.md",
            "title": "Send pricing proposal",
            "body": "Alex needs the tier proposal by Friday.",
            "target_path": "",
            "patch": {},
            "confidence": 0.8,
            "evidence_speaker": "Alex",
            "evidence_quote": "Can you send pricing by Friday?",
        }
        meta = {
            "platform": "google_meet",
            "native_meeting_id": "abc-defg-hij",
            "gcal_event_id": "evt_abc",
            "scheduled_start": "2026-05-04T15:00:00+00:00",
            "attendees": ["alex@vendor.com", "david@szabostuban.com"],
            "vexa_meeting_id": 42,
        }
        record = await apply_transcript_action(action, meta)

        assert record["kind"] == "transcript:action_candidate"
        # For create_task, target is the parent_matter path.
        assert record["task_path"] == "matter/sales-q2.md"
        assert record["ref"] == "meeting:google_meet:abc-defg-hij"
        assert "Alex" in record["note"]
        assert "Send pricing proposal" in record["note"]

        # Verify the JSONL file got written.
        signal_path = tmp_path / "streams" / "steward-signals.jsonl"
        assert signal_path.exists()
        content = signal_path.read_text(encoding="utf-8").strip()
        assert content
        parsed = json.loads(content)
        assert parsed["kind"] == "transcript:action_candidate"
        assert parsed["raw"]["action"]["action_type"] == "create_task"
        assert parsed["raw"]["meeting"]["native_meeting_id"] == "abc-defg-hij"

    @pytest.mark.asyncio
    async def test_update_task_targets_task_path(self, tmp_path: Any, monkeypatch: Any) -> None:
        from src.activities import transcript as t_mod
        monkeypatch.setattr(t_mod, "load_config", lambda: _FakeConfig(str(tmp_path)))

        action = {
            "action_type": "update_task",
            "parent_matter": "matter/inbox.md",
            "title": "",
            "body": "",
            "target_path": "task/pavilion-delivery.md",
            "patch": {"state": "done"},
            "confidence": 0.95,
            "evidence_speaker": "David",
            "evidence_quote": "The pavilion arrived yesterday.",
        }
        meta = {
            "platform": "google_meet",
            "native_meeting_id": "xyz-uvw-rst",
            "gcal_event_id": "",
            "scheduled_start": "",
            "attendees": [],
            "vexa_meeting_id": "",
        }
        record = await apply_transcript_action(action, meta)
        # update_task targets the task path, not the matter.
        assert record["task_path"] == "task/pavilion-delivery.md"
        # Note carries the patch keys for quick scanability.
        assert "state" in record["note"]

    @pytest.mark.asyncio
    async def test_unknown_action_type_raises(self, tmp_path: Any, monkeypatch: Any) -> None:
        from src.activities import transcript as t_mod
        monkeypatch.setattr(t_mod, "load_config", lambda: _FakeConfig(str(tmp_path)))

        with pytest.raises(ValueError):
            await apply_transcript_action(
                {"action_type": "delete_repo"},
                {"platform": "google_meet", "native_meeting_id": "x"},
            )

    @pytest.mark.asyncio
    async def test_two_create_tasks_emit_distinct_signals(
        self, tmp_path: Any, monkeypatch: Any,
    ) -> None:
        from src.activities import transcript as t_mod
        monkeypatch.setattr(t_mod, "load_config", lambda: _FakeConfig(str(tmp_path)))

        meta = {
            "platform": "google_meet",
            "native_meeting_id": "same-meeting",
            "attendees": [],
        }
        a1 = {
            "action_type": "create_task",
            "parent_matter": "matter/x.md",
            "title": "First",
            "body": "Body one",
            "target_path": "",
            "patch": {},
            "confidence": 0.7,
            "evidence_speaker": "",
            "evidence_quote": "",
        }
        a2 = dict(a1, title="Second", body="Body two")

        r1 = await apply_transcript_action(a1, meta)
        r2 = await apply_transcript_action(a2, meta)
        # Distinct signal ids — body-derived hash differs.
        assert r1["id"] != r2["id"]
        assert r1["id"].startswith("evt_transcript_same-meeting_google_meet_create_")
