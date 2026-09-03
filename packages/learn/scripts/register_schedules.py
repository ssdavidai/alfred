"""Register all Temporal schedules for alfred-learn.

Run on container first boot:
    python -m scripts.register_schedules
"""

from __future__ import annotations

import asyncio
import json
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

# F34 — chore-schedule reconciler constants. See reconcile_chore_schedules.
CHORE_SCHEDULE_PREFIX = "chore-"
_USER_CHORES_DIR = "/alfred-data/user-chores"

# F33c — the Opus-generated brief-duplicate chore. The brief is a built-in
# now (BriefingWorkflow, F33a), so this generated chore is swept at boot.
# Slug variants cover hyphen (schedule id) + underscore (module name).
_BRIEFING_CHORE_SLUGS = ("morning-briefing", "morning_briefing")
_BRIEFING_CHORE_PY = "morning_briefing.py"

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

# Steward (#835 → #52) — perception loop. Originally one Temporal
# Schedule per matter (``al-steward-<matter-slug>``). Issue #52
# collapsed that fan-out into a single ``al-steward-sweep`` schedule
# running ``StewardSweepWorkflow`` — one schedule for the whole fleet
# of matters, regardless of matter count. The legacy per-matter
# ``al-steward-<slug>`` schedules (everything matching the prefix but
# NOT the sweep id) are deleted once on the next boot.
STEWARD_SCHEDULE_PREFIX = "al-steward-"
STEWARD_SWEEP_SCHEDULE_ID = "al-steward-sweep"
STEWARD_SWEEP_WORKFLOW = "StewardSweepWorkflow"
STEWARD_SWEEP_INTERVAL = timedelta(minutes=30)

# Stream pull (#53) — generic HTTP/Composio pull engine. Originally one
# Temporal Schedule per stream (``al-stream-pull-composio-<id...>``),
# created/deleted by ctrl-api as streams were enabled/disabled — the
# same per-entity dynamic-registrar anti-pattern as Steward. Issue #53
# collapsed that fan-out into a single ``al-stream-sweep`` schedule
# running ``StreamSweepWorkflow`` — one schedule for the whole fleet of
# streams, regardless of stream count. The sweep reads each stream's
# persisted ``schedule_interval_seconds`` / ``last_pull_at`` to decide
# what is due, so the per-stream "when" needs no per-stream schedule.
# The legacy per-stream ``al-stream-pull-*`` schedules are deleted once
# on the next boot. The 2-min sweep interval is the polling granularity:
# a stream's effective cadence is max(schedule_interval_seconds, 2 min).
STREAM_PULL_SCHEDULE_PREFIX = "al-stream-pull-"
STREAM_SWEEP_SCHEDULE_ID = "al-stream-sweep"
STREAM_SWEEP_WORKFLOW = "StreamSweepWorkflow"
STREAM_SWEEP_INTERVAL = timedelta(minutes=2)

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

# Cron-journal reconciler (#418 / GH #556) — call
# POST /api/v1/alfred-journal/reconcile-cron every 6 h.
#
# Interval arithmetic: window=48 h, cap=50 sessions/call.
# Hermes cron jobs with ``deliver`` are outbound-delivery chores (daily
# briefings, weekly digests, etc.) — a busy tenant has at most ~5 such
# jobs.  At 6-hour intervals that is ~1.25 sessions/interval, far under
# the 50-session cap.  A session missed just after one run waits at most
# 6 h, leaving 42 h of the 48-hour window intact.  Default OFF (lesson
# from FLEET_AUDIT_ENABLED defaulting ON and silently running on five
# client tenants for weeks as an operator diagnostic).
CRON_JOURNAL_RECONCILE_SCHEDULE_ID = "al-cron-journal-reconcile"
CRON_JOURNAL_RECONCILE_WORKFLOW = "CronJournalReconcileWorkflow"
CRON_JOURNAL_RECONCILE_INTERVAL = timedelta(hours=6)

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
        "id": "al-blocked-task-recovery",
        "workflow": "BlockedTaskRecoveryWorkflow",
        "interval": timedelta(hours=6),
    },
    {
        "id": "al-learning",
        "workflow": "LearningWorkflow",
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
        # but uses overlap=SKIP via the default schedule policy so two
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
        # semantics are idempotent so overlap is harmless but we still
        # SKIP for hygiene (see the schedule policy below — interval
        # schedules in this list don't currently set an explicit policy,
        # so overlap defaults to ALLOW which is fine here).
        "id": "al-composio-reconnect-cleanup",
        "workflow": "ComposioReconnectCleanupWorkflow",
        "interval": timedelta(minutes=15),
    },
    # Phase 2 #23: the al-openclaw-session-sweep schedule + its
    # OpenclawSessionSweepWorkflow were removed. The .bak-* reaper
    # existed only for OpenClaw's O(N) readdir session-leak; Hermes'
    # SQLite SessionStore makes that failure mode impossible. This is
    # a greenfield deploy with no pre-existing Temporal schedules, so
    # dropping the entry here means it is simply never created — no
    # prune step needed.
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
    {
        # Recall.ai dispatcher (#113 PR4) — every 5 min reads the
        # principal's Google Calendar for the next 15 min, applies
        # the operator-configured auto_join_policy (off /
        # principal_attendee / all), dedupes against
        # already-dispatched calendar_event_ids, refuses dispatches
        # that would blow the monthly_hours_cap, and POSTs to
        # ctrl-api's create-bot route for each surviving event. The
        # workflow is a no-op when auto_join_policy=off, so leaving
        # the schedule registered on tenants that haven't enabled
        # Recall costs only one ctrl-api GET per tick.
        "id": "al-recall-dispatcher",
        "workflow": "RecallDispatcherWorkflow",
        "interval": timedelta(minutes=5),
    },
    {
        # HA registry bootstrap (#110 PR5) — every 6h pulls the operator's
        # HA install's full state / area / device / automation surface
        # and refreshes ha_registry in state.db (via ctrl-api's
        # /api/v1/channels/ha/registry/bulk route). The workflow is a
        # no-op (returns ``{ok: False, code: "HA_NOT_CONNECTED"}``) when
        # no HA install is connected, so the schedule costs only one
        # ctrl-api GET per tick on tenants that haven't connected HA.
        #
        # 6 hours matches the spec §6.PR5 cadence. On-demand triggers
        # via ctrl-api's /api/v1/channels/ha/registry/refresh route
        # start a one-shot run with a unique workflow_id so they don't
        # clash with the scheduled tick.
        "id": "al-ha-bootstrap",
        "workflow": "HaBootstrapWorkflow",
        "interval": timedelta(hours=6),
    },
]

CALENDAR_SCHEDULES = [
    {
        "id": "al-flywheel-telemetry",
        "workflow": "FlywheelTelemetryWorkflow",
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=3)],
            minute=[ScheduleRange(start=30)],
        ),
    },
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
        # NAR daily recap — writes the nar_entry rows /attention reads.
        # 03:00, so it lands after the day it summarises has closed in UTC and
        # after the 02:00 narrative pass.
        #
        # Ad-hoc only until 2026-08-25, which left an eight-day hole in
        # nar_entry. Displaced time comes from these rows; engaged time is
        # derived live from sessions, so a missing day is not "no data" on the
        # chart — it is 0 - engaged, i.e. a confident negative.
        #
        # No input: the workflow recaps the previous UTC day by default.
        "id": "al-nar-recap",
        "workflow": "NarDayRecapWorkflow",
        "calendar": ScheduleCalendarSpec(
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
        # F33 — the daily brief is a mandatory built-in, not a chore.
        # Morning slot: butler walks in with the coffee at 05:00 LOCAL
        # (the calendar tz is the tenant's, set in register_all). The
        # positional ``slot`` string matches BriefingWorkflow.run(self,
        # slot) (C10). Onboarding no longer generates a brief chore, and
        # the duplicate generated morning_briefing chore is swept.
        "id": "al-briefing-morning",
        "workflow": "BriefingWorkflow",
        "args": ["morning"],
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=5)],
            minute=[ScheduleRange(start=0)],
        ),
    },
    {
        # F33 — evening wrap at 17:00 LOCAL.
        "id": "al-briefing-evening",
        "workflow": "BriefingWorkflow",
        "args": ["evening"],
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=17)],
            minute=[ScheduleRange(start=0)],
        ),
    },
    {
        # #114 PR 5 — daily cold-archive sweep for Store 5 (files).
        # Walks the principal's files table for blobs untouched in
        # >=90 days, hands each one to ctrl-api's
        # POST /api/v1/files/cold-promote endpoint (zstd-19 compress
        # → write to `files_cold_data` → unlink live → atomic SQL
        # flip). Runs at 03:00 LOCAL — low-traffic window, sits
        # comfortably between nightly_maintenance and the morning
        # briefing. The sweep is per-entry-isolated so one bad file
        # never wedges the rest of the run.
        "id": "al-files-cold-archive",
        "workflow": "FilesColdArchiveWorkflow",
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=3)],
            minute=[ScheduleRange(start=0)],
        ),
    },
    {
        # #584 — pre-compute the TRENDS tab attention read so it appears
        # without the Generate button.
        #
        # The schedule MUST be DAILY, not weekly.  Reason: trendsTo is
        # `now` (AttentionPage.tsx:695), so the subject key the UI looks
        # up is "attention_trend:week:<from>:<today>".  A weekly schedule
        # would write a key anchored to Monday's date; any visit on Tue–Sun
        # would find nothing and show "not generated yet".  Daily ensures
        # the stored key always matches the current day's window.
        #
        # AttentionPage.tsx line 32/694:
        #   const thirteenWeeksAgo = () => { d.setDate(d.getDate()-91) }
        #   const [trendsFrom] = useState(thirteenWeeksAgo);   // today−91d
        #   const [trendsTo]   = useState(now);               // today
        #
        # 04:00 LOCAL: nightly-maintenance (03:00) has settled, one hour
        # before the morning briefing (05:00).
        "id": "al-attention-trend-read",
        "workflow": "AttentionTrendReadWorkflow",
        "args": [{"grain": "week"}],
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
    """Feature flag for the daily fleet audit. Defaults to ``false`` (opt-in).

    The audit is an operator diagnostic — it must not run on client tenants
    by default. The dev tenant carries an explicit ``FLEET_AUDIT_ENABLED=true``
    in its ``.env``; all others stay off unless the operator sets it.
    """
    return os.environ.get(
        "FLEET_AUDIT_ENABLED", "false",
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

    Default ON (#6). A fresh single-tenant box must register the
    SignalExtract schedule or the whole signal pipeline never starts and
    the Desk is silently empty. An operator can still disable it
    explicitly by setting ``STEWARD_SIGNAL_EXTRACT_ENABLED`` to a falsy
    value (``false``/``0``/``no``).

    Single-source registration-time gate. The workflow itself does not
    re-check the env (would break Temporal determinism), so flipping the
    flag off requires a deploy that re-runs ``register_schedules`` to
    delete the schedule.
    """
    return os.environ.get(
        "STEWARD_SIGNAL_EXTRACT_ENABLED", "",
    ).strip().lower() not in ("false", "0", "no", "off")


def _signal_router_enabled() -> bool:
    """Feature flag for Phase 6 signal router (T6.3.3 / T6.3.4).

    Default ON (#6) — independent from ``STEWARD_SIGNAL_EXTRACT_ENABLED``
    so a tenant can still run extraction (write-only) without the router
    by disabling this flag alone. Without a routed signal there is no
    Desk card, so a fresh box defaults the router on too. Disable
    explicitly with a falsy value (``false``/``0``/``no``). Same
    single-source registration-time gate as the rest of the Phase 6
    flags.
    """
    return os.environ.get(
        "STEWARD_SIGNAL_ROUTER_ENABLED", "",
    ).strip().lower() not in ("false", "0", "no", "off")


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


def _cron_journal_reconcile_enabled() -> bool:
    """Feature flag for the cron-journal reconciler (#418). Default OFF.

    Tenants opt in by setting ``CRON_JOURNAL_RECONCILE_ENABLED=true``.
    Defaults OFF — lesson from FLEET_AUDIT_ENABLED defaulting ON and
    silently running as an operator diagnostic on client tenants.
    The activity re-checks at invocation time so flipping the flag off
    without a redeploy immediately stops new runs.
    """
    return os.environ.get(
        "CRON_JOURNAL_RECONCILE_ENABLED", "",
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

    Gate: ``STEWARD_SIGNAL_EXTRACT_ENABLED`` — default ON (#6), disable
    with a falsy value (``false``/``0``/``no``).

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


async def register_cron_journal_reconcile(
    client: Client, task_queue: str,
) -> None:
    """Create-or-delete ``al-cron-journal-reconcile`` based on the flag.

    Gate: ``CRON_JOURNAL_RECONCILE_ENABLED=true``.  Default OFF.
    Interval: 6 h.  See the constant block above for the arithmetic.
    """
    await _register_or_delete_singleton_schedule(
        client,
        CRON_JOURNAL_RECONCILE_SCHEDULE_ID,
        CRON_JOURNAL_RECONCILE_WORKFLOW,
        task_queue,
        CRON_JOURNAL_RECONCILE_INTERVAL,
        _cron_journal_reconcile_enabled(),
        label="cron_journal_reconcile",
    )


async def register_signal_router(client: Client, task_queue: str) -> None:
    """Create-or-delete ``al-signal-router`` based on the Phase 6.3 flag.

    Gate: ``STEWARD_SIGNAL_ROUTER_ENABLED`` — default ON (#6), disable
    with a falsy value (``false``/``0``/``no``). The router triggers
    signal-mutation routing (and, after T6.4.x ships,
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


# ---------------------------------------------------------------------------
# Steward (#835 → #52) — single sweep-schedule registration
# ---------------------------------------------------------------------------

async def _delete_legacy_steward_schedules(client: Client) -> int:
    """Delete every legacy per-matter ``al-steward-<slug>`` schedule.

    Issue #52 retired the per-matter ``al-steward-*`` fan-out in favour
    of the single ``al-steward-sweep`` schedule. This is a one-time
    cleanup: it lists every schedule whose id starts with the
    ``al-steward-`` prefix and deletes all of them EXCEPT the new
    ``al-steward-sweep`` id. It is idempotent — once the legacy
    schedules are gone, subsequent boots find nothing to delete.

    This repurposes the old ``_delete_orphan_steward_schedules`` logic:
    where that deleted schedules whose matter no longer existed, this
    deletes every per-matter schedule unconditionally (the sweep now
    owns all matters). Best-effort — a failed individual delete is
    logged and does not abort the boot sequence.

    Returns the number of schedules deleted.
    """
    deleted = 0
    try:
        legacy_ids: list[str] = []
        async for entry in await client.list_schedules():
            sid = getattr(entry, "id", None) or ""
            if sid.startswith(STEWARD_SCHEDULE_PREFIX) and sid != STEWARD_SWEEP_SCHEDULE_ID:
                legacy_ids.append(sid)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "register_steward_sweep: list_schedules failed: %s "
            "— skipping legacy-schedule cleanup this boot", exc,
        )
        return 0

    for sid in legacy_ids:
        try:
            await client.get_schedule_handle(sid).delete()
            logger.info(
                "register_steward_sweep: deleted legacy per-matter "
                "schedule %s", sid,
            )
            deleted += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "register_steward_sweep: delete legacy %s failed: %s",
                sid, exc,
            )
    return deleted


async def register_steward_schedules(client: Client) -> None:
    """Register the single ``al-steward-sweep`` schedule (#52).

    Replaces the former per-matter registrar. One schedule for the whole
    fleet of matters: ``StewardSweepWorkflow`` runs every 30 min, lists
    the matters whose per-task ``next_check_after`` cursors have elapsed,
    and runs the existing per-matter Steward loop for each.

    Also performs the one-time cleanup of the legacy per-matter
    ``al-steward-<slug>`` schedules. Idempotent — re-running refreshes
    the sweep schedule and finds no legacy schedules left to delete.
    """
    cfg = load_config()

    action = ScheduleActionStartWorkflow(
        STEWARD_SWEEP_WORKFLOW,
        id=f"{STEWARD_SWEEP_SCHEDULE_ID}-run",
        task_queue=cfg.task_queue,
        # 25-minute envelope. One sweep does more work than a single
        # per-matter run did (the old per-matter schedule used a 5-min
        # cap), so the timeout is sized up — but stays well under the
        # 30-min Hermes/Temporal cron norm (HERMES_CRON_TIMEOUT=1800)
        # and under the 30-min schedule interval. The per-run matter
        # count is bounded by SWEEP_MATTER_BATCH_LIMIT (200) so the
        # worst case stays inside this envelope; matters beyond the cap
        # drain on the next tick. Mirrors al-signal-extract's 25-min cap.
        execution_timeout=timedelta(minutes=25),
        run_timeout=timedelta(minutes=25),
    )
    spec = ScheduleSpec(
        intervals=[ScheduleIntervalSpec(every=STEWARD_SWEEP_INTERVAL)],
    )
    # SKIP overlap: a sweep run that somehow ran past its envelope must
    # not stack a second sweep on top — the per-task next_check_after
    # cursors make the next tick re-pick any matter not yet processed.
    new_schedule = Schedule(
        action=action,
        spec=spec,
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
    )

    async def _updater(inp: ScheduleUpdateInput) -> ScheduleUpdate:
        return ScheduleUpdate(schedule=new_schedule)

    handle = client.get_schedule_handle(STEWARD_SWEEP_SCHEDULE_ID)
    try:
        await handle.describe()
        await handle.update(_updater)
        logger.info(
            "register_steward_sweep: schedule %s updated (30-min, SKIP)",
            STEWARD_SWEEP_SCHEDULE_ID,
        )
    except RPCError as exc:
        if exc.status != RPCStatusCode.NOT_FOUND:
            raise
        try:
            await client.create_schedule(
                STEWARD_SWEEP_SCHEDULE_ID, new_schedule,
            )
            logger.info(
                "register_steward_sweep: schedule %s created (30-min, SKIP)",
                STEWARD_SWEEP_SCHEDULE_ID,
            )
        except RPCError as create_exc:
            if create_exc.status != RPCStatusCode.ALREADY_EXISTS:
                raise
            logger.info(
                "register_steward_sweep: schedule %s already exists "
                "(skipping)", STEWARD_SWEEP_SCHEDULE_ID,
            )

    # One-time cleanup: delete every legacy per-matter al-steward-<slug>
    # schedule now that the sweep owns all matters.
    deleted = await _delete_legacy_steward_schedules(client)
    logger.info(
        "register_steward_sweep: legacy per-matter schedules deleted=%d",
        deleted,
    )


# ---------------------------------------------------------------------------
# Stream pull (#53) — single sweep-schedule registration
# ---------------------------------------------------------------------------

async def _delete_legacy_stream_pull_schedules(client: Client) -> int:
    """Delete every legacy per-stream ``al-stream-pull-*`` schedule.

    Issue #53 retired the per-stream ``al-stream-pull-*`` fan-out in
    favour of the single ``al-stream-sweep`` schedule. ctrl-api no
    longer creates these (the schedule-registration code path in
    integrations.ts is removed), so this is a one-time cleanup: it
    lists every schedule whose id starts with the ``al-stream-pull-``
    prefix and deletes all of them. It is idempotent — once the legacy
    schedules are gone, subsequent boots find nothing to delete.

    Mirrors ``_delete_legacy_steward_schedules`` (#52). Best-effort — a
    failed individual delete is logged and does not abort the boot
    sequence.

    Returns the number of schedules deleted.
    """
    deleted = 0
    try:
        legacy_ids: list[str] = []
        async for entry in await client.list_schedules():
            sid = getattr(entry, "id", None) or ""
            if sid.startswith(STREAM_PULL_SCHEDULE_PREFIX):
                legacy_ids.append(sid)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "register_stream_sweep: list_schedules failed: %s "
            "— skipping legacy-schedule cleanup this boot", exc,
        )
        return 0

    for sid in legacy_ids:
        try:
            await client.get_schedule_handle(sid).delete()
            logger.info(
                "register_stream_sweep: deleted legacy per-stream "
                "schedule %s", sid,
            )
            deleted += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "register_stream_sweep: delete legacy %s failed: %s",
                sid, exc,
            )
    return deleted


def _slugify_chore(name: str) -> str:
    """Mirror assign_chores._slugify (a .py stem → its chore-<slug> id)."""
    import re
    s = name.lower()
    s = re.sub(r"[_\s]+", "-", s)
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


async def _fetch_vault_chore_records() -> tuple[list[dict], bool]:
    """Return ``(records, ok)`` for the live vault ``chore/*`` list (F34b).

    ``ok`` is ``True`` only on a clean 200 read; any failure yields
    ``([], False)`` so callers treat the backing source as *unknown* (not
    *empty*) and decline to delete this boot.
    """
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(
            base_url=config.alfred_ctrl_url, timeout=15.0, headers=headers
        ) as client:
            resp = await client.get("/api/v1/vault/list/chore")
            resp.raise_for_status()
            body = resp.json()
        # ctrl-api contract is {"results": [...], "count": N}. Legacy code
        # read "records" (which never exists) → silently-empty backing set.
        if isinstance(body, dict):
            records = body.get("results")
            if records is None:
                records = body.get("records")
        else:
            records = body
        return list(records or []), True
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "reconcile_chore_schedules: vault chore list failed: %s "
            "— treating backing as UNKNOWN (deleting nothing this boot)", exc,
        )
        return [], False


async def _vault_chore_slugs() -> tuple[set[str], bool]:
    """Slugs of live vault ``chore/*`` records + whether the read succeeded.

    On failure ``ok`` is ``False``; a transient read must never be mistaken
    for "no chores exist", so the caller MUST NOT delete anything then.
    """
    records, ok = await _fetch_vault_chore_records()
    slugs: set[str] = set()
    for rec in records:
        path = str((rec or {}).get("path") or "").strip()
        if path.startswith("chore/") and path.endswith(".md"):
            slugs.add(path[len("chore/"):-len(".md")])
    return slugs, ok


async def _collect_live_chore_slugs() -> tuple[set[str], bool]:
    """Backing slugs (union of ``.py`` stems + vault records) + ``backing_ok``.

    The ``.py`` arm is an additional-safety signal only; deletion is gated on
    ``backing_ok`` (the authoritative vault read), never on the ``.py`` set.
    """
    slugs: set[str] = set()
    try:
        for fn in os.listdir(_USER_CHORES_DIR):
            if fn.endswith(".py") and not fn.startswith("_"):
                slugs.add(_slugify_chore(fn[:-len(".py")]))
    except FileNotFoundError:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("reconcile_chore_schedules: user-chores scan failed: %s", exc)
    vault_slugs, backing_ok = await _vault_chore_slugs()
    slugs |= vault_slugs
    return slugs, backing_ok


async def reconcile_chore_schedules(
    client: Client,
    *,
    live_slugs: set[str] | None = None,
    backing_ok: bool | None = None,
) -> int:
    """Delete orphaned ``chore-*`` Temporal schedules (F34 / F34b).

    An orphan is a ``chore-<slug>`` schedule with NO backing ``.py`` or
    vault ``chore/<slug>.md`` record. Only the ``chore-`` prefix is swept;
    any backing keeps the schedule. Best-effort + idempotent.

    F34b safety: deletion requires a SUCCESSFUL authoritative vault read. If
    the vault list could not be read this boot, the backing set is *unknown*
    and we delete NOTHING — never fall through to a ``.py``-only set whose
    title-derived slugs don't match real schedules (the bug that nuked all 19
    live schedules). An explicit ``live_slugs`` is authoritative unless
    ``backing_ok=False`` is passed.
    """
    if live_slugs is None:
        live_slugs, collected_ok = await _collect_live_chore_slugs()
        if backing_ok is None:
            backing_ok = collected_ok
    elif backing_ok is None:
        backing_ok = True

    if not backing_ok:
        logger.warning(
            "reconcile_chore_schedules: vault backing read FAILED — "
            "skipping deletion this boot (would otherwise over-delete "
            "legit chore schedules)",
        )
        return 0

    deleted = 0
    try:
        orphan_ids: list[str] = []
        async for entry in await client.list_schedules():
            sid = getattr(entry, "id", None) or ""
            if not sid.startswith(CHORE_SCHEDULE_PREFIX):
                continue
            slug = sid[len(CHORE_SCHEDULE_PREFIX):]
            if slug not in live_slugs:
                orphan_ids.append(sid)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "reconcile_chore_schedules: list_schedules failed: %s "
            "— skipping chore-schedule reconciliation this boot", exc,
        )
        return 0

    for sid in orphan_ids:
        try:
            await client.get_schedule_handle(sid).delete()
            logger.info(
                "reconcile_chore_schedules: deleted orphan chore schedule %s "
                "(no backing .py/record)", sid,
            )
            deleted += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "reconcile_chore_schedules: delete orphan %s failed: %s",
                sid, exc,
            )
    if deleted:
        logger.info("reconcile_chore_schedules: removed %d orphan schedule(s)", deleted)
    return deleted


async def _remove_briefing_chore_files_and_record() -> None:
    """Delete the brief-duplicate chore's ``.py`` + vault record (F33c).

    Best-effort: a missing file / unreachable ctrl-api logs and continues.
    """
    try:
        py = os.path.join(_USER_CHORES_DIR, _BRIEFING_CHORE_PY)
        if os.path.exists(py):
            os.remove(py)
            logger.info("delete_duplicate_briefing_chore: removed %s", py)
    except Exception as exc:  # noqa: BLE001
        logger.warning("delete_duplicate_briefing_chore: .py remove failed: %s", exc)

    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(
            base_url=config.alfred_ctrl_url, timeout=15.0, headers=headers
        ) as client:
            for slug in _BRIEFING_CHORE_SLUGS:
                try:
                    await client.delete(f"/api/v1/vault/records/chore/{slug}.md")
                except Exception:  # noqa: BLE001
                    pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("delete_duplicate_briefing_chore: record delete failed: %s", exc)


async def delete_duplicate_briefing_chore(client: Client) -> int:
    """Sweep the duplicate generated ``morning_briefing`` chore (F33c).

    The brief is a built-in (F33a), so the Opus-generated morning_briefing
    chore — a ``.py``, a ``chore-morning-briefing`` schedule, and a
    ``chore/morning-briefing.md`` record — is a duplicate that races the
    built-in. F34's orphan reconciler won't touch it (it HAS backing), so
    this targeted cleanup deletes the schedule + ``.py`` + vault record.
    Idempotent: a clean tenant deletes nothing. Returns schedules deleted.
    """
    deleted = 0
    targets = {f"{CHORE_SCHEDULE_PREFIX}{s}" for s in _BRIEFING_CHORE_SLUGS}
    try:
        present: list[str] = []
        async for entry in await client.list_schedules():
            sid = getattr(entry, "id", None) or ""
            if sid in targets:
                present.append(sid)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "delete_duplicate_briefing_chore: list_schedules failed: %s", exc,
        )
        present = []

    for sid in present:
        try:
            await client.get_schedule_handle(sid).delete()
            logger.info("delete_duplicate_briefing_chore: deleted schedule %s", sid)
            deleted += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "delete_duplicate_briefing_chore: schedule %s delete failed: %s",
                sid, exc,
            )

    await _remove_briefing_chore_files_and_record()
    return deleted


def _chore_workflow_from_frontmatter(fm: dict[str, Any]) -> str | None:
    """Workflow type for a chore: ``workflow_class_name`` (generated) else
    ``template`` mapped via assign_chores' registry. ``None`` if neither."""
    wf_class = fm.get("workflow_class_name")
    if isinstance(wf_class, str) and wf_class.strip():
        return wf_class.strip()
    template = fm.get("template")
    if isinstance(template, str) and template.strip():
        try:
            from src.activities.assign_chores import _TEMPLATE_TO_WORKFLOW
            return _TEMPLATE_TO_WORKFLOW.get(template.strip())
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "recreate_missing_chore_schedules: template map import "
                "failed: %s", exc,
            )
    return None


def _decode_chore_params(raw: Any) -> dict[str, Any]:
    """Decode a chore record's ``params`` frontmatter (a JSON string scalar)
    into a dict; absent/empty/malformed → ``{}`` (F34b)."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            decoded = json.loads(raw)
            return decoded if isinstance(decoded, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


async def recreate_missing_chore_schedules(client: Client) -> int:
    """Re-create ``chore-<slug>`` schedules for live records lacking one (F34b).

    The F34 reconciler only deletes; an over-deletion (or Temporal reset)
    can leave a live ``chore/<slug>.md`` record with no schedule, so it never
    fires. For each ACTIVE record we (re)create ``chore-<slug>`` if absent —
    cron from ``schedule``, workflow from ``workflow_class_name``/``template``,
    input ``{"chore_slug": slug, **params}``. Idempotent, best-effort, never
    blocks boot. SKIPs F33c briefing slugs + non-active records. Returns count.
    """
    records, ok = await _fetch_vault_chore_records()
    if not ok:
        logger.warning(
            "recreate_missing_chore_schedules: vault chore list unreadable "
            "— skipping restoration this boot",
        )
        return 0

    cfg = load_config()
    created = 0
    for rec in records:
        rec = rec or {}
        path = str(rec.get("path") or "").strip()
        if not (path.startswith("chore/") and path.endswith(".md")):
            continue
        slug = path[len("chore/"):-len(".md")]
        if not slug or slug in _BRIEFING_CHORE_SLUGS:
            continue

        fm = rec.get("frontmatter")
        fm = fm if isinstance(fm, dict) else {}

        status = str(fm.get("status") or "").strip().lower()
        if status in ("paused", "completed"):
            continue

        cron = fm.get("schedule")
        if not (isinstance(cron, str) and cron.strip()):
            logger.warning("recreate_missing: %s has no cron — skipping", slug)
            continue

        workflow_name = _chore_workflow_from_frontmatter(fm)
        if not workflow_name:
            logger.warning("recreate_missing: %s has no workflow — skipping", slug)
            continue
        # BriefingWorkflow is a built-in (F33a) taking a positional slot, not
        # the chore-input dict — never recreate it as a chore schedule.
        if workflow_name == "BriefingWorkflow":
            continue

        params = _decode_chore_params(fm.get("params"))
        wf_input = {"chore_slug": slug, **params}
        schedule_id = f"{CHORE_SCHEDULE_PREFIX}{slug}"

        action = ScheduleActionStartWorkflow(
            workflow_name,
            wf_input,
            id=f"{schedule_id}-run",
            task_queue=cfg.task_queue,
        )
        spec = ScheduleSpec(cron_expressions=[cron.strip()])
        try:
            await client.create_schedule(
                schedule_id, Schedule(action=action, spec=spec),
            )
            created += 1
            logger.info(
                "recreate_missing_chore_schedules: created %s → %s",
                schedule_id, workflow_name,
            )
        except Exception as exc:  # noqa: BLE001
            err = str(exc).lower()
            if "already" in err or "exists" in err or "running" in err:
                logger.info(
                    "recreate_missing_chore_schedules: %s already exists "
                    "(skipping)", schedule_id,
                )
            else:
                logger.warning(
                    "recreate_missing_chore_schedules: create %s failed: %s",
                    schedule_id, exc,
                )
    if created:
        logger.info(
            "recreate_missing_chore_schedules: created %d missing schedule(s)",
            created,
        )
    return created


async def register_stream_sweep_schedule(client: Client) -> None:
    """Register the single ``al-stream-sweep`` schedule (#53).

    Replaces the former ctrl-api per-stream registrar. One schedule for
    the whole fleet of streams: ``StreamSweepWorkflow`` runs every
    2 min, lists the enabled streams whose persisted
    ``schedule_interval_seconds`` has elapsed since their
    ``last_pull_at``, and runs the existing per-stream pull body for
    each.

    Also performs the one-time cleanup of the legacy per-stream
    ``al-stream-pull-*`` schedules. Idempotent — re-running refreshes
    the sweep schedule and finds no legacy schedules left to delete.
    """
    cfg = load_config()

    action = ScheduleActionStartWorkflow(
        STREAM_SWEEP_WORKFLOW,
        id=f"{STREAM_SWEEP_SCHEDULE_ID}-run",
        task_queue=cfg.task_queue,
        # 110-second envelope — comfortably inside the 2-min interval so
        # a slow sweep can't stack against the next tick (overlap is
        # also SKIP). The per-run stream count is bounded by
        # SWEEP_STREAM_BATCH_LIMIT (100) and streams are typically
        # <20/tenant, so the worst case stays well inside this window;
        # any backlog drains on the next tick.
        execution_timeout=timedelta(seconds=110),
        run_timeout=timedelta(seconds=110),
    )
    spec = ScheduleSpec(
        intervals=[ScheduleIntervalSpec(every=STREAM_SWEEP_INTERVAL)],
    )
    # SKIP overlap: a sweep run that somehow ran past its envelope must
    # not stack a second sweep on top — the per-stream last_pull_at
    # cursors make the next tick re-pick any stream not yet pulled.
    new_schedule = Schedule(
        action=action,
        spec=spec,
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
    )

    async def _updater(inp: ScheduleUpdateInput) -> ScheduleUpdate:
        return ScheduleUpdate(schedule=new_schedule)

    handle = client.get_schedule_handle(STREAM_SWEEP_SCHEDULE_ID)
    try:
        await handle.describe()
        await handle.update(_updater)
        logger.info(
            "register_stream_sweep: schedule %s updated (2-min, SKIP)",
            STREAM_SWEEP_SCHEDULE_ID,
        )
    except RPCError as exc:
        if exc.status != RPCStatusCode.NOT_FOUND:
            raise
        try:
            await client.create_schedule(
                STREAM_SWEEP_SCHEDULE_ID, new_schedule,
            )
            logger.info(
                "register_stream_sweep: schedule %s created (2-min, SKIP)",
                STREAM_SWEEP_SCHEDULE_ID,
            )
        except RPCError as create_exc:
            if create_exc.status != RPCStatusCode.ALREADY_EXISTS:
                raise
            logger.info(
                "register_stream_sweep: schedule %s already exists "
                "(skipping)", STREAM_SWEEP_SCHEDULE_ID,
            )

    # One-time cleanup: delete every legacy per-stream
    # al-stream-pull-* schedule now that the sweep owns all streams.
    deleted = await _delete_legacy_stream_pull_schedules(client)
    logger.info(
        "register_stream_sweep: legacy per-stream schedules deleted=%d",
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

    for sched in schedules:
        schedule_id = sched["id"]
        workflow_name = sched["workflow"]
        spec = sched["spec"]

        # F33 — a schedule may carry positional workflow args (e.g. the
        # briefing slot string per C10). Most schedules take none.
        action = ScheduleActionStartWorkflow(
            workflow_name,
            args=sched.get("args") or [],
            id=f"{schedule_id}-run",
            task_queue=config.task_queue,
        )

        try:
            await client.create_schedule(
                schedule_id,
                Schedule(action=action, spec=spec),
            )
            logger.info("Created schedule: %s → %s", schedule_id, workflow_name)
        except Exception as e:
            err = str(e).lower()
            if "already" in err or "running" in err or "exists" in err:
                logger.info("Schedule already exists: %s (skipping)", schedule_id)
            else:
                logger.error("Failed to create schedule %s: %s", schedule_id, e)
                raise

    # Plane two-way sync (#536) — registration-time feature-gated.
    await register_plane_sync(client, config.task_queue)
    await register_plane_reverse_sync(client, config.task_queue)
    # Plane reconciliation — hourly REST-delete sweep.
    await register_plane_reconciliation(client, config.task_queue)
    # Fleet audit — daily wrong-tenant stream contamination check.
    await register_fleet_audit(client, config.task_queue)
    # Steward (#835 → #52) — single ``al-steward-sweep`` schedule.
    # Issue #52 collapsed the per-matter ``al-steward-<slug>`` fan-out
    # into one StewardSweepWorkflow schedule; this call also does the
    # one-time cleanup of the legacy per-matter schedules.
    await register_steward_schedules(client)
    # Stream pull (#53) — single ``al-stream-sweep`` schedule. Issue #53
    # collapsed the per-stream ``al-stream-pull-*`` fan-out (formerly
    # created/deleted by ctrl-api) into one StreamSweepWorkflow
    # schedule; this call also does the one-time cleanup of the legacy
    # per-stream schedules.
    await register_stream_sweep_schedule(client)
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
    # Steward Phase 6 (RFC #842 / T6.7.5) — reversal-driven negative
    # calibration. 10-min sweep over ``event/steward-action-reversed-*``
    # / ``event/signal-action-reversed-*`` records. Gated on
    # ``STEWARD_REVERSAL_CALIBRATION_ENABLED=true`` — david-only during
    # soak, fleet rollout once the per-source-type confidence shifts
    # have been observed to track real reversal patterns.
    await register_reversal_calibration(client, config.task_queue)
    # Cron-journal reconciler (#418 / GH #556) — 6-hourly call to
    # POST /api/v1/alfred-journal/reconcile-cron to journal Hermes cron
    # outbounds.  Gated on CRON_JOURNAL_RECONCILE_ENABLED (default OFF).
    await register_cron_journal_reconcile(client, config.task_queue)
    try:  # F33c — sweep the brief-duplicate chore (brief is a built-in now).
        await delete_duplicate_briefing_chore(client)
    except Exception as exc:  # noqa: BLE001
        logger.warning("delete_duplicate_briefing_chore: sweep failed: %s", exc)
    try:  # F34 — sweep TRUE orphaned chore-* schedules; never blocks boot.
        await reconcile_chore_schedules(client)
    except Exception as exc:  # noqa: BLE001
        logger.warning("reconcile_chore_schedules: sweep failed: %s", exc)
    try:  # F34b — restore chore schedules whose vault record lacks one.
        await recreate_missing_chore_schedules(client)
    except Exception as exc:  # noqa: BLE001
        logger.warning("recreate_missing_chore_schedules: restore failed: %s", exc)


def main() -> None:
    try:
        asyncio.run(register_all())
    except Exception as e:  # noqa: BLE001
        logger.error("register_schedules failed: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
