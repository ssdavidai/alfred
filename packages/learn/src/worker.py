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
from src.workflows.chore_promotion import ChorePromotionReflectionWorkflow
from src.workflows.hourly_enrichment import HourlyEnrichmentWorkflow
from src.workflows.plane_sync import PlaneSyncWorkflow
from src.workflows.plane_sync_nudge import PlaneSyncNudgeWorkflow
from src.workflows.plane_reverse_sync import PlaneReverseSyncWorkflow
from src.workflows.plane_reconciliation import PlaneReconciliationWorkflow
from src.workflows.fleet_audit import FleetAuditWorkflow
from src.workflows.composio_reconnect_cleanup import (
    ComposioReconnectCleanupWorkflow,
)

# Chore template workflows (static + dynamic)
from src.workflows.chores import ALL_CHORE_TEMPLATES
from src.workflows.chores._base import (
    decrement_quarantine_remaining,
    get_chore_run_statistics,
    load_chore_context,
    record_chore_run,
)
from src.workflows.chores._dynamic_loader import load_user_chore_templates

# Activities — chore assignment (onboarding Stage 7.5)
from src.activities.assign_chores import assign_initial_chores

# Activities — chore matching (Step 3, Opus-driven template matcher)
from src.activities.chore_matching import match_opportunities_to_templates

# Activities — chore promotion (Step 5, weekly reflection workflow)
from src.activities.chore_promotion import (
    create_github_promotion_pr,
    draft_promotion_proposal,
    identify_promotion_candidates,
    save_promotion_draft,
    scan_user_chores_directory,
)

# Activities — chore code generation (Step 4, Opus generates Python templates)
from src.activities.chore_generation import (
    deploy_generated_template,
    generate_chore_template_code,
    restart_learn_worker,
    smoke_test_generated_template,
    validate_generated_template,
)

# Activities — AgentMail email delivery (First Brief + future outbound)
from src.activities.first_brief_email import send_first_brief_email

# Activities — chore actions
from src.activities.chore_actions import (
    ask_alfred_to_judge_anomalies,
    build_daily_briefing_v2,
    call_composio,
    call_self,
    diff_subscriptions,
    fetch_financial_events,
    fetch_matter_events_last_week,
    filter_anomalies_by_threshold,
    load_subscription_snapshot,
    save_digest_to_vault,
    save_subscription_snapshot,
    send_chore_notification,
    spawn_subagent,
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
    build_sync_args,
    composio_pull,
    http_pull,
    http_pull_detail,
    ingest_events,
    load_stream_config,
    notion_fetch_blocks,
    resolve_auth_header,
    update_cursor,
)

# Activities — stream vault (zero-LLM record creation)
from src.activities.stream_vault import create_stream_vault_record

# Activities — enrichment (batched hourly LLM)
from src.activities.enrichment import (
    apply_enrichments,
    batch_enrich_events,
    ensure_enrichment_entities,
    fetch_pending_enrichment_records,
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
    seed_observations_from_chore_runs,
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

# Activities — Opus-authored pack generators (Plan B)
from src.activities.packs_opus import (
    generate_matter_pack_opus,
    generate_errand_pack_opus,
    generate_instinct_pack_opus,
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

# Composio tool belt activities
from src.activities.composio_tools import (
    list_composio_tools,
    execute_composio_action,
    check_composio_readiness,
    list_composio_connected_accounts,
)

# Ephemeral agent lifecycle (#378)
from src.activities.ephemeral_agent import (
    create_ephemeral_agent,
    delete_ephemeral_agent,
    wait_for_agent_ready,
)

# Plane sync (#536 B4) — vault → Plane one-way sync activities
from src.activities.plane_sync import (
    ensure_inbox_project,
    fetch_changed_matters,
    fetch_single_plane_record,
    fetch_task_records_batch,
    list_changed_task_paths,
    load_plane_sync_state,
    plane_sync_is_enabled,
    preload_project_labels,
    save_plane_sync_state,
    sync_matter_to_plane,
    sync_task_to_plane,
)

# Plane reconciliation — hourly sweep that mirrors REST-deleted issues
# (Plane 1.3.0 doesn't fire ``issue.deleted`` webhooks for REST DELETEs).
from src.activities.plane_reconciliation import (
    plane_reconciliation_is_enabled,
    reconcile_plane_deletes,
)

# Fleet audit — daily wrong-tenant stream contamination check.
from src.activities.fleet_audit import (
    audit_streams_for_owner_mismatch,
    fleet_audit_is_enabled,
    write_fleet_audit_observation,
)

# Composio reconnect cleanup (#645) — Temporal-scheduled safety-net reaper for
# the persistent reconnect ledger written by ctrl-api after PR #646. Coexists
# with the in-process setTimeout fast path on ctrl-api; ledger semantics are
# idempotent so whichever side wins the race, wins.
from src.activities.composio_reconnect import (
    delete_old_connection,
    read_reconnect_ledger,
    remove_ledger_entry,
    verify_new_connection_active,
)

# Plane reverse sync (#536 B7) — Plane → vault ingress activities
from src.activities.plane_reverse_sync import (
    append_plane_comment_to_vault,
    apply_plane_patch_to_vault,
    archive_vault_record,
    check_loop_guards,
    compute_plane_payload_hash,
    create_vault_task_from_plane_issue,
    fetch_plane_events,
    fetch_plane_state_groups,
    find_vault_task_path_by_plane_id,
    load_outbound_signatures,
    load_reverse_sync_state,
    mark_plane_event_processed,
    plane_reverse_sync_is_enabled,
    save_outbound_signatures,
    save_reverse_sync_cursor,
)

# Plane Alfred-as-user triggers (#536 B8)
from src.activities.plane_alfred_triggers import (
    detect_alfred_plane_trigger,
    load_alfred_self_comments,
    record_alfred_self_comment,
    resolve_plane_approval,
    spawn_alfred_for_plane_trigger,
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
    ChorePromotionReflectionWorkflow,
    HourlyEnrichmentWorkflow,
    PlaneSyncWorkflow,
    PlaneSyncNudgeWorkflow,
    PlaneReverseSyncWorkflow,
    PlaneReconciliationWorkflow,
    FleetAuditWorkflow,
    ComposioReconnectCleanupWorkflow,
    *ALL_CHORE_TEMPLATES,
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
    # Stream vault (zero-LLM)
    create_stream_vault_record,
    # Enrichment (batched hourly)
    fetch_pending_enrichment_records,
    batch_enrich_events,
    apply_enrichments,
    ensure_enrichment_entities,
    # Pull
    backfill_gmail_as_events,
    build_sync_args,
    composio_pull,
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
    seed_observations_from_chore_runs,
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
    # Opus-authored packs (Plan B)
    generate_matter_pack_opus,
    generate_errand_pack_opus,
    generate_instinct_pack_opus,
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
    validate_generated_template,
    smoke_test_generated_template,
    deploy_generated_template,
    restart_learn_worker,
    send_first_brief_email,
    load_chore_context,
    record_chore_run,
    decrement_quarantine_remaining,
    get_chore_run_statistics,
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
    # Generic chore primitives — the three passthroughs chores compose from.
    call_self,
    call_composio,
    spawn_subagent,
    # daily_morning_briefing v2 — multi-subagent orchestration on workers
    build_daily_briefing_v2,
    # Chore promotion (Step 5)
    scan_user_chores_directory,
    identify_promotion_candidates,
    draft_promotion_proposal,
    save_promotion_draft,
    create_github_promotion_pr,
    # Composio tool belt (#376) — third-party tool execution
    list_composio_tools,
    execute_composio_action,
    check_composio_readiness,
    list_composio_connected_accounts,
    # Ephemeral agent lifecycle (#378)
    create_ephemeral_agent,
    delete_ephemeral_agent,
    wait_for_agent_ready,
    # Plane sync (#536 B4)
    plane_sync_is_enabled,
    load_plane_sync_state,
    save_plane_sync_state,
    fetch_changed_matters,
    list_changed_task_paths,
    fetch_task_records_batch,
    fetch_single_plane_record,
    sync_matter_to_plane,
    sync_task_to_plane,
    ensure_inbox_project,
    preload_project_labels,
    # Plane reconciliation — hourly REST-delete mirror
    plane_reconciliation_is_enabled,
    reconcile_plane_deletes,
    # Fleet audit — daily wrong-tenant stream contamination check
    fleet_audit_is_enabled,
    audit_streams_for_owner_mismatch,
    write_fleet_audit_observation,
    # Composio reconnect cleanup (#645)
    read_reconnect_ledger,
    verify_new_connection_active,
    delete_old_connection,
    remove_ledger_entry,
    # Plane reverse sync (#536 B7)
    plane_reverse_sync_is_enabled,
    load_reverse_sync_state,
    save_reverse_sync_cursor,
    load_outbound_signatures,
    save_outbound_signatures,
    fetch_plane_events,
    fetch_plane_state_groups,
    compute_plane_payload_hash,
    check_loop_guards,
    apply_plane_patch_to_vault,
    create_vault_task_from_plane_issue,
    find_vault_task_path_by_plane_id,
    append_plane_comment_to_vault,
    archive_vault_record,
    mark_plane_event_processed,
    # Plane Alfred-as-user triggers (#536 B8)
    detect_alfred_plane_trigger,
    spawn_alfred_for_plane_trigger,
    resolve_plane_approval,
    record_alfred_self_comment,
    load_alfred_self_comments,
]


# Dynamically loaded chore templates from /alfred-data/user-chores/.
# Validated via Layer 2 static checks before import. See
# src.workflows.chores._dynamic_loader for the safety boundary.
#
# IMPORTANT: this call MUST come AFTER ALL_ACTIVITIES is defined.
# load_user_chore_templates triggers the Layer 2 validator, which calls
# chore_manifest.get_manifest(), which lazily imports src.worker to
# read ALL_ACTIVITIES. If this call ran before ALL_ACTIVITIES was
# assigned, the manifest would be built from an empty list and every
# validated template would fail with "unknown activity import" even
# when the activities are legitimate. Racy at startup because Python
# module caching can mask the bug depending on import order — fix the
# ordering so it's deterministic.
_DYNAMIC_WORKFLOWS = load_user_chore_templates()

ALL_WORKFLOWS = [*_STATIC_WORKFLOWS, *_DYNAMIC_WORKFLOWS]


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
