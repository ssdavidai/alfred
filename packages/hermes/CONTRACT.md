# CONTRACT.md — alfred-openclaw

> What this package provides and what it requires.
> Update this file when changing Dockerfiles, volumes, or gateway configuration.

---

## Provides

### Three Docker Images

**1. `ssdavidai00/alfred-openclaw` — AI Gateway**

OpenClaw gateway server exposing HTTP and WebSocket interfaces.

| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `GET /health` | HTTP | Health check |
| `POST /tools/invoke` | HTTP | Tool invocation |
| WebSocket at :18789 | WS | User/device agent connections |

Built from: `dockerfiles/openclaw.Dockerfile`
Base: `node:22-bookworm` + OpenClaw (git clone, unpinned)

**2. `ssdavidai00/alfred-worker` — Vault Worker**

Alfred daemon process — starts agent runs on the Hermes runtime via the `openclaw-wrapper` script (Python). Runs vault tools (curator, janitor, distiller).

| Connection | Address | Protocol |
|-----------|---------|----------|
| Hermes runtime | http://hermes:18790 | HTTP (Hermes `/v1/runs` API, bound directly on the canonical port) |

The `openclaw-wrapper` (filename kept for backward-compatible config/Dockerfile references) calls Hermes `POST /v1/runs` to start a run, then polls `GET /v1/runs/{id}` for the result — the OpenClaw `sessions_spawn`/`sessions_history` `/tools/invoke` contract was retired in Phase 2, and the hermes-shim that briefly fronted the Hermes API server was retired in issue #40. The `alfred` and `hermes` containers share the `/alfred-data` volume so the wrapper can read prompt files and curator manifest files written by the alfred daemons.

Built from: `dockerfiles/alfred.Dockerfile`
Base: `python:3.11-slim-bookworm` + Node.js 22 + `openclaw-wrapper` + Alfred (git clone, unpinned)

**3. `ssdavidai00/alfred-init` — Init Container**

One-shot container that runs before all others. Idempotent setup:

1. Scaffold vault from template (`rsync` from alfred repo)
2. Ensure all entity directories exist (observation, intuition/instincts, reflection, etc.)
3. Copy skills to OpenClaw workspace (vault-curator, vault-janitor, vault-distiller)
4. Generate `config.yaml` for Alfred
5. Auto-generate gateway token if not provided
6. Create intuition index record
7. Fix permissions (uid 1000 for node user)

Built from: `init/Dockerfile`
Base: `python:3.11-slim-bookworm` + Alfred repo (git clone, unpinned)

---

## Requires

### Docker Runtime

All three images run as Docker containers within the tenant Docker Compose stack.

### Volumes

| Volume Path (host) | Container Mount | Image | Access |
|-------------------|----------------|-------|--------|
| `/mnt/encrypted/vault` | `/vault` or `/home/node/.openclaw/workspace/vault` | all three | read/write |
| `/mnt/encrypted/openclaw` | `/home/node/.openclaw` or `/openclaw-state` | openclaw, init, alfred | read/write |
| `/mnt/encrypted/alfred` | `/alfred-data` or `/app/data` | all three | read/write |
| `shared_tmp` (Docker volume) | `/tmp` | openclaw, alfred | read/write |

### Environment Variables

**OpenClaw gateway:**

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENCLAW_GATEWAY_TOKEN_FILE` | yes | — | Path to gateway auth token |
| LLM provider key (via `.env`) | yes | — | `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` |

**Alfred worker:**

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENCLAW_GATEWAY_URL` | yes | `http://openclaw:18789` | OpenClaw HTTP gateway address |
| LLM provider key (via `.env`) | yes | — | Passed through to OpenClaw |

**Init container:**

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENCLAW_GATEWAY_TOKEN` | no | (auto-generated) | Pre-set gateway token |

### Upstream Dependencies (unpinned)

| Dependency | Source | Pinning Status |
|-----------|--------|---------------|
| OpenClaw | `git clone --depth 1 https://github.com/openclaw/openclaw.git` | **Unpinned** (HEAD of default branch) |
| Alfred (vault CLI) | vendored in-repo at `packages/alfred-vault` (COPYd into the alfred-worker + init images at build time) | **In-repo** (no external fetch) |

### Consumed By

| Consumer | Connection | What It Uses |
|----------|-----------|-------------|
| `alfred` (worker) | http://hermes:18790 | Hermes `/v1/runs` API (workers profile) |
| `alfred-learn` | http://hermes:18789 / :18790 | Hermes `/v1/runs` API (main / workers profile) |
| Users (via Cloudflare Tunnel) | https://{subdomain}.{domain} → :18789 | Hermes `/v1` API (main profile) |
