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
                # Record machine observation
                await client.write_record(
                    "observation",
                    f"auto-route-{event.get('id', '')[:8]}",
                    _build_machine_observation_content(event, best),
                )
                return {
                    "routed": True,
                    "destination": destination,
                    "score": best.score,
                    "instinct": best.instinct.get("name", ""),
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
) -> None:
    """Execute a routing decision — move input to destination via alfred-ctrl API."""
    config = load_config()
    client = VaultClient(config)
    try:
        path = input_event.get("path", "")
        if path:
            # Move the file via the alfred-ctrl learning/route endpoint
            resp = await client._client.post(
                "/api/v1/learning/route",
                json={"input_id": path, "destination": destination},
            )
            resp.raise_for_status()
    finally:
        await client.close()


def _build_machine_observation_content(
    event: dict[str, Any],
    best_score: Any,
) -> str:
    """Build observation content for a machine-routed event."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    instinct = best_score.instinct
    score = best_score.score

    # Extract routing rule from rich instinct schema, fall back to legacy
    routing_rule = instinct.get("routing_rule", {})
    destination = routing_rule.get("destination", instinct.get("routing_destination", ""))
    process = routing_rule.get("process", "")
    assignee = routing_rule.get("default_assignee", "")

    return f"""---
type: observation
created: {now}
status: unprocessed
input_ref: "{event.get("id", "")}"
input_type: {event.get("stream_type", "other")}
input_source: auto-judgment
routing_decision:
  destination: "{destination}"
  process: "{process}"
  assigned_to: "{assignee}"
reasoning: "Auto-routed by instinct '{instinct.get("name", "")}' with score {score:.2f}"
considered_alternatives: []
signals:
  domain_patterns: []
  keyword_patterns: []
  input_types: []
  attachment_patterns: []
confidence: machine
routed_by: alfred
source: chat
source_session: ""
created_by: ""
tags: []
---
"""
