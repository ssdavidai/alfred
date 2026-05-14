# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

**alfred-platform** is the monorepo for Alfred Black's private infrastructure. It consolidates four previously separate repos into a single repository with path-filtered CI. Each package has its own build system — no monorepo tooling (no turborepo, nx, pnpm workspaces).

The public `alfred` Python repo (vault workers, PyPI `alfred-vault`) remains independent at `ssdavidai/alfred`.

## Structure

```
alfred-platform/
├── packages/
│   ├── saas/       ← alfred-saas (Wasp app, billing, dashboard, tenant proxy)
│   ├── ctrl/       ← alfred-ctrl (Node.js TUI/CLI/API for fleet management)
│   ├── learn/      ← alfred-learn (Python Temporal intelligence layer)
│   └── openclaw/   ← alfred-openclaw (Dockerfiles, compose, init scripts)
├── deploy/         ← SaaS host infrastructure (Caddyfile, docker-compose, cloud-init)
└── Makefile
```

## Build Commands

```bash
make build-ctrl       # cd packages/ctrl && npm ci && npm run build
make dev-ctrl         # cd packages/ctrl && npm run dev
make build-saas       # cd packages/saas/app && wasp build
make test-learn       # cd packages/learn && pip install -r requirements.txt && pytest tests/ -v
make build-learn      # cd packages/learn && docker build -t ssdavidai00/alfred-learn:dev .
make build-openclaw   # cd packages/openclaw && docker build -f dockerfiles/openclaw.Dockerfile -t ssdavidai00/alfred-openclaw:dev .
```

## CI Workflows

All in `.github/workflows/`, triggered by path filters on push to `main`:

| Workflow | Trigger paths | What it does |
|----------|--------------|--------------|
| `deploy-saas.yml` | `packages/saas/**`, `packages/ctrl/**`, `deploy/**` | Build Wasp app, rsync to SaaS host, restart |
| `deploy-ctrl.yml` | `packages/ctrl/**` | Build + rsync ctrl to SaaS host, deploy API to tenants |
| `build-learn.yml` | `packages/learn/**` | Test + build Docker image → DockerHub |
| `build-openclaw.yml` | `packages/openclaw/**` | Build Docker image → DockerHub |

## Deploy Batching Policy

- One PR per logical change. Keep bug fixes and features isolated so each deploy maps cleanly to a single intent.
- After pushing a change that triggers CI, wait for the deploy workflow to complete before pushing the next change.
- Verify the deploy worked (e.g., with `scripts/smoke-test.sh` or a manual check) before moving on to another change.
- If a deploy breaks, revert the specific breaking change instead of stacking rapid follow-up fixes on top of it.
- AI agent sessions must not batch multiple unrelated fixes into rapid-fire pushes.

## Architecture (Three Planes)

**SaaS Plane** (`packages/saas`): Wasp 0.19 + Prisma + Polar.sh payments. Runs on a single Hetzner VM. Handles auth, billing, provisioning orchestration, and proxies all API calls to tenants via Tailscale.

**Control Plane** (`packages/ctrl`): Zero-dependency Node.js 22 app with dual role — CLI tool for Hetzner VM provisioning AND tenant API (systemd service at `:3100`). Uses SQLite. Runs on every tenant VPS.

**Data Plane** (tenant Docker stack via `packages/openclaw`): Four containers per tenant — `alfred` (vault workers), `openclaw` (AI gateway :18789), `temporal` (workflow engine :7233), `alfred-learn` (intelligence layer). All bind to localhost; external access only via Tailscale Serve.

Every subscriber gets a dedicated Hetzner VPS (cx53). No shared infrastructure between tenants.

## Request Flow

User → `alfred.black` SaaS proxy → SHA-256 key auth → AES-256-GCM decrypt → Tailscale WireGuard → tenant `alfred-ctrl :3100` → Docker services

---

## Package: ctrl

### Overview

alfred-ctrl is a fleet management TUI, CLI, and API server for provisioning and managing Alfred instances on Hetzner Cloud. Three interfaces:
1. **TUI** — interactive Ink (React for CLI) dashboard
2. **CLI** — Commander.js subcommands for scripting/automation
3. **API server** — HTTP API consumed by the SaaS frontend (port 3100)

### Build & Run

```bash
cd packages/ctrl
npm run build      # Bundle with esbuild → dist/index.mjs
npm run dev        # Watch mode
npm start          # Launch TUI dashboard
```

No tests, linter, or CI configured. Targets Node 22 (uses `node:sqlite`). Pass `--experimental-sqlite` inside Docker with Node v22.12.0.

### Build System

esbuild bundles everything into a single `dist/index.mjs`. `.sql` and `.njk` files loaded as text strings via esbuild loader config (`build.mjs`). `ssh2` is external (native addon).

### Architecture

- `src/index.tsx` — TUI/CLI entry point
- `src/api/` — HTTP API (server.ts, auth.ts, standalone.ts, routes/)
- `src/infra/` — Hetzner, SSH, Tailscale, Cloudflare clients
- `src/db/` — SQLite schema + queries
- `src/templates/` — Nunjucks templates (cloud-init, docker-compose, etc.)

### Environment Variables

**TUI/CLI:** `HETZNER_API_TOKEN`, `TAILSCALE_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN`
**API server:** `AAS_API_KEY`, `AAS_PORT` (default 3100), `AAS_HOST` (default 127.0.0.1)

---

## Package: learn

### Overview

Python + Temporal Docker container providing Alfred Black's self-improving intelligence layer.

### Key Constraints

- Python 3.12, temporalio SDK, httpx, pyyaml — no other dependencies without justification
- All LLM calls go through OpenClaw gateway (clerk.py) — NEVER direct Anthropic API
- All vault writes go through alfred-ctrl API (vault_client.py) — NEVER direct filesystem writes
- Terminology: observation (not cognition), instinct (not skill), intuition (not skill-graph), reflection (not synthesis), judgment (not router), discretion (not confidence gate), clerk (not subken)

### Read First

`packages/learn/docs/SPEC.md` — full production spec, source of truth.

### 6 Workflows (Temporal task queue: `alfred-learn`)

1. EventProcessorWorkflow — every 2 min
2. SessionTrackerWorkflow — every 5 min
3. DailyDigestWorkflow — daily 6pm
4. LearningWorkflow — every 5 min
5. ReflectionWorkflow — daily 2am
6. JudgmentWorkflow — every 2 min

### Environment Variables

`TEMPORAL_HOST=temporal:7233`, `OPENCLAW_GATEWAY_URL=http://openclaw:18789`, `VAULT_PATH=/vault`, `TASK_QUEUE=alfred-learn`

---

## Deployment

**VM deployment paths** (unchanged from pre-monorepo):
- SaaS host: `/opt/alfred-saas/` (Wasp app), `/opt/alfred-saas/alfred-ctrl/` (ctrl)
- Tenant: `/opt/alfred/compose/` (Docker stack)

**Docker image tags** (unchanged): `ssdavidai00/alfred-openclaw:latest`, `ssdavidai00/alfred-learn:latest`

**Deploy SaaS host infra:** Files in `deploy/` — Caddyfile, docker-compose.yaml, cloud-init.yaml, clickhouse configs, systemd service.

---

## Engineering References

- `TOPOLOGY.md` — service connection map (ports, protocols, env vars)
- Each package has a `CONTRACT.md` — what it provides and requires
- `scripts/smoke-test.sh` — post-deploy tenant verification

---

## Alfred Black 1.0 — Vocabulary, Rituals, URLs

### Canonical Home

The canonical home is now **`/desk`** (was `/dashboard`). `/dashboard` is a
thin back-compat redirect to `/desk`; all the legacy `/dashboard/*` sub-routes
have been renamed to vocabulary the redesign actually uses.

### Vocabulary (the surface a principal sees)

`Desk · Brief · Vault · Matters · Instincts · Decisions · Chores · Connections · Channels · Tools · Claude · Study · Household · Staff`

- **Desk** (`/desk`) — today's decision queue + audit ledger.
- **Brief** (`/brief`) — the daily letterpress brief.
- **Vault** (`/vault`) — three-pane Obsidian view of the principal's vault.
- **Matters** (`/matters`, `/matters/:id`) — aggregator across the household.
- **Instincts** (`/instincts`) — Asking / Confirming / Acting tiers.
- **Decisions** (`/decisions`) — audit feed with HANDLED / HELD / ASKED filters.
- **Chores** (`/chores`, `/chores/:slug`) — the principal's recurring work.
- **Connections** (`/connections`) — Composio catalogue.
- **Channels** (`/channels`) — email + phone + vexa + omi cards.
- **Tools** (`/tools`) — gateway allowlist viewer.
- **Claude** (`/claude`) — MCP setup + Skill + secrets.
- **Study** (`/study`) — the unified back office (settings, credentials, API
  keys, audit, ledger, theme).
- **Household** (`/household`) — RULES.md editor + chores.
- **Staff** (`/staff`) — the small staff of specialists, marketing surface.

### Onboarding Ritual

Onboarding is a sequential ritual, not a single page:

```
/awaken → /reading-the-room → /verify → /soul → /composing → /preparing → /first-brief → /desk
```

Each step has its own page and writes its own state into the workspace.
`/onboarding` redirects to `/awaken`.

### URL Canonicalisation Map

All legacy `/dashboard/*` paths now redirect to canonical names:

| Legacy path | Canonical | Notes |
|-------------|-----------|-------|
| `/dashboard` | `/desk` | thin redirect |
| `/dashboard/vault` | `/vault` | |
| `/dashboard/integrations` | `/connections` | |
| `/dashboard/intuition` | `/instincts` | |
| `/dashboard/tasks` | `/chores` | |
| `/dashboard/tools` | `/tools` | |
| `/dashboard/command-center/steward-feed` | `/decisions` | |
| `/dashboard/settings` | `/study#settings` | unified back office |
| `/dashboard/credentials` | `/study#credentials` | unified back office |
| `/dashboard/api-docs` | `/study#api-keys` | unified back office |
| `/back-office` | `/study` | unified back office |
| `/onboarding` | `/awaken` | ritual entry |

The `/states` route is dropped. `/triage` redirects to `/desk`.

### Validation Strategy: Parallel Preview

The Alfred Black 1.0 cutover used a parallel-preview validation strategy:
the redesigned app shipped to **`preview.alfred.black`** built from the
`feat/alfred-black-1.0` branch with `WASP_DISABLE_JOBS=true` (Wasp jobs
suppressed on the preview host) and a tenant-proxy denylist
(`WRITE_BLOCK_TENANT_OPS_DENYLIST`) blocking write operations against real
tenants. Production stayed on `alfred.black` until the preview was
exercised end-to-end. See `deploy/CUTOVER.md` for the runbook.
