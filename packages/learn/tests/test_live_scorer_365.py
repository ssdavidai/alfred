"""Regression tests for #365 — the live instinct scorer.

The old scorer was token-set Jaccard between the FULL signal text and the
instinct corpus. Real signals carry whole email bodies, so the union
denominator dwarfed the overlap: live evidence on home showed
``matched_instinct`` NULL on 1002/1002 signals all-time with a maximum
recorded score of 0.1951 against MATCH_FLOOR=0.30. The investigator
reproduced 0.074 as the best achievable score against all 36 live
instincts. These tests use a realistic long-body signal — under the old
Jaccard they scored ~0.05 and FAILED (verified red before the fix).
"""
from __future__ import annotations

import json

from src.activities.signal_actions import (
    MATCH_FLOOR,
    _score_signal_against_instinct,
)

# A live-shaped signal: subject + a real-length email body, the shape the
# router actually feeds the scorer. Under Jaccard, this body is what
# drove every score to ~zero.
CI_SIGNAL_TEXT = """
Subject: [ssdavidai/alfred] Run failed: build-learn - main (b3bc00de)
From: GitHub <notifications@github.com>

The build-learn workflow run failed for commit b3bc00de pushed by
ssdavidai. Annotations: 1 failure. Job build-learn failed after 22
minutes of execution on ubuntu-latest. View workflow run at
https://github.com/ssdavidai/alfred/actions/runs/12345678901.
You are receiving this because you are subscribed to this repository.
To unsubscribe from these emails, adjust your notification settings at
https://github.com/settings/notifications. GitHub, Inc. is located at
88 Colin P Kelly Jr St, San Francisco, CA 94107.
"""

SUPPRESS_CI_INSTINCT = {
    "frontmatter": {
        "description": "Suppress routine CI notification noise from the Desk",
        # Production shape: JSON string inside frontmatter (see
        # _parse_input_patterns docstring).
        "input_patterns": json.dumps(
            {
                "sender_domains": ["github.com"],
                "subject_keywords": ["run failed", "build"],
            }
        ),
    }
}

BILLING_INSTINCT = {
    "frontmatter": {
        "description": "Routine billing receipts get filed, not surfaced",
        "input_patterns": {
            "sender_domains": ["stripe.com"],
            "subject_keywords": ["receipt", "payment succeeded"],
        },
    }
}


class TestRealisticSignalClearsFloor:
    def test_ci_signal_matches_suppress_ci(self):
        """THE live failure case: long-body CI email vs the suppress-ci
        instinct. Old Jaccard: ~0.05 (red). Pattern coverage: 3/3."""
        score = _score_signal_against_instinct(CI_SIGNAL_TEXT, SUPPRESS_CI_INSTINCT)
        assert score >= MATCH_FLOOR, f"score={score} below floor {MATCH_FLOOR}"
        assert score == 1.0  # github.com + "run failed" + "build" all present

    def test_long_body_does_not_dilute(self):
        """Padding the body 10x must not change the score — the exact
        Jaccard failure mode (denominator growth)."""
        padded = CI_SIGNAL_TEXT + ("lorem ipsum filler words " * 400)
        assert _score_signal_against_instinct(
            padded, SUPPRESS_CI_INSTINCT
        ) == _score_signal_against_instinct(CI_SIGNAL_TEXT, SUPPRESS_CI_INSTINCT)


class TestNoOverMatch:
    def test_unrelated_instinct_scores_below_floor(self):
        score = _score_signal_against_instinct(CI_SIGNAL_TEXT, BILLING_INSTINCT)
        assert score < MATCH_FLOOR, f"unrelated instinct scored {score}"

    def test_partial_coverage_is_fractional(self):
        """One of two patterns present → 0.5, not all-or-nothing."""
        inst = {
            "frontmatter": {
                "input_patterns": {
                    "sender_domains": ["github.com"],
                    "subject_keywords": ["deployment protection rule"],
                }
            }
        }
        score = _score_signal_against_instinct(CI_SIGNAL_TEXT, inst)
        assert score == 0.5


class TestConservativeEdges:
    def test_no_patterns_scores_zero(self):
        """Description-only instincts never anchor a match — prose is not
        an anchoring signal; the HUMAN path stays the catch-all."""
        inst = {"frontmatter": {"description": "GitHub build run failed notification"}}
        assert _score_signal_against_instinct(CI_SIGNAL_TEXT, inst) == 0.0

    def test_empty_signal_scores_zero(self):
        assert _score_signal_against_instinct("", SUPPRESS_CI_INSTINCT) == 0.0

    def test_paraphrase_matches_via_token_subset(self):
        """'build failed' tokens both appear even when the phrase isn't
        verbatim — branch (b)."""
        inst = {"frontmatter": {"input_patterns": {"subject_keywords": ["failed build"]}}}
        assert _score_signal_against_instinct(CI_SIGNAL_TEXT, inst) == 1.0

    def test_flat_dict_instinct_without_frontmatter_key(self):
        """Some callers pass the frontmatter dict directly."""
        inst = {"input_patterns": {"sender_domains": ["github.com"]}}
        assert _score_signal_against_instinct(CI_SIGNAL_TEXT, inst) == 1.0
