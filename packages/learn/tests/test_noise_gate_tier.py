"""#453 — the pre-extraction noise gate obeys the promotion ladder.

The gate decides whether an inbound email becomes a signal at all. Before
this, it consulted no tier and wrote no audit row, so an instinct rendering
as `Asking` on /instincts could permanently silence a sender with no trace.
On home, one such instinct carried the principal's own client domain.

Two properties are pinned here:
  1. only `Acting` may suppress; below that the match is recorded and the
     email survives (fail toward VISIBILITY — the opposite of the router,
     because a false positive here loses mail);
  2. domain anchors match domains, not substrings.
"""

import pytest

from src.activities.noise_patterns import (
    _domain_matches,
    event_matches_noise_instinct,
)
from src.matching.tiers import AUTONOMOUS_TIER, TIER_ASKING, instinct_tier


def _inst(tier, domains=(), keywords=()):
    return {
        "path": "instinct/test-noise.md",
        "sender_domains": list(domains),
        "subject_keywords": list(keywords),
        "tier": tier,
    }


def _gmail_event(sender="someone@neoterragroup.com", subject="Quarterly plan"):
    return {"source_type": "gmail", "from": sender, "subject": subject}


class TestTierGatesSuppression:
    def test_acting_instinct_suppresses(self):
        m = event_matches_noise_instinct(
            _gmail_event(), [_inst("Acting", domains=["neoterragroup.com"])]
        )
        assert m is not None
        assert m["suppress"] is True
        assert m["tier"] == "Acting"

    @pytest.mark.parametrize("tier", ["Asking", "Confirming"])
    def test_sub_acting_matches_but_does_not_suppress(self, tier):
        """The match is still REPORTED — so it can be audited — but the
        caller must not drop the event."""
        m = event_matches_noise_instinct(
            _gmail_event(), [_inst(tier, domains=["neoterragroup.com"])]
        )
        assert m is not None, "match must stay visible for the audit row"
        assert m["suppress"] is False
        assert m["tier"] == tier

    def test_missing_tier_fails_closed_to_asking(self):
        inst = _inst(None, domains=["neoterragroup.com"])
        inst.pop("tier")
        m = event_matches_noise_instinct(_gmail_event(), [inst])
        assert m["suppress"] is False
        assert m["tier"] == TIER_ASKING

    def test_keyword_match_carries_tier_too(self):
        m = event_matches_noise_instinct(
            _gmail_event(subject="Railway will delete your volumes tomorrow"),
            [_inst("Asking", keywords=["tomorrow"])],
        )
        assert m["suppress"] is False
        assert m["matched_keyword"] == "tomorrow"

    def test_the_live_close_stale_shape_cannot_suppress(self):
        """Replay of the instinct that carries Sir's client domain."""
        live = _inst(
            "Confirming",
            domains=[
                "airbnb.com", "google.com", "googleplay.com", "gettransfer.com",
                "neoterragroup.com", "railway.app", "substack.com", "whoop.com",
            ],
            keywords=["tomorrow", "duplicate", "older", "will delete"],
        )
        m = event_matches_noise_instinct(_gmail_event(), [live])
        assert m["suppress"] is False, "client mail must not be dropped"


class TestDomainAnchoring:
    @pytest.mark.parametrize(
        "value,rule,expected",
        [
            ("x@google.com", "google.com", True),
            ("x@mail.google.com", "google.com", True),
            ("google.com", "google.com", True),
            # The bug: an unanchored substring matched these.
            ("x@notgoogle.community", "google.com", False),
            ("x@google.com.phish.example", "google.com", False),
            ("x@evilgoogle.com", "google.com", False),
            # Explicit globs keep working (hand-authored billing rules).
            ("x@invoices.szamlazz.hu", "*.szamlazz.hu", True),
            ("x@szamlazz.hu", "*.szamlazz.hu", False),
            ("", "google.com", False),
            ("x@google.com", "", False),
        ],
    )
    def test_domain_matching_is_anchored(self, value, rule, expected):
        assert _domain_matches(value, rule) is expected

    def test_unanchored_substring_no_longer_suppresses(self):
        m = event_matches_noise_instinct(
            _gmail_event(sender="hello@notgoogle.community"),
            [_inst("Acting", domains=["google.com"])],
        )
        assert m is None


class TestSharedTierReader:
    """The gate and the router must read the ladder identically (#446/#453)."""

    def test_signal_actions_delegates_to_the_shared_reader(self):
        from src.activities.signal_actions import _instinct_tier

        for tier in ("Asking", "Confirming", "Acting"):
            rec = {"frontmatter": {"tier": tier}}
            assert _instinct_tier(rec) == instinct_tier(rec) == tier

    def test_both_fail_closed_identically(self):
        from src.activities.signal_actions import _instinct_tier

        for bad in ({}, {"frontmatter": {}}, {"frontmatter": {"tier": 1}},
                    {"frontmatter": {"tier": "Autonomous"}}):
            assert _instinct_tier(bad) == instinct_tier(bad) == TIER_ASKING

    def test_autonomous_tier_is_acting(self):
        assert AUTONOMOUS_TIER == "Acting"
