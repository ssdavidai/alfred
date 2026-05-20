"""Reflection activities — validate proposals from Clerk."""

from __future__ import annotations

from typing import Any

from temporalio import activity

from src.validators.instinct import validate_instinct_proposal


@activity.defn
async def validate_proposals(proposals: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate instinct change proposals from the Clerk.

    Returns only valid proposals with their action type tagged.
    """
    valid: list[dict[str, Any]] = []

    # Process creates
    for instinct in proposals.get("create", []):
        proposal = {"action": "create", "instinct": instinct}
        result = validate_instinct_proposal(proposal)
        if result.valid:
            valid.append(proposal)

    # Process updates
    for update in proposals.get("update", []):
        proposal = {
            "action": "update",
            "path": update.get("instinct_id", update.get("path", "")),
            "changes": update.get("changes", {}),
            "name": update.get("name", ""),
        }
        result = validate_instinct_proposal(proposal)
        if result.valid:
            valid.append(proposal)

    # Process merges
    for merge in proposals.get("merge", []):
        proposal = {
            "action": "merge",
            "source_paths": merge.get("source_ids", merge.get("source_paths", [])),
            "merged_instinct": merge.get("merged_instinct", {}),
            "name": merge.get("merged_instinct", {}).get("name", "merged"),
        }
        result = validate_instinct_proposal(proposal)
        if result.valid:
            valid.append(proposal)

    # Process deprecations
    for dep in proposals.get("deprecate", []):
        proposal = {
            "action": "deprecate",
            "path": dep.get("instinct_id", dep.get("path", "")),
            "reason": dep.get("reason", ""),
            "name": dep.get("name", ""),
        }
        result = validate_instinct_proposal(proposal)
        if result.valid:
            valid.append(proposal)

    return valid
