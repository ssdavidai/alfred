# TOOLS.md — Alfred's Capability Reference

Source of truth for what tools Alfred has access to on this tenant. Read it when planning multi-step work so you pick the right tool first time instead of shelling out to bash + curl.

## Output discipline (read this first, every turn)

Tool results — JSON bodies, `{error: true, status, body: ...}` envelopes, HTTP error shapes, stack traces, bare objects — are for YOUR reasoning, never for Sir's eyes. Your Sir-facing reply is always prose (or a markdown list/table), in Sir's language, summarising what you found or explaining in a sentence what went wrong and what you'll do next. If a `self` call 404s or returns empty, say "I don't see that in the vault yet, Sir — would you like me to …?" Do NOT paste raw JSON. The first character of your reply to Sir is never `{`. This rule supersedes anything else in this file.

Tools come in five layers:

1. **Shell primitives** — `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`. Scoped to the workspace at `/home/node/.openclaw/workspace`. Use when operating on workspace files, never for ctrl-api access.
2. **Built-in OpenClaw tools** — `web_search`, `web_fetch`, `image`, `image_generate`, `video_generate`, `music_generate`, `tts`, `pdf`, `canvas`, `cron`, `sessions_*`, `subagents`, `update_plan`, `message`. Always available.
3. **`self` MCP tool** — generic proxy to THIS tenant's ctrl-api. Your default for all local vault / streams / learning / workflows / schedules / workers / admin operations.
4. **Alfred Prime only** — `tenant` and `ask_alfred` tools for cross-tenant operations. If these aren't in your tool list, you're not Prime and cross-tenant work is not available to you. See `alfred-prime-federation/SKILL.md` for details.
5. **Connected Apps** — `composio_execute` gateway tool for third-party app actions (Gmail, GitHub, Notion, Calendar, Slack, Zoom, Drive). See the `alfred-composio-*` skills per app.

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
| `GET /api/v1/streams/schema` | **Read this first when creating or configuring a stream.** Returns field descriptor, archetypes (composio_pull / webhook_push / http_pull / ambient_omi / manual_ingest) with worked example bodies, recommended Composio templates, known stream_type values, and system-stream patterns the agent must not touch. |
| `GET /api/v1/streams/events` | Recent events across all streams. `?status=unprocessed` to filter. |
| `POST /api/v1/streams/ingest` | Manually push an event. Body: `{stream_id, stream_type, raw, summary?}` |
| `POST /api/v1/streams` | Create a new stream. Body accepts the meta fields `{id, name, type?, source?, enabled?}`; full config (pull_endpoint, schedule, composio_*, auth_*, cursor_*, etc.) goes via a follow-up PATCH. **For `type: "webhook"` streams the server auto-generates the webhookToken and returns a fully-composed `webhook_url` on `response.stream` — copy that field verbatim, never construct it yourself.** Returns 201. Call `/api/v1/streams/schema` first to pick the right archetype. |
| `PATCH /api/v1/streams/:id` | Update stream config fields. Body: any subset of `{name, type, source, enabled, status, pull_endpoint, pull_mode, schedule_cron, schedule_interval_seconds, composio_action, composio_args, ...}`. |
| `DELETE /api/v1/streams/:id` | Delete a stream and its event history. Cannot delete system streams. |
| `POST /api/v1/streams/:id/pause` | Pause a stream (sets `enabled: false`, `status: "paused"`). Cannot pause system streams. |
| `POST /api/v1/streams/:id/resume` | Resume a paused stream (sets `enabled: true`, `status: "idle"`). |
| `POST /api/v1/streams/prune` | Remove processed events older than retention window. Body: `{retention_days?}` (default 7). |

### Learning & intelligence

| Endpoint | What it does |
|---|---|
| `GET /api/v1/learning/status` | Counts + last run times for learning / reflection / judgment. |
| `GET /api/v1/learning/queue` | What's waiting for the next cycle. |
| `GET /api/v1/learning/observations` | Observations extracted from streams and conversations. |
| `GET /api/v1/learning/instincts` | Learned routing rules with confidence scores. |
| `GET /api/v1/learning/reflections` | Nightly reflection syntheses. |
| `GET /api/v1/learning/sessions` | Tracked conversation sessions. |

### Briefings, decisions, state-changes, pending, in-flight

The Desk-and-delegation surface — the canonical source-of-truth for
what Alfred has surfaced to Sir, what Sir has decided, and what
mutations have been made. Always read these BEFORE acting on a
delegation. See AGENTS.md §"Delegation & Brief-Awareness Protocol".

| Endpoint | What it does |
|---|---|
| `GET /api/v1/briefings` | List morning / evening brief snapshots. Query: `slot=morning\|evening\|all`, `since`/`until` (ISO), `limit` (default 20, cap 100). Returns `{briefings, total}`. |
| `GET /api/v1/briefings/:slug-date` | Read one brief by slug-date (e.g. `2026-05-14-morning`). Returns frontmatter + letterpress body. |
| `GET /api/v1/decisions` | List decision records. Query: `state` (`open`/`completed`/`superseded`), `source` (`desk`, `decision-router.auto`, …), `since`, `limit` (default 100, cap 500). Returns `{decisions, count}`. |
| `GET /api/v1/decisions/in-flight` | Decisions Sir has routed that are still working their outcome (delegated, deferred, …). |
| `GET /api/v1/decisions/:id` | Read one decision by id. |
| `GET /api/v1/state-changes` | List the universal state-change audit ledger. Query: `target` (vault-relative path), `source` (writer name), `since`/`until`, `limit` (default 50, cap 200), `offset`. Returns `{entries, total, limit, offset}`. |
| `GET /api/v1/admin/needs-attention` | Decision cards waiting on Sir (the `/desk` queue). Query: `include=pending\|all` (default pending), `limit` (default 100, cap 500). Returns `{records, count}`. |
| `GET /api/v1/openclaw/agents/ephemeral` | List in-flight `exec-*` subagents (delegations Alfred is still resolving). Returns `{agents, count, last_touched_at}`. |

### Workflows & schedules

| Endpoint | What it does |
|---|---|
| `GET /api/v1/workflows` | List active and recent Temporal workflows. |
| `GET /api/v1/workflows/{id}` | Inspect a single workflow (activities, results, failures). |
| `POST /api/v1/workflows` | Start a workflow. Body: `{workflow_type, task_queue, input?}` |
| `POST /api/v1/workflows/:id/terminate` | Terminate a running workflow. Body: `{reason?, run_id?}`. **Confirm with Sir before running.** |
| `POST /api/v1/workflows/:id/signal` | Send a signal to a workflow. Body: `{signal_name, input?, run_id?}`. |
| `POST /api/v1/workflows/:id/cancel` | Request graceful cancellation of a workflow. Body: `{run_id?}`. **Confirm with Sir before running.** |
| `GET /api/v1/schedules` | List all schedules (`al-*`, `chore-*`). |
| `POST /api/v1/schedules` | Create a new Temporal schedule. Body: `{schedule_id, workflow_type, task_queue, cron, input?, overlap_policy?}`. Returns 201. |
| `DELETE /api/v1/schedules/:id` | Delete a schedule permanently. **Confirm with Sir before running.** |
| `POST /api/v1/schedules/{id}/trigger` | Fire a schedule once, out of cycle. |
| `POST /api/v1/schedules/{id}/pause` / `/unpause` | Pause / resume. |
| `POST /api/v1/schedules/:id/rewrite-cron` | Atomically replace a schedule's cron expression (DELETE + CREATE, preserving workflow type, task queue, and input). Body: `{cron}`. |

### Chores

| Endpoint | What it does |
|---|---|
| `GET /api/v1/chores` | List all chore records. |
| `GET /api/v1/chores/{slug}` | Single chore detail. |
| `GET /api/v1/chores/{slug}/source` | Full generated Python source + dependency audit. |
| `POST /api/v1/chores/{slug}/pause` / `/resume` / `/trigger` | State control. |
| `DELETE /api/v1/chores/{slug}` | Remove a chore. **Confirm with Sir before running.** |
| `POST /api/v1/chores` | Create a new chore from Python source. Body: `{slug, workflow_class_name, python_source, schedule, name?, user_facing_description?, params?, task_queue?, overlap_policy?, restart_worker?}`. Returns 201 with `{slug, source_path, vault_path, schedule_id, cron, restart_triggered}`. |
| `PATCH /api/v1/chores/:slug` | Edit an existing chore. Body: any subset of `{python_source, schedule, workflow_class_name, params, name, user_facing_description, tags, task_queue, overlap_policy, restart_worker}`. At least one field required. Atomically rewrites the `.py` file and Temporal schedule; restores prior state on failure. |

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
| `POST /api/v1/admin/chores/refresh-tier` | Sweep every chore record and flip stale `generated: true → false` for chores whose template has been promoted to the platform standard library. Idempotent. Run this once after a platform update that promotes a previously-generated template. |
| `POST /api/v1/admin/chores/install-standard` | Install one of the platform's standard-library chores on this tenant (creates vault record + Temporal schedule). Idempotent — re-installing updates the schedule and frontmatter. Body: `{template, schedule?, name?, user_facing_description?, params?}`. Used to roll out new standard-library chores (e.g. `daily_evening_digest`) to existing tenants that didn't get them at onboarding. |

### Connected Apps (Composio)

| Endpoint | What it does |
|---|---|
| `GET /api/v1/integrations` | List connected apps. |
| `GET /api/v1/integrations/catalog` | Browse the 1,000+ available apps. |
| `POST /api/v1/integrations/execute` | Execute a Composio action (most code paths use the `composio_execute` gateway tool instead). |

For per-app action detail, consult the `alfred-composio-*` skills (gmail, googlecalendar, github, slack, notion, zoom, googledrive).

### Connected Apps — management

Use these endpoints to inspect and modify integration configuration. Sir manages app connections through the dashboard UI; these endpoints let you act on his behalf once connected.

> **OAuth connect note**: `POST /api/v1/integrations/connect` returns a `connect_url` (OAuth redirect). You MUST surface that URL to Sir and tell him to click it. Do NOT claim the integration is connected until Sir confirms via the dashboard — the OAuth flow must complete in a browser.

| Endpoint | What it does |
|---|---|
| `POST /api/v1/integrations/connect-api-key` | Connect an app using a raw API key (non-OAuth). Body: `{toolkit_slug, credential, auth_scheme?}` (`auth_scheme` defaults to `"API_KEY"`). |
| `GET /api/v1/integrations/:toolkit/actions` | List available actions for a toolkit slug (e.g. `gmail`, `github`). Returns `{actions: [{slug, description}]}`. |
| `POST /api/v1/integrations/check-readiness` | Check whether required tools are connected. Body: `{tools_required: string[]}` (array of toolkit slugs or action slugs). |
| `POST /api/v1/integrations/:id/auto-config` | Auto-configure streams, tools, and skills after an OAuth connection completes. `:id` is the Composio `connection_id`. Connection must be `ACTIVE`. |
| `POST /api/v1/integrations/:id/enable-stream` | Create a Composio-backed pull stream for a connection. Body: `{action_slug, stream_name?, poll_interval_seconds?}`. |
| `POST /api/v1/integrations/:id/migrate-stream` | Migrate an existing stream to a new action slug (preserves config). Body: `{old_action_slug, new_action_slug?}`. |
| `POST /api/v1/integrations/:id/disable-stream` | Remove the stream config and Temporal schedule for a Composio action. Body: `{action_slug}`. |
| `POST /api/v1/integrations/enable-tool` | Add a Composio action slug to `gateway.tools.allow`. Body: `{action_slug}`. Triggers gateway restart. |
| `POST /api/v1/integrations/disable-tool` | Remove a Composio action slug from `gateway.tools.allow`. Body: `{action_slug}`. Triggers gateway restart. |
| `POST /api/v1/integrations/regenerate-skills` | Rebuild every connected app's SKILL.md from the current template (useful after a template change). No body required. |

### Email channel (AgentMail — Alfred's own inbox)

Sir's inbox at `alfred.<username>@mail.alfred.black` is an ongoing conversation channel. Inbound from authorized senders spawns a one-shot session with the message pre-loaded; you respond via the endpoints below. For the full playbook on when to reply vs reply-all vs forward vs no-response, see `alfred-email-channel/SKILL.md`.

| Endpoint | What it does |
|---|---|
| `GET /api/v1/email/status` | Check whether AgentMail is configured on this tenant. Returns `{ configured, inbox_id, inbox_address }`. |
| `POST /api/v1/email/send` | Send a new email (new thread). Body: `{ to, subject, text, html?, cc?, bcc?, reply_to?, labels?, attachments? }`. |
| `POST /api/v1/email/reply` | Reply in an existing thread. Body: `{ message_id, text, html?, reply_all?: boolean, attachments? }`. Set `reply_all: true` only when the user's instruction implies it (cc chain should stay informed). |
| `POST /api/v1/email/forward` | Forward a message. Body: `{ message_id, to, subject?, text?, html?, attachments? }`. |
| `GET /api/v1/email/message/:message_id` | Fetch a single message (use this if webhook payload was truncated at 1 MB). |
| `GET /api/v1/email/thread/:thread_id` | Fetch the full thread — always read this before composing a reply so you have complete context, including quoted history. |
| `GET /api/v1/email/attachment/:message_id/:attachment_id` | Download an attachment's content. |

**Attachments shape (send, reply, forward all accept this):**

```json
"attachments": [
  { "content": "<base64-encoded file bytes>", "filename": "report.pdf", "content_type": "application/pdf" }
]
```

- `content` is REQUIRED and must be base64-encoded bytes of the file (no data-URL prefix).
- `filename` and `content_type` are optional but recommended.
- If you promise an attachment in the body text ("please find attached"), you MUST include a real attachments array on the same request. Claiming an attachment without including one is a hallucination — Sir will notice and you will have damaged trust. If you can't actually produce the file, say so plainly or send the content inline as HTML instead.

Also: `GET/POST/DELETE /api/v1/auth/senders` — manage the authorized-senders allowlist that drives the channel/stream dispatch. Only addresses on this list get the conversational channel path; everyone else is ingested as stream events.

### Phone channel (AgentPhone — Twilio voice + SMS)

Sir can call or text his Alfred on the tenant's Twilio number. Inbound SMS from an authorized number is answered by a short LLM turn; calls from an authorized number are routed to the Voice Bridge with full cross-channel context. Unauthorized senders are ingested as stream events with no reply.

| Endpoint | What it does |
|---|---|
| `GET /api/v1/phone/config` | Single endpoint for the dashboard PhonePage. Returns `{ phoneNumber, authorizedNumbers[], recentActivity[] }` (recent activity merges inbound + outbound voice + SMS). Use this as your "is the phone channel configured + what just happened" probe. |
| `GET /api/v1/phone/voice-context` | Voice-bridge primer bundle (MEMORY.md + voice skill + open matters/tasks + recent main-agent sessions + Composio toolkits). Cached 60s. Mostly used by the bridge at call start, but you can read it for debugging context. |
| `POST /api/v1/phone/sms` | Send an outbound SMS. Body: `{ to, body }`. Ships via SaaS → Twilio and logs to the `sms-outbound` stream for vault visibility. |
| `POST /api/v1/phone/call` | Initiate an outbound call. Body: `{ to, message, mode? }` where `mode` is `"tts"` (default — one-shot TTS playback of `message`) or `"realtime"` (live Voice Bridge session, `message` becomes the Realtime initiator instructions). Returns `{ status: "initiated", sid, mode }`. |

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
| Interact with a connected app | `composio_execute` (see per-app skill) |
| Something async | `sessions_spawn` or `cron` |

## Hard rules

1. **Use MCP tools (`self`, and if present `tenant` / `ask_alfred`) for ALL ctrl-api access.** Never `bash curl` the ctrl-api, never `cat /vault/...`, never invent CLI subcommands. The MCP tools handle auth, error shapes, and peer routing for you.
2. **`self` is for your own tenant only.** Cross-tenant ops go through `tenant` or `ask_alfred` if available. If those aren't available, tell Sir you can't reach other tenants from here.
3. **Read before writing.** Use `self({endpoint:"/api/v1/vault/context"})` or `/vault/search` to confirm what exists before creating or updating records. Same for `tenant`.
4. **Destructive ops need confirmation.** Delete, restart, cancel, trigger-live-chore — always confirm with Sir before running.
5. **Never try to read raw credential values.** The credentials endpoint returns masked values.
6. **Never leak raw tool output or error bodies to Sir.** Tool results — JSON bodies, `{error: true, status, body: ...}` envelopes, HTTP error shapes, stack traces — are for YOUR reasoning, never for Sir's eyes. Your reply to Sir is always prose (or a markdown list/table), in his language, summarising what you found or explaining in a full sentence what went wrong and what you'll do next. If a tool call fails, say "I couldn't find X, Sir — would you like me to Y?" or "That endpoint didn't return anything; let me try a different angle." Do NOT paste `{"error": "Not Found"}`, `{"status": 500, ...}`, bare JSON objects, or any tool-wrapper envelope as your final message. If you ever catch yourself about to emit a `{` as the first character of a Sir-facing reply, stop and rewrite it in prose.
7. **Skill files trump this file for detail.** When in doubt about a specific flow, consult `alfred-vault-operations`, `alfred-chore-management`, `alfred-learning-introspection`, `alfred-ops-health`, and (Prime only) `alfred-prime-federation`.
