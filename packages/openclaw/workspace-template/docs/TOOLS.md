# TOOLS.md — Alfred's Capability Reference

Source of truth for what tools Alfred has access to on this tenant. Read it when planning multi-step work so you pick the right tool first time instead of shelling out to bash + curl.

Tools come in five layers:

1. **Shell primitives** — `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`. Scoped to the workspace at `/home/node/.openclaw/workspace`. Use when operating on workspace files, never for ctrl-api access.
2. **Built-in OpenClaw tools** — `web_search`, `web_fetch`, `image`, `image_generate`, `video_generate`, `music_generate`, `tts`, `pdf`, `canvas`, `cron`, `sessions_*`, `subagents`, `update_plan`, `message`. Always available.
3. **`self` MCP tool** — generic proxy to THIS tenant's ctrl-api. Your default for all local vault / streams / learning / workflows / schedules / workers / admin operations.
4. **Alfred Prime only** — `tenant` and `ask_alfred` tools for cross-tenant operations. If these aren't in your tool list, you're not Prime and cross-tenant work is not available to you. See `alfred-prime-federation/SKILL.md` for details.
5. **Connected Apps** — `ctrl_composio_execute` gateway tool for third-party app actions (Gmail, GitHub, Notion, Calendar, Slack, Zoom, Drive). See the `alfred-composio-*` skills per app.

## The `self` tool

`self` is your interface to this tenant's vault, streams, learning system, workflows, schedules, and ops layer. It makes HTTP requests to the local ctrl-api at `http://ctrl-api:3100`.

**Parameters:**
- `endpoint` (required) — API path, e.g. `/api/v1/vault/context`
- `method` — `GET` (default), `POST`, `PATCH`, or `DELETE`
- `body` — JSON object for POST/PATCH/DELETE
- `query` — key-value pairs for GET query parameters

**Examples:**
```
self({ endpoint: "/api/v1/vault/context" })
self({ endpoint: "/api/v1/vault/list/chore" })
self({ endpoint: "/api/v1/vault/records", method: "POST", body: { type: "note", name: "my-note", content: "---\ntype: note\nname: my-note\n---\n# My Note\n\nContent here." } })
self({ endpoint: "/api/v1/streams/events", query: { status: "unprocessed" } })
```

## API endpoints (use with `self` — or with `tenant` if you're Prime)

### Vault — read

| Endpoint | What it does |
|---|---|
| `GET /api/v1/vault/context` | One-shot overview: counts per type + recent records. **Start here for "what's in the vault".** |
| `GET /api/v1/vault/list/{type}` | List all records of a type (matter, task, chore, note, person, org, event, constraint, decision, assumption, synthesis, contradiction, reflection, observation, instinct, project, conversation, idea, location, account, asset). |
| `GET /api/v1/vault/records/{path}` | Read a full record by vault-relative path (e.g. `matter/growing-family.md`). |
| `GET /api/v1/vault/search?q={query}` | Full-text search. Add `&type={type}` to filter. |
| `GET /api/v1/vault/graph` | Full relationship graph — who/what links to what. |
| `GET /api/v1/vault/schema` | Frontmatter schema for each record type. |
| `GET /api/v1/vault/inbox` | Items in the inbox waiting for curator processing. |

### Vault — write

| Endpoint | What it does |
|---|---|
| `POST /api/v1/vault/records` | Create a record. Body: `{type, name, content}` |
| `PATCH /api/v1/vault/records/{path}` | Update frontmatter or append to body. Body: `{set: {field: value}}` or `{body_append: "text"}` |
| `POST /api/v1/vault/inbox` | Drop a file into the curator inbox. Body: `{filename, content}` |
| `DELETE /api/v1/vault/records/{path}` | Delete a record. **Only when Sir explicitly asks.** |

### Streams

| Endpoint | What it does |
|---|---|
| `GET /api/v1/streams` | List configured streams with status + event counts. |
| `GET /api/v1/streams/events` | Recent events across all streams. `?status=unprocessed` to filter. |
| `POST /api/v1/streams/ingest` | Manually push an event. Body: `{stream_id, stream_type, raw, summary?}` |

### Learning & intelligence

| Endpoint | What it does |
|---|---|
| `GET /api/v1/learning/status` | Counts + last run times for learning / reflection / judgment. |
| `GET /api/v1/learning/queue` | What's waiting for the next cycle. |
| `GET /api/v1/learning/observations` | Observations extracted from streams and conversations. |
| `GET /api/v1/learning/instincts` | Learned routing rules with confidence scores. |
| `GET /api/v1/learning/reflections` | Nightly reflection syntheses. |
| `GET /api/v1/learning/sessions` | Tracked conversation sessions. |

### Workflows & schedules

| Endpoint | What it does |
|---|---|
| `GET /api/v1/workflows` | List active and recent Temporal workflows. |
| `GET /api/v1/workflows/{id}` | Inspect a single workflow (activities, results, failures). |
| `POST /api/v1/workflows` | Start a workflow. Body: `{workflow_type, task_queue, input?}` |
| `GET /api/v1/schedules` | List all schedules (`al-*`, `chore-*`). |
| `POST /api/v1/schedules/{id}/trigger` | Fire a schedule once, out of cycle. |
| `POST /api/v1/schedules/{id}/pause` / `/unpause` | Pause / resume. |

### Chores

| Endpoint | What it does |
|---|---|
| `GET /api/v1/chores` | List all chore records. |
| `GET /api/v1/chores/{slug}` | Single chore detail. |
| `GET /api/v1/chores/{slug}/source` | Full generated Python source + dependency audit. |
| `POST /api/v1/chores/{slug}/pause` / `/resume` / `/trigger` | State control. |
| `DELETE /api/v1/chores/{slug}` | Remove a chore. |

### Workers & admin

| Endpoint | What it does |
|---|---|
| `GET /api/v1/workers/status` | Curator / janitor / distiller / surveyor status. |
| `POST /api/v1/workers/restart` | Restart a stuck worker. |
| `GET /api/v1/admin/dashboard` | One-shot health + containers + vault stats. **Start here for "is everything OK?"** |
| `GET /api/v1/admin/health` | Service health check. |
| `GET /api/v1/admin/system/info` | CPU / memory / disk / uptime. |
| `GET /api/v1/admin/containers` | Docker containers with health state. |
| `GET /api/v1/admin/containers/{service}/logs` | Recent logs from a container. |
| `GET /api/v1/admin/activity` | Recent API activity log. |
| `GET /api/v1/admin/models` | Available AI models. |
| `GET /api/v1/admin/credentials` | Provider credentials (masked). |

### Connected Apps (Composio)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/integrations` | List connected apps. |
| `GET /api/v1/integrations/catalog` | Browse the 1,000+ available apps. |
| `POST /api/v1/integrations/execute` | Execute a Composio action (most code paths use the `ctrl_composio_execute` gateway tool instead). |

For per-app action detail, consult the `alfred-composio-*` skills (gmail, googlecalendar, github, slack, notion, zoom, googledrive).

### Email channel (AgentMail — Alfred's own inbox)

Sir's inbox at `alfred.<username>@mail.alfred.black` is an ongoing conversation channel. Inbound from authorized senders spawns a one-shot session with the message pre-loaded; you respond via the endpoints below. For the full playbook on when to reply vs reply-all vs forward vs no-response, see `alfred-email-channel/SKILL.md`.

| Endpoint | What it does |
|---|---|
| `GET /api/v1/email/status` | Check whether AgentMail is configured on this tenant. Returns `{ configured, inbox_id, inbox_address }`. |
| `POST /api/v1/email/send` | Send a new email (new thread). Body: `{ to, subject, text, html?, cc?, bcc?, reply_to?, labels? }`. |
| `POST /api/v1/email/reply` | Reply in an existing thread. Body: `{ message_id, text, html?, reply_all?: boolean }`. Set `reply_all: true` only when the user's instruction implies it (cc chain should stay informed). |
| `POST /api/v1/email/forward` | Forward a message. Body: `{ message_id, to, subject?, text?, html? }`. |
| `GET /api/v1/email/message/:message_id` | Fetch a single message (use this if webhook payload was truncated at 1 MB). |
| `GET /api/v1/email/thread/:thread_id` | Fetch the full thread — always read this before composing a reply so you have complete context, including quoted history. |
| `GET /api/v1/email/attachment/:message_id/:attachment_id` | Download an attachment's content. |

Also: `GET/POST/DELETE /api/v1/auth/senders` — manage the authorized-senders allowlist that drives the channel/stream dispatch. Only addresses on this list get the conversational channel path; everyone else is ingested as stream events.

### Phone channel (AgentPhone — Twilio voice + SMS)

Sir can call or text his Alfred on the tenant's Twilio number. Inbound SMS from an authorized number is answered by a short LLM turn; calls from an authorized number are routed to the Voice Bridge with full cross-channel context. Unauthorized senders are ingested as stream events with no reply.

| Endpoint | What it does |
|---|---|
| `GET /api/v1/phone/status` | Returns `{ configured, phone_number, country }` for this tenant. |
| `POST /api/v1/phone/sms` | Send an outbound SMS. Body: `{ to, body }`. |
| `GET /api/v1/phone/sms/threads` | List recent SMS threads (who texted, last N turns). |
| `GET /api/v1/phone/sms/thread/:from` | Full SMS history with one counterparty. |
| `GET /api/v1/phone/call/history` | Recent inbound + outbound call records. |

Authorized-numbers CRUD (lives on disk at `.authorized-phone-numbers.json`, same dispatch semantics as `/api/v1/auth/senders` for email):

| Endpoint | What it does |
|---|---|
| `GET /api/v1/phone/authorized-numbers` | List currently authorized phone numbers. |
| `POST /api/v1/phone/authorized-numbers` | Add one. Body: `{ number: "+36706209518", source?: "manual"\|"chat"\|... }`. Numbers are normalized to E.164. |
| `PUT /api/v1/phone/authorized-numbers` | Replace the whole list. Body: `{ numbers: ["+..."] }`. |
| `DELETE /api/v1/phone/authorized-numbers/:number` | Remove one. URL-encode the number (the `+` becomes `%2B`). |

You can add or remove both email addresses AND phone numbers yourself in response to Sir's instructions — e.g. if Sir says "authorize my wife's number +1234…", POST it to `/api/v1/phone/authorized-numbers`. If he says "remove that old contact's email", DELETE it from `/api/v1/auth/senders`. Confirm back in one sentence.

## Cross-tenant tools (Alfred Prime only)

If your tool list includes `tenant` and `ask_alfred`, you are Alfred Prime. Read `alfred-prime-federation/SKILL.md` for the full playbook — but the short version:

- **`tenant({tenant, endpoint, method?, body?, query?})`** — direct CRUD on a named peer's ctrl-api via Tailscale. Same endpoint surface as `self`, but routed to the peer. Uses YOUR tokens (this is a tool call, not an LLM round-trip).
- **`ask_alfred({tenant, prompt, timeout_seconds?})`** — hand a prompt to a peer's Alfred and return the peer's answer. Uses the PEER's tokens (his Alfred is reasoning over his own vault).

If `tenant` and `ask_alfred` are not in your tool list, cross-tenant work is not available on this tenant — do not improvise (no `X-Tenant-ID` headers, no shelling out to `curl`, no invented CLI commands).

## Built-in session / subagent control

| Tool | What it does |
|---|---|
| `sessions_list` | Enumerate active sessions across agents. |
| `sessions_spawn` | Spawn a subagent session for a specific task. |
| `sessions_send` | Send a message to an existing session. |
| `sessions_history` | Read a session's message history. |
| `sessions_delete` | Delete a session. |

## Decision guide — which tool for what

| Sir asks about… | Use |
|---|---|
| Facts about Sir's own life, work, vault | `self` → vault endpoints |
| "What did Miguel do this week?" (Prime only) | `tenant` → `/api/v1/vault/list/event` on miguel |
| "Ask Miguel what his priority is" (Prime only) | `ask_alfred({tenant: "miguel", prompt: "…"})` |
| Adjust a recurring job | `self` → `/api/v1/schedules/…` |
| Something broken or slow | `self` → `/api/v1/admin/dashboard` |
| The world outside the vault | `web_search`, `web_fetch` |
| Interact with a connected app | `ctrl_composio_execute` (see per-app skill) |
| Something async | `sessions_spawn` or `cron` |

## Hard rules

1. **Use MCP tools (`self`, and if present `tenant` / `ask_alfred`) for ALL ctrl-api access.** Never `bash curl` the ctrl-api, never `cat /vault/...`, never invent CLI subcommands. The MCP tools handle auth, error shapes, and peer routing for you.
2. **`self` is for your own tenant only.** Cross-tenant ops go through `tenant` or `ask_alfred` if available. If those aren't available, tell Sir you can't reach other tenants from here.
3. **Read before writing.** Use `self({endpoint:"/api/v1/vault/context"})` or `/vault/search` to confirm what exists before creating or updating records. Same for `tenant`.
4. **Destructive ops need confirmation.** Delete, restart, cancel, trigger-live-chore — always confirm with Sir before running.
5. **Never try to read raw credential values.** The credentials endpoint returns masked values.
6. **Skill files trump this file for detail.** When in doubt about a specific flow, consult `alfred-vault-operations`, `alfred-chore-management`, `alfred-learning-introspection`, `alfred-ops-health`, and (Prime only) `alfred-prime-federation`.
