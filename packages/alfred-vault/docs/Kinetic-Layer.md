# Kinetic Layer

The Kinetic Layer is Alfred's Temporal-based execution engine. It orchestrates durable, auditable workflows that use Alfred's pluggable agent backends.

## Overview

The Kinetic Layer runs on [Temporal](https://temporal.io), a durable execution platform. Workflows survive crashes, can sleep for hours or days, and resume with full state. If the worker goes down mid-workflow, it picks up exactly where it left off when it restarts.

**Core principle:** Python handles control flow. The agent handles reasoning. A workflow might loop through 50 emails, but for each one it calls `spawn_agent` with a single atomic prompt. The agent never orchestrates — it only executes.

## Install

```bash
# Install Alfred with Temporal support
pip install "alfred-vault[temporal]"

# You also need a running Temporal server
# See: https://docs.temporal.io/cli#install
temporal server start-dev
```

## Quick Start

```bash
# Start the worker (connects to Temporal, registers workflows + activities)
alfred temporal worker

# In another terminal, trigger a workflow
alfred temporal run HelloWorkflow --params '"Hello!"'

# List discovered workflows
alfred temporal list

# Register scheduled workflows
alfred temporal schedule register my_schedules.py
alfred temporal schedule list
```

## Configuration

Add a `temporal` section to `config.yaml`:

```yaml
temporal:
  address: "127.0.0.1:7233"
  namespace: "default"
  task_queue: "alfred-workflows"
  workflow_dirs: ["./workflows"]
  agents:
    worker:
      timeout: 300
    vault-curator:
      skill: vault-curator
      scope: curator
    inbox-processor:
      backend: openclaw
      skill: vault-curator
      scope: curator
      agent_id: vault-worker
      timeout: 600
```

### Agent Profiles

Each named agent profile can override the global backend, skill, scope, and timeout:

| Field | Default | Description |
|-------|---------|-------------|
| `backend` | (global) | Override agent backend: `claude`, `zo`, `openclaw` |
| `skill` | none | Skill directory name under `_bundled/skills/` — prepended to task prompt |
| `scope` | none | Vault scope: `curator`, `janitor`, `distiller` — restricts operations |
| `timeout` | 300 | Seconds before the agent call times out |
| `agent_id` | (global) | OpenClaw agent ID override |

## Built-in Activities

Activities are the building blocks of workflows. Alfred provides these out of the box:

### `spawn_agent`

Invoke an AI agent backend with a task prompt.

```python
result = await workflow.execute_activity(
    "spawn_agent",
    args=["Process this email and create records", "worker", 300],
    start_to_close_timeout=timedelta(seconds=600),
    result_type=SpawnResult,
)
# result.success: bool
# result.output: str
```

Arguments: `(task: str, agent: str = "worker", timeout: int = 300)`

The `agent` parameter selects an agent profile from config. The profile determines which backend, skill, scope, and timeout to use.

### `run_script`

Run a shell command and return stdout + exit code.

```python
result = await workflow.execute_activity(
    "run_script",
    args=["git -C /path/to/vault log --oneline -5", 60],
    start_to_close_timeout=timedelta(seconds=120),
    result_type=ScriptResult,
)
# result.success: bool
# result.output: str
# result.exit_code: int
```

### `notify_slack`

Send a Slack notification. Currently a no-op logger — logs the message and returns `True`. Wire up to a real Slack webhook when ready.

```python
await workflow.execute_activity(
    "notify_slack",
    args=["Inbox processing complete: 12 records created"],
    start_to_close_timeout=timedelta(seconds=30),
)
```

### `ping_uptime`

Ping a healthcheck/uptime endpoint (e.g., UptimeRobot, Healthchecks.io).

### `check_day_of_week`

Returns current day of week (0=Monday, 6=Sunday). Useful for weekday-only schedules.

### `load_json_state` / `save_json_state`

Read/write JSON state files. Useful for workflows that need to track progress across runs.

## Writing Workflows

Workflows are Python classes decorated with `@workflow.defn`. Place them in a directory listed in `temporal.workflow_dirs` in config.

### Example: Hello Workflow

```python
from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from alfred.temporal.activities import SpawnResult

@workflow.defn
class HelloWorkflow:
    @workflow.run
    async def run(self, message: str = "Hello from Alfred!") -> str:
        result = await workflow.execute_activity(
            "spawn_agent",
            args=[f"Respond with: {message}", "worker", 60],
            start_to_close_timeout=timedelta(seconds=120),
            result_type=SpawnResult,
        )
        return result.output if result.success else f"FAILED: {result.output}"
```

### Example: Daily Inbox Processor

```python
from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from alfred.temporal.activities import SpawnResult, ScriptResult

@workflow.defn
class DailyInboxWorkflow:
    @workflow.run
    async def run(self) -> str:
        # Check if it's a weekday
        day = await workflow.execute_activity(
            "check_day_of_week",
            start_to_close_timeout=timedelta(seconds=10),
        )
        if day >= 5:  # Saturday or Sunday
            return "Skipped: weekend"

        # Run batch processing
        result = await workflow.execute_activity(
            "run_script",
            args=["alfred process --limit 10", 300],
            start_to_close_timeout=timedelta(seconds=600),
            result_type=ScriptResult,
        )

        # Notify
        await workflow.execute_activity(
            "notify_slack",
            args=[f"Daily inbox: {'done' if result.success else 'failed'}"],
            start_to_close_timeout=timedelta(seconds=30),
        )

        return result.output
```

### Temporal Sandbox

Temporal runs workflows in a sandboxed environment. Imports that aren't deterministic must be wrapped:

```python
with workflow.unsafe.imports_passed_through():
    from alfred.temporal.activities import SpawnResult
```

Activities are called by string name, not by direct reference. The `result_type` parameter tells Temporal how to deserialize the return value.

## Schedules

Register cron-based schedules from a Python file:

```python
# my_schedules.py
from temporalio.client import ScheduleSpec

SCHEDULES = [
    {
        "id": "daily-inbox",
        "workflow": "DailyInboxWorkflow",
        "spec": ScheduleSpec(cron_expressions=["0 7 * * 1-5"]),
        "memo": "Process inbox every weekday at 7am",
    },
    {
        "id": "weekly-janitor",
        "workflow": "WeeklyJanitorWorkflow",
        "spec": ScheduleSpec(cron_expressions=["0 3 * * 0"]),
        "memo": "Deep vault sweep every Sunday at 3am",
    },
]
```

```bash
alfred temporal schedule register my_schedules.py
alfred temporal schedule list
```

## Workflow Discovery

The worker discovers workflows from:
1. Directories listed in `temporal.workflow_dirs` in config
2. Bundled examples in `_bundled/examples/`

Any `.py` file (excluding `_`-prefixed files) containing classes with `@workflow.defn` is automatically registered.

```bash
# See what workflows are available
alfred temporal list
```

## CLI Reference

```bash
alfred temporal worker                     # start the workflow worker
alfred temporal run <workflow>             # trigger a one-off execution
alfred temporal run <workflow> --params '{"key": "value"}'  # with params
alfred temporal run <workflow> --id my-id  # with custom workflow ID
alfred temporal schedule register <file>   # register schedules from file
alfred temporal schedule list              # list registered schedules
alfred temporal list                       # list discovered workflows
```
