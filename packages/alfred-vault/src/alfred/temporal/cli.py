"""CLI handlers for `alfred temporal` subcommands."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def _load_runtime(raw: dict[str, Any]) -> Any:
    from alfred._data import get_skills_dir
    from alfred.temporal.config import load_from_unified
    return load_from_unified(raw, get_skills_dir())


def cmd_worker(args: argparse.Namespace, raw: dict[str, Any]) -> None:
    """Start the Temporal worker process."""
    from alfred.temporal.worker import run_worker
    runtime = _load_runtime(raw)
    print(f"Starting worker on {runtime.temporal.address} queue={runtime.temporal.task_queue}")
    try:
        asyncio.run(run_worker(runtime))
    except KeyboardInterrupt:
        print("\nWorker stopped.")


def cmd_run(args: argparse.Namespace, raw: dict[str, Any]) -> None:
    """Trigger a one-off workflow execution."""
    from temporalio.client import Client

    runtime = _load_runtime(raw)
    workflow_name = args.workflow_name
    params_json = args.params
    workflow_id = args.id or f"manual-{workflow_name}"

    wf_args: list[Any] = []
    if params_json:
        try:
            parsed = json.loads(params_json)
            wf_args = parsed if isinstance(parsed, list) else [parsed]
        except json.JSONDecodeError as e:
            print(f"Invalid JSON params: {e}")
            return

    async def _run() -> None:
        client = await Client.connect(
            runtime.temporal.address,
            namespace=runtime.temporal.namespace,
        )
        print(f"Executing {workflow_name} (id={workflow_id})...")
        handle = await client.start_workflow(
            workflow_name,
            args=wf_args,
            id=workflow_id,
            task_queue=runtime.temporal.task_queue,
        )
        result = await handle.result()
        print(f"Result: {result}")

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        print("\nCancelled.")
    except Exception as e:
        print(f"Error: {e}")


def cmd_schedule(args: argparse.Namespace, raw: dict[str, Any]) -> None:
    """Manage schedules: register or list."""
    schedule_cmd = args.schedule_cmd

    if schedule_cmd == "register":
        from alfred._data import get_bundled_dir
        from alfred.temporal.schedules import load_schedule_defs_from_file, register_schedules

        runtime = _load_runtime(raw)

        # Load user-provided schedule definitions
        defs = load_schedule_defs_from_file(args.file)
        print(f"Loaded {len(defs)} schedule definitions from {args.file}")

        # Also load bundled schedule definitions
        bundled_schedules = get_bundled_dir() / "examples" / "schedules.py"
        if bundled_schedules.exists():
            bundled_defs = load_schedule_defs_from_file(str(bundled_schedules))
            # Merge: bundled defs first, user defs override by id
            bundled_ids = {d["id"] for d in bundled_defs}
            user_ids = {d["id"] for d in defs}
            merged = bundled_defs + [d for d in defs if d["id"] not in bundled_ids]
            new_bundled = len(bundled_ids - user_ids)
            if new_bundled:
                print(f"Added {new_bundled} bundled schedule definitions")
            defs = merged

        count = asyncio.run(register_schedules(runtime, defs))
        print(f"Registered {count} schedules.")

    elif schedule_cmd == "list":
        from alfred.temporal.schedules import list_schedules
        runtime = _load_runtime(raw)
        ids = asyncio.run(list_schedules(runtime))
        if ids:
            print(f"Schedules ({len(ids)}):")
            for sid in ids:
                print(f"  - {sid}")
        else:
            print("No schedules registered.")

    else:
        print("Usage: alfred temporal schedule {register <file>|list}")


def cmd_list(args: argparse.Namespace, raw: dict[str, Any]) -> None:
    """List discovered workflow definitions."""
    from alfred.temporal.discovery import discover_workflows
    runtime = _load_runtime(raw)

    # Also include bundled examples directory
    from alfred._data import get_bundled_dir
    examples_dir = str(get_bundled_dir() / "examples")
    all_dirs = list(runtime.temporal.workflow_dirs) + [examples_dir]

    workflows = discover_workflows(all_dirs)
    if workflows:
        print(f"Discovered workflows ({len(workflows)}):")
        for wf in workflows:
            defn = getattr(wf, "__temporal_workflow_definition", None)
            name = defn.name if defn else wf.__name__
            print(f"  - {name} ({wf.__module__})")
    else:
        print("No workflows discovered.")
        if not runtime.temporal.workflow_dirs:
            print("Hint: set temporal.workflow_dirs in config.yaml")
