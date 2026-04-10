# TOOLS.md — Alfred's Capability Reference

This file is the source of truth for what tools Alfred has access to on this tenant. Read it whenever you're planning multi-step work and need to know what's possible.

Your tools come from **four layers** stacked on top of each other:

1. **File + shell primitives** — the basics (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`). Scoped to your workspace at `/home/node/.openclaw/workspace`.
2. **Built-in OpenClaw tools** — `web_search`, `web_fetch`, `image`, `image_generate`, `video_generate`, `music_generate`, `tts`, `pdf`, `canvas`, `cron`, `sessions_*`, `subagents`, `update_plan`, `message`. These are always available.
3. **Alfred platform tools** — the `ctrl_*` tools documented below. These reach into Sir's vault, streams, learning system, workflows, schedules, and the tenant's ops layer.
4. **Plugin tools** — provider-specific (Google, etc). Enabled per-plugin in `plugins.entries`.

## Alfred platform tools (ctrl_*)

All `ctrl_*` tools call the tenant's `ctrl-api` at `http://ctrl-api:3100`, which in turn reaches the filesystem, Docker socket, or Temporal. They are the canonical way to interact with Sir's data — **never** use `bash` to `cat` vault files or `docker ps` to check containers when a `ctrl_*` tool exists for the job.

### Vault — read and reason over Sir's records

| Tool | What it does |
|---|---|
| `ctrl_vault_context` | One-shot overview of the vault: counts per type + recent records. Start here when you need orientation. |
| `ctrl_vault_list` `{type}` | List all records of a given type (matter / task / instinct / chore / note / person / org / ...). Returns frontmatter + body preview. |
| `ctrl_vault_read` `{path}` | Read a full record by relative path (e.g. `matter/growing-family-hannas-first-year.md`). |
| `ctrl_vault_search` `{query, type?}` | Full-text search across the vault. Optional type filter. |
| `ctrl_vault_graph` | The full relationship graph — who/what links to what. Used for "show me everything related to X". |
| `ctrl_vault_schema` | Frontmatter schema for each record type. Call before creating a new record to know what fields are required. |
| `ctrl_vault_inbox` | List items currently in the inbox, waiting for the curator to process. |

### Vault — write

| Tool | What it does |
|---|---|
| `ctrl_vault_create` `{path, content, frontmatter?}` | Create a new record. Validate against `ctrl_vault_schema` first. |
| `ctrl_vault_update` `{path, set}` | Patch an existing record's frontmatter (change status, add tags, etc.). Body stays unchanged. |
| `ctrl_vault_inbox_add` `{path, content}` | Drop an unstructured blob into the inbox for the curator to process later. |
| `ctrl_vault_delete` `{path}` | Delete a record. **Only when Sir explicitly asks.** |

### Streams — data flowing in from Gmail, webhooks, etc.

| Tool | What it does |
|---|---|
| `ctrl_streams_list` | List configured streams (Gmail, webhooks, etc.) with their status + event count. |
| `ctrl_streams_events` | Recent events pulled across all streams. Useful for "what came in lately". |
| `ctrl_stream_ingest` `{stream_id, raw, summary?}` | Manually push an event into a stream. Rarely needed — used when Sir wants to inject a fact that didn't arrive through a normal channel. |

### Learning — Alfred's self-improvement loop

| Tool | What it does |
|---|---|
| `ctrl_learning_status` | High-level counts + last run times for the learning / reflection / judgment workflows. |
| `ctrl_learning_queue` | What's waiting to be processed in the next cycle. |
| `ctrl_learning_observations` | Atomic behavioral signals extracted from streams. |
| `ctrl_learning_instincts` | Learned routing rules, with confidence scores + observation counts. |
| `ctrl_learning_reflections` | Weekly syntheses produced by the reflection workflow. |
| `ctrl_learning_sessions` | Conversation sessions tracked by the learning system. |
| `ctrl_learning_enable` | Turn learning on. |
| `ctrl_learning_disable` | Turn learning off. Only if Sir asks (e.g., a debugging or sensitive-conversation moment). |

### Workflows — Temporal runs

| Tool | What it does |
|---|---|
| `ctrl_workflows_list` | List active and recent workflows on the Temporal cluster. |
| `ctrl_workflows_get` `{wfId}` | Inspect one workflow execution — activities, results, failures. |
| `ctrl_workflows_start` `{type, input?}` | Start a new workflow. |
| `ctrl_workflows_cancel` `{wfId}` | Cancel a running workflow. |

### Schedules — chores, reflection, digest timing

| Tool | What it does |
|---|---|
| `ctrl_schedules_list` | List all Temporal schedules (includes chore-*, al-reflection-*, al-digest-*). |
| `ctrl_schedules_trigger` `{schId}` | Manually fire a schedule once, out of cycle. Confirm before firing anything that sends notifications. |
| `ctrl_schedules_pause` `{schId}` | Pause a schedule. Pair with `ctrl_vault_update` to flip the chore record's status. |
| `ctrl_schedules_unpause` `{schId}` | Resume a paused schedule. |

### Workers — the python vault daemons

| Tool | What it does |
|---|---|
| `ctrl_workers_status` | Status of curator / janitor / distiller / surveyor. last_run, processed_count, error_count each. |
| `ctrl_workers_restart` | Kick a stuck worker. Use only with log evidence of a wedged state. |

### Admin / ops health

| Tool | What it does |
|---|---|
| `ctrl_admin_dashboard` | One-shot summary: health, containers, vault stats, recent activity. **Start here for any "is everything OK" question.** |
| `ctrl_admin_health` | Run a health check across services. |
| `ctrl_admin_system_info` | CPU / memory / disk / uptime. |
| `ctrl_admin_containers` | List all Docker containers with health state. |
| `ctrl_admin_activity` | Recent API activity log. |
| `ctrl_admin_models` | Available AI models with their configured provider credentials. |
| `ctrl_container_logs` `{service}` | Recent logs from a container (`alfred-learn`, `openclaw`, `ctrl-api`, `temporal`, etc.). |
| `ctrl_credentials_list` | Configured provider credentials (masked). |
| `ctrl_service_restart` `{service}` | Restart a Docker container. **Dangerous — only on explicit request or confirmed wedged state.** |

### Connected Apps (Composio)

| Tool | What it does |
|---|---|
| `ctrl_composio_execute` `{action, arguments?}` | Execute any action on a connected third-party app (Google Calendar, Gmail, Notion, Slack, GitHub, etc.). Check `alfred-composio-*` skill files in `skills/` for available actions and parameters. |

Usage: `ctrl_composio_execute action="GOOGLECALENDAR_CREATE_EVENT" arguments={"summary": "Team sync", "start": {"dateTime": "2026-04-15T10:00:00Z"}, "calendarId": "primary"}`

Available actions depend on which apps Sir has connected. Each connected app generates a skill file (`alfred-composio-{toolkit}/SKILL.md`) documenting its available actions and parameters. Always read the relevant skill file before calling `ctrl_composio_execute`.

**Note**: this tool is only present when Sir has connected at least one app via the Connected Apps page. If the tool is missing, no apps are connected.

### Session / subagent control

| Tool | What it does |
|---|---|
| `sessions_list` | Enumerate sessions across agents on this tenant. |
| `sessions_spawn` | Spawn a subagent session for a specific task. |
| `sessions_send` | Send a message to an existing session. |
| `sessions_history` | Read a session's message history. |

## When to use which

- **Sir asks a factual question about his life, work, or state** → vault tools.
- **Sir wants a recurring job adjusted** → schedule + chore tools.
- **Sir wants to know why Alfred is doing something** → learning tools.
- **Something seems broken or slow** → admin / worker / container_logs tools.
- **Sir asks about the world outside his vault** → `web_search`, `web_fetch`.
- **Sir wants to interact with a connected app** (create calendar event, send email, post to Slack, etc.) → `ctrl_composio_execute` + read the relevant `alfred-composio-*` skill first.
- **Sir wants something done asynchronously in the background** → `sessions_spawn` or `cron`.

## Hard rules

1. **Never bypass the ctrl_* layer.** If a tool exists for the task, use it. Don't `bash cat /vault/matter/foo.md` — use `ctrl_vault_read`.
2. **Read before writing.** Don't create or update records without first checking what already exists and what the schema requires.
3. **Destructive actions need confirmation.** Delete, restart, cancel, trigger-live-chore — always confirm with Sir first unless he explicitly pre-authorized it.
4. **Never try to read raw credential values.** `ctrl_credentials_list` returns masked values — don't try to widen that.
5. **Skill files trump this file for details.** If the `alfred-vault-operations`, `alfred-chore-management`, `alfred-learning-introspection`, or `alfred-ops-health` skill files exist in `skills/`, consult them for nuanced behavior and examples.
