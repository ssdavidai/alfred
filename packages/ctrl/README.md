# alfred-ctrl

Fleet management tool for provisioning and managing [Alfred](../README.md) instances on Hetzner Cloud. Provides both an interactive TUI dashboard and a scriptable CLI.

## Prerequisites

- **Node.js 22+** (uses built-in `node:sqlite`)
- **ssh-keygen** (for Ed25519 keypair generation)
- A Hetzner Cloud API token (read/write)
- A Tailscale auth key or API key

## Setup

```bash
npm install
npm run build
cp .env.example .env
# Fill in HETZNER_API_TOKEN and TAILSCALE_AUTHKEY at minimum
```

## Usage

### TUI Dashboard

```bash
npm start
# or
node dist/index.mjs
```

Keybindings:
- `q` quit, `n` new instance, `r` refresh, `Enter` detail view, arrows to navigate
- In detail view: `s` SSH, `u` update images, `d` destroy, `Esc` back

### CLI Commands

```bash
alfred-ctrl list [--json] [--status <status>]   # List instances
alfred-ctrl provision <name> [--type cx33] [--location fsn1] [--ts-key <key>]
alfred-ctrl destroy <name> [--yes]               # Destroy (with confirmation)
alfred-ctrl ssh <name>                           # Interactive SSH session
alfred-ctrl update <name> [--all]                # Pull latest images and restart
alfred-ctrl rollback <name> [--sha <sha>]        # Rollback to last healthy image
alfred-ctrl health [name]                        # Run health checks
alfred-ctrl logs <name>                          # Tail docker compose logs
```

## Architecture

```
src/
├── index.tsx              # Entry point: .env loading, Commander CLI, Ink TUI
├── app.tsx                # Root TUI component (screen router)
├── store.ts               # React Context for TUI state
├── data/
│   ├── types.ts           # All TypeScript types
│   └── constants.ts       # DEFAULTS, API URLs, color maps, keybinding hints
├── db/
│   ├── schema.sql         # SQLite schema (instances, health_checks, events)
│   ├── index.ts           # Singleton DatabaseSync connection
│   └── queries.ts         # Typed query functions
├── infra/
│   ├── hetzner.ts         # Hetzner Cloud API client
│   ├── provisioner.ts     # Multi-step provisioning orchestrator
│   ├── ssh.ts             # SSH exec/upload/download with host key pinning
│   ├── keys.ts            # Ed25519 keypair generation
│   ├── firewall.ts        # Hetzner firewall management
│   └── tailscale.ts       # Tailscale API and connectivity verification
├── monitoring/
│   ├── health.ts          # Periodic SSH health checks with status tracking
│   └── alerts.ts          # Slack/Discord webhook alerts on status changes
├── hooks/                 # React hooks wrapping infra for TUI use
├── components/            # Ink TUI components (Dashboard, DetailView, etc.)
└── templates/
    ├── cloud-init.yaml.njk          # Server bootstrap (users, packages, LUKS, systemd)
    ├── docker-compose.yaml.njk      # Alfred service stack
    └── bootstrap-openclaw.sh.njk    # OpenClaw + Tailscale setup
```

### What Provisioning Does

1. Generate Ed25519 SSH keypair
2. Upload SSH key to Hetzner
3. Create/reuse a shared firewall (SSH + ICMP only)
4. Create encrypted volume
5. Create server with cloud-init (packages, LUKS encryption, Docker, systemd timers)
6. Wait for cloud-init completion (polls via SSH)
7. Pin SSH host key fingerprint
8. Upload secrets via SSH (never in cloud-init user_data)
9. Configure restic backups to Hetzner Object Storage (if S3 credentials provided)
10. Upload docker-compose.yaml and start containers
11. Bootstrap OpenClaw gateway + Tailscale mesh networking
12. Provision TLS cert via Tailscale and set up Tailscale Serve
13. Back up LUKS keyfile locally
14. Run initial health check

### Service Stack (per instance)

| Service | Purpose |
|---------|---------|
| **init** | One-shot: scaffolds vault, generates gateway token |
| **temporal** | Workflow orchestration (SQLite-backed) |
| **openclaw** | AI agent gateway, accessed via Tailscale only |
| **alfred** | Alfred worker, connects to OpenClaw via internal WebSocket |

All services bind to `127.0.0.1`; external access is exclusively via Tailscale Serve (HTTPS).

## Security Model

- **Secrets never in cloud-init** — API keys and credentials are uploaded post-provision via SSH
- **SSH host key pinning** — fingerprint captured on first connection, verified on all subsequent connections
- **LUKS2 encryption** — data volumes encrypted with auto-generated keyfile
- **Firewall** — Hetzner cloud firewall + UFW: SSH and ICMP only inbound
- **Tailscale mesh** — all services localhost-only, external access via Tailscale Serve with auto TLS
- **Container hardening** — `no-new-privileges`, all capabilities dropped, memory and PID limits
- **Restricted sudo** — deploy user limited to specific commands (systemctl, tailscale, mkdir, bash for init scripts)
- **Input validation** — customer names restricted to `[a-zA-Z0-9_-]` to prevent template injection
- **File permissions** — docker-compose.yaml and .env files are 0600

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HETZNER_API_TOKEN` | Yes | Hetzner Cloud API token (read/write) |
| `TAILSCALE_AUTHKEY` | Yes* | Tailscale auth key (or pass `--ts-key` per provision) |
| `TAILSCALE_TAILNET` | No | Tailnet name (default: your-tailnet.ts.net) |
| `OPENROUTER_API_KEY` | No | Deployed to instances for AI model access |
| `HETZNER_S3_ACCESS_KEY` | No | For restic backups to Hetzner Object Storage |
| `HETZNER_S3_SECRET_KEY` | No | For restic backups to Hetzner Object Storage |
| `HETZNER_S3_BUCKET` | No | S3 bucket name (default: alfred-backups) |
| `HETZNER_S3_ENDPOINT` | No | S3 endpoint (default: fsn1.your-objectstorage.com) |
| `ALERT_WEBHOOK_URL` | No | Slack or Discord webhook for health alerts |
| `ALERT_WEBHOOK_TYPE` | No | `slack` or `discord` (default: slack) |
| `DEFAULT_SERVER_TYPE` | No | Default Hetzner server type (default: cx33) |
| `DEFAULT_LOCATION` | No | Default Hetzner location (default: fsn1) |

## Development

```bash
npm run dev    # Watch mode — rebuilds on file changes
npm run build  # One-shot build
npm start      # Run the TUI
```

esbuild bundles everything into `dist/index.mjs`. `.sql` and `.njk` files are loaded as text strings via esbuild loaders. `ssh2` is external (native addon).
