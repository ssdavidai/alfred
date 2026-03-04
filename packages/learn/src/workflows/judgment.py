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
                destination = best["instinct"].get("routing_destination", "")
                # Route autonomously
                await workflow.execute_activity(
                    execute_route,
                    args=[inp, destination],
                    start_to_close_timeout=timedelta(seconds=30),
                )
                # Record observation (machine-routed)
                instinct = best["instinct"]
                score = best["score"]
                breakdown = best.get("breakdown", {})
                routing_rule = instinct.get("routing_rule", {})

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
