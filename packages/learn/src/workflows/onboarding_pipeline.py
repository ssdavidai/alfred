"""Workflow: Onboarding Pipeline v2 — 100-day Gmail backfill, progressive fact extraction,
pattern analysis, personalization, automation suggestions, and butler-quality first brief.

Triggered once when the user completes Gmail OAuth. Reads 100 days of email history,
processes each day progressively, then generates a personalized first brief.
Progress is tracked in /alfred-data/onboard.json and polled by the frontend.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.onboarding import (
        init_onboard_json,
        update_onboard_stage,
        update_onboard_progress,
        backfill_gmail_history,
        process_day_chunk,
        analyze_patterns_v2,
        personalize_alfred,
        suggest_automations,
        write_first_brief,
    )

ONBOARD_PATH = "/alfred-data/onboard.json"


@dataclass
class OnboardingInput:
    user_id: str
    stream_id: str = ""


@dataclass
class OnboardingResult:
    brief_path: str = ""
    facts_count: int = 0
    patterns_count: int = 0
    error: str | None = None


@workflow.defn(name="OnboardingPipelineWorkflow")
class OnboardingPipelineWorkflow:
    @workflow.run
    async def run(self, input: OnboardingInput) -> OnboardingResult:
        onboard_path = ONBOARD_PATH

        # Initialize onboard.json
        await workflow.execute_activity(
            init_onboard_json,
            args=[onboard_path, input.user_id],
            start_to_close_timeout=timedelta(seconds=10),
        )

        # Stage 1: Backfill Gmail (100 days)
        await workflow.execute_activity(
            update_onboard_stage,
            args=[onboard_path, "backfill"],
            start_to_close_timeout=timedelta(seconds=10),
        )

        day_chunks: list[dict[str, Any]] = await workflow.execute_activity(
            backfill_gmail_history,
            args=[input.user_id],
            start_to_close_timeout=timedelta(minutes=15),
            heartbeat_timeout=timedelta(seconds=120),
        )

        # Stage 2: Process each day's emails
        await workflow.execute_activity(
            update_onboard_stage,
            args=[onboard_path, "processing"],
            start_to_close_timeout=timedelta(seconds=10),
        )

        total_days = len(day_chunks)
        for i, chunk in enumerate(day_chunks):
            await workflow.execute_activity(
                update_onboard_progress,
                args=[onboard_path, i + 1, total_days],
                start_to_close_timeout=timedelta(seconds=10),
            )
            await workflow.execute_activity(
                process_day_chunk,
                args=[chunk, onboard_path, input.user_id],
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        # Stage 3: Analyze patterns
        await workflow.execute_activity(
            update_onboard_stage,
            args=[onboard_path, "patterns"],
            start_to_close_timeout=timedelta(seconds=10),
        )
        await workflow.execute_activity(
            analyze_patterns_v2,
            args=[onboard_path],
            start_to_close_timeout=timedelta(minutes=5),
        )

        # Stage 4: Personalize Alfred (write USER.md + SOUL.md)
        await workflow.execute_activity(
            update_onboard_stage,
            args=[onboard_path, "personalize"],
            start_to_close_timeout=timedelta(seconds=10),
        )
        await workflow.execute_activity(
            personalize_alfred,
            args=[onboard_path],
            start_to_close_timeout=timedelta(minutes=5),
        )

        # Stage 5: Suggest automations
        await workflow.execute_activity(
            update_onboard_stage,
            args=[onboard_path, "automations"],
            start_to_close_timeout=timedelta(seconds=10),
        )
        await workflow.execute_activity(
            suggest_automations,
            args=[onboard_path],
            start_to_close_timeout=timedelta(minutes=5),
        )

        # Stage 6: Write first brief
        await workflow.execute_activity(
            update_onboard_stage,
            args=[onboard_path, "brief"],
            start_to_close_timeout=timedelta(seconds=10),
        )
        brief_path: str = await workflow.execute_activity(
            write_first_brief,
            args=[onboard_path],
            start_to_close_timeout=timedelta(minutes=5),
        )

        # Mark done
        await workflow.execute_activity(
            update_onboard_stage,
            args=[onboard_path, "done"],
            start_to_close_timeout=timedelta(seconds=10),
        )

        return OnboardingResult(brief_path=brief_path)
