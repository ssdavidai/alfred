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

SCHEDULES = [
    {
        "id": "al-event-processor",
        "workflow": "EventProcessorWorkflow",
        "interval": timedelta(minutes=2),
    },
    {
        "id": "al-session-tracker",
        "workflow": "SessionTrackerWorkflow",
        "interval": timedelta(minutes=5),
    },
    {
        "id": "al-daily-digest",
        "workflow": "DailyDigestWorkflow",
        "calendar": ScheduleCalendarSpec(
            hour=[ScheduleRange(start=18)],
            minute=[ScheduleRange(start=0)],
        ),
    },
    {
        "id": "al-learning",
        "workflow": "LearningWorkflow",
        "interval": timedelta(minutes=5),
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
        "id": "al-judgment",
        "workflow": "JudgmentWorkflow",
        "interval": timedelta(minutes=2),
    },
]


async def register_all() -> None:
    config = load_config()
    client = await Client.connect(config.temporal_host)

    for sched in SCHEDULES:
        schedule_id = sched["id"]
        workflow_name = sched["workflow"]

        # Build spec
        if "interval" in sched:
            spec = ScheduleSpec(
                intervals=[ScheduleIntervalSpec(every=sched["interval"])]
            )
        else:
            spec = ScheduleSpec(calendars=[sched["calendar"]])

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
            if "already exists" in str(e).lower():
                logger.info("Schedule already exists: %s", schedule_id)
            else:
                logger.error("Failed to create schedule %s: %s", schedule_id, e)
                raise


def main() -> None:
    asyncio.run(register_all())


if __name__ == "__main__":
    main()
