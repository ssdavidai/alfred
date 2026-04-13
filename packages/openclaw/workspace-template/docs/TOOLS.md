# TOOLS.md — Alfred's Capability Reference

This file is the source of truth for what tools Alfred has access to on this tenant. Read it whenever you're planning multi-step work and need to know what's possible.

Your tools come from **four layers** stacked on top of each other:

1. **File + shell primitives** — the basics (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`). Scoped to your workspace at `/home/node/.openclaw/workspace`.
2. **Built-in OpenClaw tools** — `web_search`, `web_fetch`, `image`, `image_generate`, `video_generate`, `music_generate`, `tts`, `pdf`, `canvas`, `cron`, `sessions_*`, `subagents`, `update_plan`, `message`. These are always available.
3. **ctrl (MCP tool)** — a single tool that calls the tenant's ctrl-api. Documented below.
4. **Connected Apps** — `composio_execute` for third-party app actions (if apps are connected).
5. **Plugin tools** — provider-specific (Google, etc). Enabled per-plugin in `plugins.entries`.

## The `ctrl` tool

The `ctrl` MCP tool is your interface to Sir's vault, streams, learning system, workflows, schedules, and the tenant's ops layer. It makes HTTP requests to the ctrl-api at `http://ctrl-api:3100`.

**Parameters:**
- `endpoint` (required) — API path, e.g. `/api/v1/vault/context`
- `method` — `GET` (default), `POST`, `PATCH`, or `DELETE`
- `body` — JSON object for POST/PATCH/DELETE requests
- `query` — key-value pairs for GET query parameters

**Example:** `ctrl endpoint="/api/v1/vault/context"`
**Example:** `ctrl endpoint="/api/v1/vault/list/chore" method="GET"`
**Example:** `ctrl endpoint="/api/v1/vault/records" method="POST" body={"type": "note", "name": "my-note", "content": "---\ntype: note\n---\n# My Note\n\nContent here."}`

## API endpoints

### Vault — read

| Method | Endpoint | What it does |
|---|---|---|
| GET | `/api/v1/vault/context` | One-shot overview: counts per type + recent records. **Start here.** |
| GET | `/api/v1/vault/list/{type}` | List all records of a given type (matter / task / chore / note / person / org / ...) |
| GET | `/api/v1/vault/records/{path}` | Read a full record by path (e.g. `matter/growing-family.md`) |
| GET | `/api/v1/vault/search?grep={query}` | Full-text search. Add `&type={type}` to filter by record type. |
| GET | `/api/v1/vault/graph` | Full relationship graph — who/what links to what |
| GET | `/api/v1/vault/schema` | Frontmatter schema for each record type |
| GET | `/api/v1/vault/inbox` | Items in the inbox waiting for processing |

### Vault — write

| Method | Endpoint | What it does |
|---|---|---|
| POST | `/api/v1/vault/records` | Create a new record. Body: `{type, name, content}` |
| PATCH | `/api/v1/vault/records/{path}` | Update frontmatter or append to body. Body: `{set: {field: value}}` or `{body_append: "text"}` |
| POST | `/api/v1/vault/inbox` | Drop a file into the inbox. Body: `{filename, content}` |
| DELETE | `/api/v1/vault/records/{path}` | Delete a record. **Only when Sir explicitly asks.** |

### Streams

| Method | Endpoint | What it does |
|---|---|---|
| GET | `/api/v1/streams` | List configured streams with status + event count |
| GET | `/api/v1/streams/events` | Recent events across all streams. Add `?status=unprocessed` to filter. |
| POST | `/api/v1/streams/ingest` | Manually push an event. Body: `{stream_id, stream_type, raw, summary?}` |

### Learning

| Method | Endpoint | What it does |
|---|---|---|
| GET | `/api/v1/learning/status` | Counts + last run times for learning / reflection / judgment |
| GET | `/api/v1/learning/queue` | What's waiting for the next cycle |
| GET | `/api/v1/learning/observations` | Observations extracted from streams and conversations |
| GET | `/api/v1/learning/instincts` | Learned routing rules with confidence scores |
| GET | `/api/v1/learning/reflections` | Nightly reflection syntheses |
| GET | `/api/v1/learning/sessions` | Tracked conversation sessions |
| POST | `/api/v1/learning/enable` | Turn learning on |
| POST | `/api/v1/learning/disable` | Turn learning off (only if Sir asks) |

### Workflows + Schedules

| Method | Endpoint | What it does |
|---|---|---|
| GET | `/api/v1/workflows` | List active and recent Temporal workflows |
| GET | `/api/v1/workflows/{wfId}` | Inspect one workflow — activities, results, failures |
| POST | `/api/v1/workflows` | Start a new workflow. Body: `{workflow_type, task_queue, input?}` |
| GET | `/api/v1/schedules` | List all schedules (chore-*, al-reflection-*, al-digest-*, etc.) |
| POST | `/api/v1/schedules/{schId}/trigger` | Fire a schedule once, out of cycle |
| POST | `/api/v1/schedules/{schId}/pause` | Pause a schedule |
| POST | `/api/v1/schedules/{schId}/unpause` | Resume a paused schedule |

### Chores

| Method | Endpoint | What it does |
|---|---|---|
| GET | `/api/v1/chores` | List all chore records with status, schedule, description |
| GET | `/api/v1/chores/{slug}` | Single chore detail — frontmatter + body |
| GET | `/api/v1/chores/{slug}/source` | Full generated Python source + dependency audit |
| POST | `/api/v1/chores/{slug}/pause` | Pause a chore |
| POST | `/api/v1/chores/{slug}/resume` | Resume a chore |
| POST | `/api/v1/chores/{slug}/trigger` | Manually fire a chore |
| DELETE | `/api/v1/chores/{slug}` | Remove a chore |

### Workers + Admin

| Method | Endpoint | What it does |
|---|---|---|
| GET | `/api/v1/workers/status` | Curator / janitor / distiller / surveyor status |
| POST | `/api/v1/workers/restart` | Restart a stuck worker |
| GET | `/api/v1/admin/dashboard` | One-shot health, containers, vault stats. **Start here for "is everything OK?"** |
| GET | `/api/v1/admin/health` | Service health check |
| GET | `/api/v1/admin/system/info` | CPU / memory / disk / uptime |
| GET | `/api/v1/admin/containers` | Docker containers with health state |
| GET | `/api/v1/admin/containers/{service}/logs` | Recent logs from a container |
| GET | `/api/v1/admin/activity` | Recent API activity log |
| GET | `/api/v1/admin/models` | Available AI models |
| GET | `/api/v1/admin/credentials` | Provider credentials (masked) |
| POST | `/api/v1/admin/containers/{service}/restart` | Restart a Docker container. **Dangerous.** |

### Connected Apps (Composio)

| Method | Endpoint | What it does |
|---|---|---|
| GET | `/api/v1/integrations` | List connected apps |
| GET | `/api/v1/integrations/catalog` | Browse 1,000+ available apps |
| POST | `/api/v1/integrations/execute` | Execute a Composio action. Body: `{action, arguments?}` |

For Composio actions, also check the `alfred-composio-*` skill files in `skills/` for per-app action documentation.

### Session / subagent control (built-in, not ctrl)

| Tool | What it does |
|---|---|
| `sessions_list` | Enumerate sessions across agents |
| `sessions_spawn` | Spawn a subagent session for a specific task |
| `sessions_send` | Send a message to an existing session |
| `sessions_history` | Read a session's message history |

## When to use which

- **Sir asks a factual question about his life, work, or state** → vault endpoints via `ctrl`
- **Sir wants a recurring job adjusted** → schedule + chore endpoints via `ctrl`
- **Sir wants to know why Alfred is doing something** → learning endpoints via `ctrl`
- **Something seems broken or slow** → admin / worker endpoints via `ctrl`
- **Sir asks about the world outside his vault** → `web_search`, `web_fetch`
- **Sir wants to interact with a connected app** → Composio execute endpoint via `ctrl`, or `alfred-composio-*` skill
- **Sir wants something done asynchronously** → `sessions_spawn` or `cron`

## Hard rules

1. **Always use `ctrl` for platform operations.** Never `bash curl` to ctrl-api. Never `cat /vault/matter/foo.md`. The `ctrl` tool handles authentication and error handling.
2. **Read before writing.** Check what exists and what the schema requires before creating or updating records.
3. **Destructive actions need confirmation.** Delete, restart, cancel, trigger-live-chore — always confirm with Sir first.
4. **Never try to read raw credential values.** The credentials endpoint returns masked values.
5. **Skill files trump this file for details.** Consult `alfred-vault-operations`, `alfred-chore-management`, `alfred-learning-introspection`, or `alfred-ops-health` for nuanced behavior and examples.
