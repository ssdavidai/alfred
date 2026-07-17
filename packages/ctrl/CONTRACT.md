# CONTRACT.md — alfred-ctrl-api (`packages/ctrl`)

**Frozen cross-lane interface.** Lane agents code against this document, not against ctrl's source. Regenerated 2026-07-15 from `main`; every claim below is verified in code at the cited path.

ctrl-api is the tenant API server: a zero-dependency-at-runtime Node 22 HTTP service on **:3100** that is the **sole writer** of all four stores (vault markdown, `alfred-state.db`, `ingest.db`, cold archive) plus Store 5 (files). It is HTTP-only — the pre-cutover CLI/TUI was deleted; `build.mjs` produces exactly one artefact, `dist/api.mjs`, from entry `src/api/standalone.ts`. Every other service (web, alfred-learn, the alfred vault daemon, Hermes profiles via the `alfred-ctrl` MCP server, voice-bridge) persists state by calling ctrl-api over HTTP. ctrl-api in turn reaches siblings via `docker exec` (helpers `dockerExec`, `src/api/helpers.ts:100`) and HTTP (Hermes gateway, vault-cli, mcp-server, Sure, Paperclip).

---

## Provides

### Transport, auth, health

| Surface | Detail |
|---|---|
| HTTP server | `AAS_HOST` (default `127.0.0.1`; compose pins `0.0.0.0`) : `AAS_PORT` (default `3100`) — `src/api/standalone.ts` |
| Auth (default) | `Authorization: Bearer ${AAS_API_KEY}` on every `/api/v1/*` route; constant-time compare (`src/api/auth.ts`) |
| Scoped bearer #1 | `VOICE_BRIDGE_INTERNAL_TOKEN` — path-allowlisted (exact `METHOD:path` set + anchored per-route regexes, `auth.ts` `VOICE_BRIDGE_ALLOWLIST` / `VOICE_BRIDGE_PATTERN_ALLOWLIST`). Read-mostly: exactly three narrow writes are allowlisted (`POST /api/v1/phone/transcript`, `POST /api/v1/integrations/execute`, `POST /api/v1/voice-bridge/recall-turn`); all other writes excluded. |
| Scoped bearer #2 | Channel tokens (`src/db/channelTokens.ts`, migration `0004`) — e.g. `POST /api/v1/channels/ha/turn` authenticates via the `channel_tokens` table, not the master key |
| Unauthenticated | `GET /api/v1/health`, `GET /healthz` (liveness; no auth, no DB — `server.ts`). Compose healthcheck instead curls `/api/v1/learning/status` with the bearer. |
| Public (self-authed) routes | Webhooks that carry their own auth (see `server.ts` `isPublic`): `/api/v1/streams/omi/*` (token), `/api/v1/plane/webhook` + `/api/v1/webhooks/plane/steward` (HMAC; **dormant**, see below), `/api/v1/webhooks/vexa` (410 Gone stub), `/api/v1/webhooks/in/:token`, `/api/v1/channels/email/inbound` (`?token=` = `AGENTMAIL_WEBHOOK_TOKEN`), `/api/v1/channels/paperclip/heartbeat` (HMAC), `/api/v1/channels/ha/turn` (channel token), `/api/v1/composio/webhook` (HMAC, `COMPOSIO_WEBHOOK_SECRET`), `/api/v1/webhooks/recall` (Svix, `RECALL_WEBHOOK_SECRET`), `/api/v1/channels/voice/inbound` (TwiML) |
| Raw-body routes | HMAC-over-raw-body verification needs exact bytes: plane webhooks, composio webhook, recall webhook (`server.ts` `isRawBody`) |
| Hard rejection | Any request carrying `X-Tenant-ID` → 400 `X_TENANT_ID_NOT_SUPPORTED` (`server.ts`) — cross-tenant auth is Bearer-only |
| WebSocket | `attachTerminalUpgrade` (`routes/terminal.ts:98`) — WS upgrade at path `/terminal`, auth via `?token=` bearer, single active session (second connect → 409) |

### Route modules

One row per module in `src/api/routes/` (complete index = the `register*` import block in `src/api/server.ts`). Endpoint counts are module-level; read the module for the full list.

| Module | URL prefix | Purpose |
|---|---|---|
| `vault.ts` | `/api/v1/vault/*` | Promotion-contract-enforced vault CRUD + search/graph/inbox/move. See call-out §Vault below. |
| `vaultIndex.ts` | `/api/v1/vault-index*` | Read-index over the vault (`vault_index` table) + `POST /reconcile` self-heal |
| `state.ts` | `/api/v1/state/*` | Store 2 (`alfred-state.db`) surface: audit, signals, observations, routing-decisions, links, embeddings, cold status/compact. See call-out §Four-store. |
| `ingest.ts` | `/api/v1/ingest/*` | Store 4 (`ingest.db`) stream-event and poison-event surface. `stream_event` has `failure_count INTEGER NOT NULL DEFAULT 0`, `last_error TEXT`, `dead_lettered_at TEXT`, and `dead_letter_reason TEXT`; `src/db/ingest.ts` applies guarded `ALTER TABLE` statements at open time because `ingest-schema.sql` is CREATE-only idempotent and cannot retrofit columns on deployed tenants. The fixed retry budget is `INGEST_FAILURE_BUDGET = 5`. `POST /api/v1/ingest/events/:id/failure` accepts `{error, error_class: "retryable"\|"non_retryable", source}` and returns `{failure_count, dead_lettered}`: `non_retryable` dead-letters immediately, while `retryable` dead-letters when `failure_count` reaches the budget. `GET /api/v1/ingest/events/dead-letter` returns rows with `reason`, `failure_count`, and provenance (`stream`, `channel`, `external_id`, `ts`). `POST /api/v1/ingest/events/:id/requeue` clears `dead_lettered_at`, `dead_letter_reason`, and `failure_count`; it is idempotent, so requeueing a non-dead-lettered or already-requeued event returns 200 without changing state. `GET /api/v1/ingest/events/pending` excludes dead-lettered rows, and queue counts report `pending` and `dead_lettered` separately. Dead-lettered rows remain subject to the existing 7-day TTL. |
| `streams.ts` | `/api/v1/streams*` | Stream registry + `POST /streams/ingest` (mirrors each event into ingest.db — Store-4 write failure 5xxs the ingest, no false 201) + inbox scan |
| `files.ts` | `/api/v1/files/*` | Store 5 blob store (upload/list/stat/blob/describe, cold-promote/restore, extraction) — issue #114 |
| `decisions.ts` | `/api/v1/decisions*`, `/api/v1/admin/pattern-proposals` | Unified decision write/read path. See call-out §Decisions. |
| `attention.ts` | `/api/v1/admin/needs-attention*`, `/api/v1/admin/desk-action` | Legacy Desk queue (vault `needs_attention/` cards) with done/dispatch/skip + `mintDecisionMirror` |
| `matters.ts` | `/api/v1/matters*` | Matter aggregator (derives roll-up state from linked tasks) |
| `briefings.ts` | `/api/v1/briefings*` | Brief list/detail |
| `todos.ts` | `/api/v1/todos*` | Todo records CRUD |
| `stateChanges.ts` | `/api/v1/state-changes*` | state_mutator audit surface |
| `steward.ts` | `/api/v1/steward/*` | Steward action confirm/dismiss/undo |
| `learning.ts` | `/api/v1/learning/*`, `/api/v1/curator/route-and-process` | Learning-loop read surfaces (instincts, observations, reflections, quarantine) + curator routing |
| `settings.ts` | `/api/v1/settings*` | The 3 live↔shadow mode flags. See call-out §Settings. |
| `chores.ts` | `/api/v1/chores*`, `/api/v1/chore-actions`, `/api/v1/cron/preview`, `/api/v1/admin/chores/{refresh-tier,install-standard}` | Chore CRUD/pause/resume/trigger/runs/source |
| `workflows.ts` | `/api/v1/workflows*`, `/api/v1/schedules*`, `/api/v1/onboarding/*` | Temporal workflow/schedule ops — via `docker exec temporal temporal …` CLI (`workflows.ts:28`) |
| `workers.ts` | `/api/v1/workers/*` | Worker lifecycle + distiller/janitor scan/run/history |
| `hermes.ts` | `/api/v1/hermes/*` | Hermes gateway proxy: cron jobs, ephemeral runs, model list |
| `agents.ts` | `/api/v1/agents/*`, `/api/v1/admin/agents*`, `/api/v1/admin/profiles` | Agent registry, focused-subagent dispatch (workers gateway `/v1/responses`), tool disposition |
| `profiles.ts` | `/api/v1/agent-profiles*`, `/api/v1/admin/profiles/:slug/*` | Multi-profile Hermes registry (#120): bindings, skills, MCP registrations, restore/status |
| `channel_identity.ts` | `/api/v1/agent-profiles/:slug/channel-identities*` | Per-(profile, channel_kind) display_name + avatar (#206, migration `0018`) |
| `admin.ts` | `/api/v1/admin/*` | Ops: containers start/stop/restart/logs, env config, backups, temporal cluster, tailscale admin, dashboard/health |
| `credentials.ts` | `/api/v1/admin/credentials`, `/api/v1/admin/vault/refresh` | Credential read/patch + vault-refresh into running services |
| `models.ts` | `/api/v1/admin/models` | Model catalogue |
| `logs.ts` | `/api/v1/logs` | Container log tail |
| `system.ts` | `/api/v1/system/ssh-*` | SSH pubkey surface for the /channels Terminal card + key add/revoke (writes host `authorized_keys`) |
| `workspace.ts` | `/api/v1/admin/workspace/:filename` | Read/write workspace files |
| `apps.ts` | `/api/v1/apps` | Sibling-surface launcher catalogue |
| `devices.ts` | `/api/v1/devices*` | Device pairing approve/revoke |
| `authSenders.ts` | `/api/v1/auth/senders*` | Authorized email-sender allowlist |
| `approvals.ts` | `/api/v1/approvals/*` | Pending-approval queue approve/reject |
| `tools.ts` | `/api/v1/tools*` | Gateway tool allowlist viewer + invoke |
| `integrations.ts` | `/api/v1/integrations*` | Composio surface: catalog, connect (OAuth + api-key), execute, per-toolkit actions, stream enable/migrate, skill regen |
| `composioWebhook.ts` | `/api/v1/composio/webhook` | HMAC-validated Composio inbound (Standard-Webhooks scheme) |
| `webhooksInbound.ts` | `/api/v1/webhooks/inbound*`, `/api/v1/webhooks/in/:token` | Custom inbound webhook registry + tokenized receiver |
| `notifications.ts` | `/api/v1/notifications` | Outbound notify via the Hermes main gateway |
| `context.ts` | `/api/v1/context/cross-channel` | Cross-channel context assembly |
| `crossTenant.ts` | `/api/v1/cross-tenant/*` | Peer-tenant ask (Bearer = peer apiKey; no X-Tenant-ID) |
| `alfredJournal.ts` | `/api/v1/alfred-journal*` | One-Alfred continuity journal + principal binding (migration `0002`) |
| `alfredDeliver.ts` | `/api/v1/alfred-deliver`, `/api/v1/delegate-outcomes` | Unified outbound delivery + delegate-outcome ingestion |
| `email.ts` | `/api/v1/email/*` | AgentMail-backed email ops (send/reply/forward/thread/message/attachment) |
| `channelsEmail.ts` | `/api/v1/channels/email/*` | Email channel card: status/provision/test + the AgentMail inbound webhook |
| `channelsAttachment.ts` | `/api/v1/channels/attachment/fetch` | Channel attachment fetch |
| `phone.ts` | `/api/v1/phone/*` | Phone/SMS provisioning, calls, voice-context + transcript (the two original voice-bridge-scoped routes) |
| `sms.ts` / `telegram.ts` / `slack.ts` / `voice.ts` | `/api/v1/channels/{sms,telegram,slack,voice}/*` | Channel cards: status/resolve/test + credential/token management |
| `voice_esphome.ts` | `/api/v1/channels/voice/esphome/*`, `.../wyoming/status` | ESPHome satellite + Wyoming status (#112 PR5) |
| `channels_omi.ts` + `omi.ts` | `/api/v1/channels/omi/*`, `/api/v1/streams/omi/audio` | OMI card + public audio-stream ingest |
| `channels_paperclip.ts` | `/api/v1/channels/paperclip/*` | Paperclip card: status/test/api-key + HMAC heartbeat |
| `paperclip_admin.ts` | `/api/v1/paperclip/admin/*` | Paperclip admin bootstrap: companies list/create, per-company agents list/create, users create |
| `paperclipEvidence.ts` | `/api/v1/paperclip/evidence-packet` | Evidence-packet intake |
| `channels_recall.ts` | `/api/v1/channels/recall/*`, `/api/v1/webhooks/recall`, `/api/v1/voice-bridge/recall-turn` | Recall.ai meeting bots: config, bots CRUD, transcript + SSE stream, Svix webhook (#113) |
| `recall_realtime.ts` | (no routes) | Helpers for the recall realtime path: wake-word detect, SSE frames, transcript persistence |
| `channels_ha.ts` | `/api/v1/channels/ha/*` | Home Assistant channel (#110/#111): 96 routes — connect/status/turn + discovery/write surfaces (entities, devices, areas, labels, automations, scenes, scripts, integrations, add-ons, HACS, backups, users/LLATs, proposals, gaps, registry, snapshot rollback). LLAT storage via vault-cli (Vaultwarden). NOTE: no `GET /channels/ha/state/:entity_id` on main — that backfill lives on branch `fix/ha-get-state-route`. |
| `channels_ha_ws.ts` | `/api/v1/channels/ha/ws/*` | Tier-4 long-lived HA WebSocket surface (#115/#158): status + WS-only registry pull |
| `channel_tokens.ts` | `/api/v1/channel-tokens*` | Legacy shared per-channel bearer-token surface (mint/list/rotate/revoke) — kept for deployed fleet bearers |
| `channels_tokens.ts` | `/api/v1/channels/tokens*` | Canonical REST surface over the same `channel_tokens` table (#111 PR4); new callers use this |
| `channels_tailscale.ts` | `/api/v1/channels/tailscale/*` | Tailscale sidecar lifecycle (#109): status, connect, disconnect, peers, cert (mints tailnet LE cert + drops Caddy snippet), serve, funnel |
| `mcpTokens.ts` | `/api/v1/mcp/tokens*` | Per-app MCP scoped-token proxy (PR #278). See call-out §MCP tokens. |
| `claudeSetup.ts` | `/api/v1/claude-setup*` | /claude page payload + `MCP_APPROVAL_SECRET` rotation |
| `vaultwarden.ts` | `/api/v1/vaultwarden/*` | Vaultwarden proxy via the vault-cli sidecar (`VAULT_CLI_URL`, default `http://vault-cli:8087`) |
| `sure.ts` | `/api/v1/sure/*` | Sure personal-finance REST proxy (96 endpoints; auth via `SURE_API_KEY`, missing key → `NOT_CONFIGURED`) |
| `sureAssistant.ts` | `/api/v1/sure/assistant` | Sure AI-assistant endpoint |
| `plane.ts` | `/api/v1/plane/*` | **DORMANT, not deployed** — Plane proxy + webhook. Plane was removed from the compose stack fleet-wide (PR #279); no `plane` service exists in `docker-compose.yaml`. Routes remain registered but have no upstream. Do not build against; deletion is an open follow-up. |
| `webhooks/plane.ts` | `/api/v1/webhooks/plane/steward` | **DORMANT** — same status as `plane.ts` |
| `vexa.ts` + `webhooks/vexa.ts` | `/api/v1/admin/vexa/auto-join`, `/api/v1/webhooks/vexa` | **RETIRED** (#113 PR1) — webhook is a deliberate public 410 Gone stub so retrying callers hear a terminal answer |
| `chore_manifest_data.ts` | (no routes) | Data module: `CHORE_ACTION_MANIFEST` consumed by `chores.ts` |
| `terminal.ts` | WS `/terminal` | Terminal WebSocket (registered via `attachTerminalUpgrade` in `standalone.ts`, not `addRoute`) |

### Call-out: four-store write endpoints

ctrl-api is the sole write handle on Stores 1–5. Other services persist by POSTing here — **these exact paths** (the older `POST /api/v1/audit` / `/api/v1/signals` / `/api/v1/observations` spellings do not exist on main):

| Record class | Endpoint | Store |
|---|---|---|
| audit-class actions (`signal-action`, `steward-action`, `desk-action`, `state-change`, `needs_attention_action`, `event`) | `POST /api/v1/state/audit` | `alfred-state.db` `audit` |
| signals | `POST /api/v1/state/signals` | `alfred-state.db` `signal` |
| observations (+ `pattern_proposal`, `synthesis`, `contradiction`, `assumption`, `constraint` as `kind=`) | `POST /api/v1/state/observations` | `alfred-state.db` `observation` |
| routing decisions | `POST /api/v1/state/routing-decisions` | `alfred-state.db` |
| raw stream events | `POST /api/v1/ingest/events` (direct) or `POST /api/v1/streams/ingest` (registry path; mirrors into ingest.db) | `ingest.db` `stream_event` (7d TTL, PROCESSED-only sweep — `src/db/ingest.ts`) |
| principal blobs | `POST /api/v1/files/upload` | files volume (`/files`), cold at `/cold-files` |

Destination strings are machine-surfaced: a demoted-type vault write returns them in the 422 body (`src/db/promotionContract.ts` `DEMOTED_TYPES`).

### Call-out: the promotion contract

`assertCanonicalVaultPath()` (`src/db/promotionContract.ts`) runs before the filesystem on **every** vault write route. Violation → HTTP **422** `PROMOTION_CONTRACT_VIOLATION` with `detail: { recordType, destination }` pointing at the correct store endpoint.

- Canonical record types (exactly 12): `matter task note person org place asset chore instinct decision briefing daybook`. `<type>/_closed/` subdirs remain canonical.
- Allowed top-level singletons: `SOUL.md`, `RULES.md`.
- Allowed non-record dirs (`CANONICAL_NON_RECORD_DIRS`): `_templates/` and `needs_attention/` **only**. `needs_attention/` is the interim Desk-queue posture (#78) until storage-epic cutover #28 moves the read path to state.db. Older docs claiming `_archive/`/`_migrated*/`/`_rescue/`/`inbox/` bypasses are stale — not in code.
- Path-traversal (`..`) also throws the 422.
- Never add a vault directory. If a new record class appears, it is demoted to SQLite unless the principal will read/edit it in Obsidian — and that decision is orchestrator-level (this file + `promotionContract.ts` are forbidden-zone).

### Call-out: vault PATCH body shape (the no-op gotcha)

`PATCH /api/v1/vault/records/<path>` accepts ONLY these keys (`routes/vault.ts` ~870–1130):

```
{ "set": {k: scalar} }          → alfred vault edit --set
{ "append": {k: scalar} }       → alfred vault edit --append
{ "body_append": "…" }          → alfred vault edit --body-append
{ "json_set": {k: native} }     → direct YAML merge (lists/dicts/bools/null-deletes; requires existing file)
{ "body_set": "…" }             → wholesale body replace (under the same path lock)
```

A **bare field-keyed body returns 200 with no-op**: `hasCliArgs` (`vault.ts:976`) sees no recognized key, skips the CLI exec, and nothing throws. Always wrap. Writes execute as `docker exec alfred alfred vault edit …` (`dockerExec("alfred", args, VAULT_ENV)`, `vault.ts:988`) serialized per-path by `_withVaultPathLock`; scalar `set` and `json_set` may be combined — json_set lands last and wins on key collision.

### Call-out: decisions state machine — the mint rule

`POST /api/v1/decisions` (`routes/decisions.ts`) **always mints `state: "open"`** (`initialState = "open"`, decisions.ts:568) — for every intent, including done/noise/take_mine and defer. The route performs the synchronous source-record flip itself and stamps `side_effects.synchronous_flip: true` (decisions.ts:534); learn's DecisionRouter (which lists only `state=open`) then skips the already-done action paths via its `synchronous_flip` guards but **always** runs `extract_observation_from_decision` — that is the learning-loop closer. Minting any terminal state here silently kills learning (incident 2026-05-24, commit `31fa11f`). Full state vocab: `open | scheduled | dispatching | executing | completed | reversed` (decisions.ts:101). Optional `decision_origin` in the body marks instinct-fire / router-minted decisions.

The legacy surface `POST /api/v1/admin/needs-attention/:id/{done,dispatch,skip}` (`routes/attention.ts`) flips the NA card and mints a mirror decision via `mintDecisionMirror` (also `state=open` + `synchronous_flip: true`) — **unless** `decision_origin` is set in the body, which is how DecisionRouter's own `/dispatch` calls avoid recursive decision minting (attention.ts:632–638; commit `4466c68`).

### Call-out: settings — the 3 mode flags

`GET /api/v1/settings`, `GET|PUT /api/v1/settings/:key` (`routes/settings.ts`). Registry (all default `"live"`, valid `live|shadow`):

| Key | Env override |
|---|---|
| `signal_action_mode` | `STEWARD_SIGNAL_ACTION_LIVE_MODE` |
| `state_mutator_mode` | `STEWARD_LIVE_MODE` |
| `auto_task_create_mode` | `STEWARD_SIGNAL_AUTOCREATE_TASKS` |

Resolution precedence: env var > `${ALFRED_DATA_DIR}/settings.json` > default. Responses carry `{mode, source, env_override_active}`. Writes are temp-file + atomic rename, read-modify-write (unrelated keys preserved). Hyphenated key forms are accepted as aliases (`signal-action-mode`). Adding a flag = one entry in `SETTINGS_KEYS`; endpoints and tests follow.

### Call-out: MCP scoped tokens (PR #278)

`/api/v1/mcp/tokens` (GET list, POST mint), `/:id/rotate`, DELETE `/:id` (`routes/mcpTokens.ts`) — a **thin proxy** to mcp-server's `/manage/tokens` API. mcp-server owns the tokens (its own SQLite; local validation on every `POST /<app>/mcp`). Chain: browser → web (Wasp op) → ctrl-api → mcp-server, so the browser never holds `MCP_APPROVAL_SECRET`; ctrl-api presents it as the onward Bearer. The raw token appears exactly once (mint + rotate responses); list never carries it; ctrl-api relays verbatim. Missing secret → 500 `MCP_NOT_CONFIGURED`; mcp-server down → 502 `MCP_UNREACHABLE`.

---

## Requires

### Runtime & sibling services

| Dependency | How used |
|---|---|
| Node 22 (`node:sqlite`) | run: `node --experimental-sqlite dist/api.mjs`; node builtins are the only bundle externals |
| Docker socket (`/var/run/docker.sock`) + docker CLI | `dockerExec` into siblings: `alfred` (vault CLI writes), `temporal` (workflow/schedule CLI), `hermes` (`HERMES_CMD=["hermes"]` / `HERMES_CONTAINER="hermes"` — `src/api/helpers.ts:210`); container start/stop/restart |
| Hermes gateway (HTTP) | main `HERMES_GATEWAY_URL` (default `http://hermes:18789`), workers `HERMES_WORKERS_GATEWAY_URL` (default `http://hermes:18790`); Bearer = gateway token from `OPENCLAW_GATEWAY_TOKEN_FILE` (default `/alfred-data/.gateway-token`), env fallbacks `HERMES_API_KEY` / `OPENCLAW_GATEWAY_TOKEN` |
| vault-cli sidecar | `VAULT_CLI_URL` (default `http://vault-cli:8087`) — Vaultwarden proxy + HA LLAT storage |
| mcp-server | `MCP_SERVER_URL` (default `http://mcp-server:8787`) + `MCP_APPROVAL_SECRET` |
| Sure | `SURE_API_URL` / `SURE_API_KEY` (proxy returns NOT_CONFIGURED without the key) |
| Paperclip | `PAPERCLIP_BASE_URL` / `PAPERCLIP_AGENT_TOKEN` (+ `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_HEARTBEAT_SECRET`) |
| sqlite-vec extension | baked into the image; `SQLITE_VEC_PATH` — absent → embedding routes 503, everything else works (`src/db/state.ts`) |

### Environment variables (verified in code)

| Var | Required | Default / notes |
|---|---|---|
| `AAS_API_KEY` | **yes — fatal exit if unset** (`standalone.ts`) | master Bearer |
| `AAS_PORT` / `AAS_HOST` | no | `3100` / `127.0.0.1` (compose: `0.0.0.0`) |
| `VOICE_BRIDGE_INTERNAL_TOKEN` | no | enables the scoped voice-bridge bearer |
| `VAULT_PATH` | effectively yes | compose pins `/vault` (code defaults diverge per module — do not rely on them) |
| `ALFRED_DATA_DIR` | effectively yes | compose pins `/alfred-data` (settings.json, gateway token, scratch) |
| `STATE_DB_PATH` / `INGEST_DB_PATH` / `COLD_DB_PATH` | no | default `<cwd>/data/{alfred-state.db,ingest.db,cold.db}`; volumes mount at `/state`, `/ingest`, `/cold` |
| `SQLITE_VEC_PATH`, `EMBEDDING_DIM` (768), `EMBED_MODEL`, `OLLAMA_BASE_URL` | no | vector search + embedding |
| `INGEST_TTL_DAYS` (7), `INGEST_SWEEP_INTERVAL_MS`, `COLD_TTL_*`, `COLD_COMPACT_*` | no | store TTL/compaction knobs |
| `HERMES_GATEWAY_URL`, `HERMES_WORKERS_GATEWAY_URL`, `HERMES_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_TOKEN_FILE` | no | see sibling table (OPENCLAW_* names are legacy fallbacks still read by code) |
| `HERMES_CONFIG_DIR` | compose-pinned | `/hermes-state/profiles` — ctrl-api reads/writes per-profile `config.yaml` |
| `MCP_SERVER_URL`, `MCP_APPROVAL_SECRET` | for /mcp/tokens | see call-out |
| `COMPOSE_DIR` (`/srv/alfred-black`), `COMPOSE_FILE` | compose-pinned | host compose dir bind-mounted; `.env` read/write + `docker compose` ops |
| `TENANT_BASE_URL`, `DOMAIN`, `SAAS_HOST` | webhook URL building | `TENANT_BASE_URL` unset → OMI/custom webhook URLs come back empty |
| Webhook secrets | per channel | `AGENTMAIL_WEBHOOK_TOKEN`, `COMPOSIO_WEBHOOK_SECRET`, `RECALL_WEBHOOK_SECRET`, `PAPERCLIP_HEARTBEAT_SECRET`, `PLANE_WEBHOOK_*` (dormant) |
| Channel/provider keys | per feature | `COMPOSIO_API_KEY`, `AGENTMAIL_*`, `TWILIO_*`, `RECALL_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `BW_USER`/`BW_PASSWORD`, `HA_*` (timeouts/overrides), `FILES_*` (quota/roots), `CROSS_TENANT_PEERS` |

### Mounted volumes (compose service `ctrl-api`, `docker-compose.yaml`)

`vault_data:/vault` · `alfred_data:/alfred-data` · `hermes_data:/hermes-state` · `state_data:/state` · `ingest_data:/ingest` · `cold_data:/cold` · `files_data:/files` (**sole `:rw`** — hermes + alfred mount `:ro`) · `files_cold_data:/cold-files` (ZSTD-19 archive, only ctrl-api mounts) · `/var/run/docker.sock` · `${COMPOSE_DIR_HOST:-/opt/alfred}:/srv/alfred-black` (RW) · `/root/.ssh/authorized_keys` (RW, for the Terminal card).

---

## Invariants (other lanes rely on these)

1. **Single writer.** ctrl-api holds the only write handles to `alfred-state.db`, `ingest.db`, `cold.db`, the vault, and `/files`. learn / the alfred daemon / hermes write through HTTP here — never file-direct. Readers may open the SQLite files read-only (WAL enables this — `src/db/state.ts`).
2. **Promotion contract enforced in code**, not convention: every vault write route calls `assertCanonicalVaultPath()` first; non-canonical → 422 with the correct destination endpoint. 12 canonical types + `SOUL.md`/`RULES.md` + `_templates/` + `needs_attention/` (interim). No new vault directories, ever.
3. **Migrations are append-only forbidden-zone.** `src/db/schema.sql` is the frozen v0 baseline (CREATE IF NOT EXISTS); every change after it is a numbered file in `src/db/migrations/` (currently `0001`–`0018`), applied transactionally at boot gated on `PRAGMA user_version` (`src/db/migrate.ts`). Never edit a merged migration — append the next number. Lanes cannot touch `schema.sql`, `migrations/**`, `migrate.ts`, or `api/server.ts` (commit gate rejects).
4. **Auth is Bearer on :3100.** Master `AAS_API_KEY` everywhere; the only exceptions are the enumerated public webhook routes (each self-authenticating), the two liveness probes, and the two scoped-token classes (voice-bridge allowlist, channel tokens). `X-Tenant-ID` is rejected with 400. Token compares are constant-time.
5. **Decisions mint `state: open`, always** — no write path may mint a terminal state, or the learning loop silently dies (see call-out).
6. **web never talks to mcp-server or Hermes admin directly** — the dashboard's only backend is ctrl-api; secrets (`MCP_APPROVAL_SECRET`, gateway token) stay server-side.
7. **No route module registers itself** — registration is centralized in `createApiServer()` (`server.ts`, forbidden-zone). Adding a module = orchestrator edit of `server.ts`.
8. **Deploys pull, never build.** The image is `ssdavidai00/alfred-ctrl-api:latest`, built only by CI (`.github/workflows/build-ctrl-api.yml`); `docker compose up` never builds.
9. **Plane surfaces are dormant.** No Plane container exists in the stack (PR #279). `plane.ts` / `webhooks/plane.ts` / `PLANE_*` env are dead config awaiting deletion; do not wire new consumers.

---

## Build & test

```sh
cd packages/ctrl
npm ci          # once per fresh checkout (orchestrator-only inside fix fan-outs)
npm run build   # node build.mjs → dist/api.mjs (single ESM artefact)
npm test        # node:test over tests/*.test.ts (148 test files)
```

- esbuild bundles `src/api/standalone.ts` → `dist/api.mjs`; **only node builtins are external** (incl. `node:sqlite`) — everything else (js-yaml, nunjucks, ssh2, ws, …) is bundled, so the runtime image ships no `node_modules`. (Older docs saying "ssh2 is external" are stale.)
- `.sql` / `.njk` / `.md` / `.yaml` import as text strings (esbuild `loader` config in `build.mjs`; `tests/text-loader.mjs` replicates this for the test runner). This is how `schema.sql` and every migration travel inside the bundle.
- Test invocation (from `package.json`): `node --experimental-sqlite --experimental-test-module-mocks --import tsx/esm --experimental-loader ./tests/text-loader.mjs --test tests/*.test.ts`.
- Lane VERIFY for Lane I must run build + tests against existing deps — never `npm install/ci` inside a lane.

---

## Change protocol

This file is **forbidden-zone**: the commit gate (`scripts/hooks/check_lane.py`) rejects any lane diff touching `**/CONTRACT.md`. Changes land only via an orchestrator (phase0) commit in the main checkout, after the interface change itself has merged.

A lane that finds this contract wrong — a route missing, a shape mismatched, an invariant contradicted by code — **STOPs and reports to the orchestrator. It never improvises across the boundary**, never codes to "what the provider probably meant", and never edits this file to match its patch. The orchestrator reconciles (fix the provider, or fix the contract) and re-freezes before the lane resumes.
