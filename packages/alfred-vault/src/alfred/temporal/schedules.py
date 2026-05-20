"""Schedule management — register and list Temporal schedules."""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any

from temporalio.client import Client, Schedule, ScheduleActionStartWorkflow, ScheduleSpec

from .config import TemporalRuntime

logger = logging.getLogger(__name__)


def load_schedule_defs_from_file(path: str) -> list[dict[str, Any]]:
    """Load SCHEDULES list from a Python file.

    Expected format:
        SCHEDULES = [
            {"id": "my-workflow", "workflow": "MyWorkflow",
             "spec": ScheduleSpec(cron_expressions=["0 5 * * *"]),
             "memo": "Daily run"},
        ]
    """
    file_path = Path(path).resolve()
    module_name = f"alfred_schedules.{file_path.stem}"
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ValueError(f"Cannot load schedule file: {path}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)

    schedules = getattr(module, "SCHEDULES", None)
    if not isinstance(schedules, list):
        raise ValueError(f"No SCHEDULES list found in {path}")
    return schedules


async def register_schedules(
    runtime: TemporalRuntime,
    schedule_defs: list[dict[str, Any]],
    delete_existing: bool = True,
) -> int:
    """Register schedule definitions with the Temporal server.

    Returns the number of schedules created.
    """
    client = await Client.connect(
        runtime.temporal.address,
        namespace=runtime.temporal.namespace,
    )

    if delete_existing:
        async for handle in client.list_schedules():
            try:
                sched_handle = client.get_schedule_handle(handle.id)
                await sched_handle.delete()
                logger.info("Deleted existing schedule: %s", handle.id)
            except Exception as e:
                logger.warning("Failed to delete schedule %s: %s", handle.id, e)

    created = 0
    for defn in schedule_defs:
        schedule_id = defn["id"]
        workflow_name = defn["workflow"]
        spec = defn.get("spec", ScheduleSpec())
        args = defn.get("args", [])
        memo = defn.get("memo", "")

        try:
            await client.create_schedule(
                schedule_id,
                Schedule(
                    action=ScheduleActionStartWorkflow(
                        workflow_name,
                        args,
                        id=f"scheduled-{schedule_id}",
                        task_queue=runtime.temporal.task_queue,
                    ),
                    spec=spec,
                    state=defn.get("state", None),
                ),
                memo={"description": memo} if memo else None,
            )
            logger.info("Created schedule: %s -> %s", schedule_id, workflow_name)
            created += 1
        except Exception as e:
            logger.error("Failed to create schedule %s: %s", schedule_id, e)

    return created


async def list_schedules(runtime: TemporalRuntime) -> list[str]:
    """List all schedule IDs from the Temporal server."""
    client = await Client.connect(
        runtime.temporal.address,
        namespace=runtime.temporal.namespace,
    )
    ids: list[str] = []
    async for handle in client.list_schedules():
        ids.append(handle.id)
    return ids
