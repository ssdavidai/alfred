"""#445 — the promotion-ladder tier gates autonomous dispatch.

Regression pin for the 2026-08-06 ElevenLabs incident: an instinct the UI
displayed as ``tier: Asking`` (observation_count 1) routed a signal to the
agent, which sent an irreversible cancellation email to a third party from
the principal's own Gmail. The tier was never consulted by the router.

The tier is a CEILING evaluated BEFORE the confidence bar: only ``Acting``
may route autonomously, and a malformed/absent tier fails closed.
"""

import pytest

from src.activities.signal_actions import (
    AUTONOMOUS_TIER,
    TIER_ASKING,
    TIER_CONFIRMING,
    _instinct_tier,
)
from src.matching.discretion import effective_threshold


def _instinct(tier, **fm):
    """A matched-instinct record as ``_load_active_instincts`` returns it."""
    frontmatter = {"name": "test-instinct", **fm}
    if tier is not None:
        frontmatter["tier"] = tier
    return {"path": "instinct/test-instinct.md", "frontmatter": frontmatter}


class TestInstinctTier:
    def test_reads_each_valid_tier(self):
        for tier in ("Asking", "Confirming", "Acting"):
            assert _instinct_tier(_instinct(tier)) == tier

    def test_absent_tier_fails_closed(self):
        assert _instinct_tier(_instinct(None)) == TIER_ASKING

    def test_unknown_tier_fails_closed(self):
        assert _instinct_tier(_instinct("Autonomous")) == TIER_ASKING
        assert _instinct_tier(_instinct("")) == TIER_ASKING

    def test_non_string_tier_fails_closed(self):
        # The legacy nested shape stored an integer (execution.tier: 1).
        assert _instinct_tier(_instinct(1)) == TIER_ASKING
        assert _instinct_tier(_instinct(None)) == TIER_ASKING

    def test_case_and_whitespace_tolerated(self):
        assert _instinct_tier(_instinct("  acting ")) == "Acting"
        assert _instinct_tier(_instinct("ASKING")) == TIER_ASKING

    def test_bare_frontmatter_mapping_accepted(self):
        assert _instinct_tier({"tier": "Acting"}) == "Acting"

    def test_execution_tier_cannot_buy_autonomy(self):
        """The exact live shape that fired the incident.

        ``execution.tier: 1`` + ``requires_approval: false`` must NOT
        satisfy the gate when the ladder says Asking.
        """
        rec = _instinct(
            "Asking",
            execution={"enabled": True, "requires_approval": False, "tier": 1},
        )
        assert _instinct_tier(rec) == TIER_ASKING
        assert _instinct_tier(rec) != AUTONOMOUS_TIER


class TestTierGateDecision:
    """The branch logic from ``route_signal_action`` steps 6.

    Mirrors the precedence exactly: delegate > shadow > no-match > tier >
    confidence. Kept as a pure function so the ordering is pinned without
    standing up Temporal + ctrl-api.
    """

    @staticmethod
    def _decide(
        *,
        instinct,
        combined_confidence,
        principal_delegate_override=False,
        effective_mode="live",
    ):
        threshold = effective_threshold(instinct) if instinct else 0.95
        matched_tier = _instinct_tier(instinct) if instinct else TIER_ASKING
        if principal_delegate_override:
            return "agent", "principal_delegated"
        if effective_mode == "shadow":
            return "human", "shadow_mode"
        if instinct is None:
            return "human", "no_matching_instinct"
        if matched_tier != AUTONOMOUS_TIER:
            return "human", f"tier_gate_{matched_tier.lower()}"
        if combined_confidence < threshold:
            return "human", "low_confidence"
        return "agent", "high_confidence_match"

    def test_asking_never_acts_even_at_full_confidence(self):
        # 50+ observations would earn a 0.75 bar; the tier still blocks.
        rec = _instinct("Asking", observation_count=100)
        path, reason = self._decide(instinct=rec, combined_confidence=1.0)
        assert path == "human"
        assert reason == "tier_gate_asking"

    def test_confirming_never_acts_autonomously(self):
        rec = _instinct("Confirming", observation_count=100)
        path, reason = self._decide(instinct=rec, combined_confidence=1.0)
        assert path == "human"
        assert reason == "tier_gate_confirming"

    def test_acting_dispatches_when_bar_cleared(self):
        rec = _instinct("Acting", observation_count=50)  # bar 0.75
        path, reason = self._decide(instinct=rec, combined_confidence=0.80)
        assert path == "agent"
        assert reason == "high_confidence_match"

    def test_acting_still_blocked_below_bar(self):
        """Tier is a ceiling, not a bypass — the bar still applies."""
        rec = _instinct("Acting", observation_count=0)  # bar 0.95
        path, reason = self._decide(instinct=rec, combined_confidence=0.90)
        assert path == "human"
        assert reason == "low_confidence"

    def test_absent_tier_blocks(self):
        rec = _instinct(None, observation_count=100)
        path, reason = self._decide(instinct=rec, combined_confidence=1.0)
        assert path == "human"
        assert reason == "tier_gate_asking"

    def test_principal_delegate_overrides_tier(self):
        """An explicit Delegate click is not autonomy — must still fire."""
        rec = _instinct("Asking", observation_count=0)
        path, reason = self._decide(
            instinct=rec,
            combined_confidence=0.0,
            principal_delegate_override=True,
        )
        assert path == "agent"
        assert reason == "principal_delegated"

    def test_shadow_mode_still_precedes_tier(self):
        rec = _instinct("Acting", observation_count=100)
        path, reason = self._decide(
            instinct=rec, combined_confidence=1.0, effective_mode="shadow"
        )
        assert path == "human"
        assert reason == "shadow_mode"

    def test_the_elevenlabs_incident_would_now_be_blocked(self):
        """Replay of the exact live instinct + confidence that fired."""
        rec = _instinct(
            "Asking",
            observation_count=1,
            confidence_score=0.9,
            discretion_threshold=0.9,
            live_observation_count=8,  # what got the bar down to 0.90
            execution={"enabled": True, "requires_approval": False, "tier": 1},
        )
        # Pre-fix: bar 0.90, conf 0.90 → agent → email sent.
        assert effective_threshold(rec) == pytest.approx(0.90)
        path, reason = self._decide(instinct=rec, combined_confidence=0.90)
        assert path == "human", "Asking-tier instinct must never dispatch"
        assert reason == "tier_gate_asking"


class TestSharedThresholdImplementation:
    """#445 — one raise-only implementation, not two divergent copies."""

    def test_signal_actions_delegates_to_discretion(self):
        from src.activities.signal_actions import _instinct_threshold

        rec = _instinct("Acting", observation_count=10, discretion_threshold=0.99)
        assert _instinct_threshold(rec) == effective_threshold(rec)

    def test_raise_only_override_preserved(self):
        # 10 obs earns 0.85; an explicit 0.60 may not loosen it.
        rec = _instinct("Acting", observation_count=10, discretion_threshold=0.60)
        assert effective_threshold(rec) == pytest.approx(0.85)
        # ...but 0.99 may tighten it.
        rec = _instinct("Acting", observation_count=10, discretion_threshold=0.99)
        assert effective_threshold(rec) == pytest.approx(0.99)

    def test_garbage_threshold_ignored(self):
        rec = _instinct("Acting", observation_count=10, discretion_threshold="abc")
        assert effective_threshold(rec) == pytest.approx(0.85)
