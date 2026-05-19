"""Register all Temporal schedules for alfred-learn.

Run on container first boot:
    python -m scripts.register_schedules
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from datetime import timedelta
from typing import Any

import httpx
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleIntervalSpec,
    ScheduleOverlapPolicy,
    SchedulePolicy,
    ScheduleSpec,
    ScheduleCalendarSpec,
    ScheduleRange,
    ScheduleUpdate,
    ScheduleUpdateInput,
)
from temporalio.service import RPCError, RPCStatusCode

from src.config import load_config

PLANE_SYNC_SCHEDULE_ID = "al-plane-sync"
PLANE_SYNC_WORKFLOW = "PlaneSyncWorkflow"
PLANE_SYNC_NOTE = (
    "Sync vault matters/tasks → Plane projects/issues every 15s. "
    "Feature-gated by PLANE_SYNC_ENABLED env."
)

PLANE_REVERSE_SYNC_SCHEDULE_ID = "al-plane-reverse-sync"
PLANE_REVERSE_SYNC_WORKFLOW = "PlaneReverseSyncWorkflow"
PLANE_REVERSE_SYNC_NOTE = (
    "Sync Plane webhook events → vault matter/task updates every 10s. "
    "Feature-gated by PLANE_SYNC_ENABLED env."
)

PLANE_RECONCILIATION_SCHEDULE_ID = "al-plane-reconciliation"
PLANE_RECONCILIATION_WORKFLOW = "PlaneReconciliationWorkflow"
PLANE_RECONCILIATION_NOTE = (
    "Hourly sweep that mirrors Plane REST-deletes (not webhooked in 1.3.0) "
    "into vault archives. Feature-gated by PLANE_SYNC_ENABLED env."
)

FLEET_AUDIT_SCHEDULE_ID = "al-fleet-audit"
FLEET_AUDIT_WORKFLOW = "FleetAuditWorkflow"
FLEET_AUDIT_NOTE = (
    "Daily wrong-tenant stream contamination check. Scans "
    "composio-*.jsonl for self:true attendees whose email doesn't match "
    "the tenant owner. Feature-gated by FLEET_AUDIT_ENABLED env (default "
    "true)."
)

# Steward (#835) — per-matter perception loop. One schedule per
# matter named ``al-steward-<matter-slug>``. Phase 0 cadence is the
# Layer 3 default (30 min). Layer 2 polled-source-tied cadences and
# Layer 1 webhook nudges arrive in Phase 2.
STEWARD_SCHEDULE_PREFIX = "al-steward-"
STEWARD_WORKFLOW = "StewardWorkflow"
STEWARD_DEFAULT_INTERVAL = timedelta(minutes=30)

# Steward Phase 4 (#840) — Vexa transcript intake. Two singleton
# schedules: MeetingCapture polls the gcal stream and dispatches the
# Vexa bot for upcoming Meet events; TranscriptIntake polls Vexa's
# webhook stream and feeds extracted action items back into Steward.
# Both are gated on ``VEXA_ENABLED=true`` — david-only initially.
MEETING_CAPTURE_SCHEDULE_ID = "al-meeting-capture"
MEETING_CAPTURE_WORKFLOW = "MeetingCaptureWorkflow"
MEETING_CAPTURE_INTERVAL = timedelta(seconds=60)

TRANSCRIPT_INTAKE_SCHEDULE_ID = "al-transcript-intake"
TRANSCRIPT_INTAKE_WORKFLOW = "TranscriptIntakeWorkflow"
TRANSCRIPT_INTAKE_INTERVAL = timedelta(seconds=60)

# Steward Phase 6 (RFC #842) — signal extraction. Polls the stream
# vault for unprocessed events, runs the LLM extractor, and persists
# one ``signal/`` record per non-noise event. Gated on
# ``STEWARD_SIGNAL_EXTRACT_ENABLED=true`` — david-only at T6.0.6,
# fleet rollout at T6.fleet.3.
SIGNAL_EXTRACT_SCHEDULE_ID = "al-signal-extract"
SIGNAL_EXTRACT_WORKFLOW = "SignalExtractWorkflow"
SIGNAL_EXTRACT_INTERVAL = timedelta(minutes=5)

# Steward Phase 6 (RFC #842 / T6.3.3) — signal router. Reads
# unrouted signal records every 2 minutes and dispatches each one
# through apply_signal_mutation (effect=mutation) or marks it
# action_pending / skipped (effect=action / none). Gated on
# ``STEWARD_SIGNAL_ROUTER_ENABLED=true`` — david-only at T6.3.4,
# fleet rollout at T6.fleet.3. Separate from the extract flag so a
# tenant can soak signal generation in shadow before flipping the
# router on.
SIGNAL_ROUTER_SCHEDULE_ID = "al-signal-router"
SIGNAL_ROUTER_WORKFLOW = "SignalRouterWorkflow"
SIGNAL_ROUTER_INTERVAL = timedelta(minutes=2)

# Steward Phase 6 (RFC #842 / T6.6.3) — stream-event purge. Daily
# at 03:00 UTC; deletes ``stream_event/*`` records older than 7 days
# whose signal_extracted_at is set. Gated on
# ``STEWARD_STREAM_EVENT_PURGE_ENABLED=true`` — david-only at T6.6.4,
# fleet rollout post-Phase-6.7. The ``raw_quote`` is preserved on the
# resulting signal record so dropping the source event is non-lossy.
STREAM_EVENT_PURGE_SCHEDULE_ID = "al-stream-event-purge"
STREAM_EVENT_PURGE_WORKFLOW = "StreamEventPurgeWorkflow"

# STORE-P4-1 — daily compaction of /vault/_raw/<date>.jsonl. Drops events
# >7d that are already in stream_event_processed; hard-deletes whole
# partitions >30d. Always-on (no env gate) because the operation is
# safe even when no JSONL files exist yet — the activity simply returns
# zero counts. The schedule arms a tenant before it produces any JSONL.
STREAM_RAW_COMPACT_SCHEDULE_ID = "al-stream-raw-compact"
STREAM_RAW_COMPACT_WORKFLOW = "StreamRawCompactWorkflow"

# STORE-P4-2 — hourly stuck-consumer alert. Calls ctrl-api's stuck-report
# (events in /vault/_raw/<date>.jsonl older than 7d AND not in
# stream_event_processed); if any are found, posts a Slack-compatible
# alert to ALERT_WEBHOOK_URL. Always-on (no env gate); the alert
# activity logs at ERROR + returns when ALERT_WEBHOOK_URL is unset, so
# tenants without a webhook still get the visibility through container
# logs instead of silent drift.
STUCK_PIPELINE_ALERT_SCHEDULE_ID = "al-stuck-pipeline-alert"
STUCK_PIPELINE_ALERT_WORKFLOW = "StuckPipelineAlertWorkflow"
STUCK_PIPELINE_ALERT_INTERVAL = timedelta(hours=1)

# STORE-P5-1 (#921) — daily 90-day Parquet roll-out of state.db hot
# tables (audit / signal / observation). Calendar schedule at 03:00 UTC
# daily, SKIP overlap. Always-on (no env gate) because the activity
# short-circuits when state.db isn't mounted — a freshly-provisioned
# tenant with zero rows older than 90d completes in milliseconds.
ARCHIVAL_SWEEP_SCHEDULE_ID = "al-archival-sweep"
ARCHIVAL_SWEEP_WORKFLOW = "ArchivalSweepWorkflow"

# Steward Phase 6 (RFC #842 / T6.7.5) — reversal-driven negative
# calibration. Polls the vault every 10 minutes for new
# ``event/steward-action-reversed-*.md`` (and signal-action-reversed-)
# records and applies a -0.1 confidence drop to each contributing
# source-type. Gated on ``STEWARD_REVERSAL_CALIBRATION_ENABLED=true``
# — david-only during soak, fleet rollout post-T6.7.5. The activity
# also re-checks the env at invocation time so flipping the flag off
# is fully safe even between schedule re-registration runs.
REVERSAL_CALIBRATION_SCHEDULE_ID = "al-reversal-calibration"
REVERSAL_CALIBRATION_WORKFLOW = "ReversalCalibrationWorkflow"
REVERSAL_CALIBRATION_INTERVAL = timedelta(minutes=10)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("register-schedules")

# Schedule definitions — calendar-based schedules use a placeholder for the
# ScheduleCalendarSpec which gets combined with the tenant timezone at
# registration time via ScheduleSpec(time_zone_name=...).
INTERVAL_SCHEDULES = [
    {
        "id": "al-event-processor",
        "workflow": "EventProcessorWorkflow",
        "interval": timedelta(minutes=15),
    },
    {
        "id": "al-session-tracker",
        "workflow": "SessionTrackerWorkflow",
        "interval": timedelta(minutes=15),
    },
    {
        "id": "al-learning",
        "workflow": "LearningWorkflow",
        "interval": timedelta(minutes=15),
    },
    {
        "id": "al-judgment",
        "workflow": "JudgmentWorkflow",
        "interval": timedelta(minutes=15),
    },
    {
        "id": "al-task-runner",
        "workflow": "TaskRunnerWorkflow",
        "interval": timedelta(minutes=15),
    },
    {
        "id": "al-hourly-enrichment",
        "workflow": "HourlyEnrichmentWorkflow",
        "interval": timedelta(hours=1),
    },
    {
        # Pattern detection (OBS-4) — hourly deterministic scan of the
        # unified observation pool. Clusters by (sender, intent) and
        # writes pattern_proposal records for surviving clusters. The
        # detector is cheap (one ctrl-api list call + in-memory work)
        # and ``register_all`` applies overlap=SKIP fleet-wide so two
        # ticks can't race on the skip-set.
        "id": "al-pattern-detection",
        "workflow": "PatternDetectionWorkflow",
        "interval": timedelta(hours=1),
    },
    {
        "id": "al-omi-processor",
        "workflow": "OmiAudioProcessorWorkflow",
        "interval": timedelta(minutes=10),
    },
    {
        # #645 — safety-net reaper for the persistent Composio reconnect
        # ledger written by ctrl-api after PR #646. The ctrl-api side has
        # an in-process setTimeout fast path; this Temporal schedule
        # guarantees cleanup eventually fires even if ctrl-api restarts
        # before the in-process timer (1h grace) elapses. 15-minute cadence
        # matches the other low-priority interval workflows; ledger
        # semantics are idempotent so overlap would be harmless but
        # ``register_all`` applies overlap=SKIP to every interval schedule
        # so a wedged run can't accumulate.
        "id": "al-composio-reconnect-cleanup",
        "workflow": "ComposioReconnectCleanupWorkflow",
        "interval": timedelta(minutes=15),
    },
    {
        # OpenClaw session-leak reaper — hourly sweep of the
        # ``.bak-N-<epoch>`` files OpenClaw drops in each agent's
        # sessions/ dir on rollover. Without this, listing the
        # sessions dir hits O(N) on every new session create and
        # CPU-pegs openclaw-workers (>100%) once the count grows
        # past a few hundred. See ``src/activities/openclaw_sessions.py``
        # for the full incident note + the prior David openclaw
        # degradation reference.
        "id": "al-openclaw-session-sweep",
        "workflow": "OpenclawSessionSweepWorkflow",
        "interval": timedelta(hours=1),
    },
    {
        # Decision router — every Desk click writes a decision/<ts>.md
        # record; this workflow reads them, runs side effects (status
        # flips on source records, signal re-arms + agent dispatches
        # for delegate, to_do spawns for take_mine, outcome polling for
        # executing delegates) and flips the decision state. 60-second
        # cadence is the click→side-effect latency budget.
        "id": "al-decision-router",
        "workflow": "DecisionRouterWorkflow",
        "interval": timedelta(seconds=60),
    },
    {
        # Task closure watcher (LIFECYCLE-2) — every 5 min scan the open
        # task population against recent signals. High-confidence matches
        # auto-write a decision(intent=done) that the DecisionRouter
        # picks up to close the task. Backward arrow of the signal-task
        # loop; the forward arrow has been the Desk-click path since
        # ARCH-11.
        "id": "al-task-closure-watcher",
        "workflow": "TaskClosureWatcherWorkflow",
        "interval": timedelta(minutes=5),
    },
    {
        # Defer resurface — hourly scan for skipped needs_attention
        # cards whose resurface_at has fallen due. Flips status back to
        # pending so they reappear on /desk. The "when" parsing itself
        # happens inline in the DecisionRouterWorkflow when the click
        # lands, not here — this is just the sweep that re-surfaces.
        "id": "al-defer-resurface",
        "workflow": "DeferResurfaceWorkflow",
        "interval": timedelta(minutes=15),
    },
    {
        # Scheduled dispatch — fires delegate-with-when decisions when
        # their execute_at has fallen due. The decision lands in
        # state=scheduled with execute_at stamped by clerk; this sweep
        # picks it up at the right time and triggers the real dispatch.
        "id": "al-scheduled-dispatch",
        "workflow": "ScheduledDispatchWorkflow",
        "interval": timedelta(minutes=15),
    },
    {
        # Decay watcher — six-hourly sweep that scores every pending
        # needs_attention card against a per-source half-life and stamps
        # decay_band ∈ {fresh, aging, stale}. Cards below the auto-flip
        # threshold (freshness < 0.05) are status-flipped to stale so
        # the Desk doesn't silt up with origin-old residue. The Desk UI
        # reads decay_band off needs_attention frontmatter to group the
        # queue into bands.
        "id": "al-decay-watcher",
        "workflow": "DecayWatcherWorkflow",
        "interval": timedelta(hours=6),
    },
]

CALENDAR_SCHEDULES = [
    {
        "id": "al-reflection",
        "workflow": "ReflectionWorkflow",
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=2)],
            minute=[ScheduleRange(start=0)],
        ),
    },
    {
        "id": "al-nightly-maintenance",
        "workflow": "NightlyMaintenanceWorkflow",
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=3)],
            minute=[ScheduleRange(start=0)],
        ),
    },
    {
        # S5-2: Weekly scan for generated chores worth promoting to the
        # standard library. Runs Sunday 3am (day_of_week=0 is Sunday),
        # right after Saturday's nightly_maintenance completes.
        "id": "al-chore-promotion",
        "workflow": "ChorePromotionReflectionWorkflow",
        "calendar": ScheduleCalendarSpec(
            day_of_week=[ScheduleRange(start=0, end=0)],
            hour=[ScheduleRange(start=3)],
            minute=[ScheduleRange(start=0)],
        ),
    },
    {
        # RFC #884: nightly_narrative — Workflow 7 of the Living
        # Narratives layer. Walks every active matter and asks the
        # clerk to draft a fresh ``current_state`` paragraph from the
        # last 24h of signals + task transitions. Runs at 02:00 local
        # (cron 0 2 * * *) so it lands between the 23:00 reflection /
        # 03:00 stream-event purge windows. The workflow itself is
        # idempotent: matters with zero activity are skipped without
        # invoking the clerk.
        "id": "al-nightly-narrative",
        "workflow": "NightlyNarrativeWorkflow",
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=2)],
            minute=[ScheduleRange(start=0)],
        ),
    },
    {
        # Decision patterns — daily extraction of recurring reasoning
        # from the principal's recent decisions. Writes proposed
        # decision_pattern records the principal can promote on /study.
        # Runs at 03:00 after the nightly_narrative so matter state is
        # already refreshed for the day.
        "id": "al-decision-patterns",
        "workflow": "DecisionPatternsWorkflow",
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=3)],
            minute=[ScheduleRange(start=0)],
        ),
    },
    {
        # Init-image drift check — daily pull of the manifest for
        # ``ssdavidai00/alfred-init:latest`` from DockerHub + scan for
        # the OPS-TOKEN-1 entrypoint marker. Catches the 2026-05-19
        # 11:14Z failure mode where an out-of-band push overwrote CI's
        # freshly-built image with stale content carrying ``chmod 600``,
        # which alfred-learn cannot read. Posts an ``image-drift`` audit
        # row on a positive detection — the same surface a Desk
        # operator sees on /decisions.
        #
        # Daily cadence (04:00 tenant-local) is sufficient: the CI smoke
        # step is the primary gate, this is the long-tail net. 04:00
        # sits between the 03:00 nightly_maintenance/archival batch and
        # the 05:00 morning briefing so it competes with nothing live.
        # SKIP overlap is inherited from ``register_all``.
        "id": "al-init-image-drift",
        "workflow": "InitImageDriftWorkflow",
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=4)],
            minute=[ScheduleRange(start=0)],
        ),
    },
]


def _build_schedule_entries(timezone: str) -> list[dict]:
    """Combine interval and calendar schedules into a unified list with specs."""
    entries = []
    for sched in INTERVAL_SCHEDULES:
        entries.append({
            **sched,
            "spec": ScheduleSpec(
                intervals=[ScheduleIntervalSpec(every=sched["interval"])]
            ),
        })
    for sched in CALENDAR_SCHEDULES:
        entries.append({
            **sched,
            "spec": ScheduleSpec(
                calendars=[sched["calendar"]],
                time_zone_name=timezone,
            ),
        })
    return entries


def _plane_sync_enabled() -> bool:
    """Feature flag for Plane two-way sync (#536).

    Registration-time gate: tenants without the flag don't get the schedule
    created at all, so the opt-out is free (no extra Temporal history, no
    activity task poll). The workflow itself also checks this flag at runtime
    — the two gates are redundant on purpose so flipping either direction is
    safe.
    """
    return os.environ.get("PLANE_SYNC_ENABLED", "").strip().lower() == "true"


async def register_plane_sync(client: Client, task_queue: str) -> None:
    """Create-or-delete the ``al-plane-sync`` schedule based on the feature flag.

    When ``PLANE_SYNC_ENABLED=true``:
      * create the schedule (every 15s, overlap SKIP) if absent
      * leave it alone if it already exists — the workflow itself is the
        source of truth for logic changes, not the schedule definition

    When the flag is unset/false:
      * delete the schedule if present (so a tenant flipping the flag off
        doesn't leave a zombie sync running)
      * otherwise no-op
    """
    handle = client.get_schedule_handle(PLANE_SYNC_SCHEDULE_ID)

    if not _plane_sync_enabled():
        try:
            await handle.describe()
        except RPCError as e:
            if e.status == RPCStatusCode.NOT_FOUND:
                logger.info("plane_sync disabled — schedule skipped")
                return
            raise
        await handle.delete()
        logger.info(
            "plane_sync disabled — existing schedule %s deleted",
            PLANE_SYNC_SCHEDULE_ID,
        )
        return

    action = ScheduleActionStartWorkflow(
        PLANE_SYNC_WORKFLOW,
        id=f"{PLANE_SYNC_SCHEDULE_ID}-run",
        task_queue=task_queue,
        # 5-minute timeout: same wedge protection as reverse-sync. Forward
        # sync's per-batch cursor advancement means a wedged run also
        # blocks the schedule (SKIP overlap) until the wedge clears.
        execution_timeout=timedelta(minutes=5),
        run_timeout=timedelta(minutes=5),
    )
    spec = ScheduleSpec(
        intervals=[ScheduleIntervalSpec(every=timedelta(seconds=15))],
    )
    policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)

    try:
        await client.create_schedule(
            PLANE_SYNC_SCHEDULE_ID,
            Schedule(action=action, spec=spec, policy=policy),
        )
        logger.info(
            "Created schedule: %s → %s (15s, SKIP overlap)",
            PLANE_SYNC_SCHEDULE_ID,
            PLANE_SYNC_WORKFLOW,
        )
    except RPCError as e:
        if e.status == RPCStatusCode.ALREADY_EXISTS:
            logger.info(
                "Schedule already exists: %s (skipping)", PLANE_SYNC_SCHEDULE_ID
            )
            return
        logger.error(
            "Failed to create schedule %s: %s", PLANE_SYNC_SCHEDULE_ID, e
        )
        raise
    except Exception as e:  # noqa: BLE001 — keep parity with register_all()
        err = str(e).lower()
        if "already" in err or "exists" in err:
            logger.info(
                "Schedule already exists: %s (skipping)", PLANE_SYNC_SCHEDULE_ID
            )
            return
        logger.error(
            "Failed to create schedule %s: %s", PLANE_SYNC_SCHEDULE_ID, e
        )
        raise


async def register_plane_reverse_sync(client: Client, task_queue: str) -> None:
    """Create-or-delete ``al-plane-reverse-sync`` based on the feature flag.

    Same on/off pattern as ``register_plane_sync`` — flipping
    ``PLANE_SYNC_ENABLED`` off deletes the schedule cleanly so a
    tenant opting out doesn't leave a zombie sync running.

    10s interval + SKIP overlap: the workflow's own fetch activity
    handles all the backfill so skipped ticks don't drop events.
    """
    handle = client.get_schedule_handle(PLANE_REVERSE_SYNC_SCHEDULE_ID)

    if not _plane_sync_enabled():
        try:
            await handle.describe()
        except RPCError as e:
            if e.status == RPCStatusCode.NOT_FOUND:
                logger.info("plane_reverse_sync disabled — schedule skipped")
                return
            raise
        await handle.delete()
        logger.info(
            "plane_reverse_sync disabled — existing schedule %s deleted",
            PLANE_REVERSE_SYNC_SCHEDULE_ID,
        )
        return

    action = ScheduleActionStartWorkflow(
        PLANE_REVERSE_SYNC_WORKFLOW,
        id=f"{PLANE_REVERSE_SYNC_SCHEDULE_ID}-run",
        task_queue=task_queue,
        # Run timeout: if a single workflow run is still ticking after 5
        # minutes, kill it. With OverlapPolicy.SKIP a wedged run blocks
        # the schedule indefinitely (see #823: a WorkflowTaskTimedOut
        # workflow ran for 1h+ on david, blocking 17,016 scheduled runs
        # and Sir's pavilion close along with them). 5 min is generous
        # for the 10s tick — a healthy run finishes in <2s on a 50-event
        # backlog. The sweep means a wedge auto-recovers.
        execution_timeout=timedelta(minutes=5),
        run_timeout=timedelta(minutes=5),
    )
    spec = ScheduleSpec(
        intervals=[ScheduleIntervalSpec(every=timedelta(seconds=10))],
    )
    policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)

    try:
        await client.create_schedule(
            PLANE_REVERSE_SYNC_SCHEDULE_ID,
            Schedule(action=action, spec=spec, policy=policy),
        )
        logger.info(
            "Created schedule: %s → %s (10s, SKIP overlap)",
            PLANE_REVERSE_SYNC_SCHEDULE_ID,
            PLANE_REVERSE_SYNC_WORKFLOW,
        )
    except RPCError as e:
        if e.status == RPCStatusCode.ALREADY_EXISTS:
            logger.info(
                "Schedule already exists: %s (skipping)",
                PLANE_REVERSE_SYNC_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            PLANE_REVERSE_SYNC_SCHEDULE_ID, e,
        )
        raise
    except Exception as e:  # noqa: BLE001 — parity with register_plane_sync
        err = str(e).lower()
        if "already" in err or "exists" in err:
            logger.info(
                "Schedule already exists: %s (skipping)",
                PLANE_REVERSE_SYNC_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            PLANE_REVERSE_SYNC_SCHEDULE_ID, e,
        )
        raise


async def register_plane_reconciliation(client: Client, task_queue: str) -> None:
    """Create-or-delete ``al-plane-reconciliation`` based on the feature flag.

    Same on/off pattern as ``register_plane_sync``. Every hour, SKIP
    overlap — the workflow is idempotent but back-to-back runs would
    just chew Plane API quota for no benefit.
    """
    handle = client.get_schedule_handle(PLANE_RECONCILIATION_SCHEDULE_ID)

    if not _plane_sync_enabled():
        try:
            await handle.describe()
        except RPCError as e:
            if e.status == RPCStatusCode.NOT_FOUND:
                logger.info(
                    "plane_reconciliation disabled — schedule skipped"
                )
                return
            raise
        await handle.delete()
        logger.info(
            "plane_reconciliation disabled — existing schedule %s deleted",
            PLANE_RECONCILIATION_SCHEDULE_ID,
        )
        return

    action = ScheduleActionStartWorkflow(
        PLANE_RECONCILIATION_WORKFLOW,
        id=f"{PLANE_RECONCILIATION_SCHEDULE_ID}-run",
        task_queue=task_queue,
    )
    spec = ScheduleSpec(
        intervals=[ScheduleIntervalSpec(every=timedelta(hours=1))],
    )
    policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)

    try:
        await client.create_schedule(
            PLANE_RECONCILIATION_SCHEDULE_ID,
            Schedule(action=action, spec=spec, policy=policy),
        )
        logger.info(
            "Created schedule: %s → %s (1h, SKIP overlap)",
            PLANE_RECONCILIATION_SCHEDULE_ID,
            PLANE_RECONCILIATION_WORKFLOW,
        )
    except RPCError as e:
        if e.status == RPCStatusCode.ALREADY_EXISTS:
            logger.info(
                "Schedule already exists: %s (skipping)",
                PLANE_RECONCILIATION_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            PLANE_RECONCILIATION_SCHEDULE_ID, e,
        )
        raise
    except Exception as e:  # noqa: BLE001 — parity with sibling helpers
        err = str(e).lower()
        if "already" in err or "exists" in err:
            logger.info(
                "Schedule already exists: %s (skipping)",
                PLANE_RECONCILIATION_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            PLANE_RECONCILIATION_SCHEDULE_ID, e,
        )
        raise


def _fleet_audit_enabled() -> bool:
    """Feature flag for the daily fleet audit. Defaults to ``true``.

    Unlike the Plane flags, this one's opt-OUT — we want wrong-tenant
    detection on every tenant by default.
    """
    return os.environ.get(
        "FLEET_AUDIT_ENABLED", "true",
    ).strip().lower() == "true"


async def register_fleet_audit(client: Client, task_queue: str) -> None:
    """Create-or-delete the ``al-fleet-audit`` schedule based on the flag.

    Calendar-based: daily at 02:00 UTC (chosen after nightly_maintenance
    at 03:00 local — sufficiently off-peak). SKIP overlap policy (audit
    runs are idempotent but back-to-back would be wasteful).
    """
    handle = client.get_schedule_handle(FLEET_AUDIT_SCHEDULE_ID)

    if not _fleet_audit_enabled():
        try:
            await handle.describe()
        except RPCError as e:
            if e.status == RPCStatusCode.NOT_FOUND:
                logger.info("fleet_audit disabled — schedule skipped")
                return
            raise
        await handle.delete()
        logger.info(
            "fleet_audit disabled — existing schedule %s deleted",
            FLEET_AUDIT_SCHEDULE_ID,
        )
        return

    action = ScheduleActionStartWorkflow(
        FLEET_AUDIT_WORKFLOW,
        id=f"{FLEET_AUDIT_SCHEDULE_ID}-run",
        task_queue=task_queue,
    )
    spec = ScheduleSpec(
        calendars=[
            ScheduleCalendarSpec(
                hour=[ScheduleRange(start=2)],
                minute=[ScheduleRange(start=0)],
            )
        ],
        # Pinned to UTC on purpose — we want a fleet-wide consistent audit
        # window, not one that drifts with tenant local time.
        time_zone_name="UTC",
    )
    policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)

    try:
        await client.create_schedule(
            FLEET_AUDIT_SCHEDULE_ID,
            Schedule(action=action, spec=spec, policy=policy),
        )
        logger.info(
            "Created schedule: %s → %s (daily 02:00 UTC, SKIP overlap)",
            FLEET_AUDIT_SCHEDULE_ID,
            FLEET_AUDIT_WORKFLOW,
        )
    except RPCError as e:
        if e.status == RPCStatusCode.ALREADY_EXISTS:
            logger.info(
                "Schedule already exists: %s (skipping)",
                FLEET_AUDIT_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s", FLEET_AUDIT_SCHEDULE_ID, e,
        )
        raise
    except Exception as e:  # noqa: BLE001 — parity with sibling helpers
        err = str(e).lower()
        if "already" in err or "exists" in err:
            logger.info(
                "Schedule already exists: %s (skipping)",
                FLEET_AUDIT_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s", FLEET_AUDIT_SCHEDULE_ID, e,
        )
        raise


# ---------------------------------------------------------------------------
# Vexa transcript intake (#840 Phase 4) — singleton schedule registration
# ---------------------------------------------------------------------------

def _vexa_enabled() -> bool:
    """Feature flag for Vexa transcript intake (#840).

    Default OFF. Tenants opt in by setting ``VEXA_ENABLED=true``. Phase 4
    initially enables this only on david — the compose template's vexa
    block is also gated on the same flag, so flipping the env var alone
    isn't enough to start the bot stack on a tenant that wasn't
    provisioned with it.
    """
    return os.environ.get("VEXA_ENABLED", "").strip().lower() == "true"


def _signal_extract_enabled() -> bool:
    """Feature flag for Phase 6 signal extraction (RFC #842).

    Default OFF. Tenants opt in by setting
    ``STEWARD_SIGNAL_EXTRACT_ENABLED=true``. On david this gets flipped
    on at T6.0.6 deploy time. Fleet rollout is part of T6.fleet.3.

    Same shape as ``_vexa_enabled`` — single-source registration-time
    gate. Workflow itself does not re-check the env (would break
    Temporal determinism), so flipping the flag off requires a deploy
    that re-runs ``register_schedules`` to delete the schedule.
    """
    return os.environ.get(
        "STEWARD_SIGNAL_EXTRACT_ENABLED", "",
    ).strip().lower() in ("true", "1", "yes")


def _signal_router_enabled() -> bool:
    """Feature flag for Phase 6 signal router (T6.3.3 / T6.3.4).

    Default OFF. Tenants opt in by setting
    ``STEWARD_SIGNAL_ROUTER_ENABLED=true``. Independent from
    ``STEWARD_SIGNAL_EXTRACT_ENABLED`` so a tenant can run signal
    extraction (write-only) for a soak period before flipping the
    router on. Same single-source registration-time gate as the rest of
    the Phase 6 flags.
    """
    return os.environ.get(
        "STEWARD_SIGNAL_ROUTER_ENABLED", "",
    ).strip().lower() in ("true", "1", "yes")


def _reversal_calibration_enabled() -> bool:
    """Feature flag for Phase 6.7 reversal-driven calibration (T6.7.5).

    Default OFF. Tenants opt in by setting
    ``STEWARD_REVERSAL_CALIBRATION_ENABLED=true``. Same single-source
    registration-time gate; the activity also re-checks the env on
    each invocation so a stale schedule doesn't keep applying penalties
    when an operator flips the flag off without re-running
    register_schedules.
    """
    return os.environ.get(
        "STEWARD_REVERSAL_CALIBRATION_ENABLED", "",
    ).strip().lower() in ("true", "1", "yes")


def _stream_event_purge_enabled() -> bool:
    """Feature flag for Phase 6.6 stream-event purge (T6.6.3 / T6.6.4).

    Default OFF. Tenants opt in by setting
    ``STEWARD_STREAM_EVENT_PURGE_ENABLED=true``. Same single-source
    registration-time gate; the activity also re-checks the env so a
    stale schedule doesn't keep deleting records when an operator
    flips the flag off without re-running register_schedules.
    """
    return os.environ.get(
        "STEWARD_STREAM_EVENT_PURGE_ENABLED", "",
    ).strip().lower() in ("true", "1", "yes")


async def _register_or_delete_singleton_schedule(
    client: Client,
    schedule_id: str,
    workflow_name: str,
    task_queue: str,
    interval: timedelta,
    enabled: bool,
    *,
    label: str,
) -> None:
    """Generic create-or-delete helper for VEXA-flag-gated singleton schedules.

    Mirrors the pattern in ``register_plane_sync`` / ``register_fleet_audit``
    but parameterised so the two Vexa schedules don't duplicate the same
    20 lines.
    """
    handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await handle.describe()
        except RPCError as e:
            if e.status == RPCStatusCode.NOT_FOUND:
                logger.info("%s disabled — schedule skipped", label)
                return
            raise
        await handle.delete()
        logger.info(
            "%s disabled — existing schedule %s deleted",
            label, schedule_id,
        )
        return

    action = ScheduleActionStartWorkflow(
        workflow_name,
        id=f"{schedule_id}-run",
        task_queue=task_queue,
        # 5-minute envelope: same wedge protection as plane_sync. The
        # workflow itself ticks fast (gcal stream poll + Vexa API
        # calls) — a healthy run finishes in <5s. The cap protects
        # against a clerk wedge during transcript-action extraction.
        execution_timeout=timedelta(minutes=5),
        run_timeout=timedelta(minutes=5),
    )
    spec = ScheduleSpec(
        intervals=[ScheduleIntervalSpec(every=interval)],
    )
    # SKIP overlap: both workflows are idempotent but a wedged run that
    # somehow continued past the run_timeout (shouldn't happen) would
    # still be safe to overlap on the next tick — the activities all
    # dedupe by stream id / cursor file. We pick SKIP for hygiene
    # (matches plane_sync / fleet_audit defaults).
    policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)

    try:
        await client.create_schedule(
            schedule_id,
            Schedule(action=action, spec=spec, policy=policy),
        )
        logger.info(
            "Created schedule: %s → %s (%ds, SKIP overlap)",
            schedule_id, workflow_name, int(interval.total_seconds()),
        )
    except RPCError as e:
        if e.status == RPCStatusCode.ALREADY_EXISTS:
            logger.info(
                "Schedule already exists: %s (skipping)", schedule_id,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s", schedule_id, e,
        )
        raise
    except Exception as e:  # noqa: BLE001 — parity with sibling helpers
        err = str(e).lower()
        if "already" in err or "exists" in err:
            logger.info(
                "Schedule already exists: %s (skipping)", schedule_id,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s", schedule_id, e,
        )
        raise


async def register_meeting_capture(client: Client, task_queue: str) -> None:
    """Create-or-delete ``al-meeting-capture`` based on ``VEXA_ENABLED``."""
    await _register_or_delete_singleton_schedule(
        client,
        MEETING_CAPTURE_SCHEDULE_ID,
        MEETING_CAPTURE_WORKFLOW,
        task_queue,
        MEETING_CAPTURE_INTERVAL,
        _vexa_enabled(),
        label="meeting_capture",
    )


async def register_transcript_intake(client: Client, task_queue: str) -> None:
    """Create-or-delete ``al-transcript-intake`` based on ``VEXA_ENABLED``."""
    await _register_or_delete_singleton_schedule(
        client,
        TRANSCRIPT_INTAKE_SCHEDULE_ID,
        TRANSCRIPT_INTAKE_WORKFLOW,
        task_queue,
        TRANSCRIPT_INTAKE_INTERVAL,
        _vexa_enabled(),
        label="transcript_intake",
    )


async def register_signal_extract(client: Client, task_queue: str) -> None:
    """Create-or-delete ``al-signal-extract`` based on the Phase 6 flag.

    Gate: ``STEWARD_SIGNAL_EXTRACT_ENABLED=true``. T6.0.6 enables this
    on david only; T6.fleet.3 rolls it out fleet-wide.

    Uses a 25-minute execution timeout (not the 5-min singleton default)
    because the workflow processes up to 100 events in 10 serial chunks
    of 10 concurrent LLM calls. Worst-case: 10 chunks × 120s timeout =
    1200s. 25 min gives comfortable headroom above that ceiling.
    """
    handle = client.get_schedule_handle(SIGNAL_EXTRACT_SCHEDULE_ID)
    if not _signal_extract_enabled():
        try:
            await handle.describe()
        except RPCError as e:
            if e.status == RPCStatusCode.NOT_FOUND:
                logger.info("signal_extract disabled — schedule skipped")
                return
            raise
        await handle.delete()
        logger.info(
            "signal_extract disabled — existing schedule %s deleted",
            SIGNAL_EXTRACT_SCHEDULE_ID,
        )
        return

    action = ScheduleActionStartWorkflow(
        SIGNAL_EXTRACT_WORKFLOW,
        id=f"{SIGNAL_EXTRACT_SCHEDULE_ID}-run",
        task_queue=task_queue,
        # 25 min: 10 chunks × 120s activity timeout + safety margin.
        execution_timeout=timedelta(minutes=25),
        run_timeout=timedelta(minutes=25),
    )
    spec = ScheduleSpec(
        intervals=[ScheduleIntervalSpec(every=SIGNAL_EXTRACT_INTERVAL)],
    )
    new_schedule = Schedule(
        action=action,
        spec=spec,
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
    )

    async def _updater(inp: ScheduleUpdateInput) -> ScheduleUpdate:
        return ScheduleUpdate(schedule=new_schedule)

    try:
        await handle.describe()
        await handle.update(_updater)
        logger.info("signal_extract schedule updated (25-min timeout)")
    except RPCError as e:
        if e.status != RPCStatusCode.NOT_FOUND:
            raise
        await client.create_schedule(
            SIGNAL_EXTRACT_SCHEDULE_ID,
            new_schedule,
        )
        logger.info("signal_extract schedule created (25-min timeout)")


async def register_reversal_calibration(
    client: Client, task_queue: str,
) -> None:
    """Create-or-delete ``al-reversal-calibration`` based on T6.7.5 flag.

    Gate: ``STEWARD_REVERSAL_CALIBRATION_ENABLED=true``. Default OFF
    — flipping it on starts the 10-min reversal scan that drops
    contributing-source confidence by 0.1 per reversal. Reuses the
    same singleton helper as the Vexa / signal-extract / signal-router
    schedules so flipping the flag off cleanly deletes the schedule
    (no zombie 10-min ticks).
    """
    await _register_or_delete_singleton_schedule(
        client,
        REVERSAL_CALIBRATION_SCHEDULE_ID,
        REVERSAL_CALIBRATION_WORKFLOW,
        task_queue,
        REVERSAL_CALIBRATION_INTERVAL,
        _reversal_calibration_enabled(),
        label="reversal_calibration",
    )


async def register_signal_router(client: Client, task_queue: str) -> None:
    """Create-or-delete ``al-signal-router`` based on the Phase 6.3 flag.

    Gate: ``STEWARD_SIGNAL_ROUTER_ENABLED=true``. Default OFF — flipping
    it on triggers signal-mutation routing (and, after T6.4.x ships,
    signal-action routing). The mode (shadow vs. live) is governed by
    a SEPARATE env (``STEWARD_SIGNAL_ROUTER_LIVE_MODE``) which the
    activity reads on each invocation; the registration-time flag here
    only controls whether the schedule exists.
    """
    await _register_or_delete_singleton_schedule(
        client,
        SIGNAL_ROUTER_SCHEDULE_ID,
        SIGNAL_ROUTER_WORKFLOW,
        task_queue,
        SIGNAL_ROUTER_INTERVAL,
        _signal_router_enabled(),
        label="signal_router",
    )


async def register_stream_event_purge(client: Client, task_queue: str) -> None:
    """Create-or-delete ``al-stream-event-purge`` based on the Phase 6.6 flag.

    Gate: ``STEWARD_STREAM_EVENT_PURGE_ENABLED=true``. Calendar
    schedule at 03:00 UTC daily; SKIP overlap (the activity is
    idempotent but a stuck run shouldn't pile on). Mirrors the
    fleet-audit registration pattern — same on/off semantics.
    """
    handle = client.get_schedule_handle(STREAM_EVENT_PURGE_SCHEDULE_ID)

    if not _stream_event_purge_enabled():
        try:
            await handle.describe()
        except RPCError as e:
            if e.status == RPCStatusCode.NOT_FOUND:
                logger.info(
                    "stream_event_purge disabled — schedule skipped"
                )
                return
            raise
        await handle.delete()
        logger.info(
            "stream_event_purge disabled — existing schedule %s deleted",
            STREAM_EVENT_PURGE_SCHEDULE_ID,
        )
        return

    action = ScheduleActionStartWorkflow(
        STREAM_EVENT_PURGE_WORKFLOW,
        id=f"{STREAM_EVENT_PURGE_SCHEDULE_ID}-run",
        task_queue=task_queue,
        # 5 min envelope — david's ~10K stream-event vault drains at
        # roughly 100 records/sec through the ctrl-api delete loop, so
        # a worst-case 7-day backlog finishes in under 2 min. The cap
        # protects against a wedged ctrl-api blocking the schedule.
        execution_timeout=timedelta(minutes=10),
        run_timeout=timedelta(minutes=10),
    )
    spec = ScheduleSpec(
        calendars=[
            ScheduleCalendarSpec(
                hour=[ScheduleRange(start=3)],
                minute=[ScheduleRange(start=0)],
            )
        ],
        # Pinned to UTC so retention math is consistent fleet-wide.
        time_zone_name="UTC",
    )
    policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)

    try:
        await client.create_schedule(
            STREAM_EVENT_PURGE_SCHEDULE_ID,
            Schedule(action=action, spec=spec, policy=policy),
        )
        logger.info(
            "Created schedule: %s → %s (daily 03:00 UTC, SKIP overlap)",
            STREAM_EVENT_PURGE_SCHEDULE_ID,
            STREAM_EVENT_PURGE_WORKFLOW,
        )
    except RPCError as e:
        if e.status == RPCStatusCode.ALREADY_EXISTS:
            logger.info(
                "Schedule already exists: %s (skipping)",
                STREAM_EVENT_PURGE_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            STREAM_EVENT_PURGE_SCHEDULE_ID, e,
        )
        raise
    except Exception as e:  # noqa: BLE001 — parity with sibling helpers
        err = str(e).lower()
        if "already" in err or "exists" in err:
            logger.info(
                "Schedule already exists: %s (skipping)",
                STREAM_EVENT_PURGE_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            STREAM_EVENT_PURGE_SCHEDULE_ID, e,
        )
        raise


async def register_stream_raw_compact(client: Client, task_queue: str) -> None:
    """Create ``al-stream-raw-compact`` — STORE-P4-1 daily JSONL compactor.

    Calendar schedule at 03:30 UTC daily (offset 30m from the legacy
    stream-event-purge to avoid both touching ctrl-api simultaneously
    during the soak). SKIP overlap so a long run doesn't pile on.
    """
    handle = client.get_schedule_handle(STREAM_RAW_COMPACT_SCHEDULE_ID)
    action = ScheduleActionStartWorkflow(
        STREAM_RAW_COMPACT_WORKFLOW,
        id=f"{STREAM_RAW_COMPACT_SCHEDULE_ID}-run",
        task_queue=task_queue,
        execution_timeout=timedelta(minutes=15),
        run_timeout=timedelta(minutes=15),
    )
    spec = ScheduleSpec(
        calendars=[
            ScheduleCalendarSpec(
                hour=[ScheduleRange(start=3)],
                minute=[ScheduleRange(start=30)],
            )
        ],
        time_zone_name="UTC",
    )
    policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)

    try:
        await client.create_schedule(
            STREAM_RAW_COMPACT_SCHEDULE_ID,
            Schedule(action=action, spec=spec, policy=policy),
        )
        logger.info(
            "Created schedule: %s → %s (daily 03:30 UTC, SKIP overlap)",
            STREAM_RAW_COMPACT_SCHEDULE_ID,
            STREAM_RAW_COMPACT_WORKFLOW,
        )
    except RPCError as e:
        if e.status == RPCStatusCode.ALREADY_EXISTS:
            logger.info(
                "Schedule already exists: %s (skipping)",
                STREAM_RAW_COMPACT_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            STREAM_RAW_COMPACT_SCHEDULE_ID, e,
        )
        raise
    except Exception as e:  # noqa: BLE001 — parity with sibling helpers
        err = str(e).lower()
        if "already" in err or "exists" in err:
            logger.info(
                "Schedule already exists: %s (skipping)",
                STREAM_RAW_COMPACT_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            STREAM_RAW_COMPACT_SCHEDULE_ID, e,
        )
        raise


async def register_archival_sweep(client: Client, task_queue: str) -> None:
    """Create ``al-archival-sweep`` — STORE-P5-1 daily Parquet archiver.

    Calendar schedule at 03:00 UTC daily. SKIP overlap so a long sweep
    doesn't pile on with itself (the activity is already idempotent —
    skipped rows on attempt N show up on attempt N+1 — but SKIP keeps
    Temporal history tidy). Always-on; the activity short-circuits when
    state.db isn't present and the workflow returns per-table outcomes
    either way.
    """
    action = ScheduleActionStartWorkflow(
        ARCHIVAL_SWEEP_WORKFLOW,
        id=f"{ARCHIVAL_SWEEP_SCHEDULE_ID}-run",
        task_queue=task_queue,
        # 45 min envelope across all three tables. Each activity is
        # capped at 15 min (see ArchivalSweepWorkflow.run) so even a
        # full-fan-out worst case (each table maxes its inner timeout)
        # leaves headroom before the run-level cap fires.
        execution_timeout=timedelta(minutes=50),
        run_timeout=timedelta(minutes=50),
    )
    spec = ScheduleSpec(
        calendars=[
            ScheduleCalendarSpec(
                hour=[ScheduleRange(start=3)],
                minute=[ScheduleRange(start=0)],
            )
        ],
        # Pinned to UTC so the 90-day retention math is consistent
        # across the fleet regardless of tenant timezone.
        time_zone_name="UTC",
    )
    policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)

    try:
        await client.create_schedule(
            ARCHIVAL_SWEEP_SCHEDULE_ID,
            Schedule(action=action, spec=spec, policy=policy),
        )
        logger.info(
            "Created schedule: %s → %s (daily 03:00 UTC, SKIP overlap)",
            ARCHIVAL_SWEEP_SCHEDULE_ID,
            ARCHIVAL_SWEEP_WORKFLOW,
        )
    except RPCError as e:
        if e.status == RPCStatusCode.ALREADY_EXISTS:
            logger.info(
                "Schedule already exists: %s (skipping)",
                ARCHIVAL_SWEEP_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            ARCHIVAL_SWEEP_SCHEDULE_ID, e,
        )
        raise
    except Exception as e:  # noqa: BLE001 — parity with sibling helpers
        err = str(e).lower()
        if "already" in err or "exists" in err:
            logger.info(
                "Schedule already exists: %s (skipping)",
                ARCHIVAL_SWEEP_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            ARCHIVAL_SWEEP_SCHEDULE_ID, e,
        )
        raise


async def register_stuck_pipeline_alert(
    client: Client, task_queue: str,
) -> None:
    """Create ``al-stuck-pipeline-alert`` — STORE-P4-2 hourly alert.

    Interval schedule (1h), SKIP overlap. Always-on: if no webhook is
    configured the activity logs at ERROR and returns, so the schedule
    is safe to register fleet-wide. Idempotent — re-running the
    registrar leaves the schedule alone (ALREADY_EXISTS path).
    """
    handle = client.get_schedule_handle(STUCK_PIPELINE_ALERT_SCHEDULE_ID)
    action = ScheduleActionStartWorkflow(
        STUCK_PIPELINE_ALERT_WORKFLOW,
        id=f"{STUCK_PIPELINE_ALERT_SCHEDULE_ID}-run",
        task_queue=task_queue,
        # 2-minute envelope: the check is a single ctrl-api GET; even a
        # fleet-heaviest tenant with ~7d × 10k events/day = 70k lines
        # walks in seconds. The cap protects against a ctrl-api wedge.
        execution_timeout=timedelta(minutes=2),
        run_timeout=timedelta(minutes=2),
    )
    spec = ScheduleSpec(
        intervals=[ScheduleIntervalSpec(every=STUCK_PIPELINE_ALERT_INTERVAL)],
    )
    policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)

    try:
        await client.create_schedule(
            STUCK_PIPELINE_ALERT_SCHEDULE_ID,
            Schedule(action=action, spec=spec, policy=policy),
        )
        logger.info(
            "Created schedule: %s → %s (hourly, SKIP overlap)",
            STUCK_PIPELINE_ALERT_SCHEDULE_ID,
            STUCK_PIPELINE_ALERT_WORKFLOW,
        )
    except RPCError as e:
        if e.status == RPCStatusCode.ALREADY_EXISTS:
            logger.info(
                "Schedule already exists: %s (skipping)",
                STUCK_PIPELINE_ALERT_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            STUCK_PIPELINE_ALERT_SCHEDULE_ID, e,
        )
        raise
    except Exception as e:  # noqa: BLE001 — parity with sibling helpers
        err = str(e).lower()
        if "already" in err or "exists" in err:
            logger.info(
                "Schedule already exists: %s (skipping)",
                STUCK_PIPELINE_ALERT_SCHEDULE_ID,
            )
            return
        logger.error(
            "Failed to create schedule %s: %s",
            STUCK_PIPELINE_ALERT_SCHEDULE_ID, e,
        )
        raise


# ---------------------------------------------------------------------------
# Steward (#835) — per-matter schedule registration
# ---------------------------------------------------------------------------

def _matter_slug_from_path(path: str) -> str:
    """Extract the slug portion of a ``matter/<slug>.md`` path.

    Returns the empty string when ``path`` doesn't look like a matter
    record. Used for both schedule-id construction and matter-id
    arguments to the workflow.
    """
    if not isinstance(path, str):
        return ""
    s = path.strip()
    if not s.startswith("matter/") or not s.endswith(".md"):
        return ""
    return s[len("matter/"):-len(".md")]


def _schedule_id_for_matter(slug: str) -> str:
    return f"{STEWARD_SCHEDULE_PREFIX}{slug}"


async def _list_matter_paths(ctrl_url: str) -> list[str]:
    """Enumerate every ``matter/*.md`` path via ctrl-api.

    Returns an empty list on transport failure — better to skip Steward
    schedule registration this run than to delete every existing
    ``al-steward-*`` schedule because the API was momentarily down.
    """
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    paths: list[str] = []
    try:
        async with httpx.AsyncClient(
            base_url=ctrl_url, timeout=30.0, headers=headers,
        ) as client:
            resp = await client.get(
                "/api/v1/vault/list/matter", params={"preview": 0}
            )
            resp.raise_for_status()
            records = resp.json().get("results", [])
    except httpx.HTTPError as exc:
        logger.warning(
            "register_steward_schedules: ctrl-api list/matter failed: %s "
            "— skipping Steward schedule registration this run", exc,
        )
        return []
    for rec in records:
        path = rec.get("path") or ""
        if _matter_slug_from_path(path):
            paths.append(path)
    return paths


def _make_steward_schedule(
    slug: str, task_queue: str,
) -> Schedule:
    """Build the Schedule object for one matter.

    Args carry ``[matter_path]`` (e.g. ``["matter/inbox.md"]``) so the
    workflow's normalizer accepts both bare slugs and canonical paths.
    """
    matter_id = f"matter/{slug}.md"
    action = ScheduleActionStartWorkflow(
        STEWARD_WORKFLOW,
        args=[matter_id],
        id=f"{_schedule_id_for_matter(slug)}-run",
        task_queue=task_queue,
        # Generous 5-minute envelope. A typical no-op Phase 0 tick
        # finishes in <1s; the cap protects against a wedge during
        # Phase 1+ when LLM calls land in evaluate_task.
        execution_timeout=timedelta(minutes=5),
        run_timeout=timedelta(minutes=5),
    )
    spec = ScheduleSpec(
        intervals=[ScheduleIntervalSpec(every=STEWARD_DEFAULT_INTERVAL)],
    )
    policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)
    return Schedule(action=action, spec=spec, policy=policy)


async def _create_or_update_steward_schedule(
    client: Client, slug: str, task_queue: str,
) -> str:
    """Create the schedule, or update its action+spec if it already exists.

    Returns one of ``"created"``, ``"updated"``, ``"unchanged"`` for
    summary logging. Update is idempotent: we always re-issue the
    full Schedule definition so a deploy that bumps the cadence /
    workflow signature lands cleanly without a manual purge.
    """
    schedule_id = _schedule_id_for_matter(slug)
    schedule = _make_steward_schedule(slug, task_queue)
    handle = client.get_schedule_handle(schedule_id)

    try:
        await handle.describe()
        exists = True
    except RPCError as exc:
        if exc.status == RPCStatusCode.NOT_FOUND:
            exists = False
        else:
            raise

    if not exists:
        try:
            await client.create_schedule(schedule_id, schedule)
            return "created"
        except RPCError as exc:
            if exc.status == RPCStatusCode.ALREADY_EXISTS:
                # Race with another registrar instance — fall through
                # to the update path.
                pass
            else:
                raise
        except Exception as exc:  # noqa: BLE001 — parity with sibling helpers
            err = str(exc).lower()
            if "already" in err or "exists" in err:
                pass
            else:
                raise

    # Update path: refresh action + spec so cadence / workflow-name
    # changes flow through without a manual delete.
    async def _updater(input: ScheduleUpdateInput) -> ScheduleUpdate:
        return ScheduleUpdate(schedule=schedule)

    try:
        await handle.update(_updater)
        return "updated"
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "register_steward_schedules: update %s failed: %s",
            schedule_id, exc,
        )
        return "unchanged"


async def _delete_orphan_steward_schedules(
    client: Client, live_ids: set[str],
) -> int:
    """Delete any ``al-steward-*`` schedule whose matter no longer exists.

    Returns the number of schedules deleted. Best-effort — failures on
    individual deletes are logged and don't abort the whole sweep.
    """
    deleted = 0
    try:
        existing_ids: list[str] = []
        async for entry in client.list_schedules():
            sid = getattr(entry, "id", None) or ""
            if sid.startswith(STEWARD_SCHEDULE_PREFIX):
                existing_ids.append(sid)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "register_steward_schedules: list_schedules failed: %s "
            "— skipping orphan sweep", exc,
        )
        return 0

    for sid in existing_ids:
        if sid in live_ids:
            continue
        try:
            await client.get_schedule_handle(sid).delete()
            logger.info("register_steward_schedules: deleted orphan %s", sid)
            deleted += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "register_steward_schedules: delete %s failed: %s",
                sid, exc,
            )
    return deleted


async def register_steward_schedules(client: Client) -> None:
    """Create-or-update one ``al-steward-<slug>`` schedule per matter.

    Idempotent: re-running creates missing schedules, refreshes existing
    ones (so a cadence change lands without a manual purge), and
    deletes orphaned schedules whose matter no longer exists in the
    vault.
    """
    cfg = load_config()
    matter_paths = await _list_matter_paths(cfg.alfred_ctrl_url)
    if not matter_paths:
        logger.info(
            "register_steward_schedules: no matters found in vault "
            "— nothing to register"
        )
        return

    live_ids: set[str] = set()
    counts = {"created": 0, "updated": 0, "unchanged": 0}
    for path in matter_paths:
        slug = _matter_slug_from_path(path)
        if not slug:
            continue
        live_ids.add(_schedule_id_for_matter(slug))
        try:
            outcome = await _create_or_update_steward_schedule(
                client, slug, cfg.task_queue,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "register_steward_schedules: %s failed: %s",
                _schedule_id_for_matter(slug), exc,
            )
            continue
        counts[outcome] = counts.get(outcome, 0) + 1
        logger.info(
            "register_steward_schedules: %s %s",
            _schedule_id_for_matter(slug), outcome,
        )

    deleted = await _delete_orphan_steward_schedules(client, live_ids)
    logger.info(
        "register_steward_schedules: matters=%d created=%d updated=%d "
        "unchanged=%d deleted_orphans=%d",
        len(live_ids),
        counts.get("created", 0),
        counts.get("updated", 0),
        counts.get("unchanged", 0),
        deleted,
    )


async def register_all() -> None:
    config = load_config()
    try:
        client = await Client.connect(config.temporal_host)
    except Exception as e:  # noqa: BLE001
        # Don't silently swallow — downstream registration steps depend on
        # the Temporal client, and init should fail loudly so the operator
        # sees the problem in container logs.
        logger.error(
            "Failed to connect to Temporal at %s: %s",
            config.temporal_host, e,
        )
        raise
    timezone = config.tenant_timezone
    logger.info("Using tenant timezone: %s", timezone)

    schedules = _build_schedule_entries(timezone)

    # All interval + calendar schedules ship with overlap=SKIP. The Temporal
    # SDK's default is ALLOW, which turns "one broken workflow" into "fleet-
    # wide accumulation" (every tick stacks another wedged copy on top of
    # the previous one — see the JudgmentWorkflow / extract_input_metadata
    # incident note for the worked example). SKIP converts a broken workflow
    # into ONE noticeable stuck run that a human can spot, instead of N+1
    # per-cadence zombies. The singleton schedules registered further down
    # (plane sync, signal extract, Vexa, etc.) already follow this pattern;
    # this loop is the catch-all for the INTERVAL_SCHEDULES + CALENDAR_SCHEDULES
    # lists declared at the top of the file.
    default_policy = SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP)

    for sched in schedules:
        schedule_id = sched["id"]
        workflow_name = sched["workflow"]
        spec = sched["spec"]

        action = ScheduleActionStartWorkflow(
            workflow_name,
            id=f"{schedule_id}-run",
            task_queue=config.task_queue,
        )
        new_schedule = Schedule(action=action, spec=spec, policy=default_policy)

        # Upsert: existing tenants already have the schedule created with
        # the implicit-ALLOW policy. ``create_schedule`` is a no-op when
        # the schedule exists, so we describe-then-update to migrate
        # existing tenants on the next deploy. Fresh tenants take the
        # create-then-log path.
        handle = client.get_schedule_handle(schedule_id)
        try:
            await handle.describe()
        except RPCError as e:
            if e.status != RPCStatusCode.NOT_FOUND:
                logger.error(
                    "Failed to describe schedule %s: %s", schedule_id, e,
                )
                raise
            try:
                await client.create_schedule(schedule_id, new_schedule)
                logger.info(
                    "Created schedule: %s → %s (SKIP overlap)",
                    schedule_id, workflow_name,
                )
            except Exception as e:  # noqa: BLE001
                err = str(e).lower()
                if "already" in err or "running" in err or "exists" in err:
                    logger.info(
                        "Schedule already exists: %s (skipping)", schedule_id,
                    )
                else:
                    logger.error(
                        "Failed to create schedule %s: %s", schedule_id, e,
                    )
                    raise
            continue

        async def _updater(
            inp: ScheduleUpdateInput,
            _new_schedule: Schedule = new_schedule,
        ) -> ScheduleUpdate:
            return ScheduleUpdate(schedule=_new_schedule)

        try:
            await handle.update(_updater)
            logger.info(
                "Updated schedule: %s → %s (SKIP overlap)",
                schedule_id, workflow_name,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Failed to update schedule %s: %s", schedule_id, e)
            raise

    # Plane two-way sync (#536) — registration-time feature-gated.
    await register_plane_sync(client, config.task_queue)
    await register_plane_reverse_sync(client, config.task_queue)
    # Plane reconciliation — hourly REST-delete sweep.
    await register_plane_reconciliation(client, config.task_queue)
    # Fleet audit — daily wrong-tenant stream contamination check.
    await register_fleet_audit(client, config.task_queue)
    # Steward (#835) — per-matter schedule (Phase 0). Always-on; the
    # workflow itself is a no-op until Phase 1 swaps in evaluator
    # logic, so registration cost is negligible.
    await register_steward_schedules(client)
    # Steward Phase 4 (#840) — Vexa transcript intake. VEXA_ENABLED-gated
    # at registration time so a tenant without Vexa never gets these
    # schedules created. Both workflows tick every 60s; the
    # MeetingCapture path drives bot dispatch from gcal events and
    # TranscriptIntake processes Vexa's post-meeting webhook into
    # Steward signals. Neither workflow writes to Plane directly —
    # actions land in streams/steward-signals.jsonl as
    # ``transcript:action_candidate`` for Phase 3 to consume on the
    # relevant matter's next tick.
    await register_meeting_capture(client, config.task_queue)
    await register_transcript_intake(client, config.task_queue)
    # Steward Phase 6 (RFC #842) — signal extraction. Polls the stream
    # vault every 5 minutes for unprocessed events, runs the LLM
    # extractor, and persists one ``signal/`` record per non-noise
    # event. Gated on ``STEWARD_SIGNAL_EXTRACT_ENABLED=true`` —
    # david-only at T6.0.6, fleet rollout at T6.fleet.3.
    await register_signal_extract(client, config.task_queue)
    # Steward Phase 6 (RFC #842 / T6.3.3) — signal router. Reads
    # unrouted signal records every 2 minutes and dispatches each
    # through apply_signal_mutation (effect=mutation) or marks them
    # action_pending / skipped (effect=action / none). Gated on
    # ``STEWARD_SIGNAL_ROUTER_ENABLED=true`` — david-only at T6.3.4.
    # Mode (shadow vs. live) is a SEPARATE env
    # (``STEWARD_SIGNAL_ROUTER_LIVE_MODE``) that the activity reads
    # per-invocation; the registration flag here only controls
    # schedule existence.
    await register_signal_router(client, config.task_queue)
    # Steward Phase 6 (RFC #842 / T6.6.3) — stream-event purge.
    # Daily 03:00 UTC; deletes ``stream_event/*`` records older than
    # 7 days whose ``signal_extracted_at`` is set. The signal record
    # already preserves ``raw_quote`` so dropping the source is
    # non-lossy. Gated on ``STEWARD_STREAM_EVENT_PURGE_ENABLED=true``
    # — david-only at T6.6.4, fleet rollout post-Phase-6.7.
    await register_stream_event_purge(client, config.task_queue)
    # STORE-P4-1 — daily compaction of /vault/_raw/<date>.jsonl.
    # Drops events older than 7d that are processed, hard-deletes
    # partitions older than 30d. Always-on (no env gate).
    await register_stream_raw_compact(client, config.task_queue)
    # STORE-P4-2 — hourly stuck-consumer alert. Checks for any
    # /vault/_raw/<date>.jsonl events older than 7d that are NOT in
    # stream_event_processed; posts to ALERT_WEBHOOK_URL when found.
    # Always-on (no env gate); no webhook = log-only.
    await register_stuck_pipeline_alert(client, config.task_queue)
    # STORE-P5-1 (#921) — daily 90-day Parquet archive of state.db hot
    # tables (audit / signal / observation). 03:00 UTC, SKIP overlap.
    # Always-on; the activity short-circuits when state.db isn't
    # mounted (dev environments) so it's safe to arm before fleet
    # rollout completes the corresponding compose-template change.
    await register_archival_sweep(client, config.task_queue)
    # Steward Phase 6 (RFC #842 / T6.7.5) — reversal-driven negative
    # calibration. 10-min sweep over ``event/steward-action-reversed-*``
    # / ``event/signal-action-reversed-*`` records. Gated on
    # ``STEWARD_REVERSAL_CALIBRATION_ENABLED=true`` — david-only during
    # soak, fleet rollout once the per-source-type confidence shifts
    # have been observed to track real reversal patterns.
    await register_reversal_calibration(client, config.task_queue)


def main() -> None:
    try:
        asyncio.run(register_all())
    except Exception as e:  # noqa: BLE001
        logger.error("register_schedules failed: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
