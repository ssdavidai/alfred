"""Tests for discretion thresholds."""

import pytest

from src.matching.discretion import (
    get_discretion_threshold,
    should_route_autonomously,
    format_discretion_level,
)


class TestGetDiscretionThreshold:
    def test_very_few_observations(self):
        assert get_discretion_threshold(0) == 0.95
        assert get_discretion_threshold(1) == 0.95
        assert get_discretion_threshold(4) == 0.95

    def test_few_observations(self):
        assert get_discretion_threshold(5) == 0.90
        assert get_discretion_threshold(9) == 0.90

    def test_moderate_observations(self):
        assert get_discretion_threshold(10) == 0.85
        assert get_discretion_threshold(19) == 0.85

    def test_many_observations(self):
        assert get_discretion_threshold(20) == 0.80
        assert get_discretion_threshold(49) == 0.80

    def test_very_many_observations(self):
        assert get_discretion_threshold(50) == 0.75
        assert get_discretion_threshold(100) == 0.75
        assert get_discretion_threshold(1000) == 0.75


class TestShouldRouteAutonomously:
    def test_above_threshold_routes(self):
        instinct = {"discretion_threshold": 0.85, "observation_count": 10}
        assert should_route_autonomously(0.90, instinct) is True

    def test_at_threshold_routes(self):
        instinct = {"discretion_threshold": 0.85, "observation_count": 10}
        assert should_route_autonomously(0.85, instinct) is True

    def test_below_threshold_escalates(self):
        instinct = {"discretion_threshold": 0.85, "observation_count": 10}
        assert should_route_autonomously(0.80, instinct) is False

    def test_uses_observation_count_when_no_threshold(self):
        instinct = {"observation_count": 3}
        # 3 observations → threshold 0.95
        assert should_route_autonomously(0.94, instinct) is False
        assert should_route_autonomously(0.96, instinct) is True

    def test_zero_observations_very_cautious(self):
        instinct = {"observation_count": 0}
        assert should_route_autonomously(0.94, instinct) is False

    def test_50_plus_observations_routine(self):
        instinct = {"observation_count": 60}
        assert should_route_autonomously(0.76, instinct) is True


class TestFormatDiscretionLevel:
    def test_very_cautious(self):
        level = format_discretion_level(2)
        assert "ask" in level.lower() or "cautious" in level.lower()

    def test_routine(self):
        level = format_discretion_level(100)
        assert "routine" in level.lower() or "automatic" in level.lower()

    def test_returns_string(self):
        for count in [0, 5, 10, 20, 50]:
            assert isinstance(format_discretion_level(count), str)
