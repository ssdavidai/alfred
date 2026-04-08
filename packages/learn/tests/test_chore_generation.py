"""Tests for the chore code generation activity (Step 4, S4-4).

Most coverage is on the helpers (envelope validator, profile slicer, JSON
parser) since the actual `_call_llm` invocation requires OpenRouter and is
exercised end-to-end in the smoke test on david.
"""
from __future__ import annotations

from src.activities.chore_generation import (
    _slice_profile_for_opportunity,
    _try_parse_envelope,
    _validate_envelope,
)


# ---------------------------------------------------------------------------
# _validate_envelope
# ---------------------------------------------------------------------------

def _good_envelope() -> dict:
    return {
        "module_name": "gym_attendance_tracker",
        "workflow_class_name": "GymAttendanceTrackerWorkflow",
        "python_source": "from __future__ import annotations\n# ...",
    }


class TestValidateEnvelope:
    def test_happy_path(self):
        ok, err = _validate_envelope(_good_envelope())
        assert ok
        assert err == ""

    def test_non_dict_input_rejected(self):
        ok, err = _validate_envelope("not a dict")  # type: ignore[arg-type]
        assert not ok
        assert "is not a dict" in err

    def test_missing_module_name_rejected(self):
        env = _good_envelope()
        del env["module_name"]
        ok, err = _validate_envelope(env)
        assert not ok
        assert "module_name" in err

    def test_module_name_must_be_valid_identifier(self):
        env = _good_envelope()
        env["module_name"] = "9bad-name!"
        ok, err = _validate_envelope(env)
        assert not ok

    def test_module_name_camel_case_rejected(self):
        env = _good_envelope()
        env["module_name"] = "GymAttendance"
        ok, err = _validate_envelope(env)
        assert not ok
        assert "snake_case" in err

    def test_workflow_class_name_must_end_with_workflow(self):
        env = _good_envelope()
        env["workflow_class_name"] = "GymAttendanceTracker"
        ok, err = _validate_envelope(env)
        assert not ok
        assert "Workflow" in err

    def test_workflow_class_name_must_be_camel_case(self):
        env = _good_envelope()
        env["workflow_class_name"] = "gymTrackerWorkflow"
        ok, err = _validate_envelope(env)
        assert not ok
        assert "CamelCase" in err

    def test_missing_python_source_rejected(self):
        env = _good_envelope()
        del env["python_source"]
        ok, err = _validate_envelope(env)
        assert not ok
        assert "python_source" in err

    def test_empty_python_source_rejected(self):
        env = _good_envelope()
        env["python_source"] = "   "
        ok, err = _validate_envelope(env)
        assert not ok
        assert "python_source" in err

    def test_oversized_python_source_rejected(self):
        env = _good_envelope()
        env["python_source"] = "x" * 100_001
        ok, err = _validate_envelope(env)
        assert not ok
        assert "too large" in err

    # C.1: user_facing_description tests
    def test_user_facing_description_omitted_passes(self):
        """Backwards compat: envelopes from before C.1 don't have the field."""
        env = _good_envelope()
        # field absent
        ok, err = _validate_envelope(env)
        assert ok, f"omitted user_facing_description should pass: {err}"

    def test_user_facing_description_empty_passes(self):
        env = _good_envelope()
        env["user_facing_description"] = "   "
        ok, _ = _validate_envelope(env)
        assert ok  # empty/whitespace skipped (not enforced when absent)

    def test_user_facing_description_too_short_rejected(self):
        env = _good_envelope()
        env["user_facing_description"] = "tiny description"
        ok, err = _validate_envelope(env)
        assert not ok
        assert "too short" in err

    def test_user_facing_description_too_long_rejected(self):
        env = _good_envelope()
        env["user_facing_description"] = "x" * 1500
        ok, err = _validate_envelope(env)
        assert not ok
        assert "too long" in err

    def test_user_facing_description_non_string_rejected(self):
        env = _good_envelope()
        env["user_facing_description"] = 12345
        ok, err = _validate_envelope(env)
        assert not ok
        assert "must be a string" in err

    def test_user_facing_description_valid_passes(self):
        env = _good_envelope()
        env["user_facing_description"] = (
            "Every Tuesday at 9am, this chore pulls your last 7 days of "
            "Stripe payments and compares them against the prior week. "
            "If volume drops by more than 20%, you get an alert."
        )
        ok, err = _validate_envelope(env)
        assert ok, err


# ---------------------------------------------------------------------------
# _try_parse_envelope
# ---------------------------------------------------------------------------

class TestTryParseEnvelope:
    def test_already_dict_passthrough(self):
        env = _good_envelope()
        assert _try_parse_envelope(env) == env

    def test_plain_json_string(self):
        import json
        text = json.dumps(_good_envelope())
        result = _try_parse_envelope(text)
        assert result == _good_envelope()

    def test_markdown_fence_stripped(self):
        import json
        env = _good_envelope()
        text = "```json\n" + json.dumps(env) + "\n```"
        result = _try_parse_envelope(text)
        assert result == env

    def test_leading_explanation_stripped_via_brace_search(self):
        import json
        env = _good_envelope()
        text = "Here is the generated template:\n\n" + json.dumps(env) + "\n\nLet me know if you need anything else."
        result = _try_parse_envelope(text)
        assert result is not None
        assert result["module_name"] == env["module_name"]

    def test_truncated_json_repaired(self):
        # Missing closing brace
        text = '{"module_name": "x", "workflow_class_name": "XWorkflow", "python_source": "abc"'
        result = _try_parse_envelope(text)
        assert result is not None
        assert result["module_name"] == "x"

    def test_unparseable_returns_none(self):
        text = "not even close to JSON ¯\\_(ツ)_/¯"
        result = _try_parse_envelope(text)
        assert result is None

    def test_non_string_non_dict_input_returns_none(self):
        result = _try_parse_envelope([1, 2, 3])  # type: ignore[arg-type]
        assert result is None


# ---------------------------------------------------------------------------
# _slice_profile_for_opportunity
# ---------------------------------------------------------------------------

class TestSliceProfileForOpportunity:
    def _full_profile(self) -> dict:
        return {
            "rhythm": {
                "work_start_estimate": 9,
                "work_end_estimate": 17,
                "weekend_activity_ratio": 0.35,
                "regularity_score": 0.7,
                "peak_hours": [9, 14, 10],
                "irrelevant_field": "should not appear",
            },
            "relationships": {
                "communication_style": "responsive",
                "top_correspondents": [
                    {"name": "X", "domain": "x.com", "email_count": 100},
                ],
            },
            "summary": {
                "communication_style": "responsive",
                "key_patterns": ["pattern 1"],
                "work_hours": "9-17",
            },
            "financial": {
                "detected_subscriptions": [{"service": "Stripe"}],
                "payment_issues": [],
                "detected_merchants": [],
            },
            "huge_profile_field_we_dont_want": "x" * 10_000,
        }

    def test_includes_rhythm(self):
        opp = {"goal": "test", "tags": []}
        sliced = _slice_profile_for_opportunity(self._full_profile(), opp)
        assert sliced["rhythm"]["work_end_estimate"] == 17
        assert sliced["rhythm"]["weekend_activity_ratio"] == 0.35

    def test_includes_communication_style(self):
        opp = {"goal": "test", "tags": []}
        sliced = _slice_profile_for_opportunity(self._full_profile(), opp)
        assert sliced["communication_style"] == "responsive"

    def test_excludes_huge_irrelevant_fields(self):
        opp = {"goal": "test", "tags": []}
        sliced = _slice_profile_for_opportunity(self._full_profile(), opp)
        # The 10KB field should not appear in the slice
        assert "huge_profile_field_we_dont_want" not in sliced
        # And the irrelevant rhythm sub-field should be filtered too
        assert "irrelevant_field" not in sliced["rhythm"]

    def test_financial_included_for_subscription_opportunity(self):
        opp = {"goal": "track subscription billing failures", "tags": ["financial"]}
        sliced = _slice_profile_for_opportunity(self._full_profile(), opp)
        assert "financial" in sliced
        assert sliced["financial"]["detected_subscriptions"][0]["service"] == "Stripe"

    def test_financial_excluded_for_non_financial_opportunity(self):
        opp = {"goal": "track gym attendance", "tags": ["health"]}
        sliced = _slice_profile_for_opportunity(self._full_profile(), opp)
        assert "financial" not in sliced

    def test_top_correspondents_included_for_matter_opportunity(self):
        opp = {"goal": "weekly digest of matter activity", "tags": ["digest"]}
        sliced = _slice_profile_for_opportunity(self._full_profile(), opp)
        assert "top_correspondents" in sliced

    def test_empty_profile_returns_safe_defaults(self):
        sliced = _slice_profile_for_opportunity({}, {"goal": "test", "tags": []})
        assert isinstance(sliced, dict)
        assert "rhythm" in sliced

    def test_non_dict_profile_returns_empty(self):
        sliced = _slice_profile_for_opportunity("not a dict", {})  # type: ignore[arg-type]
        assert sliced == {}
