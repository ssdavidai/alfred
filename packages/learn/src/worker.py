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
from src.workflows.plane_reverse_sync import PlaneReverseSyncWorkflow
from src.workflows.plane_reconciliation import PlaneReconciliationWorkflow
from src.workflows.fleet_audit import FleetAuditWorkflow
from src.workflows.composio_reconnect_cleanup import (
    ComposioReconnectCleanupWorkflow,
)
# Phase 2 #23: OpenclawSessionSweepWorkflow + sweep_openclaw_bak_sessions
# were DELETED. The .bak-* session reaper existed only because OpenClaw
# did O(N) readdir over per-agent .jsonl files; Hermes' SQLite
# SessionStore makes that CPU-peg failure mode structurally impossible.
# Safe to remove workflow + activity outright: alfred-black is a fresh
# deploy with no Temporal history that could reference them on replay.
from src.workflows.steward import StewardWorkflow, StewardSweepWorkflow
from src.workflows.nightly_narrative import NightlyNarrativeWorkflow
from src.workflows.decision_router import DecisionRouterWorkflow
from src.workflows.decision_patterns import DecisionPatternsWorkflow
from src.workflows.pattern_detection import PatternDetectionWorkflow
from src.workflows.defer_resurface import DeferResurfaceWorkflow
from src.workflows.task_closure import TaskClosureWatcherWorkflow
from src.workflows.scheduled_dispatch import ScheduledDispatchWorkflow
from src.workflows.decay_watcher import DecayWatcherWorkflow
from src.workflows.meeting_capture import MeetingCaptureWorkflow
from src.workflows.transcript_intake import TranscriptIntakeWorkflow
from src.workflows.signals import SignalExtractWorkflow
from src.workflows.signal_router import (
    SignalRouterWorkflow,
    mark_signal_status,
)
from src.workflows.stream_event_purge import StreamEventPurgeWorkflow
from src.workflows.reversal_calibration import ReversalCalibrationWorkflow
from src.workflows.briefing import BriefingWorkflow

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
    collect_living_brief_data,
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
from src.activities.maintenance import (
    purge_old_stream_events,
    run_distiller_batch,
    run_janitor_scan_and_fix,
)

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

# Ephemeral agent lifecycle (#378; Phase 2 #22 — Hermes-native).
# wait_for_agent_ready and delete_ephemeral_agent are gone (#43): a
# Hermes run needs no hot-reload wait and self-cleans via the SQLite
# SessionStore. Neither was ever scheduled via workflow.execute_activity
# — both were only direct ``await`` calls inside the
# dispatch_action_to_agent activity body — so removing them is
# replay-safe (no workflow history records them).
from src.activities.ephemeral_agent import create_ephemeral_agent

# Tool inference for delegate dispatch — maps source_type → Composio
# action slug hints injected into the executor's prompt.
from src.activities.tool_inference import (
    infer_required_tools,
)

# Task closure watcher — backward arrow of the signal-task loop.
# Inbound signals get checked against open tasks; high-confidence
# matches auto-close the task via a decision(intent=done) record.
from src.activities.task_closure import (
    apply_task_closure_v2,
    list_open_tasks,
    list_recent_signals,
    assess_closure,
    assess_closure_predicate,
    write_closure_decision,
)

# Signal → observation extractor (OBS-2). Fires per signal write
# inside SignalExtractWorkflow.
from src.activities.signal_observations import (
    extract_observation_from_signal,
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

# Phase 2 #23: the openclaw .bak-* session reaper activity
# (sweep_openclaw_bak_sessions) was DELETED — Hermes' SQLite
# SessionStore removes the O(N) readdir leak it existed to mop up.

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

# Steward (#835 Phase 0 + #836 Phase 0.5 + #837 Phase 1 + #838 Phase 2)
# — per-matter perception loop.
# Phase 0: no-op evaluator + cursor-stamping activity (registered for
# the Schedule infrastructure). Phase 0.5 adds ``apply_state_change`` —
# the audit-trail emitter that writes one ``event/steward-action-*.md``
# vault record per Steward decision in shadow mode (no task mutation,
# no Plane action). Phase 1 (#837) wires the first signal source
# (``vault:record``) and shadow LLM evaluation: ``evaluate_task`` now
# orchestrates ``gather_signals_vault_record`` → ``evaluate_state`` →
# ``apply_state_change(mode="shadow")``. Phase 2 (#838) adds three more
# signal sources (gmail / sure / ctrl-api stream) plus the matter-level
# cadence backoff bookkeeping. Phase 3 (#839) will flip
# ``apply_state_change`` to ``mode="live"``.
from src.activities.steward import (
    apply_state_change as steward_apply_state_change,
    evaluate_state as steward_evaluate_state,
    evaluate_task as steward_evaluate_task,
    gather_signals_ctrl_api_stream as steward_gather_signals_ctrl_api_stream,
    gather_signals_gmail as steward_gather_signals_gmail,
    gather_signals_sure as steward_gather_signals_sure,
    gather_signals_vault_record as steward_gather_signals_vault_record,
    list_due_steward_matters as steward_list_due_steward_matters,
    load_matter_tasks as steward_load_matter_tasks,
    record_steward_check as steward_record_steward_check,
    update_matter_cadence as steward_update_matter_cadence,
)

# State-mutation Phase A (#889) — universal state-mutator primitive.
# ``apply_state_change_v2`` is the read-reason-write-log entry point
# every state writer routes through. ``read_target`` + ``gather_observed``
# are helper activities for Pattern A workflows (spec §6.1) that don't
# already have the prior state + observed window in hand. The legacy
# Steward ``apply_state_change`` (v1) is untouched in Phase A and will
# become a backwards-compat shim around v2 in Phase B.
from src.activities.state_mutator import (
    apply_state_change_v2,
    gather_observed as state_mutator_gather_observed,
    read_target as state_mutator_read_target,
)

# State-mutation Phase D writers — propose functions register
# themselves with the propose-fn registry on import. They are NOT
# Temporal activities (the universal mutator dispatches them
# in-process), but the worker imports them so the registry is
# populated before any workflow asks the mutator for a propose function
# by name. See ``docs/STATE-MUTATION.md`` §6.1+§6.2.
import src.activities.archival_sweep  # noqa: F401 — register archival_sweep.cold

# Steward Phase 4 (#840) — Vexa transcript intake. Activities back the
# MeetingCaptureWorkflow + TranscriptIntakeWorkflow. NO direct Plane
# writes from these — every action becomes a Steward signal of kind
# ``transcript:action_candidate`` for Phase 3's apply_state_change to
# consume on the relevant matter's next tick.
from src.activities.transcript import (
    apply_transcript_action,
    extract_actions_from_transcript,
    find_upcoming_meet_events,
    list_unprocessed_transcript_events,
    mark_transcript_event_processed,
    vexa_get_transcript,
    vexa_join_meeting,
)

# Steward Phase 6 (RFC #842 / T6.0.5) — signal extraction. Activities
# back the SignalExtractWorkflow which runs every 5 minutes (registered
# in scripts/register_schedules.py, gated on
# STEWARD_SIGNAL_EXTRACT_ENABLED at registration time only). The four
# activities cover: list unprocessed events, run the LLM extractor,
# persist signal records, and mark the source event processed.
from src.activities.signals import (
    extract_signal_from_event,
    # Phase 1 multi-signal extractor — wired in via
    # workflow.patched("signal_extract_multi_signal_v1") in
    # SignalExtractWorkflow. Returns list[dict] (one event -> N signals).
    extract_signals_from_event,
    list_unprocessed_stream_events,
    mark_stream_event_processed,
    write_signal_record,
)

# Steward Phase 6 (RFC #842 / T6.5.1) — auto-create tasks when a signal
# has no resolvable target. The activity is invoked from inside
# extract_signal_from_event when target resolution returns no match
# AND the signal carries effect ∈ {"action", "mutation"} AND the
# STEWARD_SIGNAL_AUTOCREATE_TASKS env var is "true". Idempotency cache
# lives at /alfred-data/state/steward/signal-task-creation.json.
from src.activities.task_creation import create_task_from_signal

# Steward Phase 6 (RFC #842 / T6.3.2 + T6.3.3) — signal router.
# Reads ``signal/`` records with ``effect=mutation`` and applies them
# via Steward's ``apply_state_change`` (which T6.3.1 extended for
# matter targets). Mode gate is ``STEWARD_SIGNAL_ROUTER_LIVE_MODE``,
# read by the activity on each invocation; registration-time gate is
# ``STEWARD_SIGNAL_ROUTER_ENABLED``.
from src.activities.signal_mutations import (
    apply_signal_mutation,
    list_unrouted_signals,
)

# Steward Phase 6 (RFC #842 / T6.4.1–T6.4.4) — signal action router.
# Routes ``signal/`` records with ``effect=action`` to either openclaw
# main (HIGH path: matched instinct + above discretion threshold +
# non-shadow effective mode) or to ``needs_attention/<ts>.md`` cards
# the dashboard surfaces (HUMAN path: anything else). Mode gate is
# ``STEWARD_SIGNAL_ACTION_LIVE_MODE``, read by the activity at
# invocation time.
from src.activities.signal_actions import (
    dispatch_action_to_agent,
    route_signal_action,
    write_needs_attention_record,
)

# Steward Phase 6 (RFC #842 / T6.7.5) — reversal-driven negative-feedback
# calibration. Runs in its own ReversalCalibrationWorkflow on a 10-min
# schedule. Reads ``event/steward-action-reversed-*.md`` and
# ``event/signal-action-reversed-*.md`` records, drops the contributing
# source-types' confidence by 0.1 (immediate, not EMA — see
# steward.NEGATIVE_FEEDBACK_PENALTY), persists the source-type
# calibration block + processed-reversals cache at
# ``/alfred-data/state/steward/reversal-calibration.json``. Gated on
# ``STEWARD_REVERSAL_CALIBRATION_ENABLED`` at activity-invocation time
# AND at registration time; safe to register the activity unconditionally.
from src.activities.calibration_reversal import (
    process_reversals_for_calibration,
)

# Nightly narrative (RFC #884) — model-written matter status paragraphs.
# Activities back NightlyNarrativeWorkflow; the schedule lives in
# scripts/register_schedules.py as ``al-nightly-narrative`` (cron 0 2 * * *).
from src.activities.nightly_narrative import (
    apply_matter_narrative_v2 as narrative_apply_matter_narrative_v2,
    generate_matter_narrative as narrative_generate,
    list_active_matters as narrative_list_active_matters,
    load_matter_signals_24h as narrative_load_matter_signals_24h,
    load_source_events as narrative_load_source_events,
    load_task_transitions_24h as narrative_load_task_transitions_24h,
    patch_matter_narrative as narrative_patch_matter_narrative,
    read_matter_summary as narrative_read_matter_summary,
)

# Decision router — every Desk click writes a decision/<ts>.md record;
# this workflow (cron */1 min) reads them, runs side effects (status
# flips, signal re-arms, to_do spawns, outcome polling) and flips the
# decision state. Schedule registered as ``al-decision-router``.
from src.activities.decision_router import (
    apply_decision_outcome_link_v2 as dr_apply_outcome_link_v2,
    check_decision_outcomes as dr_check_outcomes,
    list_decisions_by_state as dr_list_decisions,
    reverse_decision as dr_reverse_decision,
    route_decision as dr_route_decision,
)

# Decision pattern extraction (daily 3am) — groups recent decisions by
# matter, asks clerk for recurring rules, writes proposed
# decision_pattern records for principal review on /study.
from src.activities.decision_patterns import (
    extract_decision_patterns as dp_extract,
)

# Pattern detection (OBS-4, hourly) — deterministic clustering over
# the unified observation pool. Writes pattern_proposal records that
# OBS-5's acceptor materialises into instincts once the principal
# clicks Delegate on the /desk card.
from src.activities.pattern_detection import (
    detect_pattern_proposals as pd_detect,
)

# Defer resurface — parses "when shall I resurface this?" notes into
# concrete datetimes and re-flips skipped needs_attention back to
# pending when their resurface_at falls due.
from src.activities.defer_resurface import (
    parse_resurface_time as dr_parse_resurface,
    resurface_due_needs_attention as dr_resurface_due,
    stamp_resurface_on_needs_attention as dr_stamp_resurface,
)

# Scheduled dispatch — fires delegate-with-note decisions when their
# execute_at falls due.
from src.activities.scheduled_dispatch import (
    fire_due_scheduled_dispatches as sd_fire_due,
)

# Noise patterns — materialised when the principal clicks "Noise" on a
# Desk card. Activity writes signal_noise_pattern records; signal_extract
# consults them before LLM calls.
from src.activities.noise_patterns import (
    write_noise_pattern as np_write,
)

# Decay watcher — six-hourly sweep that stamps freshness bands on
# pending needs_attention cards and auto-flips deeply stale ones to
# status=stale, keeping the Desk free of origin-old residue.
#
# SM-D-W8 (#892) — the workflow's patched branch additionally adjusts
# matter ``surface_class`` based on activity-decay bands through the
# universal state-mutator. The propose function
# ``decay_watcher.adjust`` is registered at module import time (the
# decay_watcher activity module declares it via @propose_fn). Two new
# activities back the patched branch:
#   * ``list_active_matters_for_decay`` — matter enumerator.
#   * ``adjust_matter_surface_class_v2`` — per-matter v2 wrapper.
from src.activities.decay_watcher import (
    adjust_matter_surface_class_v2 as dw_adjust_v2,
    list_active_matters_for_decay as dw_list_matters,
    watch_decay as dw_watch,
)

# Decisions → observations + pattern-proposal lifecycle. Every click
# distills into an observation the intuition engine consumes; pattern
# proposals materialize as instinct records when adopted.
from src.activities.decision_observations import (
    extract_observation_from_decision as do_extract_obs,
    adopt_instinct_from_pattern as do_adopt_pattern,
    reject_pattern_proposal as do_reject_pattern,
)

# State-mutation Phase E (#893) — BriefingWorkflow + activities.
# Morning + evening briefings are two writers under the universal
# contract. ``briefing.propose_matter_update`` registers itself with
# the propose-fn registry on import (the universal mutator dispatches
# it in-process by name); the four activities below are dispatched by
# ``BriefingWorkflow.run`` directly.
from src.activities.briefing import (
    briefing_visit_matter,
    compose_and_write_briefing,
    get_prior_briefing,
    list_active_matters_for_briefing,
)

# Validators used as activities
from src.validators.frontmatter import validate_classification

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("alfred-learn")


_STATIC_WORKFLOWS = [
    EventProcessorWorkflow,
    SessionTrackerWorkflow,
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
    PlaneReverseSyncWorkflow,
    PlaneReconciliationWorkflow,
    FleetAuditWorkflow,
    ComposioReconnectCleanupWorkflow,
    # OpenclawSessionSweepWorkflow removed — Phase 2 #23.
    # StewardWorkflow kept registered as a tombstone (#52): no longer
    # scheduled per-matter, but callable ad-hoc and harmless to register.
    StewardWorkflow,
    StewardSweepWorkflow,
    NightlyNarrativeWorkflow,
    DecisionRouterWorkflow,
    DecisionPatternsWorkflow,
    PatternDetectionWorkflow,
    DeferResurfaceWorkflow,
    TaskClosureWatcherWorkflow,
    ScheduledDispatchWorkflow,
    DecayWatcherWorkflow,
    MeetingCaptureWorkflow,
    TranscriptIntakeWorkflow,
    SignalExtractWorkflow,
    SignalRouterWorkflow,
    StreamEventPurgeWorkflow,
    ReversalCalibrationWorkflow,
    BriefingWorkflow,
    *ALL_CHORE_TEMPLATES,
]

ALL_ACTIVITIES = [
    # Clerk
    clerk_classify,
    clerk_compare_topics,
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
    collect_living_brief_data,
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
    # Stream-event purge (Phase 6.6 / T6.6.3) — daily 03:00 UTC purge
    # of stream_event/ records >7 days old that have signal_extracted_at
    # set. Gated on STEWARD_STREAM_EVENT_PURGE_ENABLED at both
    # registration time AND activity-invocation time.
    purge_old_stream_events,
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
    # Ephemeral agent lifecycle (#378; Phase 2 #22 — Hermes-native).
    # delete_ephemeral_agent and wait_for_agent_ready were removed (#43):
    # never scheduled as activities, only direct ``await`` calls inside
    # the dispatch_action_to_agent activity body — replay-safe to drop.
    create_ephemeral_agent,
    # Tool inference for delegate dispatch
    infer_required_tools,
    # Task closure watcher — signal-closes-task backward arrow
    list_open_tasks,
    list_recent_signals,
    assess_closure,
    assess_closure_predicate,
    write_closure_decision,
    # SM-D-W4: v2 wrapper that emits state_change audit + flips task
    # status="closed" + outcome=... on the matched task.
    apply_task_closure_v2,
    # OBS-2 — signal → observation extractor
    extract_observation_from_signal,
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
    # sweep_openclaw_bak_sessions removed — Phase 2 #23.
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
    # Steward (#835 Phase 0 + #836 Phase 0.5 + #837 Phase 1 + #838
    # Phase 2) — per-matter perception loop. Phase 1 added
    # gather_signals_vault_record + evaluate_state. Phase 2 adds the
    # gmail / sure / ctrl-api stream gatherers plus the matter-level
    # cadence backoff helper.
    steward_list_due_steward_matters,
    steward_load_matter_tasks,
    steward_evaluate_task,
    steward_record_steward_check,
    steward_apply_state_change,
    steward_gather_signals_vault_record,
    steward_gather_signals_gmail,
    steward_gather_signals_sure,
    steward_gather_signals_ctrl_api_stream,
    steward_evaluate_state,
    steward_update_matter_cadence,
    # State-mutation Phase A (#889) — universal mutator + helpers.
    apply_state_change_v2,
    state_mutator_read_target,
    state_mutator_gather_observed,
    # Steward Phase 4 (#840) — Vexa transcript intake activities.
    find_upcoming_meet_events,
    vexa_join_meeting,
    vexa_get_transcript,
    extract_actions_from_transcript,
    apply_transcript_action,
    list_unprocessed_transcript_events,
    mark_transcript_event_processed,
    # Steward Phase 6 (RFC #842 / T6.0.5) — signal extraction. The
    # SignalExtractWorkflow drives these; the schedule that triggers
    # the workflow is gated on STEWARD_SIGNAL_EXTRACT_ENABLED at
    # registration time so a tenant without the flag never invokes
    # them. Registering them unconditionally here is safe (and
    # required for the worker to handle the workflow's activity
    # dispatches once the flag flips on).
    list_unprocessed_stream_events,
    extract_signal_from_event,
    # Phase 1 multi-signal extractor — registered alongside the legacy
    # single-signal extractor. SignalExtractWorkflow picks via
    # workflow.patched("signal_extract_multi_signal_v1").
    extract_signals_from_event,
    write_signal_record,
    mark_stream_event_processed,
    # Steward Phase 6 (T6.5.1) — auto-create tasks for no-target
    # signals. Invoked from inside extract_signal_from_event; the env
    # gate (STEWARD_SIGNAL_AUTOCREATE_TASKS) is read at activity
    # invocation time so registering unconditionally here is safe.
    create_task_from_signal,
    # Steward Phase 6 (T6.3.2 + T6.3.3) — signal router. The
    # SignalRouterWorkflow drives apply_signal_mutation on each
    # unrouted ``effect=mutation`` signal; list_unrouted_signals scans
    # vault/signal/ for records pending routing; mark_signal_status
    # patches the action_pending / skipped statuses for the
    # non-mutation branches. The router schedule is gated on
    # STEWARD_SIGNAL_ROUTER_ENABLED at registration time and the
    # apply-mode is gated on STEWARD_SIGNAL_ROUTER_LIVE_MODE at
    # activity-invocation time.
    list_unrouted_signals,
    apply_signal_mutation,
    mark_signal_status,
    # Steward Phase 6 (T6.4.1–T6.4.4) — signal action router. The
    # SignalRouterWorkflow now dispatches route_signal_action for
    # effect=action signals (replacing the action_pending mark).
    # dispatch_action_to_agent + write_needs_attention_record are
    # exposed independently so smoke tests / future workflows can
    # invoke them directly. The autonomous-dispatch path is gated on
    # STEWARD_SIGNAL_ACTION_LIVE_MODE at activity-invocation time.
    route_signal_action,
    dispatch_action_to_agent,
    write_needs_attention_record,
    # Steward Phase 6 (T6.7.5) — reversal-driven negative-feedback
    # calibration. Activity is gated on
    # STEWARD_REVERSAL_CALIBRATION_ENABLED at invocation time so
    # registering unconditionally is safe; the schedule that triggers
    # ReversalCalibrationWorkflow is also registration-time-gated.
    process_reversals_for_calibration,
    # Nightly narrative (RFC #884) — Workflow 7. One clerk call per
    # matter to refresh ``current_state`` + ``as_of``. Schedule:
    # ``al-nightly-narrative``, cron ``0 2 * * *``. Workflow is
    # idempotent: matters with zero signals AND zero task transitions
    # in the lookback window are skipped (no LLM, no patch).
    narrative_list_active_matters,
    narrative_read_matter_summary,
    narrative_load_matter_signals_24h,
    narrative_load_task_transitions_24h,
    narrative_load_source_events,
    narrative_generate,
    narrative_patch_matter_narrative,
    # State-mutation Phase C (#891) — v2-retrofitted per-matter writer.
    # The new wrapper activity ``apply_matter_narrative_v2`` is dispatched
    # by ``NightlyNarrativeWorkflow.run`` under the
    # ``nightly_narrative_state_mutator_v1`` patched gate; legacy
    # histories continue to drive the pre-patch direct-PATCH activities.
    narrative_apply_matter_narrative_v2,
    # Decision router (every Desk click → vault record → side-effect
    # cascade). Activities back DecisionRouterWorkflow.
    dr_list_decisions,
    dr_route_decision,
    dr_reverse_decision,
    dr_check_outcomes,
    # SM-D-W7: per-match task-side outcome linkage through
    # state_mutator v2. Workflow gates the fan-out behind
    # ``decision_router_outcome_state_mutator_v1`` patched gate.
    dr_apply_outcome_link_v2,
    # Decision pattern extraction (daily) — extracts recurring rules
    # from the principal's recent decisions per matter.
    dp_extract,
    # Pattern detection (hourly, OBS-4) — deterministic clustering
    # over the unified observation pool.
    pd_detect,
    # Defer resurface (hourly + on-defer parse).
    dr_parse_resurface,
    dr_stamp_resurface,
    dr_resurface_due,
    # Decisions → observations + pattern-proposal lifecycle.
    do_extract_obs,
    do_adopt_pattern,
    do_reject_pattern,
    # Scheduled dispatch — fires delegate-with-when at the right time.
    sd_fire_due,
    # Noise pattern materialisation — runs after intent=noise click.
    np_write,
    # Decay watcher — stamps freshness bands, auto-flips deeply stale.
    # SM-D-W8 (#892) adds the matter surface_class adjustment pass —
    # ``list_active_matters_for_decay`` enumerates, ``adjust_matter_surface_class_v2``
    # routes each matter through the universal state-mutator behind
    # the ``decay_watcher_state_mutator_v1`` patched gate.
    dw_watch,
    dw_list_matters,
    dw_adjust_v2,
    # State-mutation Phase E (#893) — BriefingWorkflow activities. The
    # propose function ``briefing.propose_matter_update`` is registered
    # on import of ``src.activities.briefing``; the four activities
    # below back the morning + evening briefing slots through
    # ``BriefingWorkflow.run``.
    list_active_matters_for_briefing,
    get_prior_briefing,
    briefing_visit_matter,
    compose_and_write_briefing,
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
