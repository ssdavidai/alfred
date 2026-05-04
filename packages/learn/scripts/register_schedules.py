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
]

CALENDAR_SCHEDULES = [
    {
        "id": "al-daily-digest",
        "workflow": "DailyDigestWorkflow",
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=18)],
            minute=[ScheduleRange(start=0)],
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

        action = ScheduleActionStartWorkflow(
            workflow_name,
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


def main() -> None:
    try:
        asyncio.run(register_all())
    except Exception as e:  # noqa: BLE001
        logger.error("register_schedules failed: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
