"""Temporal worker entry point — registers all workflows and activities."""

from __future__ import annotations

import asyncio
import logging

from temporalio.client import Client
from temporalio.worker import Worker

from src.config import load_config

# Workflows
from src.workflows.event_processor import EventProcessorWorkflow
from src.workflows.session_tracker import SessionTrackerWorkflow
from src.workflows.daily_digest import DailyDigestWorkflow
from src.workflows.learning import LearningWorkflow
from src.workflows.reflection import ReflectionWorkflow
from src.workflows.judgment import JudgmentWorkflow
from src.workflows.media_ingestion import MediaIngestionWorkflow
from src.workflows.task_runner import TaskRunnerWorkflow
from src.workflows.stream_puller import StreamPullerWorkflow
from src.workflows.onboarding_pipeline import OnboardingPipelineWorkflow
from src.workflows.omi_processor import OmiAudioProcessorWorkflow

# Activities — clerk
from src.activities.clerk import (
    clerk_classify,
    clerk_compare_topics,
    clerk_daily_digest,
    clerk_execute_instructions,
    clerk_extract_braindump,
    clerk_extract_hint_observation,
    clerk_extract_instruction_observation,
    clerk_extract_observation,
    clerk_match_session_context,
    clerk_process_media,
    clerk_reflect,
    clerk_session_boundary,
)

# Activities — streams
from src.activities.streams import (
    fetch_unprocessed_events,
    mark_event_processed,
    quarantine_event,
)

# Activities — pull
from src.activities.pull import (
    backfill_gmail_as_events,
    http_pull,
    http_pull_detail,
    ingest_events,
    load_stream_config,
    notion_fetch_blocks,
    resolve_auth_header,
    update_cursor,
)

# Activities — vault
from src.activities.vault import (
    apply_instinct_change,
    assign_records_to_session,
    collect_daily_activity,
    create_session_record,
    ensure_entities_exist,
    fetch_active_instincts,
    fetch_distiller_learnings,
    fetch_janitor_flags,
    fetch_unassigned_records,
    fetch_unprocessed_observations,
    mark_observations_processed,
    rebuild_intuition_index,
    write_digest_record,
    write_observation_record,
    write_reflection_report,
    write_vault_record,
)

# Activities — classify
from src.activities.classify import (
    classify_event,
    extract_metadata,
)

# Activities — session
from src.activities.session import (
    append_to_session,
    close_session,
    create_session,
    detect_session_boundaries,
    fetch_recent_records,
    read_session_state,
    write_session_state,
)

# Activities — notify
from src.activities.notify import notify_digest_ready, notify_eod_prompt, escalate_to_user

# Activities — observe
from src.activities.observe import (
    clear_observation_queue,
    execute_alfred_instructions,
    execute_routing_hint,
    read_observation_queue,
    scan_alfred_instructions,
    validate_observation,
)

# Activities — reflect
from src.activities.reflect import validate_proposals

# Activities — judge
from src.activities.judge import (
    attempt_judgment,
    execute_route,
    fetch_unrouted_inputs,
    load_intuition_index,
    score_instincts,
)

# Activities — onboarding v2
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

# Activities — omi audio
from src.activities.omi_audio import (
    group_audio_segments,
    ingest_omi_transcription,
    scan_audio_buffer,
    transcribe_audio_group,
)

# Activities — braindump
from src.activities.braindump import detect_braindump, extract_braindump

# Activities — tasks
from src.activities.tasks import (
    assemble_task_context,
    check_task_prerequisites,
    complete_task,
    evaluate_consequentials,
    execute_task,
    fetch_queued_tasks,
    update_task_status,
    write_ledger_entry,
    write_task_artifacts,
)

# Activities — media
from src.activities.media import (
    detect_file_type,
    process_audio,
    process_document,
    process_image,
)

# Validators used as activities
from src.validators.frontmatter import validate_classification

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("alfred-learn")


ALL_WORKFLOWS = [
    EventProcessorWorkflow,
    SessionTrackerWorkflow,
    DailyDigestWorkflow,
    LearningWorkflow,
    ReflectionWorkflow,
    JudgmentWorkflow,
    MediaIngestionWorkflow,
    TaskRunnerWorkflow,
    StreamPullerWorkflow,
    OnboardingPipelineWorkflow,
    OmiAudioProcessorWorkflow,
]

ALL_ACTIVITIES = [
    # Clerk
    clerk_classify,
    clerk_compare_topics,
    clerk_daily_digest,
    clerk_execute_instructions,
    clerk_extract_braindump,
    clerk_extract_hint_observation,
    clerk_extract_instruction_observation,
    clerk_extract_observation,
    clerk_match_session_context,
    clerk_process_media,
    clerk_reflect,
    clerk_session_boundary,
    # Streams
    fetch_unprocessed_events,
    mark_event_processed,
    quarantine_event,
    # Pull
    backfill_gmail_as_events,
    http_pull,
    http_pull_detail,
    ingest_events,
    load_stream_config,
    notion_fetch_blocks,
    resolve_auth_header,
    update_cursor,
    # Vault
    apply_instinct_change,
    assign_records_to_session,
    collect_daily_activity,
    create_session_record,
    ensure_entities_exist,
    fetch_active_instincts,
    fetch_distiller_learnings,
    fetch_janitor_flags,
    fetch_unassigned_records,
    fetch_unprocessed_observations,
    mark_observations_processed,
    rebuild_intuition_index,
    write_digest_record,
    write_observation_record,
    write_reflection_report,
    write_vault_record,
    # Classify
    classify_event,
    extract_metadata,
    # Session
    append_to_session,
    close_session,
    create_session,
    detect_session_boundaries,
    fetch_recent_records,
    read_session_state,
    write_session_state,
    # Notify
    notify_digest_ready,
    notify_eod_prompt,
    escalate_to_user,
    # Observe
    clear_observation_queue,
    execute_alfred_instructions,
    execute_routing_hint,
    read_observation_queue,
    scan_alfred_instructions,
    validate_observation,
    # Reflect
    validate_proposals,
    # Judge
    attempt_judgment,
    execute_route,
    fetch_unrouted_inputs,
    load_intuition_index,
    score_instincts,
    # Tasks
    assemble_task_context,
    check_task_prerequisites,
    complete_task,
    evaluate_consequentials,
    execute_task,
    fetch_queued_tasks,
    update_task_status,
    write_ledger_entry,
    write_task_artifacts,
    # Onboarding v2
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
    # Braindump
    detect_braindump,
    extract_braindump,
    # Media
    detect_file_type,
    process_audio,
    process_document,
    process_image,
    # Omi Audio
    scan_audio_buffer,
    group_audio_segments,
    transcribe_audio_group,
    ingest_omi_transcription,
    # Validators
    validate_classification,
]


async def run_worker() -> None:
    config = load_config()

    if not config.enabled:
        logger.info("Alfred Learn is disabled (ALFRED_LEARN_ENABLED=false). Exiting.")
        return

    logger.info("Connecting to Temporal at %s", config.temporal_host)
    client = await Client.connect(config.temporal_host)

    # Pre-warm Whisper model so first transcription doesn't timeout
    from src.whisper_model import warmup as whisper_warmup
    whisper_warmup()

    logger.info("Starting worker on task queue: %s", config.task_queue)
    worker = Worker(
        client,
        task_queue=config.task_queue,
        workflows=ALL_WORKFLOWS,
        activities=ALL_ACTIVITIES,
    )

    logger.info("Alfred Learn worker running.")
    await worker.run()


def main() -> None:
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
