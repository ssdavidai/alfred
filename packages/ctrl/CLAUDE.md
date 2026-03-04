# CLAUDE.md

> Part of [alfred-platform](../../CLAUDE.md) monorepo.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

alfred-ctrl is a fleet management TUI, CLI, and API server for provisioning and managing Alfred instances on Hetzner Cloud. It has three interfaces:
1. **TUI** — interactive Ink (React for CLI) dashboard
2. **CLI** — Commander.js subcommands for scripting/automation
3. **API server** — HTTP API consumed by the SaaS frontend (alfred-saas)

Local state lives in SQLite (`data/alfred-ctrl.db`) using Node 22's built-in `node:sqlite`.

## Build & Run

```bash
npm run build      # Bundle with esbuild → dist/index.mjs
npm run dev        # Watch mode (rebuilds on change)
npm start          # Launch TUI dashboard

# CLI (requires build first)
node dist/index.mjs list              # List instances
node dist/index.mjs provision <name>  # Provision new instance
node dist/index.mjs health            # Run health checks
node dist/index.mjs deploy-api <name> # Deploy API to instance

# API server (used by SaaS, runs on tenant instances)
node dist/api/standalone.mjs          # Start API server on :3100
```

No tests, linter, or CI are configured. The project targets Node 22 (uses `node:sqlite`). When running inside Docker containers with Node v22.12.0, pass `--experimental-sqlite`.

## Build System

esbuild bundles everything into a single `dist/index.mjs`. Key build details:
- `.sql` and `.njk` files are loaded as text strings via esbuild's loader config (`build.mjs`)
- `src/loaders.d.ts` provides TypeScript ambient declarations for these imports
- `ssh2` is external (native addon); optional deps like `react-devtools-core` and `yoga-wasm-web` are stubbed
- A banner injects `createRequire` for CJS compatibility in the ESM bundle
- Path aliases: `@/*` maps to `src/*` (in tsconfig, but esbuild handles resolution via bundling)

## Architecture

### Three Interfaces

`src/index.tsx` is the TUI/CLI entry point. With no subcommand it renders the Ink TUI. Commander.js subcommands bypass the TUI entirely. `src/api/standalone.ts` is a separate entry point for the HTTP API server.

### TUI (Ink/React)

- `src/app.tsx` — root component, manages screen state via React Context (`src/store.ts`)
- Screens: `dashboard`, `provision`, `detail`, `logs` — selected components render based on `screen` state
- React hooks in `src/hooks/` wrap infra operations for TUI use (`useProvision`, `useHealth`, `useInstances`, `useSSH`)
- Health monitor starts on TUI mount, polls instances periodically via SSH

### API Server (`src/api/`)

HTTP API running on tenant instances (port 3100), consumed by the SaaS dashboard frontend. Authenticated via `AAS_API_KEY` header.

- `server.ts` — lightweight HTTP router with path-to-regex matching, CORS, JSON body parsing
- `auth.ts` — API key authentication middleware
- `standalone.ts` — standalone entry point (loads .env, starts HTTP server)
- `routes/` — route handlers:
  - `vault.ts` — CRUD operations on vault records
  - `agents.ts` — per-agent model configuration (reads/writes OpenClaw config)
  - `credentials.ts` — manage API keys (.env file on tenant)
  - `workers.ts` — start/stop/restart Docker containers
  - `devices.ts` — OpenClaw device management
  - `admin.ts` — instance admin operations
  - `openclaw.ts` — OpenClaw gateway status/config
  - `logs.ts` — container log retrieval
  - `workflows.ts` — Temporal workflow management

All routes use `/api/v1/` prefix (e.g., `/api/v1/vault/schema`, `/api/v1/admin/credentials`).

### Infrastructure Layer (`src/infra/`)

- `hetzner.ts` — typed Hetzner Cloud API client (singleton). Creates/deletes servers, volumes, SSH keys, firewalls. All resources labeled `managed-by: alfred-ctrl`
- `provisioner.ts` — multi-step provisioning orchestrator. Steps: generate keypair → upload SSH key → ensure firewall → create volume → render cloud-init → create server → wait for cloud-init → upload secrets via SSH → upload docker-compose → start containers → bootstrap OpenClaw + Tailscale → backup LUKS key → health check
- `ssh.ts` — SSH operations via `ssh2`: exec, upload (SFTP), download, waitForFile (polling)
- `keys.ts` — Ed25519 keypair generation, stored in `data/ssh_keys/<instance_id>/`
- `firewall.ts` — ensures a shared "SSH + ICMP only" firewall exists
- `tailscale.ts` — Tailscale API for auth key generation, SSH-based connection verification
- `cloudflare.ts` — Cloudflare Tunnel and DNS management (tunnel creation, DNS records, Access policies)

### Database (`src/db/`)

- `schema.sql` — three tables: `instances`, `health_checks`, `events`
- `index.ts` — singleton `DatabaseSync` connection, auto-creates `data/` directory
- `queries.ts` — typed query functions (CRUD for instances, health checks, events)

### Monitoring (`src/monitoring/`)

- `health.ts` — periodic SSH-based health checks. Runs `healthcheck.sh` on instances, classifies status (ok/degraded/down/unreachable), tracks healthy SHAs for rollback
- `alerts.ts` — webhook alerts on health status changes (Slack or Discord format)

### Types & Constants (`src/data/`)

- `types.ts` — all TypeScript types: `Instance`, `Screen`, `InstanceConfig`, `ProvisioningState`, `ProvisioningStep`, `HealthStatus`, `HealthCheck`, `Event`, `EventType`, `InstanceStatus`, `ContainerStatus`
- `constants.ts` — `DEFAULTS` (serverType, location, paths, timeouts), `HETZNER_API_BASE`, `LABEL_SELECTOR`, status color maps, keybinding hints per screen

### Templates (`src/templates/`)

Nunjucks templates imported as strings at build time:
- `cloud-init.yaml.njk` — server bootstrap (user creation, packages, LUKS setup)
- `docker-compose.yaml.njk` — Alfred service stack
- `bootstrap-openclaw.sh.njk` — OpenClaw + Tailscale setup script
- `cloudflared-config.yaml.njk` — Cloudflare Tunnel ingress rules

### Data Files (not in source control)

- `data/alfred-ctrl.db` — SQLite database
- `data/ssh_keys/<id>/id_ed25519` — per-instance SSH keypairs
- `data/ssh_keys/<id>/luks.key` — backed-up LUKS encryption keys
- `data/ssh_keys/<id>/restic.env` — backed-up restic credentials

## Deployment Context

This repo is used in two contexts:
1. **Locally** — TUI/CLI for fleet management (provision, destroy, health checks)
2. **On tenant instances** — API server (`standalone.ts`) runs inside Docker, serving the SaaS dashboard's backend requests. The SaaS frontend (alfred-saas repo) proxies dashboard API calls to each tenant's alfred-ctrl API via Tailscale.

The SaaS control plane at 138.199.236.244 also runs an alfred-ctrl instance for provisioning. DB paths inside containers use `/app/alfred-ctrl/` (not host paths).

## Security Model

- Secrets (API keys, LUKS passphrases) are NEVER in cloud-init `user_data` (readable via Hetzner metadata API). They are uploaded post-provision via SSH
- Firewall allows only SSH (22) and ICMP inbound; all services bind to localhost
- External access to instances is via Tailscale mesh and Cloudflare Tunnel only
- LUKS2 encryption on data volumes with auto-generated passphrases
- Ed25519 SSH keys only, generated per-instance
- See `SECURITY.md` for a full audit with 25 findings and remediation priorities

## Environment Variables

Set in `.env` (auto-loaded without dotenv). See `.env.example` for all options.

**TUI/CLI:** `HETZNER_API_TOKEN` (required), `TAILSCALE_API_KEY` (required), `OPENROUTER_API_KEY`, `HETZNER_S3_*` (for restic backups), `ALERT_WEBHOOK_URL`/`ALERT_WEBHOOK_TYPE`, `CLOUDFLARE_API_TOKEN`.

**API server:** `AAS_API_KEY` (required), `AAS_PORT` (default 3100), `AAS_HOST` (default 127.0.0.1).
