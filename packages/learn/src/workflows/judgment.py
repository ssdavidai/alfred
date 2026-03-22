"""Workflow 6: Judgment — per-input routing decisions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from src.activities.judge import (
        execute_route,
        fetch_unrouted_inputs,
        load_intuition_index,
        score_instincts,
    )
    from src.activities.notify import escalate_to_user
    from src.activities.vault import write_observation_record
    from src.matching.discretion import should_route_autonomously
    from src.matching.metadata import extract_input_metadata


@dataclass
class JudgmentResult:
    routed: int = 0
    escalated: int = 0


@workflow.defn(name="JudgmentWorkflow")
class JudgmentWorkflow:
    @workflow.run
    async def run(self, input_event: dict[str, Any] | None = None) -> JudgmentResult:
        # If called with specific input, judge it
        # If called by schedule, scan for unrouted inputs
        if input_event:
            inputs = [input_event]
        else:
            inputs = await workflow.execute_activity(
                fetch_unrouted_inputs,
                start_to_close_timeout=timedelta(seconds=30),
            )

        routed = 0
        escalated = 0

        for inp in inputs:
            # 1. Load intuition index (Python — deterministic)
            instincts: list[dict[str, Any]] = await workflow.execute_activity(
                load_intuition_index,
                start_to_close_timeout=timedelta(seconds=10),
            )

            if not instincts:
                # No instincts yet — everything escalates
                await workflow.execute_activity(
                    escalate_to_user,
                    args=[inp, None],
                    start_to_close_timeout=timedelta(seconds=15),
                )
                escalated += 1
                continue

            # 2. Extract metadata (Python — deterministic)
            metadata = await workflow.execute_activity(
                extract_input_metadata,
                args=[inp],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # 3. Score each instinct (Python — deterministic)
            scores: list[dict[str, Any]] = await workflow.execute_activity(
                score_instincts,
                args=[metadata, instincts],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # 4. Apply discretion (Python — deterministic)
            best = scores[0] if scores else None

            if best and should_route_autonomously(best["score"], best["instinct"]):
                instinct = best["instinct"]
                score = best["score"]
                breakdown = best.get("breakdown", {})
                routing_rule = instinct.get("routing_rule", {})
                destination = routing_rule.get(
                    "destination", instinct.get("routing_destination", ""),
                )

                # Build routing context for Curator
                routing_context = {
                    "assigned_to": routing_rule.get("default_assignee", ""),
                    "process": routing_rule.get("process", ""),
                    "instinct_name": instinct.get("name", ""),
                    "confidence_score": score,
                }

                # Route via Curator (creates structured records)
                route_result: dict[str, Any] = await workflow.execute_activity(
                    execute_route,
                    args=[inp, destination, routing_context],
                    start_to_close_timeout=timedelta(seconds=120),
                )

                # If routing completely failed, escalate instead of silently dropping
                route_error = route_result.get("error")
                no_path = route_result.get("reason") == "no_path"
                if not route_result.get("processed", False) and not route_result.get("fallback", False) and (route_error or no_path):
                    await workflow.execute_activity(
                        escalate_to_user,
                        args=[inp, best],
                        start_to_close_timeout=timedelta(seconds=15),
                    )
                    escalated += 1
                    continue

                # Record observation enriched with Curator results
                curator_processed = route_result.get("processed", False)
                observation = {
                    "input_type": inp.get("stream_type", "other"),
                    "input_source": "auto-judgment",
                    "input_ref": inp.get("id", ""),
                    "routing_decision": {
                        "destination": destination,
                        "process": routing_rule.get("process", ""),
                        "assigned_to": routing_rule.get("default_assignee", ""),
                    },
                    "reasoning": (
                        f"Auto-routed by instinct '{instinct.get('name', '')}'"
                        f" with score {score:.2f}"
                        + (
                            f" — Curator created {len(route_result.get('entities_created', []))} entities"
                            if curator_processed
                            else " — Curator unavailable, raw move"
                        )
                    ),
                    "signals": {
                        "domain_patterns": breakdown.get("domain", []),
                        "keyword_patterns": breakdown.get("keywords", []),
                        "input_types": breakdown.get("input_type", []),
                        "attachment_patterns": breakdown.get("attachment", []),
                    },
                    "confidence": "machine",
                    "routed_by": "alfred",
                }

                # Only write observation via vault activity if the route-and-process
                # endpoint didn't already write one (it does for the new endpoint)
                if not (route_result.get("observation_path") or route_result.get("observation")):
                    await workflow.execute_activity(
                        write_observation_record,
                        args=[observation],
                        start_to_close_timeout=timedelta(seconds=30),
                    )
                routed += 1
            else:
                # Escalate — notify main Alfred
                await workflow.execute_activity(
                    escalate_to_user,
                    args=[inp, best],
                    start_to_close_timeout=timedelta(seconds=15),
                )
                escalated += 1

        return JudgmentResult(routed=routed, escalated=escalated)
