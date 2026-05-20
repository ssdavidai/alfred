"""Tests for the chore code generation activity (Step 4, S4-4).

Most coverage is on the helpers (envelope validator, profile slicer, JSON
parser) since the actual `_call_llm` invocation requires OpenRouter and is
exercised end-to-end in the smoke test on the owner tenant.
"""
from __future__ import annotations

from src.activities.chore_generation import (
    _extract_description_timezone,
    _slice_profile_for_opportunity,
    _try_parse_envelope,
    _validate_cron_expression,
    _validate_cron_matches_description,
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

    # Schedule field tests (generated-chore-schedule fix)
    def test_schedule_omitted_passes(self):
        """Backwards compat: envelopes generated before the fix don't have the field."""
        env = _good_envelope()
        ok, err = _validate_envelope(env)
        assert ok, f"omitted schedule should pass: {err}"

    def test_schedule_valid_passes(self):
        env = _good_envelope()
        env["schedule"] = "30 14 * * 1-5"
        ok, err = _validate_envelope(env)
        assert ok, err

    def test_schedule_english_prose_rejected(self):
        env = _good_envelope()
        env["schedule"] = "every Tuesday at 9am"
        ok, err = _validate_envelope(env)
        assert not ok
        assert "schedule invalid" in err

    def test_schedule_wrong_field_count_rejected(self):
        env = _good_envelope()
        env["schedule"] = "0 9 * *"  # 4 fields
        ok, err = _validate_envelope(env)
        assert not ok
        assert "5-field" in err


# ---------------------------------------------------------------------------
# _validate_cron_expression
# ---------------------------------------------------------------------------

class TestValidateCronExpression:
    def test_weekday_afternoon(self):
        ok, err = _validate_cron_expression("30 14 * * 1-5")
        assert ok, err

    def test_first_of_month(self):
        ok, err = _validate_cron_expression("30 14 1 * *")
        assert ok, err

    def test_every_friday_3pm(self):
        ok, err = _validate_cron_expression("0 15 * * 5")
        assert ok, err

    def test_step_ranges(self):
        ok, err = _validate_cron_expression("0 8-18/2 * * 1-5")
        assert ok, err

    def test_hour_out_of_range(self):
        ok, err = _validate_cron_expression("0 25 * * *")
        assert not ok
        assert "hour" in err and "25" in err

    def test_day_out_of_range(self):
        ok, err = _validate_cron_expression("0 9 32 * *")
        assert not ok
        assert "day-of-month" in err

    def test_english_prose_rejected(self):
        ok, err = _validate_cron_expression("every Tuesday 9am")
        assert not ok

    def test_too_many_fields(self):
        ok, err = _validate_cron_expression("0 9 * * 1 2026")
        assert not ok
        assert "5-field" in err

    def test_empty(self):
        ok, err = _validate_cron_expression("")
        assert not ok
        assert "empty" in err

    def test_every_minute_rejected(self):
        ok, err = _validate_cron_expression("* * * * *")
        assert not ok
        assert "every minute" in err


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


# ---------------------------------------------------------------------------
# _validate_cron_matches_description (#478)
# ---------------------------------------------------------------------------

class TestValidateCronMatchesDescription:
    # ----- Real-world tenant-a bugs that motivated the validator -----

    def test_tenant_a_daily_morning_briefing_misalignment_caught(self):
        """The exact bug from issue #478: 'every day at 05:30 CET' but cron
        is `0 18 * * 0` (Sundays at 18:00 UTC = Mondays 00:00 Budapest).
        """
        ok, err = _validate_cron_matches_description(
            "0 18 * * 0",
            "Every day at 05:30 CET, this chore assembles a single morning "
            "briefing summarising your day-ahead calendar, overnight emails, "
            "and any open errands.",
            "Europe/Budapest",
        )
        assert not ok
        assert "daily" in err.lower() or "day-of-week" in err.lower()

    def test_tenant_a_weekly_wellness_misalignment_caught(self):
        """'Every Friday at 18:00 CET' but cron is `0 18 * * 0` (Sundays)."""
        ok, err = _validate_cron_matches_description(
            "0 18 * * 0",
            "Every Friday at 18:00 CET, this chore reviews your week and "
            "queues a wellness checkpoint conversation.",
            "Europe/Budapest",
        )
        assert not ok
        assert "5" in err

    # ----- Daily-implies-wildcard cases -----

    def test_daily_cron_30_4_passes_for_0530_cet_summer(self):
        """CEST 05:30 = UTC 03:30. Tolerance ±1h means UTC 04:30 also passes.
        `30 4 * * *` is the correct cron for 'every day at 05:30 CET' in
        summer (CEST). Should pass.
        """
        ok, err = _validate_cron_matches_description(
            "30 4 * * *",
            "Every day at 05:30 CET, this chore assembles your morning briefing.",
            "Europe/Budapest",
        )
        assert ok, err

    def test_daily_morning_with_wildcard_dow_passes(self):
        ok, err = _validate_cron_matches_description(
            "0 7 * * *",
            "Each morning at 07:00 UTC, this chore drafts your day plan.",
            "UTC",
        )
        assert ok, err

    def test_daily_with_specific_dow_fails(self):
        ok, err = _validate_cron_matches_description(
            "0 7 * * 1",
            "Each morning at 07:00 UTC, this chore drafts your day plan.",
            "UTC",
        )
        assert not ok
        assert "daily" in err.lower() or "day-of-week" in err.lower()

    # ----- Specific named day -----

    def test_friday_evening_cet_passes(self):
        """'Every Friday at 18:00 CET' → UTC 17:00 Friday (summer ±1h)."""
        ok, err = _validate_cron_matches_description(
            "0 17 * * 5",
            "Every Friday at 18:00 CET, this chore reviews your week.",
            "Europe/Budapest",
        )
        assert ok, err

    def test_monday_morning_passes(self):
        ok, err = _validate_cron_matches_description(
            "0 9 * * 1",
            "Every Monday at 09:00 UTC, this chore queues your week.",
            "UTC",
        )
        assert ok, err

    def test_monday_morning_with_wrong_day_fails(self):
        ok, err = _validate_cron_matches_description(
            "0 9 * * 0",  # Sunday
            "Every Monday at 09:00 UTC, this chore queues your week.",
            "UTC",
        )
        assert not ok
        assert "1" in err

    def test_sunday_accepts_both_0_and_7(self):
        ok, err = _validate_cron_matches_description(
            "0 18 * * 7",
            "Every Sunday at 18:00 UTC, this chore generates the weekly digest.",
            "UTC",
        )
        assert ok, err

    # ----- Weekday / weekend patterns -----

    def test_weekdays_with_1_5_passes(self):
        ok, err = _validate_cron_matches_description(
            "0 9 * * 1-5",
            "Weekdays at 09:00 UTC, this chore drafts a daily digest.",
            "UTC",
        )
        assert ok, err

    def test_weekdays_with_friday_only_fails(self):
        """'Weekdays at 09:00' but cron only fires Friday → fail."""
        ok, err = _validate_cron_matches_description(
            "0 9 * * 5",
            "Weekdays at 09:00 UTC, this chore drafts a daily digest.",
            "UTC",
        )
        assert not ok
        assert "weekday" in err.lower() or "Mon-Fri" in err

    def test_weekends_with_0_and_6_passes(self):
        ok, err = _validate_cron_matches_description(
            "0 10 * * 0,6",
            "On weekends at 10:00 UTC, this chore reviews personal projects.",
            "UTC",
        )
        assert ok, err

    def test_weekends_with_only_saturday_fails(self):
        ok, err = _validate_cron_matches_description(
            "0 10 * * 6",
            "On weekends at 10:00 UTC, this chore reviews personal projects.",
            "UTC",
        )
        assert not ok

    # ----- Vague descriptions skip checks -----

    def test_vague_description_skips_day_check(self):
        ok, err = _validate_cron_matches_description(
            "0 12 * * *",
            "Regularly throughout the week, this chore checks for anomalies.",
            "UTC",
        )
        assert ok, err

    def test_no_time_no_day_passes_anything(self):
        ok, err = _validate_cron_matches_description(
            "0 18 * * 0",
            "This chore reviews your activity and surfaces interesting items.",
            "UTC",
        )
        assert ok, err

    # ----- Empty / defensive inputs -----

    def test_empty_cron_skips_check(self):
        ok, err = _validate_cron_matches_description("", "Every day at 9am UTC", "UTC")
        assert ok, err

    def test_empty_description_skips_check(self):
        ok, err = _validate_cron_matches_description("0 9 * * 0", "", "UTC")
        assert ok, err

    def test_garbage_cron_skips_check(self):
        # Syntactic problems are someone else's job (_validate_cron_expression)
        ok, err = _validate_cron_matches_description(
            "definitely not a cron",
            "Every Friday at 18:00 UTC",
            "UTC",
        )
        assert ok, err

    # ----- Time-only checks -----

    def test_time_match_passes_for_utc(self):
        ok, err = _validate_cron_matches_description(
            "0 9 * * *",
            "Daily at 09:00 UTC, this chore checks overnight events.",
            "UTC",
        )
        assert ok, err

    def test_time_mismatch_fails_for_utc(self):
        """'09:00 UTC' but cron fires at 18:00 — 9-hour gap, far beyond ±1h."""
        ok, err = _validate_cron_matches_description(
            "0 18 * * *",
            "Daily at 09:00 UTC, this chore checks overnight events.",
            "UTC",
        )
        assert not ok
        assert "off by" in err or "UTC" in err

    def test_dst_tolerance_one_hour(self):
        """CET = UTC+1 winter, CEST = UTC+2 summer. Either offset should pass
        thanks to ±1h tolerance.
        """
        ok, err = _validate_cron_matches_description(
            "30 13 * * 1-5",
            "Every weekday at 14:30 CET, this chore drafts an afternoon recap.",
            "Europe/Budapest",
        )
        assert ok, err
        ok, err = _validate_cron_matches_description(
            "30 12 * * 1-5",
            "Every weekday at 14:30 CET, this chore drafts an afternoon recap.",
            "Europe/Budapest",
        )
        assert ok, err

    def test_cron_with_range_in_hour_skips_time_check(self):
        """When cron uses 8-18 in the hour field we can't anchor a single
        firing time, so the time check is skipped (the day check still runs).
        """
        ok, err = _validate_cron_matches_description(
            "0 8-18/2 * * 1-5",
            "Every weekday during business hours, this chore polls events.",
            "UTC",
        )
        assert ok, err

    def test_pm_marker_handled(self):
        ok, err = _validate_cron_matches_description(
            "0 21 * * *",
            "Every day at 9 PM UTC, this chore drafts a recap.",
            "UTC",
        )
        assert ok, err

    def test_ampm_with_12pm_is_noon(self):
        ok, err = _validate_cron_matches_description(
            "0 12 * * *",
            "Daily at 12pm UTC, this chore runs.",
            "UTC",
        )
        assert ok, err


# ---------------------------------------------------------------------------
# _validate_envelope integration with _validate_cron_matches_description
# ---------------------------------------------------------------------------

class TestEnvelopeSemanticAlignment:
    """When schedule + user_facing_description are both present and disagree,
    _validate_envelope must reject the envelope so the retry loop fires."""

    def _envelope(self, **overrides) -> dict:
        env = {
            "module_name": "morning_briefing",
            "workflow_class_name": "MorningBriefingWorkflow",
            "python_source": "from __future__ import annotations\n# ...",
            "user_facing_description": (
                "Every day at 05:30 CET, this chore assembles a single morning "
                "briefing summarising your day-ahead calendar."
            ),
            "schedule": "0 18 * * 0",  # the bug: Sunday 18:00 UTC
        }
        env.update(overrides)
        return env

    def test_misaligned_envelope_rejected(self):
        ok, err = _validate_envelope(self._envelope())
        assert not ok
        assert "user_facing_description" in err

    def test_aligned_envelope_passes(self):
        env = self._envelope(schedule="30 4 * * *")  # daily 04:30 UTC ≈ 05:30 CEST
        ok, err = _validate_envelope(env)
        assert ok, err

    def test_envelope_without_description_passes_syntactic_only(self):
        env = self._envelope()
        env.pop("user_facing_description")
        # Without a description we have nothing to compare against — only
        # the syntactic cron validator runs (and `0 18 * * 0` is valid).
        ok, err = _validate_envelope(env)
        assert ok, err


# ---------------------------------------------------------------------------
# _extract_description_timezone — description-stated tz takes precedence
# over the tenant-level fallback. Motivated by the audit-script false
# positives on tenant-b + tenant-a (see audit_chore_description_cron_alignment).
# ---------------------------------------------------------------------------

class TestExtractDescriptionTimezone:
    """The helper inspects the description for any tz signal; the validator
    (and the offline audit script) prefer it over `tenant_timezone`."""

    # ----- Adjacent abbreviation (highest signal) -----

    def test_abbrev_adjacent_to_time_wins(self):
        assert (
            _extract_description_timezone(
                "Every day at 05:30 CET, this chore briefs you."
            )
            == "Europe/Paris"
        )

    def test_abbrev_adjacent_utc_resolves_to_utc(self):
        assert (
            _extract_description_timezone("Daily at 09:00 UTC, fires the digest.")
            == "UTC"
        )

    # ----- City name (covers the tenant-a bugs) -----

    def test_budapest_city_name(self):
        # The exact form Opus produced for tenant-a's penthouse-project-tracker.
        assert (
            _extract_description_timezone(
                "Every Friday at 2pm Budapest time, this chore pulls events..."
            )
            == "Europe/Budapest"
        )

    def test_budapest_in_parenthetical_wins_over_lone_utc(self):
        # The exact form Opus produced for tenant-a's family-calendar-watch.
        # 'UTC' also appears as a sanity-check; we must NOT prefer it over
        # the city the author actually meant.
        assert (
            _extract_description_timezone(
                "Every Sunday at 18:00 (Budapest time, 16:00 UTC), this chore..."
            )
            == "Europe/Budapest"
        )

    def test_budapest_in_local_time_parenthetical(self):
        # tenant-a's monday-strategy-brief.
        assert (
            _extract_description_timezone(
                "Every Monday at 06:30 local time (Budapest, ~04:30 UTC), this chore..."
            )
            == "Europe/Budapest"
        )

    def test_warsaw_city_name(self):
        assert (
            _extract_description_timezone("Daily at 09:00 Warsaw time.")
            == "Europe/Warsaw"
        )

    def test_new_york_multi_word_city(self):
        assert (
            _extract_description_timezone(
                "Daily at 9am New York time, this chore fires."
            )
            == "America/New_York"
        )

    def test_word_boundary_no_partial_match(self):
        # Don't pick up "rome" inside "syndrome".
        assert (
            _extract_description_timezone(
                "Reviews recent posts about Stockholm syndrome at 18:00."
            )
            == "Europe/Stockholm"
        )

    def test_unrelated_word_does_not_match(self):
        assert (
            _extract_description_timezone(
                "Daily at 9am, this chore monitors anomaly events."
            )
            is None
        )

    # ----- Multi-word regional phrase -----

    def test_central_european_time_phrase(self):
        # tenant-a's italy-trip-planner / watch-subscriptions.
        assert (
            _extract_description_timezone(
                "Every Monday and Thursday at 10:00 AM (Central European time), this chore..."
            )
            == "Europe/Paris"
        )

    def test_eastern_time_phrase(self):
        assert (
            _extract_description_timezone(
                "Daily at 09:00 Eastern Time, this chore drafts a recap."
            )
            == "America/New_York"
        )

    def test_pacific_standard_time_full_phrase_beats_pst_word(self):
        # Phrase match should still resolve correctly; either is acceptable
        # because both map to America/Los_Angeles.
        assert (
            _extract_description_timezone(
                "Daily at 09:00 Pacific Standard Time, this chore fires."
            )
            == "America/Los_Angeles"
        )

    # ----- Lone abbreviation (lowest signal) -----

    def test_lone_abbreviation_in_parenthetical_when_no_city(self):
        # If the description gives ONLY a UTC sanity-check (no city, no
        # phrase), use it.
        assert (
            _extract_description_timezone("Every Friday afternoon (16:00 UTC).")
            == "UTC"
        )

    # ----- No signal -----

    def test_no_signal_returns_none(self):
        # tenant-b's daily-afternoon-briefing — author meant local time but
        # didn't say so. Caller falls back to tenant_timezone.
        assert (
            _extract_description_timezone(
                "Every weekday at 14:30, this chore pulls your Gmail activity."
            )
            is None
        )

    def test_empty_string_returns_none(self):
        assert _extract_description_timezone("") is None

    def test_whitespace_only_returns_none(self):
        assert _extract_description_timezone("   \n\t  ") is None

    def test_non_string_returns_none(self):
        assert _extract_description_timezone(None) is None  # type: ignore[arg-type]
        assert _extract_description_timezone(12345) is None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# _validate_cron_matches_description with description-stated timezone —
# regression tests for the 9 audit false positives on tenant-b + tenant-a.
# ---------------------------------------------------------------------------

class TestValidatorHonorsDescriptionTimezone:
    """When the description names a timezone (city / phrase / parenthetical
    abbrev), the validator must use it instead of the tenant_timezone arg."""

    def test_tenant_a_family_calendar_watch_passes(self):
        """The exact cron + description that produced a false positive on
        tenant-a. Cron `0 16 * * 0` fires Sunday 16:00 UTC = 18:00 Budapest
        CEST. Description says "18:00 (Budapest time, 16:00 UTC)" so the
        validator should resolve tz to Europe/Budapest, NOT the
        UTC tenant fallback.
        """
        ok, err = _validate_cron_matches_description(
            "0 16 * * 0",
            "Every Sunday at 18:00 (Budapest time, 16:00 UTC), this chore "
            "checks the family calendar.",
            tenant_timezone="UTC",
        )
        assert ok, err

    def test_tenant_a_monday_strategy_brief_passes(self):
        ok, err = _validate_cron_matches_description(
            "30 4 * * 1",
            "Every Monday at 06:30 local time (Budapest, ~04:30 UTC), this "
            "chore queues your week.",
            tenant_timezone="UTC",
        )
        assert ok, err

    def test_tenant_a_penthouse_project_tracker_passes(self):
        ok, err = _validate_cron_matches_description(
            "0 12 * * 5",
            "Every Friday at 2pm Budapest time, this chore pulls all events "
            "from the penthouse project.",
            tenant_timezone="UTC",
        )
        assert ok, err

    def test_tenant_a_site_health_patrol_passes(self):
        ok, err = _validate_cron_matches_description(
            "0 6 * * 3",
            "Every Wednesday at 8:00 AM Budapest time, this chore scans the "
            "site for issues.",
            tenant_timezone="UTC",
        )
        assert ok, err

    def test_tenant_a_italy_trip_planner_passes(self):
        ok, err = _validate_cron_matches_description(
            "0 8 * * 1,4",
            "Every Monday and Thursday at 10:00 AM (Central European time), "
            "this chore organises your Italy trip.",
            tenant_timezone="UTC",
        )
        assert ok, err

    def test_tenant_a_watch_subscriptions_passes(self):
        ok, err = _validate_cron_matches_description(
            "0 7 * * 5",
            "Every Friday at 9:00 AM (Central European time), this chore "
            "audits your subscriptions.",
            tenant_timezone="UTC",
        )
        assert ok, err

    def test_no_description_tz_falls_back_to_tenant_timezone(self):
        """tenant-b's daily-afternoon-briefing — description has no tz, so we
        fall back to the tenant_timezone arg. With the correct fallback
        (Europe/Warsaw), 14:30 Warsaw CEST = 12:30 UTC matches the cron.
        """
        ok, err = _validate_cron_matches_description(
            "30 12 * * 1-5",
            "Every weekday at 14:30, this chore pulls your Gmail activity.",
            tenant_timezone="Europe/Warsaw",
        )
        assert ok, err

    def test_no_description_tz_with_utc_fallback_still_fails(self):
        """When the description has no tz AND tenant_timezone is UTC, the
        existing behaviour is preserved — we still treat the time as UTC and
        flag the 2-hour offset. Operator must run the audit with the right
        --tenant-timezone for tenants whose chores were authored in local
        time without saying so.
        """
        ok, _err = _validate_cron_matches_description(
            "30 12 * * 1-5",
            "Every weekday at 14:30, this chore pulls your Gmail activity.",
            tenant_timezone="UTC",
        )
        assert not ok

    def test_lone_utc_does_not_trump_city(self):
        """Both 'Budapest time' AND 'UTC' appear in the description; the
        author is using UTC as a sanity-check conversion, not declaring the
        chore fires in UTC. City wins; cron matches.
        """
        ok, err = _validate_cron_matches_description(
            "0 16 * * 0",
            "Every Sunday at 18:00 (Budapest time, 16:00 UTC), reviews family.",
            tenant_timezone="UTC",
        )
        assert ok, err


# ---------------------------------------------------------------------------
# Generator re-roll on static validation failure (tenant-c ordering bug)
#
# The retry loop inside generate_chore_template_code must trigger an Opus
# re-roll when the generated python_source fails the static validator. We
# mock _call_llm and verify (a) two attempts happen when the first response
# is bad-then-good and (b) the violation message gets fed back into the
# next prompt as retry_feedback so Opus can fix it.
# ---------------------------------------------------------------------------

import asyncio
from unittest.mock import patch

from temporalio.testing import ActivityEnvironment

from src.activities.chore_generation import (
    ChoreGenerationError,
    generate_chore_template_code,
)


def _bad_ordering_python_source() -> str:
    """The exact shape from the tenant-c incident — workflow used in
    `with workflow.unsafe.imports_passed_through():` BEFORE the
    `from temporalio import workflow` import."""
    return '''"""Bad ordering."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

with workflow.unsafe.imports_passed_through():
    from temporalio import workflow
    from temporalio.common import RetryPolicy
    from src.workflows.chores._base import load_chore_context, record_chore_run
    from src.activities.chore_actions import fetch_financial_events


@dataclass
class TestInput:
    chore_slug: str


@dataclass
class TestResult:
    notes: str = ""


@workflow.defn(name="BadOrderingChoreWorkflow")
class BadOrderingChoreWorkflow:
    @workflow.run
    async def run(self, input: TestInput) -> TestResult:
        return TestResult(notes="x")
'''


def _good_python_source() -> str:
    """Canonical shape — workflow imported at module scope before the
    with-block."""
    return '''"""Good ordering."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.workflows.chores._base import load_chore_context, record_chore_run
    from src.activities.chore_actions import fetch_financial_events


@dataclass
class GoodOrderingInput:
    chore_slug: str


@dataclass
class GoodOrderingResult:
    notes: str = ""


@workflow.defn(name="GoodOrderingChoreWorkflow")
class GoodOrderingChoreWorkflow:
    @workflow.run
    async def run(self, input: GoodOrderingInput) -> GoodOrderingResult:
        await workflow.execute_activity(
            load_chore_context,
            args=[input.chore_slug],
            start_to_close_timeout=timedelta(seconds=15),
        )
        return GoodOrderingResult(notes="x")
'''


def _envelope(python_source: str, module="my_chore", cls="MyChoreWorkflow") -> str:
    """Wrap a python_source in the JSON envelope the generator expects."""
    import json
    return json.dumps({
        "module_name": module,
        "workflow_class_name": cls,
        "user_facing_description": (
            "Every Monday at 09:00 UTC, this chore reviews the previous "
            "week's financial events for anything unusual and only "
            "notifies you when something exceeds the configured threshold."
        ),
        "schedule": "0 9 * * 1",
        "python_source": python_source,
    })


class TestGeneratorReRollOnStaticValidation:
    """Integration test: when Opus emits the tenant-c import-ordering bug,
    the generator must re-roll instead of returning the broken source."""

    def _opportunity(self) -> dict:
        return {
            "id": "test-import-ordering",
            "name": "Test re-roll",
            "description": "Test that bad ordering triggers re-roll.",
            "goal": "verify retry path",
            "tags": ["test"],
        }

    def _profile(self) -> dict:
        return {"rhythm": {"work_start_estimate": 9, "work_end_estimate": 17}}

    def test_bad_ordering_response_triggers_reroll(self):
        """First _call_llm returns bad ordering → second returns good →
        generator returns the good one with attempts==2."""
        responses = [
            _envelope(_bad_ordering_python_source()),
            _envelope(_good_python_source(), module="good_chore", cls="GoodOrderingChoreWorkflow"),
        ]
        captured_prompts: list[str] = []

        async def fake_call_llm(prompt, max_tokens=8192, heartbeat_message=""):
            captured_prompts.append(prompt)
            return responses[len(captured_prompts) - 1]

        async def run_it():
            env = ActivityEnvironment()
            with patch(
                "src.activities.chore_generation._call_llm",
                side_effect=fake_call_llm,
            ):
                with patch(
                    "src.activities.chore_generation._read_template_examples",
                    return_value={},
                ):
                    return await env.run(
                        generate_chore_template_code,
                        self._opportunity(),
                        self._profile(),
                    )

        result = asyncio.run(run_it())

        assert result["attempts"] == 2, (
            f"expected 2 attempts (bad → good), got {result['attempts']}"
        )
        assert result["module_name"] == "good_chore"
        assert "from temporalio import workflow" in result["python_source"]
        # The second prompt must include retry feedback referencing the
        # ordering violation so Opus can fix it.
        assert len(captured_prompts) == 2
        feedback_prompt = captured_prompts[1]
        assert "previous generation attempt failed" in feedback_prompt
        assert (
            "imports_passed_through" in feedback_prompt
            or "static validation" in feedback_prompt
        ), "retry prompt must surface the static-validation feedback"

    def test_three_bad_responses_raises_chore_generation_error(self):
        """If every attempt has bad ordering, the generator exhausts its
        budget and raises — caller in assign_chores then skips the
        opportunity instead of writing broken code to disk."""
        bad_envelope = _envelope(_bad_ordering_python_source())

        async def fake_call_llm(prompt, max_tokens=8192, heartbeat_message=""):
            return bad_envelope

        async def run_it():
            env = ActivityEnvironment()
            with patch(
                "src.activities.chore_generation._call_llm",
                side_effect=fake_call_llm,
            ):
                with patch(
                    "src.activities.chore_generation._read_template_examples",
                    return_value={},
                ):
                    return await env.run(
                        generate_chore_template_code,
                        self._opportunity(),
                        self._profile(),
                    )

        try:
            asyncio.run(run_it())
        except ChoreGenerationError as exc:
            assert "static validation" in str(exc) or "imports_passed_through" in str(exc)
            return
        raise AssertionError(
            "expected ChoreGenerationError after 3 bad-ordering attempts"
        )

    def test_good_response_on_first_attempt_no_reroll(self):
        """Sanity check: when the first attempt is good, no retry happens."""
        good_envelope = _envelope(
            _good_python_source(),
            module="good_chore",
            cls="GoodOrderingChoreWorkflow",
        )
        call_count = {"n": 0}

        async def fake_call_llm(prompt, max_tokens=8192, heartbeat_message=""):
            call_count["n"] += 1
            return good_envelope

        async def run_it():
            env = ActivityEnvironment()
            with patch(
                "src.activities.chore_generation._call_llm",
                side_effect=fake_call_llm,
            ):
                with patch(
                    "src.activities.chore_generation._read_template_examples",
                    return_value={},
                ):
                    return await env.run(
                        generate_chore_template_code,
                        self._opportunity(),
                        self._profile(),
                    )

        result = asyncio.run(run_it())
        assert result["attempts"] == 1
        assert call_count["n"] == 1
