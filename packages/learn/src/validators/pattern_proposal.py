"""Validate pattern_proposal records.

A pattern_proposal is a clustered observation surface — written by
PatternDetectionWorkflow (OBS-4) when N observations cohere around a
candidate rule. The principal reviews it on /desk; accepting it
triggers OBS-5's acceptor which materialises an instinct.

Schema (the writer in OBS-4 will populate these; this validator gates
what the ctrl-api allows to land in vault):

    type: "pattern_proposal"          required
    name: <short title>                required
    created: <ISO timestamp>           required (REQUIRED_FIELDS in vault.ts)
    status: proposed|adopted|...       required, enum
    rule: <natural-language "when X">  required
    proposed_action: <"then Y">        required
    evidence: <human-readable summary> optional
    observation_refs: [vault paths]    required, len >= 3
    cluster_size: <int>                required, >= len(observation_refs)
    confidence: <0..1 float>           required
    matter_ref: <vault path>           optional
    source_kind: "observation_cluster" optional (writer stamps)

This validator only enforces shape — semantic dedup against
already-adopted/rejected proposals lives in the detection workflow.
"""
from __future__ import annotations

from typing import Any

from src.validators.schema import (
    MIN_PATTERN_PROPOSAL_EVIDENCE,
    VALID_PATTERN_PROPOSAL_STATUSES,
    ValidationResult,
)


def validate_pattern_proposal_record(proposal: dict[str, Any]) -> ValidationResult:
    """Validate a pattern_proposal frontmatter dict."""
    result = ValidationResult(valid=True)

    # Required strings
    for field_name in ("name", "rule", "proposed_action"):
        val = proposal.get(field_name)
        if not val or not isinstance(val, str) or not val.strip():
            result.add_error(f"Missing or invalid field: {field_name}")

    # Status — default "proposed" is acceptable
    status = proposal.get("status", "proposed")
    if status not in VALID_PATTERN_PROPOSAL_STATUSES:
        result.add_error(
            f"Invalid status: {status}. Valid: {sorted(VALID_PATTERN_PROPOSAL_STATUSES)}"
        )

    # observation_refs — the evidence pool. Must be a non-trivial list.
    refs = proposal.get("observation_refs")
    if not isinstance(refs, list):
        result.add_error("observation_refs must be a list")
    else:
        if len(refs) < MIN_PATTERN_PROPOSAL_EVIDENCE:
            result.add_error(
                f"observation_refs requires >= {MIN_PATTERN_PROPOSAL_EVIDENCE} "
                f"entries (got {len(refs)})"
            )
        for ref in refs:
            if not isinstance(ref, str) or not ref.startswith("observation/"):
                result.add_error(
                    f"observation_refs entries must be 'observation/...' paths "
                    f"(got {ref!r})"
                )
                break  # one error is enough — don't spam

    # cluster_size — should be >= the visible refs, since the writer
    # may sample a representative subset into observation_refs.
    cluster_size = proposal.get("cluster_size")
    if cluster_size is not None:
        if not isinstance(cluster_size, int) or cluster_size < 0:
            result.add_error("cluster_size must be a non-negative integer")
        elif isinstance(refs, list) and cluster_size < len(refs):
            result.add_error(
                f"cluster_size ({cluster_size}) must be >= len(observation_refs) "
                f"({len(refs)})"
            )

    # Confidence — 0..1 inclusive (matches existing observation precedent).
    confidence = proposal.get("confidence")
    if confidence is None:
        result.add_error("Missing required field: confidence")
    elif not isinstance(confidence, (int, float)) or not (0.0 <= float(confidence) <= 1.0):
        result.add_error("confidence must be a number between 0.0 and 1.0")

    # matter_ref — optional but if present must be a vault path string.
    matter_ref = proposal.get("matter_ref")
    if matter_ref is not None and matter_ref != "":
        if not isinstance(matter_ref, str) or not matter_ref.startswith("matter/"):
            result.add_error("matter_ref must be a 'matter/...' vault path or null")

    return result
