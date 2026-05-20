"""Tests for the profile-derived chore param helpers (Step 1).

These cover the four public helpers added in `src.activities.assign_chores`:
  - _derive_chore_schedule(template_id, profile) -> cron str
  - _derive_alert_threshold(template_id, profile) -> float
  - _derive_min_events_for_digest(profile) -> int
  - _infer_default_session_id(profile) -> str

Plus an integration check that `_decide_chores` actually calls them and
produces chores with bespoke params instead of hardcoded ones.
"""
from __future__ import annotations

import pytest

from src.activities.assign_chores import (
    _decide_chores,
    _derive_alert_threshold,
    _derive_chore_schedule,
    _derive_min_events_for_digest,
    _infer_default_session_id,
    _DEFAULT_ALERT_THRESHOLD,
    _DEFAULT_DIGEST_HOUR_UTC,
    _DEFAULT_MIN_EVENTS,
    _DEFAULT_SUBSCRIPTION_HOUR_UTC,
    _HOUR_MAX_CLAMP,
    _HOUR_MIN_CLAMP,
)


# ---------------------------------------------------------------------------
# _derive_chore_schedule
# ---------------------------------------------------------------------------

class TestDeriveChoreSchedule:
    def test_subscription_watcher_uses_work_end_plus_one_on_friday(self):
        profile = {"rhythm": {"work_end_estimate": 17}}
        result = _derive_chore_schedule("subscription_watcher", profile)
        # 17 + 1 = 18, still within 8-22 clamp → hour = 18, day = Friday (5)
        assert result == "0 18 * * 5"

    def test_subscription_watcher_clamps_early_work_end(self):
        # User who "ends work" at 4am (unusual — nightshift or bad data)
        profile = {"rhythm": {"work_end_estimate": 4}}
        result = _derive_chore_schedule("subscription_watcher", profile)
        # 4 + 1 = 5, clamped up to 8
        assert result == f"0 {_HOUR_MIN_CLAMP} * * 5"

    def test_subscription_watcher_clamps_late_work_end(self):
        # User who ends work at 22 — 22+1=23, clamped down to 22
        profile = {"rhythm": {"work_end_estimate": 22}}
        result = _derive_chore_schedule("subscription_watcher", profile)
        assert result == f"0 {_HOUR_MAX_CLAMP} * * 5"

    def test_subscription_watcher_falls_back_when_rhythm_missing(self):
        profile: dict = {}
        result = _derive_chore_schedule("subscription_watcher", profile)
        assert result == f"0 {_DEFAULT_SUBSCRIPTION_HOUR_UTC} * * 5"

    def test_subscription_watcher_falls_back_when_work_end_not_int(self):
        profile = {"rhythm": {"work_end_estimate": None}}
        result = _derive_chore_schedule("subscription_watcher", profile)
        assert result == f"0 {_DEFAULT_SUBSCRIPTION_HOUR_UTC} * * 5"

    def test_matter_digest_defaults_to_friday_when_no_weekend_activity(self):
        profile = {
            "rhythm": {
                "work_end_estimate": 17,
                "weekend_activity_ratio": 0.1,
            }
        }
        result = _derive_chore_schedule("weekly_matter_digest", profile)
        # 17 + 2 = 19, hour=19, day=Friday (5) because weekend_ratio < 0.3
        assert result == "0 19 * * 5"

    def test_matter_digest_goes_sunday_when_weekend_active(self):
        profile = {
            "rhythm": {
                "work_end_estimate": 17,
                "weekend_activity_ratio": 0.5,
            }
        }
        result = _derive_chore_schedule("weekly_matter_digest", profile)
        # 17 + 2 = 19, day=Sunday (0) because weekend_ratio >= 0.3
        assert result == "0 19 * * 0"

    def test_matter_digest_falls_back_when_rhythm_missing(self):
        profile: dict = {}
        result = _derive_chore_schedule("weekly_matter_digest", profile)
        # Missing rhythm → default hour, default day (Friday because no weekend signal)
        assert result == f"0 {_DEFAULT_DIGEST_HOUR_UTC} * * 5"

    def test_matter_digest_handles_weekend_ratio_as_int(self):
        # Tolerance for int vs float
        profile = {
            "rhythm": {
                "work_end_estimate": 17,
                "weekend_activity_ratio": 1,  # int, not float
            }
        }
        result = _derive_chore_schedule("weekly_matter_digest", profile)
        assert result.endswith("* * 0")  # Sunday

    def test_unknown_template_uses_digest_default(self):
        result = _derive_chore_schedule("unknown_template", {})
        assert result == f"0 {_DEFAULT_DIGEST_HOUR_UTC} * * 0"


# ---------------------------------------------------------------------------
# _derive_alert_threshold
# ---------------------------------------------------------------------------

class TestDeriveAlertThreshold:
    def test_selective_style_tight_threshold(self):
        profile = {"relationships": {"communication_style": "selective"}}
        assert _derive_alert_threshold("subscription_watcher", profile) == 0.85

    def test_responsive_style_default_threshold(self):
        profile = {"relationships": {"communication_style": "responsive"}}
        assert _derive_alert_threshold("subscription_watcher", profile) == 0.70

    def test_batched_style_loose_threshold(self):
        profile = {"relationships": {"communication_style": "batched"}}
        assert _derive_alert_threshold("subscription_watcher", profile) == 0.55

    def test_sparse_style_very_tight_threshold(self):
        profile = {"relationships": {"communication_style": "sparse"}}
        assert _derive_alert_threshold("subscription_watcher", profile) == 0.90

    def test_style_from_summary_fallback(self):
        # Prefers relationships.communication_style, falls back to summary
        profile = {
            "relationships": {},
            "summary": {"communication_style": "selective"},
        }
        assert _derive_alert_threshold("subscription_watcher", profile) == 0.85

    def test_missing_style_returns_default(self):
        profile: dict = {}
        assert _derive_alert_threshold("subscription_watcher", profile) == _DEFAULT_ALERT_THRESHOLD

    def test_unknown_style_returns_default(self):
        profile = {"relationships": {"communication_style": "unknown-weird-value"}}
        assert _derive_alert_threshold("subscription_watcher", profile) == _DEFAULT_ALERT_THRESHOLD

    def test_non_subscription_template_returns_default(self):
        # Only subscription_watcher uses this threshold; other templates get default
        profile = {"relationships": {"communication_style": "selective"}}
        assert _derive_alert_threshold("weekly_matter_digest", profile) == _DEFAULT_ALERT_THRESHOLD


# ---------------------------------------------------------------------------
# _derive_min_events_for_digest
# ---------------------------------------------------------------------------

class TestDeriveMinEventsForDigest:
    def test_high_volume_returns_5(self):
        profile = {"meta": {"email_count": 3500}}
        assert _derive_min_events_for_digest(profile) == 5

    def test_high_volume_exact_boundary(self):
        profile = {"meta": {"email_count": 2000}}
        assert _derive_min_events_for_digest(profile) == 5

    def test_medium_volume_returns_3(self):
        profile = {"meta": {"email_count": 1200}}
        assert _derive_min_events_for_digest(profile) == 3

    def test_medium_volume_lower_boundary(self):
        profile = {"meta": {"email_count": 500}}
        assert _derive_min_events_for_digest(profile) == 3

    def test_low_volume_returns_2(self):
        profile = {"meta": {"email_count": 200}}
        assert _derive_min_events_for_digest(profile) == 2

    def test_missing_meta_returns_default(self):
        profile: dict = {}
        assert _derive_min_events_for_digest(profile) == _DEFAULT_MIN_EVENTS

    def test_missing_email_count_returns_default(self):
        profile = {"meta": {}}
        assert _derive_min_events_for_digest(profile) == _DEFAULT_MIN_EVENTS

    def test_non_int_email_count_returns_default(self):
        profile = {"meta": {"email_count": "not an int"}}
        assert _derive_min_events_for_digest(profile) == _DEFAULT_MIN_EVENTS


# ---------------------------------------------------------------------------
# _infer_default_session_id
# ---------------------------------------------------------------------------

class TestInferDefaultSessionId:
    def test_returns_main(self):
        assert _infer_default_session_id({}) == "main"

    def test_returns_main_with_full_profile(self):
        # Future: will inspect connected streams. Today: always "main".
        profile = {"rhythm": {}, "relationships": {}, "meta": {"email_count": 5000}}
        assert _infer_default_session_id(profile) == "main"


# ---------------------------------------------------------------------------
# Integration: _decide_chores actually uses the helpers
# ---------------------------------------------------------------------------

class TestDecideChoresIntegration:
    def _owner_like_profile(self) -> dict:
        """A profile similar to owner@example's actual shape (Apr 2026)."""
        return {
            "meta": {"email_count": 3140},
            "rhythm": {
                "peak_hours": [9, 14, 10],
                "quiet_hours": [3, 2, 4],
                "work_start_estimate": 9,
                "work_end_estimate": 17,
                "weekend_activity_ratio": 0.35,
                "regularity_score": 0.75,
                "detected_routines": [],
            },
            "relationships": {
                "top_correspondents": [
                    {"name": "GitHub", "domain": "github.com", "email_count": 426},
                    {"name": "Stan", "domain": "stan.store", "email_count": 242},
                    {"name": "Stripe", "domain": "stripe.com", "email_count": 127},
                ],
                "communication_style": "responsive",
            },
            "sender_tiers": {
                "service": [
                    {"domain": "stripe.com"},
                    {"domain": "polar.sh"},
                    {"domain": "examplebank.com"},
                    {"domain": "whoop.com"},
                    {"domain": "mongodb.com"},
                    {"domain": "notion.so"},
                ],
            },
            "financial": {
                "detected_services": [],
                "payment_issues": [],
            },
            "summary": {
                "communication_style": "responsive",
                "key_patterns": [],
            },
        }

    def test_subscription_chore_uses_derived_schedule(self):
        profile = self._owner_like_profile()
        chores = _decide_chores(profile, [])
        sub_chores = [c for c in chores if c["template"] == "subscription_watcher"]
        assert len(sub_chores) == 1
        # work_end_estimate=17 → hour=18, day=Friday (5)
        assert sub_chores[0]["schedule"] == "0 18 * * 5"
        # NOT the old hardcoded "0 9 * * 5"
        assert sub_chores[0]["schedule"] != "0 9 * * 5"

    def test_subscription_chore_uses_derived_threshold(self):
        profile = self._owner_like_profile()
        chores = _decide_chores(profile, [])
        sub_chores = [c for c in chores if c["template"] == "subscription_watcher"]
        # "responsive" style → 0.70 (same as old default, but derived not hardcoded)
        assert sub_chores[0]["params"]["alert_threshold"] == 0.70

    def test_subscription_chore_with_selective_style_has_tight_threshold(self):
        profile = self._owner_like_profile()
        profile["relationships"]["communication_style"] = "selective"
        profile["summary"]["communication_style"] = "selective"
        chores = _decide_chores(profile, [])
        sub_chores = [c for c in chores if c["template"] == "subscription_watcher"]
        assert sub_chores[0]["params"]["alert_threshold"] == 0.85

    def test_digest_chore_uses_derived_schedule(self):
        profile = self._owner_like_profile()
        chores = _decide_chores(profile, [])
        digest_chores = [c for c in chores if c["template"] == "weekly_matter_digest"]
        assert len(digest_chores) >= 1
        # work_end_estimate=17 → hour=19, weekend_ratio=0.35 → Sunday (>=0.3)
        assert digest_chores[0]["schedule"] == "0 19 * * 0"
        # NOT the old hardcoded "0 18 * * 0"
        assert digest_chores[0]["schedule"] != "0 18 * * 0"

    def test_digest_chore_uses_derived_min_events(self):
        profile = self._owner_like_profile()
        chores = _decide_chores(profile, [])
        digest_chores = [c for c in chores if c["template"] == "weekly_matter_digest"]
        # email_count=3140 → high volume → min_events=5
        assert digest_chores[0]["params"]["min_events_for_digest"] == 5

    def test_all_chores_use_inferred_session_id(self):
        profile = self._owner_like_profile()
        chores = _decide_chores(profile, [])
        for chore in chores:
            assert chore["params"]["session_id"] == "main"

    def test_owner_like_profile_produces_4_chores(self):
        # Regression check: owner's profile should still produce 1 sub + 3 digests
        profile = self._owner_like_profile()
        chores = _decide_chores(profile, [])
        assert len(chores) == 4
        assert sum(1 for c in chores if c["template"] == "subscription_watcher") == 1
        assert sum(1 for c in chores if c["template"] == "weekly_matter_digest") == 3

    def test_missing_profile_produces_no_regressions(self):
        # Empty profile → no chores (no signal, no action — bounds the blast radius)
        chores = _decide_chores({}, [])
        assert chores == []


# ---------------------------------------------------------------------------
# Step 2 (S2-3): opportunity → template heuristic matcher
# ---------------------------------------------------------------------------

from src.activities.assign_chores import (  # noqa: E402
    _build_opportunity_haystack,
    _chore_spec_from_opportunity,
    _decide_chores_from_opportunities,
    _extract_matter_slug_from_opportunity,
    _heuristic_match_opportunity,
)


def _opp(
    *,
    id: str,
    name: str,
    goal: str = "",
    description: str = "",
    tags: list | None = None,
) -> dict:
    """Build a minimal opportunity dict for tests."""
    return {
        "id": id,
        "name": name,
        "description": description,
        "goal": goal,
        "trigger": {"kind": "cron", "hint": "weekly"},
        "data_sources": [],
        "frequency_hint": "weekly",
        "notify_when": "",
        "tags": tags or [],
    }


class TestHeuristicMatcher:
    def test_subscription_keyword_in_goal_matches(self):
        opp = _opp(
            id="watch-stripe",
            name="Watch Stripe",
            goal="Catch failed charges and unexpected price hikes from Stripe.",
        )
        assert _heuristic_match_opportunity(opp) == "subscription_watcher"

    def test_subscription_keyword_in_name_matches(self):
        opp = _opp(id="x", name="Subscription review", goal="quarterly")
        assert _heuristic_match_opportunity(opp) == "subscription_watcher"

    def test_billing_keyword_matches(self):
        opp = _opp(id="x", name="Billing watcher", goal="catch billing errors")
        assert _heuristic_match_opportunity(opp) == "subscription_watcher"

    def test_cash_flow_keyword_matches(self):
        opp = _opp(id="x", name="Cash flow forecast", goal="weekly review")
        assert _heuristic_match_opportunity(opp) == "subscription_watcher"

    def test_digest_keyword_matches_matter_template(self):
        opp = _opp(id="x", name="Weekly Acme Consulting digest", goal="weekly summary")
        assert _heuristic_match_opportunity(opp) == "weekly_matter_digest"

    def test_matter_keyword_matches(self):
        opp = _opp(id="x", name="X", goal="track the matter activity")
        assert _heuristic_match_opportunity(opp) == "weekly_matter_digest"

    def test_unknown_topic_returns_none(self):
        opp = _opp(
            id="gym-tracker",
            name="Gym tracker",
            goal="remind me of workout routine",
        )
        assert _heuristic_match_opportunity(opp) is None

    def test_empty_opportunity_returns_none(self):
        opp = _opp(id="x", name="", goal="", description="")
        assert _heuristic_match_opportunity(opp) is None

    def test_subscription_keyword_in_tags_matches(self):
        opp = _opp(id="x", name="Misc", goal="track stuff", tags=["subscription"])
        assert _heuristic_match_opportunity(opp) == "subscription_watcher"

    def test_first_match_wins_subscription_before_digest(self):
        # If both keywords match, subscription_watcher wins because it's first
        opp = _opp(
            id="x",
            name="Subscription digest",
            goal="weekly digest of subscriptions",
        )
        assert _heuristic_match_opportunity(opp) == "subscription_watcher"


class TestExtractMatterSlug:
    def test_strips_weekly_prefix(self):
        opp = _opp(id="weekly-acme-digest", name="Weekly Acme Consulting digest")
        assert _extract_matter_slug_from_opportunity(opp) == "acme"

    def test_strips_daily_prefix(self):
        opp = _opp(id="daily-stripe-summary", name="Daily Stripe summary")
        assert _extract_matter_slug_from_opportunity(opp) == "stripe"

    def test_falls_back_to_id_when_no_pattern(self):
        opp = _opp(id="custom-thing", name="Custom thing")
        assert _extract_matter_slug_from_opportunity(opp) == "custom-thing"

    def test_unknown_when_id_missing(self):
        opp = {"name": "X"}  # no id
        assert _extract_matter_slug_from_opportunity(opp) == "unknown"


class TestChoreSpecFromOpportunity:
    def test_subscription_spec_uses_profile_financial_domains(self):
        opp = _opp(
            id="watch-subscriptions",
            name="Watch subscriptions",
            goal="catch billing failures",
        )
        profile = {
            "rhythm": {"work_end_estimate": 17},
            "financial": {
                "detected_services": [
                    {"domain": "stripe.com"},
                    {"domain": "polar.sh"},
                ],
            },
            "sender_tiers": {
                "service": [{"domain": "examplebank.com"}, {"domain": "whoop.com"}],
            },
            "relationships": {"communication_style": "responsive"},
        }
        spec = _chore_spec_from_opportunity(opp, "subscription_watcher", profile)
        assert spec["template"] == "subscription_watcher"
        assert spec["name"] == "Watch subscriptions"
        assert spec["schedule"] == "0 18 * * 5"  # work_end+1, Friday
        assert "stripe.com" in spec["params"]["matter_domains"]
        assert "polar.sh" in spec["params"]["matter_domains"]
        assert "examplebank.com" in spec["params"]["matter_domains"]
        assert spec["params"]["alert_threshold"] == 0.70  # responsive
        assert spec["params"]["session_id"] == "main"
        assert "chore" in spec["tags"]
        assert "auto-generated" in spec["tags"]

    def test_matter_digest_spec_extracts_slug(self):
        opp = _opp(id="weekly-acme-digest", name="Weekly Acme Consulting digest")
        profile = {
            "rhythm": {"work_end_estimate": 17, "weekend_activity_ratio": 0.4},
            "meta": {"email_count": 3000},
        }
        spec = _chore_spec_from_opportunity(opp, "weekly_matter_digest", profile)
        assert spec["template"] == "weekly_matter_digest"
        assert spec["params"]["matter_slug"] == "acme"
        assert spec["params"]["min_events_for_digest"] == 5  # high volume
        assert spec["schedule"] == "0 19 * * 0"  # Sunday because weekend ratio >= 0.3


class TestDecideChoresFromOpportunities:
    def test_matches_some_unmatches_others(self):
        profile = {
            "rhythm": {"work_end_estimate": 17},
            "meta": {"email_count": 3000},
            "financial": {"detected_services": []},
            "sender_tiers": {"service": []},
            "relationships": {"communication_style": "responsive"},
        }
        opportunities = [
            _opp(id="watch-stripe", name="Watch Stripe", goal="catch billing failures"),
            _opp(id="weekly-foo-digest", name="Weekly Foo digest", goal="weekly summary"),
            _opp(id="gym-tracker", name="Gym tracker", goal="workout routine"),
        ]
        matched, unmatched = _decide_chores_from_opportunities(opportunities, profile)
        assert len(matched) == 2
        assert len(unmatched) == 1
        assert matched[0]["template"] == "subscription_watcher"
        assert matched[1]["template"] == "weekly_matter_digest"
        assert unmatched[0]["opportunity"]["id"] == "gym-tracker"
        assert "no template keyword match" in unmatched[0]["reason"]

    def test_deduplicates_by_chore_name(self):
        profile = {"rhythm": {}, "meta": {}, "relationships": {}}
        # Two opportunities that both reduce to the same chore name
        opportunities = [
            _opp(id="x1", name="Watch subscriptions", goal="catch billing"),
            _opp(id="x2", name="Watch subscriptions", goal="another framing"),
        ]
        matched, unmatched = _decide_chores_from_opportunities(opportunities, profile)
        assert len(matched) == 1
        assert len(unmatched) == 1
        assert "duplicate" in unmatched[0]["reason"]

    def test_empty_opportunities_returns_empty(self):
        matched, unmatched = _decide_chores_from_opportunities([], {})
        assert matched == []
        assert unmatched == []

    def test_skips_non_dict_entries(self):
        matched, unmatched = _decide_chores_from_opportunities(
            ["not a dict", None, _opp(id="x", name="Watch billing", goal="track stuff")],
            {"rhythm": {}, "relationships": {}},
        )
        assert len(matched) == 1
        assert len(unmatched) == 0  # non-dicts are silently dropped


class TestBuildOpportunityHaystack:
    def test_concatenates_name_goal_description_tags(self):
        opp = _opp(
            id="x",
            name="Watch X",
            goal="Track Y",
            description="Description Z",
            tags=["foo", "bar"],
        )
        haystack = _build_opportunity_haystack(opp)
        assert "watch x" in haystack
        assert "track y" in haystack
        assert "description z" in haystack
        assert "foo" in haystack
        assert "bar" in haystack
        assert haystack == haystack.lower()  # all lowercased


# ---------------------------------------------------------------------------
# Step 3 (S3-3): chore spec from Opus match result
# ---------------------------------------------------------------------------

from src.activities.assign_chores import _chore_spec_from_opus_match  # noqa: E402


class TestChoreSpecFromOpusMatch:
    def test_subscription_uses_opus_provided_domains(self):
        opp = _opp(id="x", name="Watch billing")
        opus_match = {
            "opportunity_id": "x",
            "template_id": "subscription_watcher",
            "params": {
                "matter_domains": ["stripe.com", "polar.sh"],
                "alert_threshold": 0.85,
                "session_id": "main",
            },
            "reason": "fits",
        }
        profile = {"rhythm": {"work_end_estimate": 17}, "relationships": {}}
        spec = _chore_spec_from_opus_match(opus_match, opp, profile)
        assert spec["template"] == "subscription_watcher"
        assert spec["params"]["matter_domains"] == ["stripe.com", "polar.sh"]
        assert spec["params"]["alert_threshold"] == 0.85
        assert spec["params"]["session_id"] == "main"

    def test_subscription_falls_back_to_profile_when_opus_omits_domains(self):
        opp = _opp(id="x", name="Watch billing")
        opus_match = {
            "opportunity_id": "x",
            "template_id": "subscription_watcher",
            "params": {},
        }
        profile = {
            "rhythm": {"work_end_estimate": 17},
            "relationships": {},
            "financial": {"detected_services": []},
            "sender_tiers": {"service": [{"domain": "fallback.com"}]},
        }
        spec = _chore_spec_from_opus_match(opus_match, opp, profile)
        assert spec["params"]["matter_domains"] == ["fallback.com"]

    def test_subscription_clamps_invalid_threshold(self):
        opp = _opp(id="x", name="Watch billing")
        opus_match = {
            "opportunity_id": "x",
            "template_id": "subscription_watcher",
            "params": {"alert_threshold": "not a number"},
        }
        profile = {"rhythm": {}, "relationships": {"communication_style": "responsive"}}
        spec = _chore_spec_from_opus_match(opus_match, opp, profile)
        assert spec["params"]["alert_threshold"] == 0.70

    def test_subscription_rejects_out_of_range_threshold(self):
        opp = _opp(id="x", name="Watch billing")
        opus_match = {
            "opportunity_id": "x",
            "template_id": "subscription_watcher",
            "params": {"alert_threshold": 1.5},
        }
        profile = {"rhythm": {}, "relationships": {}}
        spec = _chore_spec_from_opus_match(opus_match, opp, profile)
        assert spec["params"]["alert_threshold"] == 0.70

    def test_matter_digest_uses_opus_slug(self):
        opp = _opp(id="weekly-foo-digest", name="Weekly foo digest")
        opus_match = {
            "opportunity_id": "weekly-foo-digest",
            "template_id": "weekly_matter_digest",
            "params": {
                "matter_slug": "acme",
                "min_events_for_digest": 7,
                "session_id": "telegram",
            },
        }
        profile = {"rhythm": {"work_end_estimate": 17}, "meta": {"email_count": 3000}}
        spec = _chore_spec_from_opus_match(opus_match, opp, profile)
        assert spec["params"]["matter_slug"] == "acme"
        assert spec["params"]["min_events_for_digest"] == 7
        assert spec["params"]["session_id"] == "telegram"

    def test_matter_digest_falls_back_to_extracted_slug(self):
        opp = _opp(id="weekly-foo-digest", name="Weekly foo digest")
        opus_match = {
            "opportunity_id": "weekly-foo-digest",
            "template_id": "weekly_matter_digest",
            "params": {},
        }
        profile = {"rhythm": {}, "meta": {}}
        spec = _chore_spec_from_opus_match(opus_match, opp, profile)
        assert spec["params"]["matter_slug"] == "foo"

    def test_tags_always_include_chore_and_auto_generated(self):
        opp = _opp(id="x", name="X", tags=["custom"])
        opus_match = {
            "opportunity_id": "x",
            "template_id": "subscription_watcher",
            "params": {},
        }
        profile = {"rhythm": {}, "relationships": {}}
        spec = _chore_spec_from_opus_match(opus_match, opp, profile)
        assert "chore" in spec["tags"]
        assert "auto-generated" in spec["tags"]
        assert "custom" in spec["tags"]
