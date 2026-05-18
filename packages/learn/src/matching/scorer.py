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
    keyword_score = _score_keyword_overlap(
        metadata.get("keywords", []),
        patterns["keyword_patterns"],
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


def _score_keyword_overlap(input_keywords: list[str], pattern_keywords: list[str]) -> float:
    """Score keyword overlap between input and pattern. Returns 0.0–1.0."""
    if not pattern_keywords:
        return 0.0

    input_set = {k.lower() for k in input_keywords}
    pattern_set = {k.lower() for k in pattern_keywords}

    if not pattern_set:
        return 0.0

    overlap = input_set & pattern_set
    return len(overlap) / len(pattern_set)


def _score_type_match(input_type: str, allowed_types: list[str]) -> float:
    """Score whether the input type is in the allowed types. Returns 0.0 or 1.0."""
    if not allowed_types:
        return 0.0
    return 1.0 if input_type.lower() in [t.lower() for t in allowed_types] else 0.0
