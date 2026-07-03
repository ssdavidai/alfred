"""Reflection activities — validate proposals from Clerk."""

from __future__ import annotations

from typing import Any

from temporalio import activity

from src.validators.instinct import validate_instinct_proposal


@activity.defn
async def validate_proposals(proposals: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate instinct change proposals from the Clerk.

    Returns only valid proposals with their action type tagged.

    Tolerant of malformed clerk output: a non-dict envelope, a non-list
    bucket, a bare-string entry (treated as an instinct path/id), or one
    bad entry must NEVER crash the activity. A crash here retried forever
    and wedged ReflectionWorkflow (the third wedge found on the home
    canary: the clerk returned a bare-string ``deprecate`` entry and
    ``dep.get(...)`` raised AttributeError).
    """
    valid: list[dict[str, Any]] = []
    if not isinstance(proposals, dict):
        return valid

    def _bucket(key: str) -> list:
        v = proposals.get(key)
        return v if isinstance(v, list) else []

    # Process creates
    for instinct in _bucket("create"):
        if not isinstance(instinct, dict):
            continue
        try:
            proposal = {"action": "create", "instinct": instinct}
            if validate_instinct_proposal(proposal).valid:
                valid.append(proposal)
        except Exception:  # noqa: BLE001 — one bad proposal must not wedge the run
            continue

    # Process updates (a bare string == the instinct path/id)
    for update in _bucket("update"):
        if isinstance(update, str):
            update = {"path": update}
        if not isinstance(update, dict):
            continue
        try:
            proposal = {
                "action": "update",
                "path": update.get("instinct_id", update.get("path", "")),
                "changes": update.get("changes", {}),
                "name": update.get("name", ""),
            }
            if validate_instinct_proposal(proposal).valid:
                valid.append(proposal)
        except Exception:  # noqa: BLE001
            continue

    # Process merges
    for merge in _bucket("merge"):
        if not isinstance(merge, dict):
            continue
        try:
            merged = merge.get("merged_instinct", {})
            if not isinstance(merged, dict):
                merged = {}
            proposal = {
                "action": "merge",
                "source_paths": merge.get("source_ids", merge.get("source_paths", [])),
                "merged_instinct": merged,
                "name": merged.get("name", "merged"),
            }
            if validate_instinct_proposal(proposal).valid:
                valid.append(proposal)
        except Exception:  # noqa: BLE001
            continue

    # Process deprecations (a bare string == the instinct path/id)
    for dep in _bucket("deprecate"):
        if isinstance(dep, str):
            dep = {"path": dep}
        if not isinstance(dep, dict):
            continue
        try:
            proposal = {
                "action": "deprecate",
                "path": dep.get("instinct_id", dep.get("path", "")),
                "reason": dep.get("reason", ""),
                "name": dep.get("name", ""),
            }
            if validate_instinct_proposal(proposal).valid:
                valid.append(proposal)
        except Exception:  # noqa: BLE001
            continue

    return valid
