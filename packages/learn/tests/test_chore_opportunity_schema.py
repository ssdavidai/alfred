"""Tests for ChoreOpportunity dataclass + validation.

Covers every required/optional field, every rejection case, and the
forgiving-but-bounded handling of Opus's sometimes-quirky JSON output.
"""
from __future__ import annotations

import pytest

from src.activities.chore_opportunity_schema import (
    ChoreOpportunity,
    ChoreOpportunityValidationError,
)


def _valid_opportunity_dict() -> dict:
    """Return a minimal valid opportunity dict for reuse across tests."""
    return {
        "id": "watch-subscriptions",
        "name": "Watch subscriptions",
        "description": "Reviews recurring charges and surfaces anomalies.",
        "goal": "Catch failed charges and unexpected price increases before they recur.",
        "trigger": {"kind": "cron", "hint": "weekly"},
        "data_sources": ["event", "matter"],
        "frequency_hint": "weekly",
        "notify_when": "anomaly confidence > 0.7",
        "tags": ["financial", "auto-generated"],
    }


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

class TestHappyPath:
    def test_minimal_valid_opportunity_parses(self):
        opp = ChoreOpportunity.from_dict(_valid_opportunity_dict())
        assert opp.id == "watch-subscriptions"
        assert opp.name == "Watch subscriptions"
        assert opp.trigger == {"kind": "cron", "hint": "weekly"}
        assert opp.data_sources == ["event", "matter"]
        assert opp.frequency_hint == "weekly"
        assert opp.notify_when == "anomaly confidence > 0.7"
        assert opp.tags == ["financial", "auto-generated"]

    def test_to_dict_roundtrip(self):
        orig = _valid_opportunity_dict()
        opp = ChoreOpportunity.from_dict(orig)
        out = opp.to_dict()
        assert out["id"] == orig["id"]
        assert out["trigger"] == orig["trigger"]
        assert out["data_sources"] == orig["data_sources"]

    def test_optional_fields_default_correctly(self):
        minimal = {
            "id": "a",
            "name": "A",
            "description": "A minimal opportunity.",
            "goal": "Minimal test.",
            "trigger": {"kind": "cron"},
        }
        opp = ChoreOpportunity.from_dict(minimal)
        assert opp.data_sources == []
        assert opp.tags == []
        assert opp.frequency_hint == "weekly"
        assert opp.notify_when == ""

    def test_single_char_id_accepted(self):
        raw = _valid_opportunity_dict()
        raw["id"] = "a"
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.id == "a"

    def test_numeric_id_accepted(self):
        raw = _valid_opportunity_dict()
        raw["id"] = "chore-2026"
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.id == "chore-2026"


# ---------------------------------------------------------------------------
# ID validation
# ---------------------------------------------------------------------------

class TestIdValidation:
    def test_rejects_uppercase_id(self):
        raw = _valid_opportunity_dict()
        raw["id"] = "WatchSubs"
        with pytest.raises(ChoreOpportunityValidationError, match="slug"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_id_with_spaces(self):
        raw = _valid_opportunity_dict()
        raw["id"] = "watch subs"
        with pytest.raises(ChoreOpportunityValidationError, match="slug"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_id_starting_with_hyphen(self):
        raw = _valid_opportunity_dict()
        raw["id"] = "-watch"
        with pytest.raises(ChoreOpportunityValidationError, match="slug"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_id_ending_with_hyphen(self):
        raw = _valid_opportunity_dict()
        raw["id"] = "watch-"
        with pytest.raises(ChoreOpportunityValidationError, match="slug"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_empty_id(self):
        raw = _valid_opportunity_dict()
        raw["id"] = ""
        with pytest.raises(ChoreOpportunityValidationError):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_id_over_64_chars(self):
        raw = _valid_opportunity_dict()
        raw["id"] = "a" * 65
        with pytest.raises(ChoreOpportunityValidationError, match="slug"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_id_with_special_chars(self):
        raw = _valid_opportunity_dict()
        raw["id"] = "watch@subs"
        with pytest.raises(ChoreOpportunityValidationError, match="slug"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_missing_id(self):
        raw = _valid_opportunity_dict()
        del raw["id"]
        with pytest.raises(ChoreOpportunityValidationError, match="'id'"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_non_string_id(self):
        raw = _valid_opportunity_dict()
        raw["id"] = 42
        with pytest.raises(ChoreOpportunityValidationError, match="'id'"):
            ChoreOpportunity.from_dict(raw)


# ---------------------------------------------------------------------------
# Name / description / goal validation
# ---------------------------------------------------------------------------

class TestRequiredStringFields:
    def test_rejects_empty_name(self):
        raw = _valid_opportunity_dict()
        raw["name"] = ""
        with pytest.raises(ChoreOpportunityValidationError, match="'name'"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_whitespace_only_name(self):
        raw = _valid_opportunity_dict()
        raw["name"] = "   "
        with pytest.raises(ChoreOpportunityValidationError, match="'name'"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_name_too_long(self):
        raw = _valid_opportunity_dict()
        raw["name"] = "x" * 121
        with pytest.raises(ChoreOpportunityValidationError, match="'name'"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_empty_description(self):
        raw = _valid_opportunity_dict()
        raw["description"] = ""
        with pytest.raises(ChoreOpportunityValidationError, match="'description'"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_empty_goal(self):
        raw = _valid_opportunity_dict()
        raw["goal"] = ""
        with pytest.raises(ChoreOpportunityValidationError, match="'goal'"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_description_too_long(self):
        raw = _valid_opportunity_dict()
        raw["description"] = "x" * 401
        with pytest.raises(ChoreOpportunityValidationError, match="'description'"):
            ChoreOpportunity.from_dict(raw)


# ---------------------------------------------------------------------------
# Trigger validation
# ---------------------------------------------------------------------------

class TestTriggerValidation:
    def test_rejects_missing_trigger(self):
        raw = _valid_opportunity_dict()
        del raw["trigger"]
        with pytest.raises(ChoreOpportunityValidationError, match="trigger"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_non_dict_trigger(self):
        raw = _valid_opportunity_dict()
        raw["trigger"] = "cron weekly"
        with pytest.raises(ChoreOpportunityValidationError, match="trigger must be a dict"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_trigger_without_kind(self):
        raw = _valid_opportunity_dict()
        raw["trigger"] = {"hint": "weekly"}
        with pytest.raises(ChoreOpportunityValidationError, match="trigger.kind"):
            ChoreOpportunity.from_dict(raw)

    def test_rejects_invalid_trigger_kind(self):
        raw = _valid_opportunity_dict()
        raw["trigger"] = {"kind": "quantum-entangled", "hint": "weekly"}
        with pytest.raises(ChoreOpportunityValidationError, match="trigger.kind"):
            ChoreOpportunity.from_dict(raw)

    def test_accepts_cron_trigger(self):
        raw = _valid_opportunity_dict()
        raw["trigger"] = {"kind": "cron", "hint": "Friday 9am"}
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.trigger["kind"] == "cron"

    def test_accepts_event_trigger(self):
        raw = _valid_opportunity_dict()
        raw["trigger"] = {"kind": "event", "hint": "on inbox email from stripe"}
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.trigger["kind"] == "event"

    def test_accepts_on_demand_trigger(self):
        raw = _valid_opportunity_dict()
        raw["trigger"] = {"kind": "on-demand", "hint": "when user asks"}
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.trigger["kind"] == "on-demand"

    def test_trigger_without_hint_gets_empty_string(self):
        raw = _valid_opportunity_dict()
        raw["trigger"] = {"kind": "cron"}
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.trigger["hint"] == ""

    def test_trigger_hint_truncated(self):
        raw = _valid_opportunity_dict()
        raw["trigger"] = {"kind": "cron", "hint": "x" * 500}
        opp = ChoreOpportunity.from_dict(raw)
        assert len(opp.trigger["hint"]) == 200  # _MAX_HINT_LEN


# ---------------------------------------------------------------------------
# Forgiving list-of-strings handling
# ---------------------------------------------------------------------------

class TestListFieldForgivingness:
    def test_missing_data_sources_defaults_to_empty(self):
        raw = _valid_opportunity_dict()
        del raw["data_sources"]
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.data_sources == []

    def test_null_data_sources_defaults_to_empty(self):
        raw = _valid_opportunity_dict()
        raw["data_sources"] = None
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.data_sources == []

    def test_non_list_data_sources_becomes_empty(self):
        raw = _valid_opportunity_dict()
        raw["data_sources"] = "event, matter"  # Opus sometimes returns strings
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.data_sources == []

    def test_non_string_items_dropped(self):
        raw = _valid_opportunity_dict()
        raw["data_sources"] = ["event", 42, None, "matter"]
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.data_sources == ["event", "matter"]

    def test_too_many_data_sources_truncated(self):
        raw = _valid_opportunity_dict()
        raw["data_sources"] = [f"src-{i}" for i in range(20)]
        opp = ChoreOpportunity.from_dict(raw)
        assert len(opp.data_sources) == 10  # _MAX_DATA_SOURCES

    def test_long_tag_truncated(self):
        raw = _valid_opportunity_dict()
        raw["tags"] = ["x" * 100]
        opp = ChoreOpportunity.from_dict(raw)
        assert len(opp.tags[0]) == 40  # _MAX_TAG_LEN

    def test_empty_strings_in_list_dropped(self):
        raw = _valid_opportunity_dict()
        raw["tags"] = ["good", "", "   ", "also-good"]
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.tags == ["good", "also-good"]


# ---------------------------------------------------------------------------
# Frequency hint normalization
# ---------------------------------------------------------------------------

class TestFrequencyHintNormalization:
    def test_accepts_canonical_frequency(self):
        raw = _valid_opportunity_dict()
        raw["frequency_hint"] = "daily"
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.frequency_hint == "daily"

    def test_normalizes_uppercase(self):
        raw = _valid_opportunity_dict()
        raw["frequency_hint"] = "DAILY"
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.frequency_hint == "daily"

    def test_unknown_frequency_defaults_to_weekly(self):
        raw = _valid_opportunity_dict()
        raw["frequency_hint"] = "every full moon"
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.frequency_hint == "weekly"

    def test_missing_frequency_defaults_to_weekly(self):
        raw = _valid_opportunity_dict()
        del raw["frequency_hint"]
        opp = ChoreOpportunity.from_dict(raw)
        assert opp.frequency_hint == "weekly"


# ---------------------------------------------------------------------------
# Top-level validation
# ---------------------------------------------------------------------------

class TestTopLevelValidation:
    def test_rejects_non_dict_input(self):
        with pytest.raises(ChoreOpportunityValidationError, match="must be a dict"):
            ChoreOpportunity.from_dict("not a dict")

    def test_rejects_list_input(self):
        with pytest.raises(ChoreOpportunityValidationError, match="must be a dict"):
            ChoreOpportunity.from_dict([])

    def test_rejects_none_input(self):
        with pytest.raises(ChoreOpportunityValidationError, match="must be a dict"):
            ChoreOpportunity.from_dict(None)
