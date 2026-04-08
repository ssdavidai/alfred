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
    def _david_like_profile(self) -> dict:
        """A profile similar to david@szabostuban's actual shape (Apr 2026)."""
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
                    {"domain": "mercury.com"},
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
        profile = self._david_like_profile()
        chores = _decide_chores(profile, [])
        sub_chores = [c for c in chores if c["template"] == "subscription_watcher"]
        assert len(sub_chores) == 1
        # work_end_estimate=17 → hour=18, day=Friday (5)
        assert sub_chores[0]["schedule"] == "0 18 * * 5"
        # NOT the old hardcoded "0 9 * * 5"
        assert sub_chores[0]["schedule"] != "0 9 * * 5"

    def test_subscription_chore_uses_derived_threshold(self):
        profile = self._david_like_profile()
        chores = _decide_chores(profile, [])
        sub_chores = [c for c in chores if c["template"] == "subscription_watcher"]
        # "responsive" style → 0.70 (same as old default, but derived not hardcoded)
        assert sub_chores[0]["params"]["alert_threshold"] == 0.70

    def test_subscription_chore_with_selective_style_has_tight_threshold(self):
        profile = self._david_like_profile()
        profile["relationships"]["communication_style"] = "selective"
        profile["summary"]["communication_style"] = "selective"
        chores = _decide_chores(profile, [])
        sub_chores = [c for c in chores if c["template"] == "subscription_watcher"]
        assert sub_chores[0]["params"]["alert_threshold"] == 0.85

    def test_digest_chore_uses_derived_schedule(self):
        profile = self._david_like_profile()
        chores = _decide_chores(profile, [])
        digest_chores = [c for c in chores if c["template"] == "weekly_matter_digest"]
        assert len(digest_chores) >= 1
        # work_end_estimate=17 → hour=19, weekend_ratio=0.35 → Sunday (>=0.3)
        assert digest_chores[0]["schedule"] == "0 19 * * 0"
        # NOT the old hardcoded "0 18 * * 0"
        assert digest_chores[0]["schedule"] != "0 18 * * 0"

    def test_digest_chore_uses_derived_min_events(self):
        profile = self._david_like_profile()
        chores = _decide_chores(profile, [])
        digest_chores = [c for c in chores if c["template"] == "weekly_matter_digest"]
        # email_count=3140 → high volume → min_events=5
        assert digest_chores[0]["params"]["min_events_for_digest"] == 5

    def test_all_chores_use_inferred_session_id(self):
        profile = self._david_like_profile()
        chores = _decide_chores(profile, [])
        for chore in chores:
            assert chore["params"]["session_id"] == "main"

    def test_david_like_profile_produces_4_chores(self):
        # Regression check: david's profile should still produce 1 sub + 3 digests
        profile = self._david_like_profile()
        chores = _decide_chores(profile, [])
        assert len(chores) == 4
        assert sum(1 for c in chores if c["template"] == "subscription_watcher") == 1
        assert sum(1 for c in chores if c["template"] == "weekly_matter_digest") == 3

    def test_missing_profile_produces_no_regressions(self):
        # Empty profile → no chores (no signal, no action — bounds the blast radius)
        chores = _decide_chores({}, [])
        assert chores == []
