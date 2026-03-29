"""Workflow: Onboarding Pipeline v2 — RESUMABLE.

100-day Gmail backfill, progressive fact extraction, pattern analysis,
personalization, automation suggestions, and butler-quality first brief.

RESUME CAPABILITY: If the workflow fails and is restarted, it reads
onboard.json and skips stages/days that have already been completed.
Facts, patterns, and other extracted data are preserved.
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
        write_facts_to_vault,
    )

ONBOARD_PATH = "/alfred-data/onboard.json"

# Stage ordering for resume logic
STAGE_ORDER = [
    "backfill",      # Stage 1: fetch Gmail history
    "processing",    # Stage 2: extract facts per day
    "patterns",      # Stage 3: analyze patterns
    "personalize",   # Stage 4: write USER.md + SOUL.md
    "automations",   # Stage 5: suggest workflows
    "brief",         # Stage 6: write first brief
    "writing_facts", # Stage 7: write facts to vault
    "done",
]


def _stage_index(stage: str) -> int:
    try:
        return STAGE_ORDER.index(stage)
    except ValueError:
        return 0  # Unknown stage = start from beginning


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

        # Initialize — preserves existing data if resuming
        current_state: dict[str, Any] = await workflow.execute_activity(
            init_onboard_json,
            args=[onboard_path, input.user_id],
            start_to_close_timeout=timedelta(seconds=10),
        )

        resume_stage = current_state.get("stage", "backfill")
        resume_idx = _stage_index(resume_stage)
        processed_days = set(current_state.get("processed_days", []))

        # If already done, just return
        if resume_stage == "done":
            return OnboardingResult(
                brief_path="event/First Brief.md",
                facts_count=len(current_state.get("facts", [])),
                patterns_count=len(current_state.get("patterns", [])),
            )

        # -----------------------------------------------------------------
        # Stage 1: Backfill Gmail (skip if we're past this stage)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("backfill"):
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

        # -----------------------------------------------------------------
        # Stage 2: Process each day's emails (skip already-processed days)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("processing"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "processing"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            total_days = len(day_chunks)
            for i, chunk in enumerate(day_chunks):
                # Skip days already processed (resume capability)
                day_date = chunk.get("date", "")
                if day_date in processed_days:
                    continue

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

        # -----------------------------------------------------------------
        # Stage 3: Analyze patterns (skip if already done)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("patterns"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "patterns"],
                start_to_close_timeout=timedelta(seconds=10),
            )
            await workflow.execute_activity(
                analyze_patterns_v2,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=8),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        # -----------------------------------------------------------------
        # Stage 4: Personalize Alfred (skip if already done)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("personalize"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "personalize"],
                start_to_close_timeout=timedelta(seconds=10),
            )
            await workflow.execute_activity(
                personalize_alfred,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=8),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        # -----------------------------------------------------------------
        # Stage 5: Suggest automations (skip if already done)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("automations"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "automations"],
                start_to_close_timeout=timedelta(seconds=10),
            )
            await workflow.execute_activity(
                suggest_automations,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        # -----------------------------------------------------------------
        # Stage 6: Write first brief (skip if already done)
        # -----------------------------------------------------------------
        brief_path = "event/First Brief.md"
        if resume_idx <= _stage_index("brief"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "brief"],
                start_to_close_timeout=timedelta(seconds=10),
            )
            brief_path = await workflow.execute_activity(
                write_first_brief,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=8),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        # -----------------------------------------------------------------
        # Stage 7: Write facts to vault (always run — idempotent)
        # -----------------------------------------------------------------
        await workflow.execute_activity(
            write_facts_to_vault,
            args=[onboard_path],
            start_to_close_timeout=timedelta(minutes=30),
            heartbeat_timeout=timedelta(seconds=120),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )

        return OnboardingResult(
            brief_path=brief_path,
            facts_count=len(current_state.get("facts", [])),
            patterns_count=len(current_state.get("patterns", [])),
        )
