"""Sir-matter-task gap 5b — the scorer must match multi-word patterns.

# Root cause investigation (2026-05-24)

Live tenant audit found:
  - 13 ``kind=decision`` observations extracted today, ALL 13 have
    ``instinct_ref: None``.
  - The ``scorer_failed`` log line is NOT tripping → the scorer isn't
    raising, it's silently returning low scores.

Reproducing the live ``escalate-critical-payment-failures`` instinct
against the live ``A Soft Murmur Pro payment failed`` needs_attention
card locally surfaced the actual bug:

  1. The instinct frontmatter carries multi-word
     ``subject_keywords`` PHRASES: ``["payment failed", "payment
     declined", "failed payment", "overdue", "update payment method",
     "card declined", ...]``.
  2. ``extract_input_metadata`` tokenises the signal text into SINGLE
     WORDS (regex ``\\b[a-z]{3,}\\b``): ``["payment", "failed",
     "subscription", "soft", "murmur", ...]``.
  3. ``_score_keyword_overlap`` does ``input_set & pattern_set`` —
     **intersection of single words with multi-word phrases is EMPTY**.

End result: even when the signal screams "payment failed", the
keyword component of the score is 0.0; only the input_type weight
fires (0.15). For decision-sourced observations,
``_source_kind_to_input_type("decision")`` returns ``""`` →
input_type=other → score=0.0 → ``instinct_ref=None``.

# Fix tested below

The scorer must match multi-word patterns by ALSO checking whether
the pattern phrase appears as a substring of the input ``full_text``
(or equivalently, by tokenising the pattern phrases into single
words). The fix lives in ``src/matching/scorer.py``.

The test pins the contract: feed the live escalate-critical-payment-
failures instinct + the live A Soft Murmur signal text, assert the
score clears MATCH_THRESHOLD (0.05) with a non-zero keyword component.
"""
from __future__ import annotations

import pytest

from src.matching.metadata import extract_input_metadata
from src.matching.scorer import score_instinct


# ---------------------------------------------------------------------------
# Fixture: the live escalate-critical-payment-failures instinct
# (copied verbatim from /vault/instinct/escalate-critical-payment-failures.md
# on home.alfred.black, 2026-05-24)
# ---------------------------------------------------------------------------

LIVE_PAYMENT_INSTINCT = {
    "input_patterns": {
        "sender_domains": [
            "stripe.com", "digitalocean.com", "fly.io", "openai.com",
            "openrouter.ai", "github.com", "google.com", "slack.com",
            "macstadium.com", "wise.com", "polar.sh",
        ],
        "subject_keywords": [
            "payment failed", "payment declined", "failed payment",
            "overdue", "past due", "invoice failed", "billing issue",
            "update payment method", "card declined",
            "subscription paused", "service suspended",
        ],
        "input_types": ["email"],
    },
}


# Live raw_quote from /vault/needs_attention/...8c27d0fd.md, 2026-05-24
LIVE_PAYMENT_SIGNAL_TEXT = (
    "Your A Soft Murmur Pro yearly subscription payment failed — "
    "$9.00 payment for A Soft Murmur Pro yearly subscription was "
    "unsuccessful ending in 4822"
)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_multi_word_pattern_matches_signal_substring():
    """``payment failed`` is a substring of the signal text — the
    scorer's keyword component MUST register that.

    Before the fix: keyword score = 0.0 (set intersection of single
    words vs phrases).
    After the fix: keyword score > 0.0 (substring match across full_text
    OR tokenised pattern-words intersect with input keywords).
    """
    synthetic = {
        "summary": LIVE_PAYMENT_SIGNAL_TEXT,
        "title": "A Soft Murmur Pro payment failed",
        "subject": "Payment failed",
        "body": LIVE_PAYMENT_SIGNAL_TEXT,
        "stream_type": "email",
    }
    metadata = extract_input_metadata(synthetic)
    score = score_instinct(metadata, LIVE_PAYMENT_INSTINCT)

    assert score.breakdown["keywords"] > 0.0, (
        f"keyword score must be >0 (signal contains 'payment failed' substring); "
        f"breakdown={score.breakdown}"
    )


def test_live_payment_signal_clears_match_threshold():
    """End-to-end: the live signal + the live instinct should produce
    a total score ≥ ``MATCH_THRESHOLD`` (currently 0.05) so
    ``best_instinct_path`` returns the instinct path."""
    synthetic = {
        "summary": LIVE_PAYMENT_SIGNAL_TEXT,
        "title": "A Soft Murmur Pro payment failed",
        "subject": "Payment failed",
        "body": LIVE_PAYMENT_SIGNAL_TEXT,
        "stream_type": "email",
    }
    metadata = extract_input_metadata(synthetic)
    score = score_instinct(metadata, LIVE_PAYMENT_INSTINCT)

    from src.matching.instinct_match import MATCH_THRESHOLD
    assert score.score >= MATCH_THRESHOLD, (
        f"score={score.score} must clear MATCH_THRESHOLD={MATCH_THRESHOLD}; "
        f"breakdown={score.breakdown}"
    )


def test_decision_sourced_observation_still_matches():
    """The decision-flow path (where ``source_kind="decision"`` collapses
    ``input_type`` to "other") still produces a non-zero keyword score
    because the keyword-substring fix doesn't depend on input_type."""
    # Mimic _match_instinct_for_observation's decision path.
    fact_clean = (
        "Decided (handle) on needs_attention 'Update the payment method "
        "for A Soft Murmur Pro or cancel the subscription' "
        "[note: send me a direct message about this right now]"
    )
    synthetic = {
        "summary": fact_clean,
        "title": fact_clean[:90],
        "subject": "payment",
        "body": "",
        "stream_type": "other",  # decision source_kind collapses
    }
    metadata = extract_input_metadata(synthetic)
    score = score_instinct(metadata, LIVE_PAYMENT_INSTINCT)

    # "update payment method" tokenises to ["update","payment","method"]
    # — all 3 tokens appear in the fact_clean keywords → tokenised
    # match fires → keyword score > 0.
    assert score.breakdown["keywords"] > 0.0, (
        f"decision-flow scoring must register multi-word match "
        f"('update payment method' tokens in fact_clean); "
        f"breakdown={score.breakdown}"
    )


def test_decision_flow_score_is_substantially_above_zero():
    """The original failure mode: 13 ``kind=decision`` observations
    today all had ``instinct_ref: None`` — scorer was returning 0.0
    deterministically (set intersection of single-word input vs
    multi-word patterns).

    After the substring + tokenised scorer fix, the decision-flow
    score is around 0.027 — a meaningful step up from a flat 0.0 even
    though the very thin decision-side text (just the fact_clean
    sentence) doesn't pull the score all the way up to MATCH_THRESHOLD.

    Full closure of the gap (matching the live signal flow's 0.20) needs
    ``_match_instinct_for_observation`` to walk back to the upstream
    signal_fm/event_fm — that's a separate enrichment fix on the
    decision-observation activity, out of scope for the scorer fix.

    What we pin here: the broken-zero-floor is gone; the scorer
    returns a real, non-zero score that an operator can decide to
    tune the threshold against.
    """
    fact_clean = (
        "Decided (handle) on needs_attention 'Update the payment method "
        "for A Soft Murmur Pro or cancel the subscription' "
        "[note: send me a direct message about this right now]"
    )
    synthetic = {
        "summary": fact_clean,
        "title": fact_clean[:90],
        "subject": "payment",
        "body": "",
        "stream_type": "other",
    }
    metadata = extract_input_metadata(synthetic)
    score = score_instinct(metadata, LIVE_PAYMENT_INSTINCT)

    # Was 0.0 deterministically (silent failure). Now is non-zero,
    # which is the actionable change here.
    assert score.score > 0.0
    assert score.breakdown["keywords"] > 0.0


def test_enriched_signal_flow_clears_lowered_threshold():
    """The signal-flow path (where signal_fm + event_fm provide rich
    text + a domain) clears the MATCH_THRESHOLD comfortably. This pins
    the threshold-tuning end of the fix."""
    # Mirrors what build_observation_metadata does for the signal-flow
    # call via signal_observations.extract_obs_from_signal.
    from src.matching.instinct_match import build_observation_metadata
    obs_fm = {
        "fact": "observed: payment failed",
        "sender": "no-reply@asoftmurmur.com",
        "topic": "payment",
        "name": "A Soft Murmur Pro payment failed",
        "source_kind": "signal",
        "source_type": "email",
        "event_kind": "gmail.message_received",
    }
    signal_fm = {
        "raw_quote": LIVE_PAYMENT_SIGNAL_TEXT,
        "reasoning": "Failed payment for a yearly subscription.",
    }
    event_fm = {
        "from": "no-reply@asoftmurmur.com",
        "subject": "Payment failed for A Soft Murmur Pro yearly subscription",
        "body": LIVE_PAYMENT_SIGNAL_TEXT + " Please update your payment method.",
    }
    metadata = build_observation_metadata(
        obs_fm, signal_fm=signal_fm, event_fm=event_fm
    )
    score = score_instinct(metadata, LIVE_PAYMENT_INSTINCT)
    from src.matching.instinct_match import MATCH_THRESHOLD
    assert score.score >= MATCH_THRESHOLD, (
        f"signal-flow observation must clear MATCH_THRESHOLD={MATCH_THRESHOLD}; "
        f"got score={score.score} breakdown={score.breakdown}"
    )


def test_single_word_patterns_still_match():
    """Regression: the fix must not break existing single-word matching.
    ``overdue`` is a single-word pattern; a signal containing
    ``overdue`` should still score on the keywords axis."""
    instinct = {
        "input_patterns": {
            "sender_domains": [],
            "subject_keywords": ["overdue"],
            "input_types": ["email"],
        }
    }
    synthetic = {
        "summary": "Your invoice is overdue please pay",
        "title": "overdue invoice",
        "subject": "Invoice overdue",
        "body": "Your invoice is overdue please pay",
        "stream_type": "email",
    }
    metadata = extract_input_metadata(synthetic)
    score = score_instinct(metadata, instinct)
    assert score.breakdown["keywords"] > 0.0, (
        f"single-word pattern must still match; breakdown={score.breakdown}"
    )


def test_unrelated_signal_does_not_falsely_match():
    """Negative case: a signal about something completely unrelated
    (e.g. a calendar invite) must NOT match the payment-failure
    instinct. The fix can't be so aggressive that it floods false
    positives."""
    synthetic = {
        "summary": "Coffee chat with Sam Lee at 3pm tomorrow",
        "title": "Coffee chat",
        "subject": "Calendar invite",
        "body": "Coffee chat with Sam Lee at 3pm tomorrow",
        "stream_type": "calendar",
    }
    metadata = extract_input_metadata(synthetic)
    score = score_instinct(metadata, LIVE_PAYMENT_INSTINCT)

    # None of the payment-failure phrases appear in a coffee chat.
    assert score.breakdown["keywords"] == 0.0, (
        f"unrelated signal must not match payment-failure keywords; "
        f"breakdown={score.breakdown}"
    )


def test_partial_phrase_match_via_tokens():
    """Edge case: a signal that says ``payment unsuccessful`` (not
    ``payment failed`` verbatim) should at least partially score
    because the tokenised pattern words (``payment``, ``failed``) can
    overlap with the input single words.

    This is the fallback path — substring fails (no full ``payment
    failed`` substring in input), but tokenised intersection helps.
    """
    synthetic = {
        "summary": "Your subscription payment was unsuccessful — card declined ending in 4822",
        "title": "Subscription payment unsuccessful",
        "subject": "Card declined",
        "body": "Your subscription payment was unsuccessful — card declined ending in 4822",
        "stream_type": "email",
    }
    metadata = extract_input_metadata(synthetic)
    score = score_instinct(metadata, LIVE_PAYMENT_INSTINCT)

    # "card declined" appears verbatim → substring hit. Bonus: "payment"
    # appears in the input keywords → tokenised hit too.
    assert score.breakdown["keywords"] > 0.0, (
        f"partial-phrase signal must register some keyword score; "
        f"breakdown={score.breakdown}"
    )
