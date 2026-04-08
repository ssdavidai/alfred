"""Tests for the ALFRED_CHORE_SKIP_TEMPLATE_MATCHING + ALFRED_CHORE_MAX_GENERATED env flags.

Covers:
  - `_max_generated_chores_per_onboarding` parsing (default, valid int,
    zero/negative, invalid, safety ceiling)
  - Skip-matching path in `assign_initial_chores` — every opportunity
    becomes a generation candidate, no Opus matcher or keyword
    heuristic runs

The full assign_initial_chores function is long and has many dependencies
(vault writes, ctrl-api schedule creation, Opus matcher import). For
these tests we mock everything downstream of the matching decision and
verify only that the skip-matching flag correctly routes opportunities
into the `unmatched` bucket.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from temporalio.testing import ActivityEnvironment
from temporalio import activity

from src.activities import assign_chores
from src.activities.assign_chores import _max_generated_chores_per_onboarding


# ---------------------------------------------------------------------------
# _max_generated_chores_per_onboarding env var parsing
# ---------------------------------------------------------------------------

class TestMaxGeneratedEnvVar:
    def test_unset_returns_default_10(self, monkeypatch):
        monkeypatch.delenv("ALFRED_CHORE_MAX_GENERATED", raising=False)
        assert _max_generated_chores_per_onboarding() == 10

    def test_empty_string_returns_default(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CHORE_MAX_GENERATED", "")
        assert _max_generated_chores_per_onboarding() == 10

    def test_whitespace_returns_default(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CHORE_MAX_GENERATED", "   ")
        assert _max_generated_chores_per_onboarding() == 10

    def test_valid_int_returned(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CHORE_MAX_GENERATED", "7")
        assert _max_generated_chores_per_onboarding() == 7

    def test_zero_treated_as_invalid_uses_default(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CHORE_MAX_GENERATED", "0")
        assert _max_generated_chores_per_onboarding() == 10

    def test_negative_treated_as_invalid_uses_default(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CHORE_MAX_GENERATED", "-5")
        assert _max_generated_chores_per_onboarding() == 10

    def test_non_numeric_returns_default(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CHORE_MAX_GENERATED", "abc")
        assert _max_generated_chores_per_onboarding() == 10

    def test_decimal_treated_as_invalid(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CHORE_MAX_GENERATED", "3.5")
        assert _max_generated_chores_per_onboarding() == 10

    def test_safety_ceiling_enforced(self, monkeypatch):
        """Typos in .env shouldn't let a tenant run 1000 Opus calls."""
        monkeypatch.setenv("ALFRED_CHORE_MAX_GENERATED", "1000")
        assert _max_generated_chores_per_onboarding() == 20

    def test_exactly_at_ceiling_returned(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CHORE_MAX_GENERATED", "20")
        assert _max_generated_chores_per_onboarding() == 20

    def test_one_is_valid(self, monkeypatch):
        """Minimum valid value."""
        monkeypatch.setenv("ALFRED_CHORE_MAX_GENERATED", "1")
        assert _max_generated_chores_per_onboarding() == 1


# ---------------------------------------------------------------------------
# ALFRED_CHORE_SKIP_TEMPLATE_MATCHING — skip-matching path
# ---------------------------------------------------------------------------

# We test the matching-dispatch block in isolation by stubbing out
# everything downstream (vault writes, schedule creation, generation
# pipeline). The goal is to prove that the skip-matching flag correctly
# produces `unmatched` containing every input opportunity, without
# calling the Opus matcher or the keyword heuristic.


def _run_assign(onboard_path: str) -> dict:
    env = ActivityEnvironment()
    return asyncio.run(env.run(assign_chores.assign_initial_chores, onboard_path, "test-user"))


def _write_onboard_json(tmp_path, opportunities: list[dict]) -> str:
    import json
    path = tmp_path / "onboard.json"
    path.write_text(json.dumps({
        "profile": {
            "rhythm": {"peak_hours": [10, 14], "work_end_estimate": 17},
            "meta": {"email_count": 500},
        },
        "facts": [],
        "opportunities": opportunities,
    }))
    return str(path)


def _sample_opportunities() -> list[dict]:
    return [
        {
            "id": "watch-subs",
            "name": "Watch subscriptions",
            "description": "Flag unexpected subscription charges",
            "goal": "track subscription billing anomalies",
            "tags": ["financial"],
        },
        {
            "id": "weekly-digest",
            "name": "Weekly digest",
            "description": "Summarize important emails every Friday",
            "goal": "weekly summary of key correspondence",
            "tags": ["digest"],
        },
        {
            "id": "gym-tracker",
            "name": "Gym tracker",
            "description": "Track gym attendance",
            "goal": "health habits",
            "tags": ["health"],
        },
    ]


class TestSkipTemplateMatching:
    def test_flag_unset_defaults_to_skipped(self, tmp_path, monkeypatch):
        """When the flag is unset, the DEFAULT is now skip-matching —
        every opportunity becomes a generation candidate without any
        matcher running. This is the mega-plan's intended default."""
        monkeypatch.delenv("ALFRED_CHORE_SKIP_TEMPLATE_MATCHING", raising=False)
        monkeypatch.setenv("ALFRED_CHORE_GENERATION_ENABLED", "false")

        onboard = _write_onboard_json(tmp_path, _sample_opportunities())
        result = _run_assign(onboard)
        assert result["source"] == "skipped"

    def test_flag_explicit_false_runs_legacy_matcher(self, tmp_path, monkeypatch):
        """Opt-out path: explicitly setting the flag to false re-enables
        the legacy matcher-first flow. With Opus matcher also disabled
        we expect to land in the keyword heuristic path."""
        monkeypatch.setenv("ALFRED_CHORE_SKIP_TEMPLATE_MATCHING", "false")
        monkeypatch.setenv("ALFRED_CHORE_OPUS_MATCHING_ENABLED", "false")
        monkeypatch.setenv("ALFRED_CHORE_GENERATION_ENABLED", "false")

        onboard = _write_onboard_json(tmp_path, _sample_opportunities())
        result = _run_assign(onboard)
        assert result["source"] == "keyword"

    def test_flag_true_uses_skipped_source(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALFRED_CHORE_SKIP_TEMPLATE_MATCHING", "true")
        monkeypatch.setenv("ALFRED_CHORE_GENERATION_ENABLED", "false")

        onboard = _write_onboard_json(tmp_path, _sample_opportunities())
        result = _run_assign(onboard)
        assert result["source"] == "skipped"

    def test_all_opportunities_go_to_unmatched(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALFRED_CHORE_SKIP_TEMPLATE_MATCHING", "true")
        monkeypatch.setenv("ALFRED_CHORE_GENERATION_ENABLED", "false")

        opps = _sample_opportunities()
        onboard = _write_onboard_json(tmp_path, opps)
        result = _run_assign(onboard)
        # Every opportunity should be in the unmatched bucket
        assert result["unmatched"] == len(opps)
        # None should be "decided" since generation is disabled
        assert result["decided"] == 0

    def test_skip_matching_persists_unmatched_to_onboard_json(self, tmp_path, monkeypatch):
        import json

        monkeypatch.setenv("ALFRED_CHORE_SKIP_TEMPLATE_MATCHING", "true")
        monkeypatch.setenv("ALFRED_CHORE_GENERATION_ENABLED", "false")

        opps = _sample_opportunities()
        onboard_path = _write_onboard_json(tmp_path, opps)
        _run_assign(onboard_path)

        # Check that unmatched_opportunities was written back to onboard.json
        onboard = json.loads(open(onboard_path).read())
        unmatched = onboard.get("unmatched_opportunities", [])
        assert len(unmatched) == len(opps)
        # Each entry should have the original opportunity + a reason
        for entry in unmatched:
            assert "opportunity" in entry
            assert "reason" in entry
            assert "ALFRED_CHORE_SKIP_TEMPLATE_MATCHING" in entry["reason"]

    def test_skip_matching_does_not_call_opus_matcher(self, tmp_path, monkeypatch):
        """Verify that with the flag on, match_opportunities_to_templates
        is never called — this is the whole point of the flag."""
        monkeypatch.setenv("ALFRED_CHORE_SKIP_TEMPLATE_MATCHING", "true")
        monkeypatch.setenv("ALFRED_CHORE_GENERATION_ENABLED", "false")

        onboard = _write_onboard_json(tmp_path, _sample_opportunities())

        mock_matcher = AsyncMock()
        with patch(
            "src.activities.chore_matching.match_opportunities_to_templates",
            new=mock_matcher,
        ):
            _run_assign(onboard)

        mock_matcher.assert_not_called()

    def test_skip_matching_ignored_when_no_opportunities(self, tmp_path, monkeypatch):
        """If there are no opportunities, skip-matching has nothing to do
        and we fall through to the rule-based path."""
        monkeypatch.setenv("ALFRED_CHORE_SKIP_TEMPLATE_MATCHING", "true")
        monkeypatch.setenv("ALFRED_CHORE_GENERATION_ENABLED", "false")

        onboard = _write_onboard_json(tmp_path, [])
        result = _run_assign(onboard)
        # Empty opportunities → rules path, not skipped
        assert result["source"] == "rules"

    def test_non_dict_opportunities_filtered(self, tmp_path, monkeypatch):
        """Junk entries in the opportunities list should be silently dropped."""
        monkeypatch.setenv("ALFRED_CHORE_SKIP_TEMPLATE_MATCHING", "true")
        monkeypatch.setenv("ALFRED_CHORE_GENERATION_ENABLED", "false")

        mixed = _sample_opportunities() + ["not a dict", 42, None]  # type: ignore
        onboard = _write_onboard_json(tmp_path, mixed)
        result = _run_assign(onboard)
        # Only the 3 valid dicts should become unmatched entries
        assert result["unmatched"] == 3
        assert result["source"] == "skipped"
