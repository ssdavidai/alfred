"""Validate observation records."""

from __future__ import annotations

from typing import Any

from src.validators.schema import (
    SIGNAL_KEYS,
    VALID_CONFIDENCE_VALUES,
    VALID_OBSERVATION_SOURCES,
    VALID_OBSERVATION_STATUSES,
    VALID_ROUTED_BY_VALUES,
    ValidationResult,
)


def validate_observation_record(observation: dict[str, Any]) -> ValidationResult:
    """Validate an observation record has all required fields with valid values."""
    result = ValidationResult(valid=True)

    # Required string fields
    for field in ("input_type", "reasoning"):
        val = observation.get(field)
        if not val or not isinstance(val, str):
            result.add_error(f"Missing or invalid field: {field}")

    # input_source
    source = observation.get("input_source")
    if not source or not isinstance(source, str):
        result.add_error("Missing or invalid field: input_source")

    # routing_decision — structured dict or legacy flat string
    rd = observation.get("routing_decision")
    if not rd:
        result.add_error("Missing or invalid field: routing_decision")
    elif isinstance(rd, str):
        pass  # legacy flat string still accepted
    elif isinstance(rd, dict):
        if not rd.get("destination"):
            result.add_error("routing_decision.destination is required")
    else:
        result.add_error("routing_decision must be a string or dict")

    # confidence
    confidence = observation.get("confidence", "human")
    if confidence not in VALID_CONFIDENCE_VALUES:
        result.add_error(f"Invalid confidence: {confidence}. Valid: {sorted(VALID_CONFIDENCE_VALUES)}")

    # routed_by
    routed_by = observation.get("routed_by", "user")
    if routed_by not in VALID_ROUTED_BY_VALUES:
        result.add_error(f"Invalid routed_by: {routed_by}. Valid: {sorted(VALID_ROUTED_BY_VALUES)}")

    # source (observation provenance)
    obs_source = observation.get("source")
    if obs_source and obs_source not in VALID_OBSERVATION_SOURCES:
        result.add_error(f"Invalid source: {obs_source}. Valid: {sorted(VALID_OBSERVATION_SOURCES)}")

    # signals
    signals = observation.get("signals")
    if not signals or not isinstance(signals, dict):
        result.add_error("Missing or invalid signals object")
    else:
        for key in SIGNAL_KEYS:
            if key not in signals:
                result.add_error(f"Missing signal key: {key}")
            elif not isinstance(signals[key], list):
                result.add_error(f"Signal '{key}' must be a list")

    # Optional structured fields — validate types if present
    if "considered_alternatives" in observation:
        if not isinstance(observation["considered_alternatives"], list):
            result.add_error("considered_alternatives must be a list")

    return result
