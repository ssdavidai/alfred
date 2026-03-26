# CONTRACT.md — alfred-saas

> What this package provides and what it requires.
> Update this file when adding/removing API routes, env vars, or external dependencies.

---

## Provides

### Web Application (port 3000)

SaaS platform at `alfred.black` — user-facing web app for Alfred Black.

| Feature | Technology |
|---------|-----------|
| User authentication | Wasp 0.19 (email + social auth) |
| Billing & subscriptions | Polar.sh integration |
| Provisioning orchestration | Triggers ctrl CLI on SaaS host |
| Dashboard | Proxies API calls to tenant alfred-ctrl |

### Caddy Endpoints (via reverse proxy)

| Path Pattern | Purpose |
|-------------|---------|
| `/api/*` | Backend API |
| `/auth/*` | Authentication flows |
| `/operations/*` | Wasp operations (queries + actions) |
| `/jobs/*` | Background jobs |
| `/payments/*` | Polar.sh payment flows |
| `/webhooks/*` | Webhook receivers (Polar.sh, etc.) |
| `/*` (default) | Static SPA (React) |

### Dashboard Proxy

The SaaS frontend calls Wasp server actions, which proxy to each tenant's alfred-ctrl API via Tailscale:

```
Browser → alfred.black/operations/* → Wasp action → proxyToTenant()
  → HTTPS over Tailscale → {tailscale-hostname}:3100/api/v1/*
```

- Auth: Bearer token (AES-256-GCM encrypted, stored in PostgreSQL `Instance.apiKey`)
- Timeout: 15 seconds
- Source: `app/src/server/tenantProxy.ts`

---

## Requires

### External Services

| Service | Address | Protocol | Purpose |
|---------|---------|----------|---------|
| PostgreSQL 16 | localhost:5432 | TCP | SaaS database (`alfred_saas`) |
| Caddy | localhost:80/443 | HTTP/HTTPS | TLS termination + reverse proxy |
| Tenant alfred-ctrl | {tailscale-hostname}:3100 | HTTPS (Tailscale) | Dashboard API proxy |
| Polar.sh | api.polar.sh | HTTPS | Billing + subscriptions |

### Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `COLUMN_ENCRYPTION_KEY` | yes | — | AES-256 key (hex) for API key encryption |
| `POLAR_ACCESS_TOKEN` | yes | — | Polar.sh API token |
| `POLAR_WEBHOOK_SECRET` | yes | — | Polar.sh webhook verification |
| `POSTGRES_PASSWORD` | yes | — | PostgreSQL password (docker-compose) |
| `PLAUSIBLE_BASE_URL` | no | `http://localhost:8000` | Plausible analytics URL |
| `PLAUSIBLE_SECRET_KEY_BASE` | yes | — | Plausible secret |
| `PLAUSIBLE_TOTP_VAULT_KEY` | yes | — | Plausible TOTP secret |

### Database Schema

Managed by Wasp/Prisma. Key model:

| Model | Purpose |
|-------|---------|
| `User` | Auth, profile |
| `Instance` | Tenant VPS record (tailscaleHostname, apiKey, status) |
| `Stream` | Integration connection (source, type, webhookToken, status) |
| `StreamEvent` | Events received from integrations |

### Integrations (Streams)

The Integrations page (`/dashboard/streams`) is the primary data input hub for Alfred. Users connect external services (Gmail, GitHub, Polar, Omi, OpenClaw, Custom) that stream events into the intelligence pipeline:

```
Integrations → EventProcessor → Classification → Judgment → Task execution
```

Each integration creates a `Stream` with:
- Source-specific type (scheduled, webhook, or realtime)
- Health status and event counts per source
- Webhook URL for inbound event delivery (webhook type)

### Consumed By

| Consumer | What It Uses |
|----------|-------------|
| End users (browser) | Web app at alfred.black |
| Polar.sh | Webhook callbacks at `/webhooks/*` |
| External services | Integration webhook endpoints at `/webhooks/:token` |
