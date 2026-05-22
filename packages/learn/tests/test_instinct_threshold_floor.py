"""C-B6: the observation-earned bar is a FLOOR in the runtime gate.

``signal_actions._instinct_threshold`` returns the *effective* discretion
bar a matched instinct must clear to auto-route. Per C-B6 an explicit
``discretion_threshold`` (seeded day-zero by onboarding) may only RAISE
the bar (more cautious / lower trust), never authorize autonomy below
what the live observation count has earned. A fresh instinct seeded with
a low threshold but zero observations must still sit at the Asking bar
(0.95) and must not auto-act.
"""
from __future__ import annotations

import src.activities.signal_actions as sa


class TestInstinctThresholdFloor:
    def test_seeded_low_threshold_at_zero_obs_clamps_to_asking(self):
        # Seeded 0.80 threshold, ZERO real observations → effective bar
        # is the earned floor (0.95 — Asking), NOT the seeded 0.80.
        instinct = {
            "frontmatter": {
                "discretion_threshold": 0.80,
                "observation_count": 0,
            }
        }
        assert sa._instinct_threshold(instinct) == 0.95

    def test_explicit_threshold_raise_only(self):
        # 60 obs earns a 0.75 bar; an explicit 0.90 operator override
        # must raise the effective bar, not be ignored.
        instinct = {
            "frontmatter": {
                "discretion_threshold": 0.90,
                "observation_count": 60,
            }
        }
        assert sa._instinct_threshold(instinct) == 0.90

    def test_earned_instinct_keeps_low_bar(self):
        # >=20 decision-sourced observations earns 0.80 (Acting); with no
        # premature seed the bar reflects the earned autonomy.
        instinct = {"frontmatter": {"observation_count": 25}}
        assert sa._instinct_threshold(instinct) == 0.80

    def test_live_count_preferred_over_snapshot(self):
        # Live (ctrl-api-enriched) count is decision-sourced truth and
        # overrides a stale/fake stored snapshot.
        instinct = {
            "frontmatter": {
                "live_observation_count": 0,
                "observation_count": 99,
            }
        }
        assert sa._instinct_threshold(instinct) == 0.95

    def test_no_frontmatter_wrapper(self):
        # Flat record (no nested frontmatter) is handled too.
        assert sa._instinct_threshold({"observation_count": 0}) == 0.95
