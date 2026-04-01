"""Workflow: Onboarding Pipeline v3 — 4 Opus calls, 5-minute intelligence.

Replaces the 101-sequential-Clerk-call pipeline with 4 direct Opus 4.6
calls. Full email corpus as context. User sees First Brief ~15 min after
signup. Vault builds in background via curator.

Stages:
1. Fetch email metadata + snippets (30-60s)
2. Extract facts (1 Opus call)
3. Discover patterns (1 Opus call)
4. Personalize: USER.md + SOUL.md + MEMORY.md + TOOLS.md (1 Opus call)
5. First Brief — high-EQ butler welcome letter (1 Opus call)
6. Mark done → show brief
7. Background: full email backfill → batch to inbox → curator builds vault
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
    )
    from src.activities.onboarding_v3 import (
        fetch_email_metadata,
        extract_facts_opus,
        discover_patterns_opus,
        personalize_opus,
        write_brief_opus,
    )
    from src.activities.pull import backfill_gmail_as_events
    from src.activities.batch_processor import process_stream_batch

ONBOARD_PATH = "/alfred-data/onboard.json"

STAGE_ORDER = [
    "metadata",              # Stage 1: fetch email metadata + snippets
    "facts",                 # Stage 2: extract facts (Opus)
    "patterns",              # Stage 3: discover patterns (Opus)
    "personalize",           # Stage 4: USER.md + SOUL.md + MEMORY.md + TOOLS.md (Opus)
    "awaiting_verification", # Stage 4.5: wait for user to verify key facts
    "brief",                 # Stage 5: First Brief (Opus) — with corrections
    "done",                  # Stage 6: complete — show brief, start background vault build
]


def _stage_index(stage: str) -> int:
    try:
        return STAGE_ORDER.index(stage)
    except ValueError:
        return 0


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

        # Init onboard.json (preserves existing data for resume)
        current_state: dict[str, Any] = await workflow.execute_activity(
            init_onboard_json,
            args=[onboard_path, input.user_id],
            start_to_close_timeout=timedelta(seconds=10),
        )

        current_stage = current_state.get("stage", "metadata")
        resume_idx = _stage_index(current_stage)

        # If already done, skip everything
        if current_stage == "done":
            return OnboardingResult(
                brief_path="event/First Brief.md",
                facts_count=len(current_state.get("facts", [])),
                patterns_count=len(current_state.get("patterns", [])),
            )

        # -----------------------------------------------------------------
        # Stage 1: Fetch email metadata + snippets
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("metadata"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "metadata"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # Activity writes emails directly to onboard.json (too large for
            # Temporal activity result — 5000 emails exceeds 4MB gRPC limit)
            await workflow.execute_activity(
                fetch_email_metadata,
                args=[input.user_id],
                start_to_close_timeout=timedelta(minutes=30),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        # -----------------------------------------------------------------
        # Stage 2: Extract facts (1 Opus call)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("facts"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "facts"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            await workflow.execute_activity(
                extract_facts_opus,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=30),
                schedule_to_start_timeout=timedelta(minutes=15),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        # -----------------------------------------------------------------
        # Stage 3: Discover patterns (1 Opus call)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("patterns"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "patterns"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            await workflow.execute_activity(
                discover_patterns_opus,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        # -----------------------------------------------------------------
        # Stage 4: Personalize (1 Opus call)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("personalize"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "personalize"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            await workflow.execute_activity(
                personalize_opus,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        # -----------------------------------------------------------------
        # Stage 4.5: Wait for user verification of key identity facts
        # The workflow RETURNS here. A separate trigger (from the SaaS
        # submitFactCorrections operation) restarts the workflow to
        # continue from the "brief" stage.
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("awaiting_verification"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "awaiting_verification"],
                start_to_close_timeout=timedelta(seconds=10),
            )
            # Return — dashboard shows the fact verification card.
            # When the user confirms, the workflow is re-triggered
            # and resumes from "brief" stage.
            return OnboardingResult(
                brief_path="",
                facts_count=len(current_state.get("facts", [])),
                patterns_count=len(current_state.get("patterns", [])),
            )

        # -----------------------------------------------------------------
        # Stage 5: First Brief (1 Opus call) — with user corrections
        # -----------------------------------------------------------------
        brief_path = ""
        if resume_idx <= _stage_index("brief"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "brief"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            await workflow.execute_activity(
                write_brief_opus,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            brief_path = "event/First Brief.md"

        # -----------------------------------------------------------------
        # Mark done BEFORE background processing
        # -----------------------------------------------------------------
        await workflow.execute_activity(
            update_onboard_stage,
            args=[onboard_path, "done"],
            start_to_close_timeout=timedelta(seconds=10),
        )

        # -----------------------------------------------------------------
        # Background: full email backfill → batch to inbox → curator
        # -----------------------------------------------------------------
        if input.stream_id:
            # Fetch full emails as stream events
            await workflow.execute_activity(
                backfill_gmail_as_events,
                args=[input.stream_id, input.user_id, 100, 5000],
                start_to_close_timeout=timedelta(minutes=60),
                heartbeat_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # Batch process into inbox for curator
            await workflow.execute_activity(
                process_stream_batch,
                args=[input.stream_id, "gmail"],
                start_to_close_timeout=timedelta(minutes=30),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        return OnboardingResult(
            brief_path=brief_path,
            facts_count=len(current_state.get("facts", [])),
            patterns_count=len(current_state.get("patterns", [])),
        )
