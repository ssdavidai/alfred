"""SM-D-W8 — propose function unit tests for the DecayWatcher retrofit.

Covers the deterministic ``decay_watcher.adjust`` propose function +
the patched-gate plumbing inside the workflow's matter pass. The
legacy ``watch_decay`` activity (needs_attention freshness) is
untouched — its existing tests continue to assert that behaviour.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from src.activities.decay_watcher import (
    ACTIVITY_BAND_HIGH_MIN,
    ACTIVITY_BAND_NORMAL_MIN,
    _band_for_activity_count,
    propose_decay_watcher_adjust,
)
from src.activities.state_mutator import ObservedWindow, ProposedMutation
from src.workflows.decay_watcher import DECAY_WATCHER_STATE_MUTATOR_PATCH


def _window(*, signals: int = 0, decisions: int = 0, other: int = 0) -> ObservedWindow:
    now = datetime.now(timezone.utc)
    return ObservedWindow(
        start=now - timedelta(days=14),
        end=now,
        signal_paths=[f"signal/s-{i}.md" for i in range(signals)],
        decision_paths=[f"decision/d-{i}.md" for i in range(decisions)],
        other_refs=[f"event/e-{i}.md" for i in range(other)],
    )


class TestBandForActivityCount:
    """Deterministic band mapping is the load-bearing classifier."""

    def test_zero_activity_is_low(self) -> None:
        assert _band_for_activity_count(0) == "low"

    def test_below_normal_min_is_low(self) -> None:
        assert _band_for_activity_count(ACTIVITY_BAND_NORMAL_MIN - 1) == "low"

    def test_normal_min_is_normal(self) -> None:
        assert _band_for_activity_count(ACTIVITY_BAND_NORMAL_MIN) == "normal"

    def test_below_high_min_is_normal(self) -> None:
        assert _band_for_activity_count(ACTIVITY_BAND_HIGH_MIN - 1) == "normal"

    def test_high_min_is_high(self) -> None:
        assert _band_for_activity_count(ACTIVITY_BAND_HIGH_MIN) == "high"

    def test_well_above_high_min_is_high(self) -> None:
        assert _band_for_activity_count(ACTIVITY_BAND_HIGH_MIN + 50) == "high"


class TestProposeDecayWatcherAdjust:
    """The propose function returns ProposedMutation only on band change."""

    def test_quiet_matter_moves_to_low(self) -> None:
        """An ``active`` matter that has gone quiet → surface_class=low."""

        async def _go() -> ProposedMutation | None:
            target = {
                "frontmatter": {"surface_class": "normal"},
                "body": "",
                "as_of": "2026-05-01T00:00:00Z",
            }
            return await propose_decay_watcher_adjust(
                target=target,
                observed=_window(signals=0, decisions=0, other=0),
                args={"lookback_days": 14},
            )

        result = asyncio.run(_go())
        assert isinstance(result, ProposedMutation)
        assert result.fields == {"surface_class": "low"}
        # Deterministic, full confidence.
        assert result.confidence == 1.0
        # Reason mentions prior + new bands for /decisions readability.
        assert "normal" in result.reason and "low" in result.reason

    def test_busy_matter_moves_to_high(self) -> None:
        """A matter receiving 5+ signals/decisions/events → high."""

        async def _go() -> ProposedMutation | None:
            target = {
                "frontmatter": {"surface_class": "normal"},
                "body": "",
            }
            return await propose_decay_watcher_adjust(
                target=target,
                observed=_window(signals=3, decisions=1, other=2),
                args={"lookback_days": 14},
            )

        result = asyncio.run(_go())
        assert isinstance(result, ProposedMutation)
        assert result.fields == {"surface_class": "high"}

    def test_already_in_target_band_returns_none(self) -> None:
        """No-op write: matter already on the band the activity count picks."""

        async def _go() -> ProposedMutation | None:
            target = {"frontmatter": {"surface_class": "high"}}
            return await propose_decay_watcher_adjust(
                target=target,
                observed=_window(signals=ACTIVITY_BAND_HIGH_MIN, decisions=0, other=0),
                args={},
            )

        assert asyncio.run(_go()) is None

    def test_missing_surface_class_defaults_compared_to_desired(self) -> None:
        """Matter without ``surface_class`` set yet — desired=normal lands
        because current (None) != desired ("normal")."""

        async def _go() -> ProposedMutation | None:
            target = {"frontmatter": {}}
            return await propose_decay_watcher_adjust(
                target=target,
                observed=_window(signals=1),
                args={},
            )

        result = asyncio.run(_go())
        assert isinstance(result, ProposedMutation)
        assert result.fields == {"surface_class": "normal"}

    def test_case_insensitive_current_band(self) -> None:
        """A stray writer that wrote ``HIGH`` (mixed case) is still recognised."""

        async def _go() -> ProposedMutation | None:
            target = {"frontmatter": {"surface_class": "HIGH"}}
            return await propose_decay_watcher_adjust(
                target=target,
                observed=_window(signals=ACTIVITY_BAND_HIGH_MIN, decisions=2),
                args={},
            )

        # Current and desired both resolve to "high" — no mutation.
        assert asyncio.run(_go()) is None


class TestPatchedGateConstant:
    """The patched-gate name is part of the in-flight history compat
    contract — accidental rename breaks replay determinism. Guard the
    constant so a refactor that re-spells it triggers this test."""

    def test_patched_gate_name_is_stable(self) -> None:
        assert DECAY_WATCHER_STATE_MUTATOR_PATCH == "decay_watcher_state_mutator_v1"
