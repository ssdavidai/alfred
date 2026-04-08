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
        write_brief_and_opportunities_opus,
    )
    from src.activities.pull import backfill_gmail_as_events
    from src.activities.batch_processor import process_stream_batch
    from src.activities.profiler import run_behavioral_profiler
    from src.activities.packs import (
        generate_stream_pack,
        generate_matter_pack,
        generate_instinct_pack,
        generate_errand_pack,
    )
    from src.activities.packs_opus import (
        generate_errand_pack_opus,
        generate_instinct_pack_opus,
        generate_matter_pack_opus,
    )
    from src.activities.assign_chores import assign_initial_chores
    from src.activities.chore_generation import restart_learn_worker

ONBOARD_PATH = "/alfred-data/onboard.json"

STAGE_ORDER = [
    "metadata",              # Stage 1: fetch email metadata + snippets
    "profiler",              # Stage 2: behavioral profiler (pure Python/ML, no LLM)
    "facts",                 # Stage 3: extract facts (Opus) — enhanced with profiler data
    "patterns",              # Stage 4: discover patterns (Opus) — enhanced with profiler data
    "personalize",           # Stage 5: USER.md + SOUL.md + MEMORY.md + TOOLS.md (Opus)
    "awaiting_verification", # Stage 5.5: wait for user to verify key facts
    "brief",                 # Stage 6: First Brief (Opus) — with corrections
    "packs",                 # Stage 7: generate four packs from profiler data
    "chores",                # Stage 7.5: assign initial chores (templates + schedules)
    "done",                  # Stage 8: complete — show brief, start background vault build
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
        # Stage 2: Behavioral profiler (pure Python/ML, no LLM)
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("profiler"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "profiler"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            await workflow.execute_activity(
                run_behavioral_profiler,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=10),
                heartbeat_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        # -----------------------------------------------------------------
        # Stage 3: Extract facts (1 Opus call) — enhanced with profiler data
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
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=60),
                schedule_to_start_timeout=timedelta(minutes=15),
                retry_policy=RetryPolicy(maximum_attempts=4),
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
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=4),
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
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=4),
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

            # Stage 6 now uses write_brief_and_opportunities_opus which
            # generates the welcome brief AND a structured chore-opportunity
            # list in one Opus call (see PR S2-1). The old write_brief_opus
            # is kept as the activity's internal fallback for when the
            # structured-output parse fails across all retries.
            await workflow.execute_activity(
                write_brief_and_opportunities_opus,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=4),
            )
            brief_path = "event/First Brief.md"

        # -----------------------------------------------------------------
        # Stage 7: Generate four packs from profiler data
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("packs"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "packs"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # Run pack generators sequentially.
            # Matter pack uses Opus-authored version (Plan B.1) which
            # falls back to generate_matter_pack on any failure.
            # Timeout bumped to 15 minutes to accommodate the Opus call
            # (typical ~60-120 seconds, retry budget eats the rest).
            await workflow.execute_activity(
                generate_matter_pack_opus,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            # Instinct pack uses Opus-authored version (Plan B.3) which
            # falls back to generate_instinct_pack on any failure.
            await workflow.execute_activity(
                generate_instinct_pack_opus,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            # Errand pack uses Opus-authored version (Plan B.2) which
            # falls back to generate_errand_pack on any failure.
            await workflow.execute_activity(
                generate_errand_pack_opus,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            await workflow.execute_activity(
                generate_stream_pack,
                args=[onboard_path],
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        # -----------------------------------------------------------------
        # Stage 7.5: Assign initial chores from profile
        # -----------------------------------------------------------------
        if resume_idx <= _stage_index("chores"):
            await workflow.execute_activity(
                update_onboard_stage,
                args=[onboard_path, "chores"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # Assign initial chores runs the full chain:
            #  - Opus template matching (Step 3)
            #  - S4-8 generation chain for unmatched opportunities
            #    (generate → validate → smoke → deploy, up to 3 templates)
            # Timeout extended to 20 minutes because each generation attempt
            # can make up to 3 Opus calls (_call_llm total timeout 600s per
            # call) and we can generate up to 3 templates in one run.
            chore_result = await workflow.execute_activity(
                assign_initial_chores,
                args=[onboard_path, input.user_id],
                start_to_close_timeout=timedelta(minutes=20),
                heartbeat_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # If any templates were generated, we need to restart the
            # alfred-learn worker so load_user_chore_templates picks
            # them up on next boot. This activity kills its own worker
            # mid-flight — Temporal's retry policy handles reconnection
            # automatically when the new worker comes online.
            if isinstance(chore_result, dict) and chore_result.get("generated", 0) > 0:
                workflow.logger.info(
                    "Stage 7.5 generated %d templates — triggering worker restart",
                    chore_result["generated"],
                )
                await workflow.execute_activity(
                    restart_learn_worker,
                    start_to_close_timeout=timedelta(minutes=3),
                    heartbeat_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(
                        maximum_attempts=2,
                        initial_interval=timedelta(seconds=30),
                    ),
                )

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
