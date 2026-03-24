# TOPOLOGY.md — Service Connection Map

> Machine-readable map of every service-to-service connection in Alfred Black.
> Source of truth for ports, protocols, and env vars across all planes.

---

## SaaS Host (deploy/)

Single Hetzner VM running the SaaS application and analytics.

| Service | Bind Address | Protocol | Purpose |
|---------|-------------|----------|---------|
| Caddy | 0.0.0.0:80/443 | HTTPS | Reverse proxy for all SaaS domains |
| Wasp app (`alfred-saas`) | 127.0.0.1:3000 | HTTP | SaaS web app (auth, billing, dashboard) |
| Plausible | 127.0.0.1:8000 | HTTP | Analytics dashboard |
| PostgreSQL | 127.0.0.1:5432 | TCP | SaaS database (`alfred_saas`) |
| ClickHouse | (no host port) | HTTP | Plausible events (container-internal only, accessed by Plausible via Docker network) |

**Domains** (Caddy terminates TLS):

| Domain | Backend | Notes |
|--------|---------|-------|
| `alfred.black` | localhost:3000 | Main SaaS app — static files + API proxy |
| `app.alfred.black` | redirect → alfred.black | GET/HEAD/OPTIONS redirect; POST routes to :3000 |
| `plausible.alfred.black` | localhost:8000 | Analytics |

**Source files:** `deploy/docker-compose.yaml`, `deploy/Caddyfile`

---

## Tenant Docker Stack (per subscriber)

Each subscriber gets a dedicated Hetzner VPS (cx53) with this stack. All services bind to `127.0.0.1` — no direct internet exposure.

| Service | Image | Bind Address | Protocol | Purpose |
|---------|-------|-------------|----------|---------|
| `init` | `ssdavidai00/alfred-init:latest` | — (one-shot) | — | Scaffold vault, copy skills, generate config, create gateway token |
| `temporal` | `temporalio/temporal:latest` | 127.0.0.1:7233 | gRPC | Workflow engine |
| `temporal` (UI) | (same) | 127.0.0.1:8233 | HTTP | Temporal Web UI |
| `openclaw` | `ssdavidai00/alfred-openclaw:latest` | 127.0.0.1:18789 | HTTP/WS | AI gateway (tools, agents, WebSocket) |
| `alfred` | `ssdavidai00/alfred-worker:latest` | — (no port) | — | Vault worker daemons |
| `alfred-learn` | `ssdavidai00/alfred-learn:latest` | — (no port) | — | Temporal worker (intelligence layer) |
| `ctrl-api` | `node:22-slim` | 127.0.0.1:3100 | HTTP | Tenant API server (Docker container, mounts host Docker socket) |

**Startup Order:**

```
init (one-shot, must complete successfully)
  ↓
ctrl-api (waits for init) + temporal (must be healthy) + openclaw (must be healthy, also waits for init)
  ↓
alfred (waits for openclaw healthy + ctrl-api healthy + init complete)
alfred-learn (waits for temporal healthy + openclaw healthy + ctrl-api healthy)
```

**CAUTION:** `ctrl-api` shares `env_file: .env` with all other services. Running
`docker compose up -d` after an `.env` change will recreate ctrl-api too. Always
use `--no-deps --force-recreate <service>` to restart individual services without
cascading to ctrl-api.

**Internal Connections:**

| From | To | Address | Protocol | Env Var |
|------|----|---------|----------|---------|
| `alfred` | `openclaw` | ws://openclaw:18789 | WebSocket | `OPENCLAW_GATEWAY_URL` |
| `alfred` | `ctrl-api` | http://ctrl-api:3100 | HTTP | `ALFRED_CTRL_URL` |
| `alfred-learn` | `temporal` | temporal:7233 | gRPC | `TEMPORAL_HOST` |
| `alfred-learn` | `openclaw` | http://openclaw:18789 | HTTP | `OPENCLAW_GATEWAY_URL` |
| `alfred-learn` | `ctrl-api` | http://ctrl-api:3100 | HTTP | `ALFRED_CTRL_URL` |
| `openclaw` | gateway token | /alfred-data/.gateway-token | file | `OPENCLAW_GATEWAY_TOKEN_FILE` |
| `alfred-learn` | gateway token | /alfred-data/.gateway-token | file | `OPENCLAW_GATEWAY_TOKEN_FILE` |

**Volume Mounts:**

| Volume Path (host) | Container Mount | Used By |
|-------------------|----------------|---------|
| `/mnt/encrypted/vault` | `/vault` (ro for learn) | init, openclaw, alfred, alfred-learn |
| `/mnt/encrypted/openclaw` | `/home/node/.openclaw` (openclaw), `/openclaw-state` (init), `/root/.openclaw` (alfred) | init, openclaw, alfred |
| `/mnt/encrypted/alfred` | `/alfred-data` (init, openclaw, alfred-learn), `/app/data` (alfred) | init, openclaw, alfred, alfred-learn |
| `/mnt/encrypted/temporal` | `/data` | temporal |

**Source files:** `packages/ctrl/src/templates/docker-compose.yaml.njk`

---

## Cross-Plane Connections

### SaaS → Tenant (Dashboard Proxy)

```
SaaS app (alfred.black)
  → Tailscale WireGuard mesh
    → https://{tailscale-hostname}:3100
      → Bearer token auth (AES-256-GCM encrypted in PostgreSQL)
        → alfred-ctrl API
```

- Protocol: HTTPS over Tailscale (WireGuard)
- Port: 3100
- Auth: `Authorization: Bearer {api_key}` — key decrypted from PostgreSQL using `COLUMN_ENCRYPTION_KEY`
- Timeout: 15s (hardcoded in `tenantProxy.ts`)
- Source: `packages/saas/app/src/server/tenantProxy.ts`

### User → Tenant OpenClaw (AI Gateway)

```
User browser
  → {subdomain}.{domain} (Cloudflare DNS)
    → Cloudflare Tunnel
      → localhost:18789
        → OpenClaw gateway (authenticated via gateway token)
```

- Protocol: HTTPS (Cloudflare terminates) → HTTP (localhost)
- Port: 18789
- Auth: OpenClaw gateway token (auto-generated by init container)
- Source: `packages/ctrl/src/templates/cloudflared-config.yaml.njk`

### Admin → Tenant (Tailscale Serve)

```
Admin (on Tailnet)
  → https://{tailscale-hostname}:8233  → Temporal UI
  → https://{tailscale-hostname}:3100  → alfred-ctrl API
```

- Provisioned by: `packages/ctrl/src/templates/bootstrap-openclaw.sh.njk`

### CI → Tenants (Deploy Rollout)

```
GitHub Actions
  → SSH to SaaS host
    → alfred-ctrl CLI: `update --all`
      → SSH to each tenant VPS
        → docker compose pull + up -d
```

---

## Docker Images

| Image | Registry | Built By | Pinned? |
|-------|----------|----------|---------|
| `ssdavidai00/alfred-openclaw:latest` | Docker Hub | `.github/workflows/build-openclaw.yml` | No — uses `:latest` |
| `ssdavidai00/alfred-learn:latest` | Docker Hub | `.github/workflows/build-learn.yml` | No — uses `:latest` |
| `ssdavidai00/alfred-worker:latest` | Docker Hub | `.github/workflows/build-alfred.yml` | No — uses `:latest` |
| `ssdavidai00/alfred-init:latest` | Docker Hub | `.github/workflows/build-alfred.yml` | No — uses `:latest` |
| `temporalio/temporal:latest` | Docker Hub | upstream | No — uses `:latest` |
| `postgres:16-alpine` | Docker Hub | upstream | Partial — major version pinned |
| `clickhouse/clickhouse-server:24.12-alpine` | Docker Hub | upstream | Yes — minor version pinned |
| `ghcr.io/plausible/community-edition:v3.2.0` | GHCR | upstream | Yes — exact version |
| `alfred-saas:latest` | local build | `deploy-saas.yml` | No — uses `:latest` |
