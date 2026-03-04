"""Validate instinct records."""

from __future__ import annotations

from typing import Any

from src.validators.schema import (
    DEFAULT_MATCHING_WEIGHTS,
    SIGNAL_KEYS,
    VALID_INSTINCT_STATUSES,
    VALID_ROUTING_DESTINATION_TYPES,
    ValidationResult,
)

# Keys accepted in input_patterns (rich schema)
INPUT_PATTERN_KEYS = frozenset({"sender_domains", "subject_keywords", "attachment_types", "input_types"})


def validate_instinct_record(instinct: dict[str, Any]) -> ValidationResult:
    """Validate an instinct record has all required fields with valid values."""
    result = ValidationResult(valid=True)

    # Required string fields
    if not instinct.get("name"):
        result.add_error("Missing required field: name")

    # Status
    status = instinct.get("status", "active")
    if status not in VALID_INSTINCT_STATUSES:
        result.add_error(f"Invalid status: {status}. Valid: {sorted(VALID_INSTINCT_STATUSES)}")

    # Observation count
    obs_count = instinct.get("observation_count", 0)
    if not isinstance(obs_count, (int, float)) or obs_count < 0:
        result.add_error("observation_count must be a non-negative number")

    # Discretion threshold
    threshold = instinct.get("discretion_threshold", 0.85)
    if not isinstance(threshold, (int, float)) or not (0.0 <= threshold <= 1.0):
        result.add_error("discretion_threshold must be between 0.0 and 1.0")

    # Rich schema: input_patterns (preferred over flat signals)
    input_patterns = instinct.get("input_patterns")
    signals = instinct.get("signals")

    if input_patterns:
        if not isinstance(input_patterns, dict):
            result.add_error("input_patterns must be a dict")
        else:
            for key in INPUT_PATTERN_KEYS:
                val = input_patterns.get(key)
                if val is not None and not isinstance(val, list):
                    result.add_error(f"input_patterns.{key} must be a list")
    elif signals:
        # Legacy signals validation
        if not isinstance(signals, dict):
            result.add_error("Missing or invalid signals object")
        else:
            for key in SIGNAL_KEYS:
                if key not in signals:
                    result.add_error(f"Missing signal key: {key}")
                elif not isinstance(signals[key], list):
                    result.add_error(f"Signal '{key}' must be a list")
    else:
        result.add_error("Missing input_patterns or signals")

    # Rich schema: routing_rule (preferred over flat routing_destination)
    routing_rule = instinct.get("routing_rule")
    routing_destination = instinct.get("routing_destination")

    if routing_rule:
        if not isinstance(routing_rule, dict):
            result.add_error("routing_rule must be a dict")
        else:
            dest_type = routing_rule.get("destination_type")
            if dest_type and dest_type not in VALID_ROUTING_DESTINATION_TYPES:
                result.add_error(
                    f"Invalid routing_rule.destination_type: {dest_type}. "
                    f"Valid: {sorted(VALID_ROUTING_DESTINATION_TYPES)}"
                )
            if not routing_rule.get("destination"):
                result.add_error("routing_rule.destination is required")
    elif not routing_destination:
        result.add_error("Missing routing_rule or routing_destination")

    # confidence_score
    conf_score = instinct.get("confidence_score")
    if conf_score is not None:
        if not isinstance(conf_score, (int, float)) or not (0.0 <= conf_score <= 1.0):
            result.add_error("confidence_score must be between 0.0 and 1.0")

    # observations list (wikilinks)
    observations = instinct.get("observations", instinct.get("based_on", []))
    if observations is not None and not isinstance(observations, list):
        result.add_error("observations must be a list")

    # Matching weights
    weights = instinct.get("matching_weights", {})
    if weights:
        total = sum(weights.values())
        if abs(total - 1.0) > 0.01:
            result.add_error(f"matching_weights must sum to 1.0 (got {total:.2f})")

    # Domain — required only for legacy schema (without routing_rule)
    if not instinct.get("routing_rule") and not instinct.get("domain"):
        result.add_error("domain is required when routing_rule is not specified")

    return result


def validate_instinct_proposal(proposal: dict[str, Any]) -> ValidationResult:
    """Validate an instinct change proposal from the Clerk."""
    result = ValidationResult(valid=True)

    action = proposal.get("action")
    if action not in ("create", "update", "merge", "deprecate"):
        result.add_error(f"Invalid proposal action: {action}")
        return result

    if action == "create":
        instinct = proposal.get("instinct", {})
        inner = validate_instinct_record(instinct)
        if not inner.valid:
            result.errors.extend(inner.errors)
            result.valid = False

        # New instincts must be grounded in at least 3 observations
        observations = instinct.get("observations", instinct.get("based_on", []))
        if not isinstance(observations, list) or len(observations) < 3:
            result.add_error("New instincts require at least 3 observations")

    elif action == "update":
        if not proposal.get("path"):
            result.add_error("Update proposal missing path")
        if not proposal.get("changes"):
            result.add_error("Update proposal missing changes")

    elif action == "merge":
        if not proposal.get("source_paths"):
            result.add_error("Merge proposal missing source_paths")
        merged = proposal.get("merged_instinct", {})
        inner = validate_instinct_record(merged)
        if not inner.valid:
            result.errors.extend(inner.errors)
            result.valid = False

    elif action == "deprecate":
        if not proposal.get("path"):
            result.add_error("Deprecate proposal missing path")
        if not proposal.get("reason"):
            result.add_error("Deprecate proposal missing reason")

    return result
