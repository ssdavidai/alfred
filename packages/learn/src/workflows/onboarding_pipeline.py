"""Workflow: Onboarding Pipeline — orchestrates first-run onboarding after Gmail connect.

Triggered once when the user completes Gmail OAuth. Waits for initial emails,
extracts entities and patterns, then generates a personalized first brief.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.onboarding import (
        wait_for_gmail_events,
        extract_entities_from_emails,
        analyze_patterns,
        generate_first_brief,
        write_onboarding_results,
    )


@dataclass
class OnboardingInput:
    user_id: str
    stream_id: str  # Gmail stream ID


@dataclass
class OnboardingResult:
    entities_extracted: int = 0
    patterns_found: int = 0
    brief_path: str = ""
    error: str | None = None


@workflow.defn(name="OnboardingPipelineWorkflow")
class OnboardingPipelineWorkflow:
    @workflow.run
    async def run(self, input: OnboardingInput) -> OnboardingResult:
        result = OnboardingResult()

        # 1. Wait for at least 10 unprocessed Gmail events (up to 5 min)
        events: list[dict[str, Any]] = await workflow.execute_activity(
            wait_for_gmail_events,
            args=[input.stream_id, 10, 300],
            start_to_close_timeout=timedelta(seconds=360),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )

        if not events:
            result.error = "no_events_within_timeout"
            return result

        # 2. Extract entities (people, orgs, topics) from the email batch
        entities: dict[str, Any] = await workflow.execute_activity(
            extract_entities_from_emails,
            args=[events],
            start_to_close_timeout=timedelta(seconds=300),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.entities_extracted = len(entities.get("people", [])) + len(entities.get("organizations", [])) + len(entities.get("topics", []))

        # 3. Analyze communication patterns, routines, priorities
        patterns: dict[str, Any] = await workflow.execute_activity(
            analyze_patterns,
            args=[events, entities],
            start_to_close_timeout=timedelta(seconds=300),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.patterns_found = len(patterns.get("patterns", []))

        # 4. Generate personalized first brief
        brief: str = await workflow.execute_activity(
            generate_first_brief,
            args=[events, entities, patterns],
            start_to_close_timeout=timedelta(seconds=300),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )

        # 5. Write entities, patterns, and brief to vault
        brief_path: str = await workflow.execute_activity(
            write_onboarding_results,
            args=[entities, patterns, brief],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
        result.brief_path = brief_path

        return result
