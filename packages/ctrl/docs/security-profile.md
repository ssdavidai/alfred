# Alfred Platform Security Profile

**Last updated:** 2026-02-27
**Scope:** alfred-ctrl (fleet management), alfred-saas (multi-tenant SaaS), Alfred (Python AI tools), tenant VM infrastructure

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Trust Boundaries & Data Flow](#2-trust-boundaries--data-flow)
3. [Network Security](#3-network-security)
4. [Tenant VM Containerization](#4-tenant-vm-containerization)
5. [Encryption & Secrets Management](#5-encryption--secrets-management)
6. [Authentication & Authorization](#6-authentication--authorization)
7. [Input Validation & Output Sanitization](#7-input-validation--output-sanitization)
8. [Audit Logging & Monitoring](#8-audit-logging--monitoring)
9. [Backup & Disaster Recovery](#9-backup--disaster-recovery)
10. [Supply Chain Security](#10-supply-chain-security)
11. [Attack Surface Analysis](#11-attack-surface-analysis)
12. [Known Vulnerabilities & Remediation Status](#12-known-vulnerabilities--remediation-status)
13. [Out of Scope & Accepted Risks](#13-out-of-scope--accepted-risks)
14. [Hardening Checklist](#14-hardening-checklist)

---

## 1. Architecture Overview

Alfred is a multi-tenant platform where each customer gets a dedicated Hetzner Cloud VM running AI-powered knowledge management tools against an Obsidian-compatible vault. The platform has three layers:

```
                          Internet Users
                               |
                        Cloudflare Edge
                        (TLS termination)
                               |
                     Cloudflare Tunnel (outbound-only)
                               |
    +----------------------------------------------------------+
    |                   Tenant VM (Hetzner)                     |
    |  +----------+  +-----------+  +--------+  +----------+   |
    |  | OpenClaw |  | Temporal  |  | Alfred |  | Tenant   |   |
    |  | Gateway  |  | Workflow  |  | Worker |  | API      |   |
    |  | :18789   |  | :7233/    |  | (no    |  | :3100    |   |
    |  | (HTTP)   |  |  :8233    |  |  port) |  | (HTTP)   |   |
    |  +----------+  +-----------+  +--------+  +----------+   |
    |       All bound to 127.0.0.1 (localhost only)            |
    |  +----------------------------------------------------+  |
    |  |        /mnt/encrypted (LUKS2 volume)               |  |
    |  |   vault/  openclaw/  alfred/  temporal/            |  |
    |  +----------------------------------------------------+  |
    +----------------------------------------------------------+
              |                              |
         Tailscale Mesh                 Hetzner Firewall
         (WireGuard)                    (SSH + UDP 41641)
              |
    +-------------------+        +-------------------+
    | Control Plane VM  |        | SaaS App          |
    | alfred-ctrl       |        | (Wasp + Prisma +  |
    | (SQLite)          |        |  PostgreSQL)       |
    | 138.199.236.244   |        | app.alfred.black   |
    +-------------------+        +-------------------+
```

### Components

| Component | Technology | Role |
|-----------|-----------|------|
| **alfred-ctrl** | Node.js + SQLite | Fleet provisioning, health monitoring, infrastructure orchestration |
| **alfred-saas** | Wasp (React + Node.js + Prisma + PostgreSQL) | Multi-tenant SaaS dashboard, billing, user auth |
| **Alfred** | Python | AI tools (Curator, Janitor, Distiller, Surveyor) running on tenant VMs |
| **OpenClaw** | Node.js | AI agent gateway; executes skills via tools |
| **Temporal** | Go | Workflow orchestration engine (dev mode, SQLite backend) |
| **Tenant API** | Node.js (Express) | REST API for SaaS-to-tenant communication |
| **cloudflared** | Go | Cloudflare Tunnel daemon for user-facing HTTPS access |

---

## 2. Trust Boundaries & Data Flow

### Trust Boundary Map

```
+-- UNTRUSTED -----------------------------------------------+
|  Internet users, Cloudflare edge, public DNS               |
+------------------------------------------------------------+
        | HTTPS (Cloudflare TLS)           | HTTPS (Caddy TLS)
        v                                  v
+-- SEMI-TRUSTED -------------------------------------------+
|  Cloudflare Tunnel endpoint      SaaS App (app.alfred.black)
|  ({tenant}.alfred.black)         Wasp auth + session cookies
+------------------------------------------------------------+
        | HTTP (localhost)                 | HTTPS (Tailscale)
        v                                  v
+-- TRUSTED (per-tenant) -----------------------------------+
|  OpenClaw Gateway (:18789)       Tenant API (:3100)        |
|  Gateway token auth              Bearer token auth (AES)   |
+------------------------------------------------------------+
        | WebSocket (Docker network)
        v
+-- TRUSTED (per-tenant) -----------------------------------+
|  Alfred Worker (vault read/write via scoped CLI)           |
|  Temporal (workflow engine, no external auth)               |
+------------------------------------------------------------+
        | Filesystem
        v
+-- DATA (encrypted at rest) -------------------------------+
|  /mnt/encrypted/ (LUKS2)                                   |
|  vault/, openclaw/, alfred/, temporal/                      |
+------------------------------------------------------------+
```

### Data Flow: User Request

1. User visits `https://acme.alfred.black` (Cloudflare edge terminates TLS)
2. Cloudflare forwards to tenant VM via outbound-only tunnel
3. `cloudflared` daemon routes to `localhost:18789` (OpenClaw)
4. OpenClaw serves Control UI (gateway token auth in URL)

### Data Flow: SaaS Dashboard

1. User authenticates at `app.alfred.black` (Wasp auth: email/password or OAuth)
2. Dashboard fetches data via `tenantProxy.ts` server action
3. Proxy connects to `https://alfred-{name}.tail5ec603.ts.net:3100/api/v1/*` over Tailscale
4. Tenant API authenticates via Bearer token (AES-256-GCM encrypted in PostgreSQL)
5. Tenant API executes `alfred vault` CLI commands locally

### Data Flow: Provisioning

1. SaaS creates PgBoss job with instance config
2. Worker spawns `node alfred-ctrl/dist/index.mjs provision {name}`
3. alfred-ctrl: creates SSH key -> Hetzner server -> uploads secrets via SSH -> starts containers -> creates Cloudflare Tunnel
4. Secrets (API keys, LUKS keyfile, restic credentials) are **never** in cloud-init user_data; uploaded post-boot via SSH

---

## 3. Network Security

### 3.1 Four-Layer Network Model

**Layer 1: Hetzner Cloud Firewall** (`alfred-ctrl-hardened`)

| Rule | Protocol | Port | Source | Purpose |
|------|----------|------|--------|---------|
| SSH | TCP | 22 | `ADMIN_SSH_CIDRS` (configurable) | Admin access |
| Tailscale | UDP | 41641 | 0.0.0.0/0, ::/0 | WireGuard mesh |
| ICMP | ICMP | - | 0.0.0.0/0, ::/0 | Ping/diagnostics |
| Egress | All | All | Outbound only | No restriction |

The firewall is created once and shared across all instances. `ADMIN_SSH_CIDRS` defaults to `0.0.0.0/0,::/0` (open) but should be restricted to the control plane IP in production.

**Layer 2: Host UFW Firewall** (mirrors Hetzner rules)

Applied via cloud-init. Adds `ufw allow 41641/udp` for Tailscale, default deny incoming. UFW and Hetzner firewall are defense-in-depth — either alone would be sufficient, but both together protect against misconfiguration.

**Layer 3: Tailscale Mesh (WireGuard)**

All inter-VM communication uses Tailscale's encrypted WireGuard tunnels. ACL policy enforces:

```
tag:admin  -> tag:tenant:*   ALLOW   (control plane -> all tenants)
tag:admin  -> tag:admin:*    ALLOW   (admin -> admin)
tag:tenant -> tag:tenant:*   DENY    (implicit, no rule)
tag:tenant -> tag:admin:*    DENY    (implicit, no rule)
autogroup:member -> *:*      ALLOW   (personal devices, existing untagged instances)
```

New instances are provisioned with `tag:tenant` via ephemeral pre-authorized auth keys. The control plane uses `tag:admin`. Tenant VMs **cannot** communicate with each other or initiate connections to the control plane.

**Layer 4: Cloudflare Tunnel (user-facing)**

Each tenant VM runs `cloudflared` as a systemd service. The tunnel is outbound-only — no inbound firewall ports are opened for user traffic. Cloudflare's edge handles TLS termination, DDoS protection, and WAF.

Tunnel routing:
```yaml
ingress:
  - hostname: {subdomain}.alfred.black
    service: http://localhost:18789
  - service: http_status:404
```

### 3.2 SSH Hardening

Applied via `/etc/ssh/sshd_config.d/99-alfred-hardening.conf`:

| Setting | Value | Purpose |
|---------|-------|---------|
| PermitRootLogin | no | No root SSH |
| PasswordAuthentication | no | Key-only auth |
| MaxAuthTries | 3 | Brute-force limit |
| MaxSessions | 3 | Session limit |
| X11Forwarding | no | No X11 tunneling |
| AllowTcpForwarding | no | No port forwarding |
| AllowAgentForwarding | no | No agent forwarding |
| ClientAliveInterval | 300 | 5-min idle timeout |
| ClientAliveCountMax | 2 | 10-min max idle |
| LoginGraceTime | 30 | 30s login window |

Fail2ban: 3 retries, 1-hour ban (recommendation: increase to 24h).

### 3.3 Service Binding

All services bind to `127.0.0.1` (localhost). No service is directly exposed to the network:

| Service | Bind Address | Accessible Via |
|---------|-------------|----------------|
| OpenClaw (:18789) | 127.0.0.1 | Cloudflare Tunnel |
| Temporal gRPC (:7233) | 127.0.0.1 | Docker internal network |
| Temporal UI (:8233) | 127.0.0.1 | Tailscale Serve (HTTPS, admin-only) |
| Tenant API (:3100) | 127.0.0.1 | Tailscale Serve (HTTPS, admin + SaaS proxy) |

Tailscale Serve endpoints (set up during bootstrap):
```
https://alfred-{name}:8233  -> http://localhost:8233  (Temporal UI)
https://alfred-{name}:3100  -> http://localhost:3100  (Tenant API)
```

---

## 4. Tenant VM Containerization

### 4.1 Container Security Controls

All containers apply defense-in-depth hardening:

| Control | temporal | openclaw | alfred (worker) | init |
|---------|----------|----------|-----------------|------|
| `no-new-privileges` | Yes | Yes | Yes | No |
| `cap_drop: ALL` | No | Yes | Yes | No |
| `cap_add` | None | `DAC_OVERRIDE` | None | None |
| `mem_limit` | 2 GB | 2 GB | 2 GB | None |
| `pids_limit` | 256 | 256 | 256 | None |
| Health check | Yes | Yes | No | No |
| Restart policy | unless-stopped | unless-stopped | unless-stopped | None (one-shot) |
| Port binding | 127.0.0.1 | 127.0.0.1 | None | None |
| User | uid 1000 (temporal) | uid 1000 (node) | Default | Default |

**Why `DAC_OVERRIDE` on OpenClaw:** The OpenClaw container mounts volumes owned by `deploy` (uid 1000 on host). The `node` user inside the container (also uid 1000) needs to read/write files created by both the host and other containers. `DAC_OVERRIDE` allows bypassing file permission checks for owner/group mismatches within the mounted volumes.

### 4.2 Container Images

| Container | Image | Source |
|-----------|-------|--------|
| init | `ssdavidai00/alfred-init:latest` | Custom (scaffolds vault, OpenClaw config) |
| temporal | `temporalio/temporal:latest` | Official Temporal image |
| openclaw | `ssdavidai00/alfred-openclaw:latest` | Custom (OpenClaw gateway + skills) |
| alfred | `ssdavidai00/alfred-worker:latest` | Custom (Python Alfred tools) |

All custom images are hosted on Docker Hub under `ssdavidai00/`. Images use mutable `:latest` tags (see [Known Vulnerabilities](#12-known-vulnerabilities--remediation-status) for risks).

### 4.3 Volume Mounts

```
Container     Host Path                        Container Path              Access
---------     ---------                        --------------              ------
init          /mnt/encrypted/vault             /vault                      RW
              /mnt/encrypted/openclaw          /openclaw-state             RW
              /mnt/encrypted/alfred            /alfred-data                RW

temporal      /mnt/encrypted/temporal          /data                       RW

openclaw      /mnt/encrypted/openclaw          /home/node/.openclaw        RW
              /mnt/encrypted/vault             /home/node/.openclaw/       RW
                                                 workspace/vault
              /mnt/encrypted/alfred            /alfred-data                RW

alfred        /mnt/encrypted/vault             /vault                      RW
              /mnt/encrypted/alfred            /app/data                   RW
```

All persistent data lives on the LUKS2-encrypted volume at `/mnt/encrypted/`. Nothing sensitive is stored on the unencrypted root filesystem except the LUKS keyfile at `/opt/alfred/luks.key`.

### 4.4 Docker Network

Containers communicate via Docker's default bridge network. Only the `openclaw` container exposes port 18789 (to localhost), which is the gateway for the `alfred` worker's WebSocket connection (`ws://openclaw:18789`).

The `alfred` worker has **no** exposed ports. It connects outbound to OpenClaw via Docker DNS (`openclaw:18789`) and reads/writes the vault filesystem directly.

### 4.5 Container Startup Order

```
init (one-shot) ──completed──> temporal ──healthy──> openclaw ──healthy──> alfred
```

The `init` container scaffolds the vault directory structure and OpenClaw configuration, then exits. Temporal must be healthy (gRPC responding) before OpenClaw starts. OpenClaw must be healthy (HTTP /health 200) before Alfred starts.

---

## 5. Encryption & Secrets Management

### 5.1 Encryption at Rest

**LUKS2 Volume Encryption:**
- Algorithm: AES-256-XTS (LUKS2 default)
- Key: 4 KB random keyfile generated during cloud-init (`dd if=/dev/urandom of=/opt/alfred/luks.key bs=4096 count=1`)
- Auto-unlock: systemd service runs `cryptsetup luksOpen` with keyfile before Docker starts
- Keyfile permissions: `0600` (root-only)
- Keyfile backup: Copied to control plane at `data/ssh_keys/{id}/luks.key` via SSH

**PostgreSQL (SaaS):**
- Tenant API keys encrypted with AES-256-GCM before storage
- Key: `COLUMN_ENCRYPTION_KEY` (32-byte hex, 64-char string)
- Format: `{iv_hex}:{auth_tag_hex}:{ciphertext_hex}`
- Unique random IV per encryption operation
- Auth tag verification on decryption (tamper detection)

**SQLite (alfred-ctrl):**
- Instance metadata including `gateway_token` and `api_key` stored in **plaintext**
- Mitigation: Database file is on the control plane, not on tenant VMs
- Recommendation: Implement column-level encryption matching the SaaS pattern

### 5.2 Encryption in Transit

| Path | Encryption | Auth |
|------|-----------|------|
| User -> Cloudflare | TLS 1.3 (Cloudflare edge) | None (public) or CF Access |
| Cloudflare -> Tenant VM | Cloudflare Tunnel (TLS over QUIC) | Tunnel credentials |
| SaaS -> Tenant API | Tailscale (WireGuard, Curve25519) | Bearer token |
| Control Plane -> Tenant SSH | SSH (Ed25519) | Public key |
| alfred-ctrl -> Hetzner API | HTTPS | Bearer token |
| alfred-ctrl -> Cloudflare API | HTTPS | API key + email |
| alfred-ctrl -> Tailscale API | HTTPS | API key (basic auth) |

### 5.3 Secret Lifecycle

**Provisioning secrets flow:**

```
1. Generate Ed25519 SSH keypair        -> data/ssh_keys/{id}/id_ed25519 (0600)
2. Generate LUKS keyfile               -> Cloud-init (on VM, never transmitted)
3. Generate Tailscale auth key         -> Passed in bootstrap script, deleted after use
4. Generate gateway token              -> Uploaded via SSH to .env (0600)
5. Generate AAS_API_KEY                -> Uploaded via SSH, encrypted in PostgreSQL
6. Generate restic password            -> Uploaded via SSH to restic.env (0600)
7. Generate Cloudflare tunnel secret   -> Uploaded via SSH to /etc/cloudflared/credentials.json (0600)
8. Backup LUKS keyfile                 -> Downloaded via SSH to data/ssh_keys/{id}/luks.key (0600)
9. Backup restic credentials           -> Downloaded via SSH to data/ssh_keys/{id}/restic.env (0600)
```

**Critical principle:** Secrets are **never** placed in Hetzner cloud-init `user_data`, which is readable via the instance metadata API at `http://169.254.169.254/`. All secrets are uploaded post-provisioning via SSH after the server is running and the firewall is active.

### 5.4 Secret Storage Locations

| Secret | Location | Protection | Risk |
|--------|----------|-----------|------|
| Hetzner API token | `.env` file | Filesystem permissions | Host compromise |
| Tailscale API key | `.env` file | Filesystem permissions | Host compromise |
| Cloudflare API key | `.env` file | Filesystem permissions | Host compromise |
| SSH private keys | `data/ssh_keys/{id}/` | 0600 permissions | Host compromise |
| LUKS keyfiles (backup) | `data/ssh_keys/{id}/luks.key` | 0600 permissions | Plaintext, host compromise |
| Restic credentials (backup) | `data/ssh_keys/{id}/restic.env` | 0600 permissions | Plaintext, host compromise |
| Tenant API keys | PostgreSQL `instances.apiKey` | AES-256-GCM encrypted | Key compromise |
| Gateway tokens | SQLite `instances.gateway_token` | **Plaintext** | DB access |
| Cloudflare tunnel creds | `/etc/cloudflared/credentials.json` | 0600, on encrypted volume | LUKS key compromise |

---

## 6. Authentication & Authorization

### 6.1 SaaS Authentication (alfred-saas)

Handled by the Wasp framework:
- **Email + password** with bcrypt hashing
- **OAuth** (Google, GitHub) supported but optional
- **Session management**: JWT-based, `JWT_SECRET` in environment
- **Admin role**: `ADMIN_EMAILS` environment variable whitelist

### 6.2 Tenant API Authentication

The tenant API at `:3100` uses Bearer token authentication:

```
Authorization: Bearer alf_<32 hex chars>
```

- Token generated per-instance during provisioning (cryptographically random)
- Stored encrypted (AES-256-GCM) in PostgreSQL
- Compared using timing-safe equality check (`crypto.timingSafeEqual`)
- No token expiry or rotation (recommendation: implement rotation)

### 6.3 OpenClaw Gateway Authentication

- Gateway token stored at `/mnt/encrypted/alfred/.gateway-token`
- Passed as URL parameter: `?token={gateway_token}`
- Token generated once during bootstrap, persists across restarts
- No token rotation mechanism

### 6.4 Vault Scope Enforcement

Each Alfred tool (Curator, Janitor, Distiller) operates under a restricted scope that limits what vault operations it can perform:

| Operation | Curator | Janitor | Distiller |
|-----------|---------|---------|-----------|
| read | Yes | Yes | Yes |
| search | Yes | Yes | Yes |
| list | Yes | Yes | Yes |
| context | Yes | Yes | Yes |
| create | Yes | **No** | Learn types only |
| edit | Yes | Yes | **No** |
| move | Inbox only | **No** | **No** |
| delete | **No** | Yes | **No** |

Scope is enforced in `vault/scope.py` via `check_scope()` before every operation. The scope name is passed as `ALFRED_VAULT_SCOPE` environment variable to the agent subprocess.

**Learn types** (Distiller only): assumption, decision, constraint, contradiction, synthesis.

**Inbox-only move** (Curator only): Source path must start with `inbox/`.

### 6.5 SaaS-to-Tenant Proxy Authorization

`tenantProxy.ts` enforces:
1. User must be authenticated (Wasp session)
2. User must own an instance with `status = "running"`
3. Instance must have `tailscaleHostname` and `apiKey` set
4. API key is decrypted from PostgreSQL and sent as Bearer token
5. 15-second timeout with AbortController
6. Error responses are sanitized (no internal details leaked)

---

## 7. Input Validation & Output Sanitization

### 7.1 Input Validation

**Instance name** (`provisioner.ts`):
```typescript
if (!/^[a-zA-Z0-9_-]+$/.test(config.customer_name)) {
  throw new Error("Invalid customer name");
}
```
Prevents template injection in Nunjucks templates, path traversal in filesystem operations, and command injection in shell commands.

**Vault record paths** (`operations.ts`):
```typescript
const normalized = args.path.replace(/\\/g, "/");
if (normalized.includes("..") || normalized.startsWith("/") || normalized.includes("\0")) {
  throw new HttpError(400, "Invalid record path");
}
```
Prevents directory traversal in the SaaS proxy's vault record endpoint.

**Vault operations** (`vault/ops.py`):
- `Path.resolve()` + prefix check ensures all paths stay within the vault directory
- Type validation against `KNOWN_TYPES` (20 entity types)
- Status validation against per-type allowed status values
- Required fields checked before record creation
- YAML frontmatter parsed with error handling

**API key names** (`apikeys/operations.ts`):
- Required and trimmed
- Maximum 10 keys per user

**SQL queries** (all database code):
- Parameterized queries throughout (`?` placeholders with value binding)
- No string concatenation in SQL

### 7.2 Output Sanitization

**Tenant proxy errors** (`tenantProxy.ts`):
```typescript
const safeMessage =
  response.status === 404 ? "Resource not found"
  : response.status === 401 ? "Authentication failed"
  : response.status >= 500 ? "Internal tenant error"
  : text?.slice(0, 200) || response.statusText;
```
Prevents leaking internal API endpoints, token validity, infrastructure details, or stack traces to end users. Connection errors produce generic "Failed to reach tenant instance" (no `error.message` leak).

**Health check JSON** (`healthcheck.sh`):
JSON responses are constructed using `jq -n` with `--argjson`/`--arg` flags instead of string interpolation, preventing JSON injection via crafted container names or status messages.

---

## 8. Audit Logging & Monitoring

### 8.1 Vault Mutation Log

Every vault operation is recorded in two locations:

1. **Session log**: Temporary JSONL file per agent session (`/mnt/encrypted/alfred/session_*.jsonl`)
   - Fields: `op`, `path`, `timestamp`, `field_changes`
   - Used by tools to verify agent completed the expected work

2. **Audit log**: Append-only JSONL at `/mnt/encrypted/alfred/vault_audit.log`
   - Persistent record of all creates, edits, moves, deletes
   - Survives container restarts

### 8.2 Instance Events

alfred-ctrl records lifecycle events in SQLite:

| Event Type | Trigger |
|-----------|---------|
| `provisioned` | Instance creation complete |
| `health_ok` | Health status changes to OK |
| `health_degraded` | Disk >90%, memory >95%, or service issues |
| `health_down` | Health check script reports failure |
| `health_unreachable` | SSH connection fails |
| `destroyed` | Instance teardown complete |
| `updated` | Image update applied |
| `rolled_back` | Rollback to last healthy image |

### 8.3 Health Monitoring

Health checks run periodically via SSH, executing `/opt/alfred/healthcheck.sh`:

```bash
# Checks performed:
1. Docker container states (running/exited/restarted)
2. Disk utilization (degraded if >90%)
3. Memory utilization (degraded if >95%)
4. cloudflared service status (degraded if not "active")
```

Classification logic:
- **OK**: All containers running (init may be exited with code 0), disk <90%, memory <95%, cloudflared active
- **Degraded**: Any non-init container not running, high resource usage, or cloudflared inactive
- **Down**: Health check script returns non-zero
- **Unreachable**: SSH connection fails

### 8.4 Alert Webhooks

Status changes trigger webhook notifications to Slack or Discord:
- Webhook URL configured via `ALERT_WEBHOOK_URL`
- Format selected via `ALERT_WEBHOOK_TYPE` (slack or discord)
- Contains: customer name, old -> new status, IP address
- **Known issue**: Alert delivery failures are silently swallowed (no retry, no secondary channel)

---

## 9. Backup & Disaster Recovery

### 9.1 Automated Backups

Each tenant VM runs daily restic backups at 3am (with 30-min random jitter):

1. Stop containers (alfred, openclaw, temporal) for consistency
2. Run `restic backup /mnt/encrypted --exclude=/mnt/encrypted/temporal`
3. Restart containers
4. Prune old snapshots (7 daily, 4 weekly, 6 monthly)

**Storage**: Hetzner Object Storage (S3-compatible) at `s3:https://{endpoint}/{bucket}/{customer_name}`

**Encryption**: Restic encrypts all backup data with a per-instance random password (32-byte hex). The password is stored in `/opt/alfred/restic.env` on the VM (encrypted volume) and backed up to the control plane at `data/ssh_keys/{id}/restic.env`.

**What's excluded**: Temporal's SQLite database (workflow execution history). This is ephemeral/reconstructible.

### 9.2 LUKS Key Backup

The LUKS keyfile is backed up to the control plane immediately after provisioning. If the VM's root disk is lost, the encrypted volume can be attached to a new server and unlocked with the backed-up keyfile.

**Risk**: Keyfile backups are stored in plaintext at `data/ssh_keys/{id}/luks.key`. A control plane compromise exposes all tenant LUKS keys. Recommendation: Encrypt backups with age/GPG.

### 9.3 Restic Credential Backup

S3 credentials and the restic encryption password are backed up to `data/ssh_keys/{id}/restic.env`. This enables disaster recovery even if the original VM is destroyed.

### 9.4 Recovery Procedure

1. Create new Hetzner server (same region as volume)
2. Attach existing encrypted volume
3. Unlock with backed-up LUKS keyfile
4. Mount, restore docker-compose and .env
5. Start containers — vault data is intact on the volume

If volume is also lost:
1. Create new server + volume
2. Provision fresh (new LUKS, new scaffold)
3. Restore from restic: `restic restore latest --target /mnt/encrypted/`
4. Start containers

---

## 10. Supply Chain Security

### 10.1 Package Installation

| Package | Method | Verification |
|---------|--------|-------------|
| Tailscale | APT with GPG key from `pkgs.tailscale.com` | GPG signature verification |
| cloudflared | APT with GPG key from `pkg.cloudflare.com` | GPG signature verification |
| Docker | APT from Docker's official repository | GPG signature verification |
| System packages | Ubuntu APT | Standard APT signature verification |

Previously, Tailscale was installed via `curl | sh` (supply chain risk). This was remediated by switching to APT with GPG key verification.

### 10.2 Container Images

**Risk**: All custom images use mutable `:latest` tags. An attacker with Docker Hub access could push a malicious image that would be pulled on the next auto-update cycle (every 15 minutes).

**Auto-update mechanism** (`alfred-update.timer`):
```
Every 15 minutes: docker compose pull --quiet && docker compose up -d --remove-orphans
```

No image signature verification (Docker Content Trust / cosign) is performed. No health check gate between pull and restart. No automatic rollback on failure.

**Recommendations**:
1. Pin images by digest (`image: ssdavidai00/alfred-openclaw@sha256:...`)
2. Sign images with cosign and verify before pull
3. Add health check gate: pull -> start canary -> verify health -> promote
4. Enable Docker Content Trust (`DOCKER_CONTENT_TRUST=1`)

### 10.3 OpenClaw Skills

OpenClaw supports installing third-party skills from ClawHub. This is a significant supply chain risk:

- **CVE-2026-25253** (CVSS 8.8): OpenClaw Control UI RCE via untrusted `gatewayUrl` in query string
- **ClawHavoc campaign** (Jan 2026): 1,184+ malicious skills on ClawHub, including the Atomic macOS Stealer

**Mitigations in Alfred**:
- OpenClaw binds to localhost only (not exposed to internet directly)
- User-facing access through Cloudflare Tunnel adds a layer of indirection
- Skills cannot be installed via the tunnel without explicit gateway token auth

**Recommendations**:
- Maintain an allowlist of vetted skills
- Disable skill installation in production
- Monitor for unauthorized skill changes via the tenant API `/api/v1/openclaw/skills` endpoint

---

## 11. Attack Surface Analysis

### 11.1 External Attack Vectors

| Vector | Exposure | Authentication | Impact | Mitigation |
|--------|----------|---------------|--------|------------|
| SSH brute-force | Port 22 (admin CIDRs) | Ed25519 key only | Server access | fail2ban, key-only auth, MaxAuthTries=3 |
| Cloudflare Tunnel hijack | Public HTTPS | Tunnel credentials | Traffic interception | Credentials on encrypted volume, outbound-only |
| DNS poisoning | `*.alfred.black` | Cloudflare proxied | User redirection | Cloudflare DNSSEC (if enabled), proxied records |
| SaaS app exploitation | `app.alfred.black` | Wasp auth | User data, provisioning | Input validation, parameterized queries |
| OpenClaw skill RCE | Via Cloudflare Tunnel | Gateway token | Full container access | Localhost binding, token auth, container caps |
| Tailscale key compromise | WireGuard mesh | Auth key (ephemeral) | Mesh access | Ephemeral keys, ACL isolation |

### 11.2 Internal Attack Vectors (post-compromise)

| Vector | Prerequisite | Impact | Mitigation |
|--------|-------------|--------|------------|
| Container escape | Container access | Host access | `no-new-privileges`, `cap_drop: ALL`, mem/pid limits |
| LUKS key theft | Root on VM | All tenant data | Keyfile 0600, root-only |
| Lateral movement (tenant-to-tenant) | Compromised tenant VM | Other tenants | Tailscale ACL denies tenant-to-tenant |
| Control plane compromise | SSH to 138.199.236.244 | All tenants | Restricted SSH CIDRs, key-only auth |
| SQLite DB theft | Control plane access | All gateway tokens, API keys | **Plaintext** — encrypt with AES-256-GCM |
| Docker socket abuse | `deploy` user on VM | Host root equivalent | deploy user in docker group (inherent risk) |

### 11.3 Tenant Isolation Model

Each tenant is isolated at multiple levels:

1. **Compute**: Dedicated Hetzner VM per tenant (no shared containers)
2. **Storage**: Dedicated LUKS2-encrypted volume per tenant
3. **Network**: Tailscale ACL prevents tenant-to-tenant communication
4. **DNS**: Unique Cloudflare Tunnel per tenant (no shared ingress)
5. **Auth**: Unique API keys, gateway tokens, SSH keys per tenant
6. **Firewall**: Shared Hetzner firewall policy (not per-tenant)

**What is NOT isolated**:
- Hetzner API token (shared across all tenants — compromise = all VMs)
- Tailscale tailnet (shared, isolation via ACLs only)
- Cloudflare account (shared, per-tenant tunnels and DNS records)
- Docker Hub images (shared, pulled by all tenants)
- S3 bucket (shared, per-tenant prefix path `/{customer_name}`)

---

## 12. Known Vulnerabilities & Remediation Status

### Critical (3)

| # | Finding | Status | Details |
|---|---------|--------|---------|
| 1 | SSH host key verification incomplete | Partial | Host key captured on first connection and stored, but `hostVerify` callback not fully enforced on all paths |
| 2 | LUKS keyfile backup stored unencrypted | Open | `data/ssh_keys/{id}/luks.key` is plaintext. Encrypt with age/GPG |
| 3 | Generated LUKS passphrase is dead code | Open | `provisioner.ts` generates a passphrase that is never used (keyfile is used instead). Remove dead code |

### High (7)

| # | Finding | Status | Details |
|---|---------|--------|---------|
| 4 | Unrestricted passwordless sudo | **Fixed** | `deploy` user has scoped sudo (systemctl, docker, cryptsetup, tailscale) |
| 5 | Tailscale auth key persisted on disk | **Fixed** | Bootstrap script deleted after execution, chmod 0700 |
| 6 | Template injection via customer_name | **Fixed** | Validated against `/^[a-zA-Z0-9_-]+$/` |
| 7 | API keys in docker-compose.yaml | **Fixed** | Uses `env_file:` directive, .env file with 0600 permissions |
| 8 | No container hardening | **Fixed** | `no-new-privileges`, `cap_drop: ALL`, mem/pid limits on all containers |
| 9 | Restic backup failure ignored | **Fixed** | Now a hard error — provisioning aborts |
| 10 | Tailscale installed via curl\|sh | **Fixed** | Installed via APT with GPG key verification |

### Medium (8)

| # | Finding | Status | Details |
|---|---------|--------|---------|
| 11 | SSH open to entire internet | **Fixed** | Hetzner firewall uses `ADMIN_SSH_CIDRS` (configurable) |
| 12 | IP addresses leaked in alert webhooks | Open | Webhook payloads contain server IPs |
| 13 | fail2ban bantime too short (1h) | Open | Recommend 24h or progressive banning |
| 14 | docker-compose.yaml world-readable | **Fixed** | Uploaded with mode 0600 |
| 15 | No API token rotation mechanism | Open | No expiry or rotation for Hetzner/Cloudflare/Tailscale tokens |
| 16 | SSH key storage depends on cwd() | Open | Keys at `path.join(process.cwd(), "data")` — recommend env var |
| 17 | Health check JSON via string interpolation | **Fixed** | Uses `jq -n` with `--argjson`/`--arg` flags |
| 18 | Backup service runs as root | Open | `alfred-backup.service` has no `User=` directive |

### Low (7)

| # | Finding | Status | Details |
|---|---------|--------|---------|
| 19 | No egress filtering | Open | UFW allows all outbound traffic |
| 20 | Docker images use `:latest` tag | Open | No digest pinning or signing |
| 21 | Auto-update timer has no verification | Open | 15-min pull cycle, no health gate or rollback |
| 22 | Silent alert webhook failures | Open | Delivery errors not logged or retried |
| 23 | ICMP allowed from all sources | Open | Enables host discovery scanning |
| 24 | Incomplete SSH hardening | **Fixed** | Comprehensive sshd_config drop-in added |
| 25 | Error messages leak internal details | **Fixed** | Tenant proxy sanitizes all error responses |

**Summary**: 10 of 25 findings remediated. 3 critical, 2 high, 4 medium, 6 low remain open.

---

## 13. Out of Scope & Accepted Risks

### Out of Scope

These areas are **not** covered by the current security architecture and are explicitly deferred:

| Area | Reason |
|------|--------|
| **DDoS protection** | Delegated to Cloudflare (included in free tier) |
| **WAF rules** | Delegated to Cloudflare; no application-level WAF |
| **Container image scanning** | No Trivy/Grype integration; images are custom-built |
| **Runtime threat detection** | No Falco/Sysdig; reliance on container hardening |
| **Key Management Service** | No HashiCorp Vault or AWS KMS; secrets in env vars and files |
| **MFA for SaaS users** | Wasp supports it but not enforced |
| **SOC 2 / ISO 27001 compliance** | No formal compliance program |
| **Penetration testing** | No formal pentest conducted |
| **Log aggregation** | Logs are per-VM in systemd journal; no centralized SIEM |
| **Intrusion Detection System** | fail2ban only; no OSSEC/Wazuh/CrowdStrike |
| **Database encryption (SQLite)** | alfred-ctrl stores tokens in plaintext |
| **Secrets rotation** | No automated rotation for any credential |
| **Client-side security** | No CSP headers, no subresource integrity on SaaS app |

### Accepted Risks

| Risk | Rationale |
|------|-----------|
| **`deploy` user in docker group** | Required for container management. Docker group = root equivalent. Mitigated by SSH key auth and fail2ban |
| **Shared Hetzner API token** | Single token manages all tenant infrastructure. Compromise = total fleet control. Accepted for operational simplicity; monitor via Hetzner audit logs |
| **Shared Tailscale tailnet** | All tenants on same tailnet, isolated by ACLs. Tailscale ACL misconfiguration = lateral movement. Accepted; ACLs are version-controlled |
| **Auto-update without verification** | 15-min pull cycle with no signature check. Accepted for rapid patching; Docker Hub credentials are strong |
| **Mutable `:latest` image tags** | Image mutation risk accepted for development velocity. Pin digests before GA |
| **LUKS auto-unlock** | Keyfile on root disk enables boot without manual intervention. Physical server access (Hetzner DC) could extract keyfile. Accepted; Hetzner DCs are ISO 27001 certified |

---

## 14. Hardening Checklist

### Applied (current state)

- [x] Ed25519 SSH keys (no RSA, no passwords)
- [x] SSH hardening via sshd_config drop-in (MaxAuthTries, no forwarding, idle timeout)
- [x] fail2ban on SSH (3 retries, 1h ban)
- [x] LUKS2 full-disk encryption on data volumes
- [x] Secrets uploaded via SSH, never in cloud-init user_data
- [x] Hetzner Cloud Firewall (SSH restricted, Tailscale UDP, ICMP)
- [x] Host UFW firewall (defense-in-depth)
- [x] Container `no-new-privileges` and `cap_drop: ALL`
- [x] Container memory and PID limits
- [x] All services bound to localhost (no public ports)
- [x] Tailscale mesh with ACL-based tenant isolation
- [x] Cloudflare Tunnel for user-facing access (outbound-only)
- [x] Cloudflare SSL mode: Full
- [x] Tailscale + cloudflared installed via APT with GPG verification
- [x] API keys in env_file (not docker-compose.yaml), mode 0600
- [x] Scoped sudo for deploy user (not blanket NOPASSWD)
- [x] Vault scope enforcement (per-tool operation restrictions)
- [x] Parameterized SQL queries (no injection)
- [x] Customer name regex validation (no template injection)
- [x] Path traversal protection on vault record access
- [x] Error message sanitization in tenant proxy
- [x] JSON construction via jq (no string interpolation injection)
- [x] Automated restic backups with per-instance encryption
- [x] Restic backup failure = hard provisioning error
- [x] Health monitoring with webhook alerts
- [x] Unattended security updates enabled
- [x] Ephemeral, single-use Tailscale auth keys
- [x] AES-256-GCM encryption for API keys in PostgreSQL

### Recommended (not yet applied)

- [ ] Encrypt LUKS keyfile backups with age/GPG
- [ ] Enforce SSH host key verification on all connection paths
- [ ] Pin Docker images by digest and sign with cosign
- [ ] Add health check gate to auto-update timer
- [ ] Implement API token rotation (Hetzner, Cloudflare, Tailscale)
- [ ] Increase fail2ban bantime to 24h or progressive
- [ ] Add egress filtering (restrict outbound to required destinations)
- [ ] Run backup service as non-root user
- [ ] Encrypt SQLite secrets at rest (match SaaS pattern)
- [ ] Add rate limiting to tenant API
- [ ] Implement centralized log aggregation
- [ ] Enable Cloudflare Access on tenant tunnel endpoints
- [ ] Add CSP headers to SaaS application
- [ ] Enforce MFA for SaaS admin users
- [ ] Implement alert delivery retry with secondary channel
- [ ] Use `ALFRED_DATA_DIR` env var instead of `process.cwd()`
- [ ] Scan container images with Trivy/Grype in CI
- [ ] Restrict ICMP to admin CIDRs
- [ ] Disable OpenClaw skill installation in production
- [ ] Add Docker Content Trust verification
