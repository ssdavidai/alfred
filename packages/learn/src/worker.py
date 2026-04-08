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
from src.workflows.nightly_maintenance import NightlyMaintenanceWorkflow

# Chore template workflows (static + dynamic)
from src.workflows.chores import ALL_CHORE_TEMPLATES
from src.workflows.chores._base import load_chore_context, record_chore_run
from src.workflows.chores._dynamic_loader import load_user_chore_templates

# Activities — chore assignment (onboarding Stage 7.5)
from src.activities.assign_chores import assign_initial_chores

# Activities — chore matching (Step 3, Opus-driven template matcher)
from src.activities.chore_matching import match_opportunities_to_templates

# Activities — chore code generation (Step 4, Opus generates Python templates)
from src.activities.chore_generation import generate_chore_template_code

# Activities — chore actions
from src.activities.chore_actions import (
    ask_alfred_to_judge_anomalies,
    diff_subscriptions,
    fetch_financial_events,
    fetch_matter_events_last_week,
    filter_anomalies_by_threshold,
    load_subscription_snapshot,
    save_digest_to_vault,
    save_subscription_snapshot,
    send_chore_notification,
    write_matter_digest_via_llm,
)

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
from src.activities.batch_processor import (
    process_stream_batch,
    process_onboarding_facts,
)
from src.activities.onboarding_v3 import (
    fetch_email_metadata,
    extract_facts_opus,
    discover_patterns_opus,
    personalize_opus,
    write_brief_opus,
    write_brief_and_opportunities_opus,
)
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
    drop_raw_event_to_inbox,
    ensure_entities_exist,
    fetch_active_instincts,
    fetch_distiller_learnings,
    fetch_janitor_flags,
    fetch_stream_log,
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

# Activities — stream log
from src.activities.stream_log import append_to_stream_log
from src.activities.maintenance import run_janitor_scan_and_fix, run_distiller_batch

# Activities — behavioral profiler + packs (#283, #284)
from src.activities.profiler import run_behavioral_profiler
from src.activities.packs import (
    generate_stream_pack,
    generate_matter_pack,
    generate_instinct_pack,
    generate_errand_pack,
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


_STATIC_WORKFLOWS = [
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
    NightlyMaintenanceWorkflow,
    *ALL_CHORE_TEMPLATES,
]

# Dynamically loaded chore templates from /alfred-data/user-chores/.
# Validated via Layer 2 static checks before import. See
# src.workflows.chores._dynamic_loader for the safety boundary.
_DYNAMIC_WORKFLOWS = load_user_chore_templates()

ALL_WORKFLOWS = [*_STATIC_WORKFLOWS, *_DYNAMIC_WORKFLOWS]

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
    # Batch processor
    process_stream_batch,
    process_onboarding_facts,
    # Onboarding v3
    fetch_email_metadata,
    extract_facts_opus,
    discover_patterns_opus,
    personalize_opus,
    write_brief_opus,
    write_brief_and_opportunities_opus,
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
    drop_raw_event_to_inbox,
    ensure_entities_exist,
    fetch_active_instincts,
    fetch_distiller_learnings,
    fetch_janitor_flags,
    fetch_stream_log,
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
    # Stream log
    append_to_stream_log,
    # Nightly maintenance
    run_janitor_scan_and_fix,
    run_distiller_batch,
    # Behavioral profiler + packs
    run_behavioral_profiler,
    generate_stream_pack,
    generate_matter_pack,
    generate_instinct_pack,
    generate_errand_pack,
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
    # Chore template helpers + actions + assignment + matching + generation
    assign_initial_chores,
    match_opportunities_to_templates,
    generate_chore_template_code,
    load_chore_context,
    record_chore_run,
    fetch_financial_events,
    load_subscription_snapshot,
    save_subscription_snapshot,
    diff_subscriptions,
    filter_anomalies_by_threshold,
    ask_alfred_to_judge_anomalies,
    fetch_matter_events_last_week,
    write_matter_digest_via_llm,
    save_digest_to_vault,
    send_chore_notification,
]


async def run_worker() -> None:
    config = load_config()

    if not config.enabled:
        logger.info("Alfred Learn is disabled (ALFRED_LEARN_ENABLED=false). Exiting.")
        return

    logger.info("Connecting to Temporal at %s", config.temporal_host)
    client = await Client.connect(config.temporal_host)

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
