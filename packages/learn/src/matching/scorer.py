"""Deterministic instinct scoring.

Weighted scoring:
  domain: 0.30, keywords: 0.30, input_type: 0.15,
  attachment: 0.15, tags: 0.10
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from typing import Any

from src.validators.schema import DEFAULT_MATCHING_WEIGHTS


@dataclass
class InstinctScore:
    instinct: dict[str, Any]
    score: float
    breakdown: dict[str, float]


def _get_instinct_patterns(instinct: dict[str, Any]) -> dict[str, list[str]]:
    """Extract signal patterns from instinct, supporting both rich and legacy schemas."""
    input_patterns = instinct.get("input_patterns")
    if input_patterns and isinstance(input_patterns, dict):
        return {
            "domain_patterns": input_patterns.get("sender_domains", []),
            "keyword_patterns": input_patterns.get("subject_keywords", []),
            "input_types": input_patterns.get("input_types", []),
            "attachment_patterns": input_patterns.get("attachment_types", []),
        }
    # Legacy signals fallback
    signals = instinct.get("signals", {})
    return {
        "domain_patterns": signals.get("domain_patterns", []),
        "keyword_patterns": signals.get("keyword_patterns", []),
        "input_types": signals.get("input_types", []),
        "attachment_patterns": signals.get("attachment_patterns", []),
    }


def score_instinct(metadata: dict[str, Any], instinct: dict[str, Any]) -> InstinctScore:
    """Score how well an input matches a single instinct.

    All scoring is deterministic Python — no LLM involved.
    Supports both rich (input_patterns) and legacy (signals) schemas.
    """
    patterns = _get_instinct_patterns(instinct)
    weights = instinct.get("matching_weights", DEFAULT_MATCHING_WEIGHTS)

    # Domain score: do any input domains match instinct domain patterns?
    domain_score = _score_patterns(
        metadata.get("domains", []),
        patterns["domain_patterns"],
    )

    # Keyword score: what fraction of instinct keywords appear in input?
    # Sir gap 5b (2026-05-24): pass the input's full_text so multi-word
    # pattern phrases ("payment failed", "update payment method") can
    # match via substring — set intersection of single-word tokens
    # against multi-word phrases was returning 0.0 every time on the
    # live tenant (silently dropped all 31 unconfirmed instincts'
    # subject_keywords into the void).
    keyword_score = _score_keyword_overlap(
        metadata.get("keywords", []),
        patterns["keyword_patterns"],
        full_text=metadata.get("full_text", ""),
    )

    # Input type score: does the input type match?
    input_type_score = _score_type_match(
        metadata.get("input_type", ""),
        patterns["input_types"],
    )

    # Attachment score: do attachment patterns match?
    attachment_score = _score_patterns(
        metadata.get("attachment_patterns", []),
        patterns["attachment_patterns"],
    )

    # Tag score: overlap between input tags and instinct keywords
    tag_score = _score_keyword_overlap(
        metadata.get("tags", []),
        patterns["keyword_patterns"],
    )

    breakdown = {
        "domain": domain_score,
        "keywords": keyword_score,
        "input_type": input_type_score,
        "attachment": attachment_score,
        "tags": tag_score,
    }

    total = sum(
        breakdown[k] * weights.get(k, DEFAULT_MATCHING_WEIGHTS.get(k, 0))
        for k in breakdown
    )

    return InstinctScore(instinct=instinct, score=total, breakdown=breakdown)


def score_all_instincts(
    metadata: dict[str, Any],
    instincts: list[dict[str, Any]],
) -> list[InstinctScore]:
    """Score all instincts against input metadata. Returns sorted by score descending."""
    scores = [score_instinct(metadata, inst) for inst in instincts]
    scores.sort(key=lambda s: s.score, reverse=True)
    return scores


def _score_patterns(input_values: list[str], patterns: list[str]) -> float:
    """Score how many input values match any glob pattern. Returns 0.0–1.0."""
    if not patterns or not input_values:
        return 0.0

    matched = 0
    for val in input_values:
        val_lower = val.lower()
        for pattern in patterns:
            if fnmatch.fnmatch(val_lower, pattern.lower()):
                matched += 1
                break

    return matched / len(input_values)


def _score_keyword_overlap(
    input_keywords: list[str],
    pattern_keywords: list[str],
    full_text: str = "",
) -> float:
    """Score keyword overlap between input and pattern. Returns 0.0–1.0.

    Sir gap 5b (2026-05-24): the scorer used to do ONLY set
    intersection of single-word ``input_keywords`` against
    ``pattern_keywords``. That silently broke whenever an instinct's
    ``subject_keywords`` carried multi-word phrases (the realistic
    Opus-generated shape: "payment failed", "update payment method",
    "card declined", etc.). Set intersection of words vs phrases is
    always empty → keyword score = 0.0 → most instincts never matched.

    Fix: a pattern "matches" if EITHER
      (a) it appears as a substring of ``full_text`` (catches
          multi-word phrases verbatim), OR
      (b) all whitespace-separated tokens of the pattern appear in the
          input keyword set (catches paraphrased variants:
          "payment was unsuccessful" still tokenises to {payment,
          unsuccessful} — pattern "payment failed" tokens
          {payment,failed} don't ALL appear, so this branch rejects;
          but pattern "card declined" would match a signal that says
          "her card was declined yesterday" via this branch alone), OR
      (c) (legacy compat) the pattern is itself a single word and
          appears in ``input_keywords``.

    Returns the fraction of patterns that matched. ``full_text`` is
    lowercased once at the call site (``extract_input_metadata``)
    so we can substring-match directly.
    """
    if not pattern_keywords:
        return 0.0

    input_set = {k.lower() for k in input_keywords}
    full_text_lc = (full_text or "").lower()
    if not input_set and not full_text_lc:
        return 0.0

    matched = 0
    seen: set[str] = set()
    for raw_pattern in pattern_keywords:
        if not isinstance(raw_pattern, str):
            continue
        pattern = raw_pattern.lower().strip()
        if not pattern or pattern in seen:
            continue
        seen.add(pattern)

        # (a) substring match against the full input text — catches
        # multi-word phrases verbatim.
        if full_text_lc and pattern in full_text_lc:
            matched += 1
            continue

        # (b) tokenised match — split the pattern into words and check
        # that ALL of them appear in the input keyword set. Reject
        # single-word patterns here (we'll catch those in (c) so the
        # behaviour stays identical to the legacy single-word path
        # when the pattern is a single word; otherwise a single-word
        # pattern would double-match).
        pattern_tokens = [t for t in pattern.split() if t]
        if len(pattern_tokens) >= 2 and all(
            t in input_set for t in pattern_tokens
        ):
            matched += 1
            continue

        # (c) legacy single-word path.
        if len(pattern_tokens) == 1 and pattern_tokens[0] in input_set:
            matched += 1
            continue

    if not seen:
        return 0.0
    return matched / len(seen)


def _score_type_match(input_type: str, allowed_types: list[str]) -> float:
    """Score whether the input type is in the allowed types. Returns 0.0 or 1.0."""
    if not allowed_types:
        return 0.0
    return 1.0 if input_type.lower() in [t.lower() for t in allowed_types] else 0.0
