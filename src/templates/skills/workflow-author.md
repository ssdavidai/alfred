# Workflow Authoring Reference

You are helping the user write custom Temporal workflows for Alfred. This document is your complete reference for the workflow system — activities, discovery, configuration, scheduling, and CLI.

## What Workflows Are

Alfred uses [Temporal](https://temporal.io) as its workflow engine. A workflow is a Python class that orchestrates a sequence of **activities** — durable, retryable units of work. Temporal guarantees that workflow logic runs to completion even if the worker process restarts.

Alfred provides 7 built-in activities (agent invocation, scripting, notifications, state management) and a discovery system that automatically finds workflow files, registers them with the worker, and makes them available for manual or scheduled execution.

## Workflow Class Structure

Every workflow is a Python class with two decorators:

```python
from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from alfred.temporal.activities import SpawnResult, ScriptResult

@workflow.defn
class MyWorkflow:
    @workflow.run
    async def run(self, arg1: str = "default") -> str:
        # Orchestrate activities here
        result = await workflow.execute_activity(
            "spawn_agent",
            args=["Do something useful", "worker", 120],
            start_to_close_timeout=timedelta(seconds=300),
            result_type=SpawnResult,
        )
        return result.output
```

### Rules

- **`@workflow.defn`** on the class — registers it as a Temporal workflow.
- **`@workflow.run`** on exactly one async method — this is the entry point.
- The run method can accept arguments (passed as JSON from the CLI or schedule).
- **Determinism**: Workflow code must be deterministic. No `datetime.now()`, no `random`, no direct I/O. Use activities for all side effects.
- **Imports**: Non-deterministic imports (like `alfred.temporal.activities`) must be wrapped in `with workflow.unsafe.imports_passed_through():` at module level.

## Activities

Call activities by string name via `workflow.execute_activity()`. Always set `start_to_close_timeout` and `result_type`.

### spawn_agent

Invoke an AI agent with a task prompt. This is the primary way workflows interact with LLMs.

```python
result = await workflow.execute_activity(
    "spawn_agent",
    args=[task, agent, timeout],
    start_to_close_timeout=timedelta(seconds=600),
    result_type=SpawnResult,
)
# result.success: bool
# result.output: str
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | `str` | *(required)* | The prompt/instruction for the agent |
| `agent` | `str` | `"worker"` | Agent profile name from config (see Agent Profiles below) |
| `timeout` | `int` | `300` | Max seconds for the agent to complete |

Returns `SpawnResult(success: bool, output: str)`.

The agent profile determines which backend (claude, zo, openclaw), which skill prompt to prepend, which vault scope to enforce, and which timeout to use. If the profile has a `skill` set, the corresponding `SKILL.md` content is prepended to the task automatically.

### run_script

Run a shell command. Executes in the vault directory.

```python
result = await workflow.execute_activity(
    "run_script",
    args=[command, timeout],
    start_to_close_timeout=timedelta(seconds=300),
    result_type=ScriptResult,
)
# result.success: bool  (true if exit code == 0)
# result.output: str    (stdout + stderr combined)
# result.exit_code: int
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `command` | `str` | *(required)* | Shell command to execute |
| `timeout` | `int` | `120` | Max seconds |

Returns `ScriptResult(success: bool, output: str, exit_code: int)`.

### notify_slack

Send a notification message. Currently logs the message (Slack integration is a no-op placeholder).

```python
ok = await workflow.execute_activity(
    "notify_slack",
    args=[message, channel],
    start_to_close_timeout=timedelta(seconds=30),
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `message` | `str` | *(required)* | Message text |
| `channel` | `str` | `""` | Target channel (unused currently) |

Returns `bool` (always `True`).

### ping_uptime

Ping a healthcheck/uptime endpoint via HTTP GET.

```python
ok = await workflow.execute_activity(
    "ping_uptime",
    args=[key],
    start_to_close_timeout=timedelta(seconds=30),
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `key` | `str` | *(required)* | Full URL to ping (e.g. `https://hc-ping.com/abc-123`) |

Returns `bool` (`True` if HTTP status < 400).

### check_day_of_week

Get the current UTC day of week. Useful for skipping weekends or running logic on specific days.

```python
day = await workflow.execute_activity(
    "check_day_of_week",
    start_to_close_timeout=timedelta(seconds=10),
)
# 0=Monday, 1=Tuesday, 2=Wednesday, 3=Thursday, 4=Friday, 5=Saturday, 6=Sunday
```

No parameters. Returns `int`.

### load_json_state

Load a JSON file as a dict. Returns `{}` if the file doesn't exist or can't be parsed.

```python
state = await workflow.execute_activity(
    "load_json_state",
    args=[path],
    start_to_close_timeout=timedelta(seconds=10),
    result_type=dict,
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | `str` | *(required)* | Absolute path to the JSON file |

Returns `dict`.

### save_json_state

Save a dict to a JSON file. Creates parent directories if needed.

```python
ok = await workflow.execute_activity(
    "save_json_state",
    args=[path, data],
    start_to_close_timeout=timedelta(seconds=10),
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | `str` | *(required)* | Absolute path to write |
| `data` | `dict` | *(required)* | Dict to serialize as JSON |

Returns `bool` (`True` on success).

## Workflow Discovery

The worker automatically discovers workflows from directories listed in `temporal.workflow_dirs` in `config.yaml`, plus the bundled examples directory.

### Rules

1. Scans each directory for `*.py` files (non-recursive).
2. **Skips** files whose name starts with `_` (e.g. `_helpers.py`, `__init__.py`).
3. Imports each file and looks for classes with the `@workflow.defn` decorator.
4. Deduplicates by workflow definition name.

### Where to put workflow files

Create a `workflows/` directory alongside your vault and add it to config:

```yaml
temporal:
  workflow_dirs: ["./workflows"]
```

Then place your `.py` files there:

```
workflows/
  daily_inbox.py
  weekly_report.py
  _helpers.py        # ← skipped (underscore prefix)
```

## Agent Profiles

Agent profiles let you configure different AI backends, skills, vault scopes, and timeouts for different agent names used in `spawn_agent`.

### Config format

```yaml
temporal:
  agents:
    worker:                  # default profile — used when no profile matches
      timeout: 300
    vault-curator:
      skill: vault-curator   # prepend SKILL.md from skills/vault-curator/
      scope: curator         # restrict vault operations to curator scope
    inbox-processor:
      backend: openclaw      # override backend (claude, zo, openclaw)
      skill: vault-curator
      scope: curator
      agent_id: vault-worker # OpenClaw agent ID to use
      timeout: 600
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backend` | `str \| null` | `null` (uses global `agent.backend`) | Backend override: `"claude"`, `"zo"`, or `"openclaw"` |
| `skill` | `str \| null` | `null` | Skill directory name — its `SKILL.md` is prepended to the task prompt |
| `scope` | `str \| null` | `null` | Vault scope: `"curator"`, `"janitor"`, or `"distiller"` |
| `timeout` | `int` | `300` | Default timeout in seconds |
| `agent_id` | `str \| null` | `null` | OpenClaw agent ID override |

When `spawn_agent` is called with an agent name, the matching profile is looked up. If no match is found, the default `AgentProfile()` (no skill, no scope, 300s timeout) is used.

## Config.yaml — Temporal Section

```yaml
temporal:
  address: "127.0.0.1:7233"         # Temporal server address
  namespace: "default"               # Temporal namespace
  task_queue: "alfred-workflows"     # Task queue name
  workflow_dirs: ["./workflows"]     # Directories to scan for workflow files
  agents:                            # Agent profiles (see above)
    worker:
      timeout: 300
```

## Schedules

Schedules define cron-based execution of workflows. They are defined in a Python file and registered with the Temporal server.

### Schedule file format

Create a Python file (e.g. `schedules.py`) with a `SCHEDULES` list:

```python
from temporalio.client import ScheduleSpec

SCHEDULES = [
    {
        "id": "daily-inbox",
        "workflow": "DailyInboxWorkflow",
        "spec": ScheduleSpec(cron_expressions=["0 7 * * 1-5"]),
        "memo": "Process inbox every weekday at 7am",
        "args": [],       # optional: workflow arguments
        "state": None,    # optional: ScheduleState
    },
    {
        "id": "weekly-report",
        "workflow": "WeeklyReportWorkflow",
        "spec": ScheduleSpec(cron_expressions=["0 9 * * 1"]),
        "memo": "Generate weekly report on Monday mornings",
    },
]
```

### Schedule fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `str` | yes | Unique schedule identifier |
| `workflow` | `str` | yes | Workflow class name (as registered by `@workflow.defn`) |
| `spec` | `ScheduleSpec` | yes | Cron expression(s) defining when to run |
| `memo` | `str` | no | Human-readable description |
| `args` | `list` | no | Arguments passed to the workflow's `run()` method |
| `state` | `ScheduleState` | no | Initial schedule state |

Cron expressions follow standard 5-field format: `minute hour day-of-month month day-of-week`.

## CLI Commands

```bash
# Start the workflow worker (foreground, connects to Temporal and polls for work)
alfred temporal worker

# Trigger a workflow manually
alfred temporal run MyWorkflow
alfred temporal run MyWorkflow --params '["arg1", "arg2"]'
alfred temporal run MyWorkflow --params '"single_string_arg"'
alfred temporal run MyWorkflow --id my-custom-run-id

# List discovered workflows
alfred temporal list

# Register schedules from a file (replaces all existing schedules)
alfred temporal schedule register schedules.py

# List registered schedules
alfred temporal schedule list
```

## Worked Examples

### Example 1: Simple Greeting Workflow

A minimal workflow that spawns an agent with a message.

```python
from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from alfred.temporal.activities import SpawnResult

@workflow.defn
class GreetingWorkflow:
    @workflow.run
    async def run(self, name: str = "world") -> str:
        result = await workflow.execute_activity(
            "spawn_agent",
            args=[f"Write a short, friendly greeting for {name}.", "worker", 60],
            start_to_close_timeout=timedelta(seconds=120),
            result_type=SpawnResult,
        )
        return result.output if result.success else f"Failed: {result.output}"
```

Run it: `alfred temporal run GreetingWorkflow --params '"Alice"'`

### Example 2: Vault + Agent Hybrid

A workflow that uses `run_script` for fast vault operations and `spawn_agent` for AI-powered analysis.

```python
from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from alfred.temporal.activities import SpawnResult, ScriptResult

@workflow.defn
class VaultReviewWorkflow:
    @workflow.run
    async def run(self) -> str:
        # Use run_script for fast vault queries
        listing = await workflow.execute_activity(
            "run_script",
            args=["alfred vault list --type task --status active", 30],
            start_to_close_timeout=timedelta(seconds=60),
            result_type=ScriptResult,
        )
        if not listing.success:
            return f"Failed to list tasks: {listing.output}"

        # Feed the listing to an agent for analysis
        result = await workflow.execute_activity(
            "spawn_agent",
            args=[
                f"Review these active tasks and summarize which are overdue or stalled:\n\n{listing.output}",
                "worker",
                180,
            ],
            start_to_close_timeout=timedelta(seconds=300),
            result_type=SpawnResult,
        )
        return result.output if result.success else f"Analysis failed: {result.output}"
```

### Example 3: Scheduled Batch with State Tracking

A workflow that tracks its last run time using JSON state and pings a healthcheck on completion.

```python
from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from alfred.temporal.activities import SpawnResult, ScriptResult

STATE_PATH = "/opt/alfred/data/batch_state.json"

@workflow.defn
class DailyBatchWorkflow:
    @workflow.run
    async def run(self) -> str:
        # Skip weekends
        day = await workflow.execute_activity(
            "check_day_of_week",
            start_to_close_timeout=timedelta(seconds=10),
        )
        if day >= 5:
            return "Skipped: weekend"

        # Load last run state
        state = await workflow.execute_activity(
            "load_json_state",
            args=[STATE_PATH],
            start_to_close_timeout=timedelta(seconds=10),
            result_type=dict,
        )
        run_count = state.get("run_count", 0) + 1

        # Process inbox via agent with curator skill + scope
        result = await workflow.execute_activity(
            "spawn_agent",
            args=[
                "Process all new items in the inbox.",
                "vault-curator",   # uses the vault-curator agent profile
                600,
            ],
            start_to_close_timeout=timedelta(seconds=900),
            result_type=SpawnResult,
        )

        # Save updated state
        await workflow.execute_activity(
            "save_json_state",
            args=[STATE_PATH, {"run_count": run_count, "last_result": result.success}],
            start_to_close_timeout=timedelta(seconds=10),
        )

        # Notify
        await workflow.execute_activity(
            "notify_slack",
            args=[f"Daily batch #{run_count}: {'done' if result.success else 'failed'}"],
            start_to_close_timeout=timedelta(seconds=30),
        )

        # Ping healthcheck
        await workflow.execute_activity(
            "ping_uptime",
            args=["https://hc-ping.com/your-check-uuid"],
            start_to_close_timeout=timedelta(seconds=30),
        )

        return f"Batch #{run_count}: {'success' if result.success else 'failed'}"
```

Schedule file for this workflow:

```python
from temporalio.client import ScheduleSpec

SCHEDULES = [
    {
        "id": "daily-batch",
        "workflow": "DailyBatchWorkflow",
        "spec": ScheduleSpec(cron_expressions=["0 7 * * *"]),
        "memo": "Process inbox every morning at 7am UTC",
    },
]
```

Register it: `alfred temporal schedule register schedules.py`
