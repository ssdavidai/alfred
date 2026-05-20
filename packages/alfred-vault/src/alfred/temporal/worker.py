"""Temporal worker process — connects to server and runs workflows + activities."""

from __future__ import annotations

import asyncio
import logging

from temporalio.client import Client
from temporalio.worker import Worker

from .activities import AlfredActivities
from .config import TemporalRuntime
from .discovery import discover_workflows

logger = logging.getLogger(__name__)


async def _health_watchdog(client: Client, interval: int = 60, max_failures: int = 5) -> None:
    """Periodically probe the Temporal server; exit after consecutive failures."""
    failures = 0
    while True:
        await asyncio.sleep(interval)
        try:
            # Simple health check — list a single schedule
            await client.service_client.check_health()
            failures = 0
        except Exception as e:
            failures += 1
            logger.warning("Health check failed (%d/%d): %s", failures, max_failures, e)
            if failures >= max_failures:
                logger.error("Too many health check failures — exiting.")
                raise SystemExit(1)


async def run_worker(runtime: TemporalRuntime) -> None:
    """Start the Temporal worker with discovered workflows and Alfred activities."""
    from alfred._data import get_bundled_dir
    all_dirs = list(runtime.temporal.workflow_dirs) + [str(get_bundled_dir() / "examples")]
    workflows = discover_workflows(all_dirs)
    if not workflows:
        logger.warning("No workflows discovered from dirs: %s", runtime.temporal.workflow_dirs)

    for wf in workflows:
        defn = getattr(wf, "__temporal_workflow_definition", None)
        name = defn.name if defn else wf.__name__
        logger.info("Registered workflow: %s", name)

    activities_instance = AlfredActivities(runtime)
    activity_methods = [
        activities_instance.spawn_agent,
        activities_instance.run_script,
        activities_instance.notify_slack,
        activities_instance.ping_uptime,
        activities_instance.check_day_of_week,
        activities_instance.load_json_state,
        activities_instance.save_json_state,
        activities_instance.harvest_openclaw_sessions,
    ]

    client = await Client.connect(
        runtime.temporal.address,
        namespace=runtime.temporal.namespace,
    )

    logger.info(
        "Starting worker on task queue '%s' (namespace=%s, address=%s)",
        runtime.temporal.task_queue,
        runtime.temporal.namespace,
        runtime.temporal.address,
    )

    worker = Worker(
        client,
        task_queue=runtime.temporal.task_queue,
        workflows=workflows,
        activities=activity_methods,
    )

    await asyncio.gather(
        worker.run(),
        _health_watchdog(client),
    )
