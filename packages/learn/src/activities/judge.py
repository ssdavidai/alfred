"""Judgment activities — scoring, routing, escalation."""

from __future__ import annotations

from typing import Any

from temporalio import activity

from src.config import load_config
from src.matching.discretion import should_route_autonomously
from src.matching.metadata import extract_input_metadata
from src.matching.scorer import score_all_instincts
from src.utils.vault_client import VaultClient


@activity.defn
async def attempt_judgment(
    event: dict[str, Any],
    metadata: dict[str, Any],
    classification: dict[str, Any],
) -> dict[str, Any]:
    """Attempt to route an event using existing instincts.

    Called by EventProcessor (step 8) after classification.
    If no instincts exist or score is below threshold, does nothing
    (event stays unrouted for JudgmentWorkflow to pick up).
    """
    config = load_config()
    client = VaultClient(config)
    try:
        instincts = await client.list_records("instinct", status="active")
        if not instincts:
            return {"routed": False, "reason": "no_instincts"}

        input_meta = extract_input_metadata({
            **event,
            "classification": classification,
        })

        scores = score_all_instincts(input_meta, instincts)
        if not scores:
            return {"routed": False, "reason": "no_scores"}

        best = scores[0]
        if should_route_autonomously(best.score, best.instinct):
            routing_rule = best.instinct.get("routing_rule", {})
            destination = routing_rule.get("destination", best.instinct.get("routing_destination", ""))
            if destination:
                # Route via Curator for structured processing
                routing_context = {
                    "assigned_to": routing_rule.get("default_assignee", ""),
                    "process": routing_rule.get("process", ""),
                    "instinct_name": best.instinct.get("name", ""),
                    "confidence_score": best.score,
                }
                curator_result = await _execute_route_inline(
                    client, event, destination, routing_context,
                )
                # Only report routed if Curator succeeded or fallback moved the file
                actually_routed = (
                    curator_result.get("processed", False)
                    or curator_result.get("fallback", False)
                    or curator_result.get("observation_path")
                    or curator_result.get("observation")
                    or curator_result.get("note_path")
                )
                if not actually_routed and curator_result.get("error"):
                    return {
                        "routed": False,
                        "reason": "route_failed",
                        "error": curator_result.get("error"),
                        "best_score": best.score,
                        "best_instinct": best.instinct.get("name", ""),
                    }

                # Check for execution block — create task if present
                task_path = None
                execution = best.instinct.get("execution", {})
                if execution.get("enabled"):
                    task_path = await _create_execution_task(
                        client, event, metadata, classification,
                        best.instinct, execution, best.score,
                    )

                return {
                    "routed": True,
                    "destination": destination,
                    "score": best.score,
                    "instinct": best.instinct.get("name", ""),
                    "curator_processed": curator_result.get("processed", False),
                    "note_path": curator_result.get("note_path"),
                    "task_created": task_path,
                }

        return {
            "routed": False,
            "reason": "below_threshold",
            "best_score": best.score,
            "best_instinct": best.instinct.get("name", ""),
        }
    finally:
        await client.close()


@activity.defn
async def fetch_unrouted_inputs() -> list[dict[str, Any]]:
    """Fetch inputs awaiting routing judgment."""
    config = load_config()
    client = VaultClient(config)
    try:
        return await client.fetch_unrouted_inputs()
    finally:
        await client.close()


@activity.defn
async def load_intuition_index() -> list[dict[str, Any]]:
    """Load all active instincts (the intuition index)."""
    config = load_config()
    client = VaultClient(config)
    try:
        return await client.list_records("instinct", status="active")
    finally:
        await client.close()


@activity.defn
async def score_instincts(
    metadata: dict[str, Any],
    instincts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Score all instincts against input metadata. Returns sorted list."""
    scores = score_all_instincts(metadata, instincts)
    return [
        {
            "instinct": s.instinct,
            "score": s.score,
            "breakdown": s.breakdown,
        }
        for s in scores
    ]


@activity.defn
async def execute_route(
    input_event: dict[str, Any],
    destination: str,
    routing_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute a routing decision — hand to Curator for structured processing.

    Calls the curator/route-and-process endpoint which:
    1. Injects routing metadata into the inbox file
    2. Triggers the Curator to create structured records
    3. Returns entities created/linked info

    Falls back to raw file move if Curator is unavailable.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        input_path = input_event.get("path", "")
        if not input_path:
            return {"processed": False, "reason": "no_path"}

        resp = await client._client.post(
            "/api/v1/curator/route-and-process",
            json={
                "input_path": input_path,
                "destination": destination,
                "routing_context": routing_context or {},
            },
            timeout=120.0,  # Curator processing takes longer
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        # Fallback: try the old route endpoint for raw file move
        activity.logger.warning(
            "Curator route-and-process failed, falling back to raw route: %s",
            exc,
        )
        try:
            resp = await client._client.post(
                "/api/v1/learning/route",
                json={"input_id": input_path, "destination": destination},
            )
            resp.raise_for_status()
            result = resp.json()
            result["processed"] = False
            result["fallback"] = True
            # Normalize observation key for downstream compatibility
            if "observation" in result and "observation_path" not in result:
                result["observation_path"] = result["observation"]
            return result
        except Exception as fallback_exc:
            activity.logger.error("Fallback route also failed: %s", fallback_exc)
            return {"processed": False, "error": str(fallback_exc)}
    finally:
        await client.close()


async def _execute_route_inline(
    client: VaultClient,
    event: dict[str, Any],
    destination: str,
    routing_context: dict[str, Any],
) -> dict[str, Any]:
    """Route via Curator inline (used by attempt_judgment which already has a client).

    Falls back to old route endpoint if Curator is unavailable.
    """
    input_path = event.get("path", "")
    if not input_path:
        return {"processed": False, "reason": "no_path"}

    try:
        resp = await client._client.post(
            "/api/v1/curator/route-and-process",
            json={
                "input_path": input_path,
                "destination": destination,
                "routing_context": routing_context,
            },
            timeout=120.0,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        activity.logger.warning(
            "Curator route-and-process failed in attempt_judgment, falling back: %s",
            exc,
        )
        try:
            resp = await client._client.post(
                "/api/v1/learning/route",
                json={"input_id": input_path, "destination": destination},
            )
            resp.raise_for_status()
            result = resp.json()
            result["processed"] = False
            result["fallback"] = True
            # Normalize observation key for downstream compatibility
            if "observation" in result and "observation_path" not in result:
                result["observation_path"] = result["observation"]
            return result
        except Exception:
            return {"processed": False, "error": str(exc)}


async def _create_execution_task(
    client: VaultClient,
    event: dict[str, Any],
    metadata: dict[str, Any],
    classification: dict[str, Any],
    instinct: dict[str, Any],
    execution: dict[str, Any],
    score: float,
) -> str | None:
    """Create an execution task in the vault when an instinct has an execution block.

    Applies discretion gate:
    - New instincts (<10 observations) → requires_approval forced true
    - Established (10-50 obs) → use instinct's requires_approval setting
    - Mature (50+ obs, score >0.75) → requires_approval defaults false

    Returns the created task path, or None on failure.
    """
    from datetime import datetime, timezone

    from src.activities.vault import slugify, vault_record_path

    now = datetime.now(timezone.utc)
    obs_count = instinct.get("observation_count", 0)
    instinct_name = instinct.get("name", "unknown")

    # Discretion gate
    requires_approval = execution.get("requires_approval", True)
    if obs_count < 10:
        requires_approval = True  # Force for new instincts
    elif obs_count >= 50 and score > 0.75:
        requires_approval = execution.get("requires_approval", False)

    # Build title from template or classification
    title_template = execution.get("task_title_template", "{title}")
    title = title_template.format(
        title=classification.get("title", metadata.get("filename", "Untitled")),
        type=classification.get("type", "unknown"),
    )

    tier = execution.get("tier", 2)
    agent_id = execution.get("agent_id", "learn-clerk")
    skill_entry = execution.get("skill_entry", "")
    budget = execution.get("budget_turns", 25)

    content = f"""---
type: task
status: queued
title: "{title}"
owner: "alfred"
tier: {tier}
agent_id: "{agent_id}"
skill_entry: "{skill_entry}"
budget_turns: {budget}
requires_approval: {str(requires_approval).lower()}
source_event: "{event.get('id', '')}"
source_instinct: "{instinct.get('path', '')}"
matter: ""
created: "{now.isoformat()}"
created_by: judgment
priority: medium
tags: [auto-created]
---

# {title}

Auto-created by judgment from instinct: {instinct_name}
Confidence score: {score:.2f}
Observation count: {obs_count}

## Source
- Event: {event.get('id', '')}
- Classification: {classification.get('type', '')} — {classification.get('summary', '')}
"""

    try:
        name = vault_record_path("task", slugify(title), now)
        path = await client.write_record("task", name, content)
        activity.logger.info(
            "Created execution task: %s (approval=%s, tier=%d, instinct=%s)",
            path, requires_approval, tier, instinct_name,
        )
        return path
    except Exception as exc:
        activity.logger.error("Failed to create execution task: %s", exc)
        return None
