# CONTRACT.md — alfred-ctrl

> What this package provides and what it requires.
> Update this file when adding/removing routes, env vars, or external dependencies.

---

## Provides

### HTTP API (port 3100)

Tenant-local API server consumed by the SaaS dashboard. All routes under `/api/v1/` prefix.

| Route Module | Key Endpoints |
|-------------|---------------|
| `vault` | `POST /records`, `GET /records/{path}`, `PATCH /records/{path}`, `GET /list/{type}`, `GET /search` |
| `streams` | `GET /events`, `POST /events/{id}/processed`, `POST /events/{id}/quarantine` |
| `learning` | `GET /queue` |
| `workers` | Start/stop/restart Docker containers |
| `workflows` | Temporal workflow management |
| `devices` | OpenClaw device management |
| `openclaw` | Gateway status and config |
| `logs` | Container log retrieval |
| `admin` | Instance admin operations |
| `credentials` | API key management (.env on tenant) |
| `agents` | Per-agent model configuration |
| `notifications` | `POST /notifications` (push to Alfred agent) |

Auth: `Authorization: Bearer {AAS_API_KEY}` on every request.

### CLI / TUI

Fleet management tool (runs locally or on SaaS host):

| Command | Purpose |
|---------|---------|
| `provision <name>` | 15-step provisioning orchestrator |
| `destroy <name>` | Tear down instance + Hetzner resources |
| `health` | SSH-based health checks across fleet |
| `deploy-api <name>` | Deploy ctrl API to a tenant |
| `update [--all]` | Rolling Docker image update |
| `list` | List all managed instances |
| (no args) | Interactive TUI dashboard |

### SSH-Based Health Monitoring

Periodic background checks via SSH into each tenant:
- Docker container status (running/stopped/restarting)
- Disk usage on `/mnt/encrypted`
- Memory usage
- cloudflared service status
- Results stored in SQLite, webhook alerts on status changes

### 15-Step Provisioning Orchestrator

1. Generate Ed25519 keypair
2. Upload SSH key to Hetzner
3. Ensure shared firewall
4. Create encrypted volume
5. Render cloud-init template
6. Create Hetzner server
7. Wait for cloud-init completion
8. Upload secrets via SSH
9. Upload docker-compose
10. Start Docker containers
11. Bootstrap OpenClaw + Tailscale
12. Register OpenClaw agents
13. Set default model
14. Backup LUKS key
15. Run health check

---

## Requires

### Runtime

| Dependency | Version | Notes |
|-----------|---------|-------|
| Node.js | 22 | Uses `node:sqlite` (pass `--experimental-sqlite` on v22.12.0) |
| Docker + Docker Compose | latest | On tenant host, for container management |

### Filesystem

| Path | Access | Purpose |
|------|--------|---------|
| `/mnt/encrypted/vault` | read/write | Vault data (markdown records) |
| `/mnt/encrypted/alfred` | read/write | Alfred runtime data |
| `/mnt/encrypted/openclaw` | read/write | OpenClaw state |
| `data/alfred-ctrl.db` | read/write | SQLite database (auto-created) |
| `data/ssh_keys/<id>/` | read/write | Per-instance SSH keypairs + LUKS backups |

### Environment Variables

**API server (on tenant):**

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `AAS_API_KEY` | yes | — | Bearer token for API authentication |
| `AAS_PORT` | no | `3100` | API listen port |
| `AAS_HOST` | no | `127.0.0.1` | API bind address |

**TUI/CLI (on dev machine or SaaS host):**

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `HETZNER_API_TOKEN` | yes | — | Hetzner Cloud API |
| `TAILSCALE_API_KEY` | yes | — | Tailscale auth key generation |
| `CLOUDFLARE_API_TOKEN` | no | — | Tunnel + DNS management |
| `OPENROUTER_API_KEY` | no | — | AI features |
| `ALERT_WEBHOOK_URL` | no | — | Slack/Discord health alerts |
| `ALERT_WEBHOOK_TYPE` | no | — | `slack` or `discord` |

### Consumed By

| Consumer | Connection | What It Uses |
|----------|-----------|-------------|
| `alfred-saas` | HTTPS over Tailscale → :3100 | All `/api/v1/*` routes |
| `alfred-learn` | http://host.docker.internal:3100 | vault, streams, learning, notifications routes |
