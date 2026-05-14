# Changelog

All notable changes to the alfred-platform monorepo.

## [Unreleased] — Alfred Black 1.0

The Alfred Black 1.0 rollout: a full visual + IA redesign of the SaaS surface
into the Door + manifesto wool aesthetic, the canonical home moves from
`/dashboard` to `/desk`, the dashboard sub-routes are renamed to vocabulary
the redesign actually uses, the back office is unified at `/study`, and the
onboarding becomes a sequential ritual. Validated against production with the
parallel-preview strategy (`preview.alfred.black`, `WASP_DISABLE_JOBS`,
`WRITE_BLOCK_TENANT_OPS_DENYLIST`) before cutover.

### Packages Changed

- `packages/saas` —
  - **Design system**: ported Alfred Black tokens (paper/wool/ink/brass) (#842),
    Playfair Display + EB Garamond + JetBrains Mono typography stack (#843),
    Frame/Seal/Icon/RitualNav/PageOverture/Markdown/Phone components
    (#844 #845), motion library + ThemeProvider with FOUC-free boot (#846),
    shadcn/ui primitives reskinned (#845).
  - **Marketing**: rebuilt LandingPage as Door + manifesto wool (#847),
    `/staff` page (#848), `/companion` `/voice` `/sms` `/voice-and-tone`
    pages (#849), restyled `/pricing` `/tos` `/pp` (#850), restyled auth
    pages with Door + Frame aesthetic (#851).
  - **Onboarding ritual**: replaced `/onboarding` with sequential
    `/awaken → /reading-the-room → /verify → /soul → /composing
    → /preparing → /first-brief → /desk` (#852), SOUL preset selector
    moved inside ritual (#853).
  - **Household editor** at `/household` wired to RULES.md + chores (#854).
  - **Canonical home**: `/desk` decision queue + audit ledger (#855),
    `/dashboard` back-compat redirect to `/desk` (#856).
  - **Brief**: `/brief` letterpress page + `getDailyBrief` query (#857).
  - **Matters**: `/matters` aggregator + `/matters/:id` (#859).
  - **Vault**: `/vault` three-pane Obsidian view (#858) +
    `getVaultTitleIndex` Wasp query wired to a Markdown live wikilink
    resolver (#873).
  - **Instincts/Decisions/Chores/Connections/Channels**: `/instincts`
    restyle (Asking/Confirming/Acting) (#860), `/decisions` audit feed
    with HANDLED/HELD/ASKED filters (#861), `/chores` + `/chores/:slug`
    restyle (#862), `/connections` Composio catalogue restyle (#863),
    `/channels` live email + phone + vexa + omi cards with Slack/Telegram
    "Soon" (#864).
  - **Tools/Claude**: `/tools` gateway allowlist viewer restyle (#865),
    `/claude` MCP setup + Skill + secrets (#866).
  - **Study**: unified back office at `/study` for settings, credentials,
    API keys, audit, ledger, theme (#867 #868) — `/back-office` and
    `/dashboard/{settings,credentials,api-docs}` now redirect into `/study`.
  - **Admin**: Alfred Black tokens + typography applied (no IA changes)
    (#869).
  - **e2e tests**: updated for the new canonical URL map; removed the
    obsolete `/demo-app` test file; deleted unreferenced legacy landing
    components (Hero, Overwhelm, KnowledgeGraph, WhatIsAlfred,
    LifeWithAlfred, EarlyAccess, ParticleCanvas, GraphCanvas) (#870).
  - **Preview safety**: `WASP_DISABLE_JOBS` env switch for preview-mode
    worker safety, `WRITE_BLOCK_TENANT_OPS` denylist middleware in
    `tenantProxy`, `deploy-preview.yml` workflow for the
    `feat/alfred-black-1.0` branch.

- `packages/ctrl` — three new tenant API endpoints powering the redesign:
  - `GET /api/v1/matters` + `GET /api/v1/matters/:id` (#859)
  - `GET /api/v1/brief/today` (#857)
  - `GET /api/v1/vault/index` with 60s tenant cache (#873)

- `deploy/` — `CUTOVER.md` runbook for the Alfred Black 1.0 rollout.

### URL Canonicalisation

All legacy `/dashboard/*` paths now redirect to canonical names. See
`CLAUDE.md` for the full map. `/triage` redirects to `/desk` and the
`/states` route is dropped.

---

## [2026.04.11] — 2026-04-11

### Connected Apps — Composio Integration Marketplace

- **1000+ app catalog** (#387): browsable toolkit catalog with search and category filtering, cached 1h server-side. Browse Gmail, Notion, Slack, GitHub, Stripe, Linear, and 1000+ more via Composio.
- **OAuth popup connect flow** (#387, #391): one-click app connection via Composio-managed OAuth. Credentials stored server-side at Composio — never touch the tenant VPS.
- **`composio_execute` gateway tool** (#391): single tool for executing any Composio action. The agent calls `composio_execute action="GOOGLECALENDAR_CREATE_EVENT" arguments={...}` instead of 300+ individual tools polluting the context window.
- **Auto-generated skill files** (#391): each connected app gets a `alfred-composio-{toolkit}/SKILL.md` with action tables, type classification, and usage examples. Written to both main and workers workspaces.
- **Auto-config on connect** (#391, #393): `POST /api/v1/integrations/:id/auto-config` creates the recommended stream, Temporal schedule, skill file, and gateway entry in one call. No manual configuration needed.
- **Capabilities classification** (#387): actions classified as stream (read verbs: FETCH, LIST, GET) or tool (write verbs: SEND, CREATE, UPDATE, DELETE) using heuristic verb matching.
- **Disconnect cleanup** (#390, #391): removes streams, schedules, skills, and gateway entries when an app is disconnected. Removes `composio_execute` from gateway if no connections remain.
- **Recommended apps section** (#397): IntegrationsPage shows Gmail, Notion, Calendar, GitHub as recommended if not yet connected via Composio.
- **Legacy stream migration** (#397): connecting an app via Composio auto-disables the legacy OAuth stream for that source (status: `migrated-to-composio`).

### Zero-LLM Stream Ingest

- **Pure Python vault record templates** (#394): every stream event creates a vault `event/` record using per-source templates (calendar, email, github, slack, notion, payment, generic). Zero LLM calls at ingest time.
- **EventProcessor rewrite** (#394): replaces Tier 1 (inbox → curator → 4+ LLM calls) with direct vault record creation. System-inbox uploads still route to curator. 97% reduction in LLM calls.
- **Stream log for all events** (#394): every non-garbage event gets a one-line entry in `memory/stream-log-YYYY-MM-DD.md`, not just Tier 2 events.

### Hourly Batch Enrichment

- **HourlyEnrichmentWorkflow** (#395): collects all vault event records with `enrichment_status: pending`, sends ONE batched clerk LLM call per 200 records. Extracts entities, topic tags, related matters, action items, priority.
- **Entity auto-creation** (#395): discovers new people/orgs from enrichment and creates vault records.
- **Wikilink injection** (#395): adds `[[person/Name]]` and `[[org/Name]]` links to enriched event bodies.
- **Schedule**: `al-hourly-enrichment`, every 1 hour. Cost: ~25 LLM calls/day regardless of event volume (was 800+).

### Incremental Stream Sync

- **`pull_mode` field** (#396): streams support `snapshot` (blind fetch), `append` (after timestamp), `sync` (backfill + sync token). Unknown apps default to `snapshot`.
- **`SYNC_CONFIGS` per-action mapping** (#396): configures backfill args, incremental args, cursor extraction, and time windows per Composio action. Placeholder-based templates with recursive resolution.
- **Google Calendar sync mode** (#396, #400): uses `nextSyncToken` for true delta sync. First run backfills 30 days past + 90 days future. Subsequent runs fetch only created/modified/deleted events (0-3 per poll instead of 250).
- **Gmail/GitHub/Notion append mode** (#396): time-based incremental filtering using `last_pull_at`.
- **Sync token reset handling** (#396): detects 410 Gone (stale token), auto-triggers full backfill.
- **Composio parser status detection** (#396): detects `status: cancelled` in Calendar sync responses for delete handling.

### Onboarding — Connect Your Apps

- **StepConnectApps** (#398): replaces Gmail-only onboarding step 3 with multi-app Composio connection. Gmail (required) + Google Calendar (recommended) + optional third app from 1000+ catalog.
- **Mini catalog modal** (#398): search-enabled app picker for the optional third connection during onboarding.
- **Post-onboarding finalization** (#399): after the pipeline completes and brief is ready, `finalizeComposioConnections` auto-configs all Composio connections (streams, skills, legacy migration).

### Composio Stream Pulling

- **Composio parser** (#388): normalizes Composio SDK responses into ParsedEvents. Handles nested data wrappers, email/page/payment type classification, ID extraction.
- **`composio_pull` activity** (#388): executes Composio actions via SDK with `dangerously_skip_version_check` (#392) and per-action default arguments (#392).
- **StreamPuller Composio branch** (#388): when stream config has `composio_action`, routes through `composio_pull` instead of HTTP pull.

### Infrastructure & Operations

- **Workers model fix**: all 5 worker agents (curator, janitor, distiller, surveyor, clerk) switched from GPT-5.4 to `google/gemini-3.1-flash-lite-preview` to prevent quota exhaustion.
- **Compose template**: ctrl-api now mounts `openclaw-workers` volume for cross-workspace skill writes.
- **TOOLS.md**: updated with Connected Apps section documenting `ctrl_composio_execute`.
- **init/entrypoint.sh**: comment documenting `composio_execute` is managed dynamically, not in static allowlist.

### Packages Changed

- `packages/ctrl` — 7 new integration routes, `composio_execute` tool dispatch, auto-config endpoint, SYNC_MODE mapping, `pull_mode` schema extension
- `packages/learn` — composio parser, composio_pull activity, zero-LLM stream_vault templates, hourly enrichment workflow, incremental sync engine, build_sync_args activity
- `packages/saas` — IntegrationsPage, StepConnectApps onboarding, finalizeComposioConnections, 12 new Wasp operations
- `packages/openclaw` — TOOLS.md update, init entrypoint comment

---

## [2026.04.09] — 2026-04-09

### Chore System

- **Bespoke chore generation** (S4, #370): Opus generates custom Python Temporal workflows per-tenant, validates statically, smoke-tests in subprocess sandbox, deploys to `/alfred-data/user-chores/`.
- **Chore quarantine** (#370): first 3 runs of every generated chore are dry-run (no notifications, no vault writes). Auto-releases after 3 clean runs.
- **Chore source audit** (#370, #371): ChoreDetailPage renders the full Python source + dependency audit showing which activities the workflow imports and what data each depends on.
- **Per-chore schedule emission** (#372): generated chores emit their own cron schedule in a header comment.

### Opus-Authored Packs (Plan B)

- **Matter pack** (#342): Opus generates rich matter records with detailed bodies.
- **Errand pack** (#344): Opus generates actionable errands linked to matters.
- **Instinct pack** (#346): Opus generates instinct records with confidence scores.

### Chores UI (Plan C)

- **Chores tab** (#349, #351, #353): user-facing chore management with pause/resume/trigger/delete, `user_facing_description` field, detail page.

### Intelligence Streamlining (Plan E)

- **5-tab layout** (#367): Inbox, Matters, Errands, Chores, Activity.

### Learning Pipeline Fix (Plan F)

- **Observation filename collisions** (#359): resolved.
- **Learning zeros bug** (#360): fixed.

### Main Agent Tool Surface

- **45-tool allowlist** (#373): `gateway.tools.allow` merged up from 10 to 45 tools at provision time.
- **Workspace template system** (#373): `packages/openclaw/workspace-template/` with 4 alfred-* skills + TOOLS.md capability reference.

### Progressive Autonomy Pipeline

- **Observation hook** (#375): captures user instructions from conversations.
- **Approval flow** (#377, #380): wire approval for execution tasks.
- **Instinct execution schema** (#374): add execution schema to instinct prompts.
- **Ephemeral subagents** (#378, #385): spawn scoped agents on openclaw-workers for task execution.
- **Composio tool belt** (#376, #384): initial Composio SDK integration for tool readiness checking.

---

## [0.2.0] — 2026-03-22

### ✨ Features

- **Curator ↔ alfred-learn filing loop** (PR #3): Judgment workflow now routes
  via `POST /api/v1/curator/route-and-process`, injecting routing metadata as
  YAML frontmatter. Falls back to raw `fs.renameSync` when Curator is unavailable.
  Observations are enriched with Curator results (entities created/linked).

- **Inbox as a stream** (PR #4): New `system-inbox` stream type unifies all
  input paths. `POST /api/v1/streams/inbox/scan` scans the filesystem inbox and
  creates stream events. All inputs now converge through
  streams → EventProcessor → Judgment → Curator.

- **ctrl API in Docker compose** (PR #6): The `ctrl-api` service now runs as a
  `node:22-slim` container inside the same Docker network as alfred-learn and
  alfred-worker. Fixes the long-standing bug where alfred-learn could never
  reach the ctrl API (systemd bound to `127.0.0.1`, unreachable from Docker
  bridge). `deploy-api` auto-migrates existing tenants.

- **Clerk via OpenClaw sessions_spawn**: Classification now spawns a full
  OpenClaw subagent with tool access (read, pdf, exec). The Clerk can actually
  inspect inbox files — PDFs, documents, etc. — instead of classifying from
  filename/metadata alone. Uses `sessions_spawn(sandbox=inherit)` +
  `sessions_history` polling pattern.

- **ctrl-api vault/records accepts raw content**: `POST /api/v1/vault/records`
  now accepts a `content` field and writes the markdown file directly to the
  vault filesystem, instead of calling the `alfred vault create` CLI (which
  doesn't support raw content).

### 🐛 Bug Fixes

- **Provisioner fixes** (PR #5): Bootstrap script retries containers stuck in
  `Created` state (uses `jq`), `exit 1` on failure, numeric UID chown for SSH
  keys.

- **VaultClient auth**: Added `AAS_API_KEY` as `Authorization: Bearer` header
  to all ctrl-api requests. Previously all calls returned 401.

- **Gateway token sync**: Provisioner and `deploy-api` now write the correct
  gateway auth token to `.gateway-token` (was writing OpenClaw's internal
  auto-generated token instead of the configured one).

- **Robust JSON extraction**: LLM responses wrapped in markdown fences or with
  extra prose text are now handled gracefully (try direct parse → strip code
  fences → find first/last braces).

- **OpenClaw crash prevention**: `subagents.allowAgents` must go on
  `agents.list[].subagents`, NOT `gateway.tools` or `agents.defaults.subagents`.
  Both wrong locations crash OpenClaw with "Unrecognized key".

- **Activity timeout**: `classify_event` Temporal activity timeout bumped from
  60s to 300s to accommodate large LLM inference (e.g., Qwen 35B on local GPU).

- **OpenClaw config for cross-agent access**: Added `tools.sessions.visibility=all`
  and `tools.agentToAgent.enabled=true` to config template so sessions_spawn
  polling works across agent boundaries.

### 🏗️ Architecture

- **Model-agnostic Clerk**: The Clerk no longer hardcodes any model. It spawns
  via OpenClaw `sessions_spawn`, which uses whatever model the `learn-clerk`
  agent is configured with in `openclaw.json`. Tenants can use any provider:
  OpenRouter (default free tier), DGX Spark Ollama, Anthropic, etc.

- **Removed CLERK_BASE_URL/CLERK_MODEL**: Direct LLM calling bypassed OpenClaw
  entirely. Now all inference goes through OpenClaw, giving the Clerk full tool
  access and model-agnostic routing.

### 📦 Packages Changed

- `packages/learn` — Clerk rewrite, config cleanup, timeout fixes
- `packages/ctrl` — ctrl-api Docker service, vault write endpoint, provisioner fixes,
  OpenClaw config template updates

### ⚙️ Configuration

**New tenants** get the updated config automatically via the provisioner template.

**Existing tenants** need these additions to `openclaw.json`:

```json
{
  "tools": {
    "sessions": { "visibility": "all" },
    "agentToAgent": { "enabled": true, "allow": ["*"] }
  },
  "gateway": {
    "tools": {
      "allow": ["sessions_send", "sessions_spawn", "sessions_history", "sessions_list"]
    }
  }
}
```

**Default model** (template): `openrouter/meta-llama/llama-3.3-70b-instruct:free`
Tenants can override per-agent models in their `openclaw.json`.

---

## [0.1.0] — 2026-03-21

Initial release with:
- Temporal-based learning workflows (EventProcessor, SessionTracker, Learning,
  Reflection, Judgment, DailyDigest)
- OpenClaw integration for LLM inference
- Vault CRUD via ctrl API
- SaaS frontend with Stripe billing
- Multi-tenant provisioning on Hetzner Cloud
- LUKS-encrypted data volumes per tenant
