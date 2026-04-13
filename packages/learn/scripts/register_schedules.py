"""Register all Temporal schedules for alfred-learn.

Run on container first boot:
    python -m scripts.register_schedules
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from temporalio.client import Client, Schedule, ScheduleActionStartWorkflow, ScheduleIntervalSpec, ScheduleSpec, ScheduleCalendarSpec, ScheduleRange

from src.config import load_config

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


async def register_all() -> None:
    config = load_config()
    client = await Client.connect(config.temporal_host)
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


def main() -> None:
    asyncio.run(register_all())


if __name__ == "__main__":
    main()
