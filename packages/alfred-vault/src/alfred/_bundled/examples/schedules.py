"""Bundled schedule definitions for built-in Alfred workflows."""

from datetime import timedelta

from temporalio.client import ScheduleIntervalSpec, ScheduleSpec

SCHEDULES = [
    {
        "id": "session-harvest",
        "workflow": "SessionHarvestWorkflow",
        "spec": ScheduleSpec(
            intervals=[ScheduleIntervalSpec(every=timedelta(minutes=5))]
        ),
        "args": [],
        "memo": "Harvest OpenClaw chat sessions to inbox every 5 minutes",
    },
]
