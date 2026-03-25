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

Alfred daemon process — spawns OpenClaw agents via the gateway's HTTP API using the `openclaw-wrapper` script (Python). Runs vault tools (curator, janitor, distiller).

| Connection | Address | Protocol |
|-----------|---------|----------|
| OpenClaw gateway | http://openclaw:18789 | HTTP (`POST /tools/invoke`) |

The `openclaw-wrapper` replaces the previous approach of running a local OpenClaw CLI over WebSocket. It calls `sessions_spawn` to start an agent, then polls `sessions_history` for the result. Both the `alfred` and `openclaw` containers share a `shared_tmp` Docker volume at `/tmp` so the wrapper can read prompt files written by the alfred daemons.

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
| Alfred | `git clone --depth 1 https://github.com/ssdavidai/alfred.git` | **Unpinned** (HEAD of default branch) |

### Consumed By

| Consumer | Connection | What It Uses |
|----------|-----------|-------------|
| `alfred` (worker) | http://openclaw:18789 | HTTP gateway (`POST /tools/invoke` → `sessions_spawn` / `sessions_history`) |
| `alfred-learn` | http://openclaw:18789 | HTTP gateway (`POST /tools/invoke` → `sessions_spawn` / `sessions_history`) |
| Users (via Cloudflare Tunnel) | https://{subdomain}.{domain} → :18789 | HTTP/WS gateway |
