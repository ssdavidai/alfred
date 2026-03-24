# CONTRACT.md — alfred-ctrl

> What this package provides and what it requires.
> Update this file when adding/removing routes, env vars, or external dependencies.

---

## Provides

### HTTP API (port 3100)

Tenant-local API server running as `ctrl-api` Docker container (`node:22-slim`).
Mounts the host Docker socket to manage other containers. Consumed by the SaaS
dashboard via Tailscale proxy. All routes under `/api/v1/` prefix.

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
| `provision <name>` | 17-step provisioning orchestrator |
| `destroy <name>` | Tear down instance + Hetzner resources |
| `health [name]` | SSH-based health checks across fleet |
| `deploy-api [name]` | Deploy ctrl API to a tenant |
| `update [name]` | Rolling Docker image update (--all for fleet) |
| `list` | List all managed instances |
| `ssh <name>` | SSH into an instance |
| `run <name> <cmd>` | Run a command on an instance via SSH |
| `rollback <name>` | Rollback to last healthy image |
| `repair-tunnel [name]` | Repair Cloudflare Tunnel on instance(s) |
| `logs <name>` | Tail docker compose logs via SSH |
| `info <name>` | Show all instance fields |
| `events <name>` | Show events for an instance |
| `devices <name>` | List OpenClaw devices |
| `device-approve <name> <requestId>` | Approve a pending device |
| `device-reject <name> <requestId>` | Reject a pending device |
| `device-remove <name> <deviceId>` | Remove a paired device |
| `openclaw <name>` | Launch OpenClaw TUI via SSH |
| `alfred-tui <name>` | Launch Alfred TUI via SSH |
| `alfred-logs <name>` | Tail alfred container logs |
| `temporal-ui <name>` | Print Temporal UI URL |
| `api-key <name>` | Retrieve tenant API key |
| (no args) | Interactive TUI dashboard |

### SSH-Based Health Monitoring

Periodic background checks via SSH into each tenant:
- Docker container status (running/stopped/restarting)
- Disk usage on `/mnt/encrypted`
- Memory usage
- cloudflared service status
- Results stored in SQLite, webhook alerts on status changes

### 17-Step Provisioning Orchestrator

1. `generate_keypair` — Generate Ed25519 keypair
2. `upload_ssh_key` — Upload SSH key to Hetzner
3. `ensure_firewall` — Ensure shared firewall
4. `create_volume` — Create encrypted volume
5. `render_cloud_init` — Render cloud-init template
6. `create_server` — Create Hetzner server
7. `wait_cloud_init` — Wait for cloud-init completion
8. `upload_env` — Upload secrets via SSH
9. `configure_backups` — Configure restic backup credentials
10. `upload_compose` — Upload docker-compose
11. `start_containers` — Start Docker containers
12. `bootstrap_openclaw` — Bootstrap OpenClaw + Tailscale
13. `backup_luks_key` — Backup LUKS key
14. `deploy_api` — Deploy ctrl API to tenant
15. `setup_tunnel` — Configure Cloudflare Tunnel
16. `health_check` — Run health check
17. `done` — Mark provisioning complete

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
| `alfred-learn` | http://ctrl-api:3100 | vault, streams, learning, notifications routes |
