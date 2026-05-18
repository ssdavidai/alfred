# Security Audit: alfred-ctrl

**Date:** 2026-02-25
**Scope:** Full security review of alfred-ctrl provisioning system, OpenClaw deployment, and supporting infrastructure.

---

## External Threat Landscape

### CVE-2026-25253: 1-Click Remote Code Execution in OpenClaw (CVSS 8.8)

Disclosed February 3, 2026. The Control UI trusted `gatewayUrl` from the query string without validation and auto-connected on page load, sending the stored gateway auth token in the WebSocket connect payload. An attacker crafts a link that redirects the UI to an attacker-controlled server, steals the auth token, then connects back to the victim's Gateway via Cross-Site WebSocket Hijacking (CSWSH). The attacker can then disable the sandbox, modify tool policies, and execute arbitrary commands.

**This exploit works even against localhost-only instances** because the victim's own browser initiates the outbound connection.

- **Affected versions:** All versions before v2026.1.29
- **Fix:** Update OpenClaw to v2026.1.29+. Rotate ALL auth tokens issued before February 2026.
- **Status:** OPEN — verify Docker images use patched OpenClaw version.

### ClawHavoc Supply Chain Attack (Active since Jan 27, 2026)

1,184+ confirmed malicious skills on ClawHub (OpenClaw's official skill marketplace). The #1 most downloaded skill was malware distributing Atomic macOS Stealer (AMOS), which harvests SSH keys, crypto wallets, browser cookies, and opens reverse shells.

- **Mitigation:** Never install unvetted ClawHub skills. Maintain a private curated allowlist. Scan with VirusTotal before installation.

### Public Exposure at Scale

Censys tracked 21,000+ publicly exposed OpenClaw instances (Jan 25-31, 2026). Our deployment binds to loopback + Tailscale only, which avoids this class of exposure.

---

## Internal Audit Findings

### CRITICAL

#### 1. No SSH Host Key Verification (MITM Vulnerability)

**File:** `src/infra/ssh.ts`, lines 49-54, 98-103, 146-151

All SSH functions (`exec`, `upload`, `download`) connect without any `hostVerify` callback. The `ssh2` client defaults to accepting any host key. Every SSH connection is vulnerable to man-in-the-middle attacks. An attacker who can intercept traffic between alfred-ctrl and a provisioned server can:

- Intercept the LUKS keyfile download
- Intercept API keys and restic credentials uploaded via SSH
- Execute arbitrary commands by manipulating SSH session output

```typescript
// No host key verification
conn.connect({
  host,
  port: 22,
  username: user,
  privateKey,
});
```

**Recommendation:** Pin the host key fingerprint at server creation time (Acme Cloud returns it in the server creation response or it can be retrieved on first connection). Store in the database. Verify on every subsequent connection using the `hostVerify` callback.

---

#### 2. LUKS Keyfile Stored Unencrypted

**File:** `src/templates/cloud-init.yaml.njk`, lines 67-69; `src/infra/provisioner.ts`, line 326

The LUKS keyfile is stored in plaintext at `/opt/alfred/luks.key` on the server (mode 0600, root-owned). Combined with the auto-unlock systemd service, LUKS encryption provides zero additional protection if the running server is compromised — root access gives immediate access to the key. The keyfile is also backed up in plaintext to the control plane's local filesystem (`data/ssh_keys/<id>/luks.key`).

**Recommendation:** Encrypt the local backup using age or GPG. Consider whether auto-unlock on boot is required, or whether manual operator unlock is acceptable for the security gain.

---

#### 3. Generated LUKS Passphrase is Dead Code

**File:** `src/infra/provisioner.ts`, lines 104-105

A LUKS passphrase is generated (`crypto.randomBytes(32).toString("hex")`) but never passed to the cloud-init template or used anywhere. The cloud-init template uses a keyfile, not a passphrase. This dead code suggests a design mismatch.

```typescript
const luks_passphrase =
  config.luks_passphrase ?? crypto.randomBytes(32).toString("hex");
// luks_passphrase is never used after this line
```

**Recommendation:** Remove the dead code, or wire the passphrase as a secondary LUKS unlock method for disaster recovery (`cryptsetup luksAddKey`).

---

### HIGH

#### 4. Unrestricted Passwordless Sudo

**File:** `src/templates/cloud-init.yaml.njk`, line 7

The `deploy` user has unrestricted passwordless sudo (`ALL=(ALL) NOPASSWD:ALL`). If an attacker gains access to the deploy account (e.g., compromised SSH key), they have immediate full root access.

**Recommendation:** Restrict sudo to only required commands:
```
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/bin/docker, /usr/bin/docker-compose, /usr/sbin/cryptsetup, /usr/bin/tailscale
```

---

#### 5. Tailscale Auth Key Persisted on Disk

**File:** `src/templates/bootstrap-openclaw.sh.njk`, line 8; `src/infra/provisioner.ts`, lines 273-279

The Tailscale auth key is rendered into the bootstrap script uploaded to `/opt/alfred/bootstrap.sh` with mode 0755 (world-readable). Even though the key is single-use and short-lived, the script remains on disk indefinitely and could leak the key pattern.

**Recommendation:** Delete the bootstrap script after successful execution. Set file mode to 0700 instead of 0755.

---

#### 6. Template Injection via customer_name

**File:** `src/infra/provisioner.ts`, line 23

Nunjucks auto-escaping is disabled (`autoescape: false`). User-controlled input (`customer_name`) is interpolated into shell scripts and YAML templates without sanitization. A malicious name like `'; rm -rf / #` could inject arbitrary shell commands via the bootstrap script.

**Recommendation:** Validate `customer_name` against `/^[a-zA-Z0-9_-]+$/` before use. Validate all template inputs.

---

#### 7. API Keys Hardcoded in docker-compose.yaml

**File:** `src/templates/docker-compose.yaml.njk`, lines 10, 46, 70

The `OPENROUTER_API_KEY` is baked directly into the rendered docker-compose.yaml. Anyone with read access to the file can extract the key. Environment variables set this way are also visible via `docker inspect` and `/proc/<pid>/environ`.

**Recommendation:** Use Docker `env_file` directive pointing to the already-uploaded `.env` file with restricted permissions (0600), and reference `${OPENROUTER_API_KEY}` from the env file instead of hardcoding.

---

#### 8. No Container Security Hardening

**File:** `src/templates/docker-compose.yaml.njk`, all services

No container has any of the following security controls:
- `security_opt: [no-new-privileges:true]`
- `read_only: true` (read-only root filesystem)
- `cap_drop: [ALL]` (drop all Linux capabilities)
- Resource limits (`mem_limit`, `cpus`, `pids_limit`)
- `tmpfs` mounts for writable temp directories

A container escape or vulnerability in any image gives unrestricted access to all encrypted data volumes.

**Recommendation:** Add to all services:
```yaml
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
mem_limit: 2g
pids_limit: 256
```
Add `read_only: true` with explicit `tmpfs` mounts where writable paths are needed.

---

#### 9. Restic Password Backup Failure Silently Ignored

**File:** `src/infra/provisioner.ts`, lines 219-231

The restic backup password is generated randomly and uploaded to the server. The local backup attempt catches and logs failures as a warning. If the local backup fails, the restic repository password is lost — making ALL backups permanently irrecoverable.

```typescript
} catch {
  log("Warning: could not backup restic credentials locally");
}
```

**Recommendation:** Make this a hard failure (throw). The restic password must be persisted locally or provisioning should abort.

---

#### 10. Tailscale Installed via curl | sh

**File:** `src/templates/cloud-init.yaml.njk`, line 53

```yaml
- curl -fsSL https://tailscale.com/install.sh | sh
```

Classic supply chain risk. If the Tailscale CDN is compromised, DNS is poisoned, or MITM occurs during cloud-init (before Tailscale is installed), arbitrary code executes as root.

**Recommendation:** Install from the official APT repository with GPG key verification:
```yaml
- curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
- curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list | tee /etc/apt/sources.list.d/tailscale.list
- apt-get update && apt-get install -y tailscale
```

---

### MEDIUM

#### 11. SSH Open to Entire Internet

**File:** `src/infra/firewall.ts`, lines 8-10; `src/templates/cloud-init.yaml.njk`, line 36

Both the Acme Cloud cloud firewall and UFW allow SSH from `0.0.0.0/0`. After Tailscale is configured, SSH should only be accessible via the tailnet.

**Recommendation:** After Tailscale bootstrap completes, restrict SSH to the Tailscale interface only. Long-term: use Tailscale SSH to eliminate the public SSH port entirely.

---

#### 12. IP Addresses Leaked in Alert Webhooks

**File:** `src/monitoring/alerts.ts`, lines 28, 53

Server IP addresses are included in Slack/Discord alert messages. If the webhook URL or channel is compromised, attackers learn the public IPs of all servers.

**Recommendation:** Use Tailscale hostnames instead of IP addresses in alerts. Make IP inclusion configurable.

---

#### 13. Fail2ban Bantime Too Short

**File:** `src/templates/cloud-init.yaml.njk`, line 47

Ban time is 3600 seconds (1 hour). With `maxretry=3` and `findtime=600`, an attacker can attempt 3 passwords every 10 minutes with only a 1-hour penalty.

**Recommendation:** Increase to `bantime = 86400` (24 hours) or use `bantime.increment = true` for progressive banning. Consider permanent bans (`bantime = -1`) since legitimate access is key-based only.

---

#### 14. docker-compose.yaml World-Readable

**File:** `src/infra/provisioner.ts`, lines 239-247

The docker-compose.yaml is uploaded without specifying a file mode, defaulting to 0644 (world-readable). Since it may contain API keys (see #7), any local user can read it.

**Recommendation:** Set mode to 0600 for docker-compose.yaml and .env files.

---

#### 15. No API Token Rotation Mechanism

**File:** `src/infra/acme-cloud.ts`, lines 208-216

The Acme Cloud API token is loaded once and cached in a module-level singleton. No rotation mechanism, no expiry check. If compromised, an attacker has full read/write access to all Acme Cloud resources (create/delete servers, volumes, etc.).

**Recommendation:** Document token rotation procedures. Monitor for unauthorized API usage via Acme Cloud audit logs.

---

#### 16. SSH Key Storage Depends on process.cwd()

**File:** `src/infra/keys.ts`, line 15

SSH private keys are stored under `path.join(process.cwd(), "data", "ssh_keys", ...)`. If the process working directory changes, keys may be stored in unexpected or insecure locations.

**Recommendation:** Use an explicit, configurable base directory via environment variable (e.g., `ALFRED_DATA_DIR`).

---

#### 17. Health Check JSON Built via String Interpolation

**File:** `src/templates/cloud-init.yaml.njk`, lines 146-152; `src/monitoring/health.ts`, line 49

The healthcheck script constructs JSON by string interpolation of shell command output. Unexpected output (error messages, locale issues) could produce malformed JSON or injected content.

```bash
echo "{\"containers\":${containers},\"disk_percent\":${disk_pct},\"memory_percent\":${mem_pct}}"
```

**Recommendation:** Use `jq` (already installed) to construct JSON safely:
```bash
jq -n --argjson c "$containers" --arg d "$disk_pct" --arg m "$mem_pct" \
  '{containers: $c, disk_percent: ($d|tonumber), memory_percent: ($m|tonumber)}'
```

---

#### 18. Backup Service Runs as Root

**File:** `src/templates/cloud-init.yaml.njk`, lines 201-211

The `alfred-backup.service` has no `User=` directive, so it runs as root. The backup script sources env files and runs restic with more privileges than necessary.

**Recommendation:** Run as the `deploy` user, or create a dedicated backup user with read-only access to `/mnt/encrypted`.

---

### LOW

#### 19. No Egress Filtering

**File:** `src/templates/cloud-init.yaml.njk`, line 35

UFW allows all outgoing traffic. If a container is compromised, it can freely exfiltrate data or establish C2 connections.

**Recommendation:** Restrict outgoing to required destinations (Docker Hub, Tailscale coordination, Acme Cloud API, S3 backup endpoint). Consider a Squid egress proxy.

---

#### 20. Docker Images Use Mutable :latest Tag

**File:** `src/templates/docker-compose.yaml.njk`, lines 3, 14, 31, 58

All images use `:latest`, which is mutable. A compromised registry could push malicious images.

**Recommendation:** Pin images by digest (`image: ssdavidai00/alfred-init@sha256:...`) or use immutable version tags. Sign images with cosign.

---

#### 21. Auto-Update Timer With No Verification

**File:** `src/templates/cloud-init.yaml.njk`, lines 111-136

The `alfred-update.timer` pulls and deploys new Docker images every 15 minutes without signature verification, health check, or rollback mechanism.

**Recommendation:** Add Docker Content Trust or cosign verification. Add a post-deploy health check with automatic rollback on failure.

---

#### 22. Silent Alert Failures

**File:** `src/monitoring/alerts.ts`, lines 79-81

Alert delivery failures are silently swallowed. If the webhook is misconfigured or the endpoint is down, no alerts will be delivered and no one will know.

**Recommendation:** Log alert failures. Implement a secondary channel or local fallback.

---

#### 23. ICMP Allowed from All Sources

**File:** `src/infra/firewall.ts`, lines 13-16

ICMP from `0.0.0.0/0` enables host discovery and potential ICMP-based attacks.

**Recommendation:** Rate-limit ICMP or restrict to Tailscale/operator IP range.

---

#### 24. Incomplete SSH Hardening

**File:** `src/templates/cloud-init.yaml.njk`, lines 29-31

Only root login is disabled. Missing hardening: `MaxAuthTries`, `ClientAliveInterval`, `AllowUsers`, `X11Forwarding no`, `AllowAgentForwarding no`, `AllowTcpForwarding no`.

**Recommendation:** Add comprehensive sshd_config hardening.

---

#### 25. Error Messages Leak Infrastructure Details

**File:** `src/infra/acme-cloud.ts`, lines 68-72; `src/infra/tailscale.ts`, lines 34-35

API error responses include full error bodies from Acme Cloud and Tailscale, which could leak API endpoints, token validity status, and internal details if surfaced to users.

**Recommendation:** Sanitize error messages before user-facing display. Log full details internally only.

---

## Summary

| Severity | Count | Fixed |
|----------|-------|-------|
| CRITICAL | 3 | 0 |
| HIGH | 7 | 5 |
| MEDIUM | 8 | 5 |
| LOW | 7 | 0 |
| **Total** | **25** | **10** |

## Remediation Status (2026-02-27)

| # | Finding | Status | Notes |
|---|---------|--------|-------|
| 1 | No SSH Host Key Verification | OPEN | SSH host key is now pinned during cloud-init (captured on first connection), but `ssh2` still needs `hostVerify` callback |
| 2 | LUKS Keyfile Stored Unencrypted | OPEN | |
| 3 | Generated LUKS Passphrase Dead Code | OPEN | |
| 4 | Unrestricted Passwordless Sudo | FIXED | Deploy user now has scoped sudo rules in cloud-init |
| 5 | Tailscale Auth Key Persisted | FIXED | Bootstrap script deleted after run, mode 0700 |
| 6 | Template Injection via customer_name | FIXED | `customer_name` validated: `/^[a-zA-Z0-9_-]+$/` |
| 7 | API Keys in docker-compose | FIXED | Using `env_file:` directive, keys in `.env` (0600) |
| 8 | No Container Hardening | FIXED | All containers have `no-new-privileges`, `cap_drop: ALL`, mem/pid limits |
| 9 | Restic Password Backup Silently Ignored | FIXED | Now a hard error — provisioning aborts if local backup fails |
| 10 | Tailscale curl\|sh | FIXED | Installed via APT with GPG key verification |
| 11 | SSH Open to Internet | FIXED | Acme Cloud firewall restricts SSH to admin CIDRs (`ADMIN_SSH_CIDRS` env var) |
| 12 | IPs in Alert Webhooks | OPEN | |
| 13 | Fail2ban Bantime | OPEN | |
| 14 | docker-compose World-Readable | FIXED | Uploaded with mode 0600 |
| 15 | No API Token Rotation | OPEN | |
| 16 | SSH Key path.cwd() | OPEN | |
| 17 | Health Check String Interpolation | FIXED | JSON now constructed with jq |
| 18 | Backup Service Runs as Root | OPEN | |
| 19 | No Egress Filtering | OPEN | |
| 20 | Docker :latest Tag | OPEN | |
| 21 | Auto-Update No Verification | OPEN | |
| 22 | Silent Alert Failures | OPEN | |
| 23 | ICMP from All | OPEN | |
| 24 | Incomplete SSH Hardening | FIXED | Comprehensive sshd_config hardening via drop-in |
| 25 | Error Messages Leak Details | FIXED | SaaS proxy sanitizes tenant API errors |

---

## Network Architecture (2026-02-27)

### Layer 1: Admin Tailnet

All VMs join a single Tailscale tailnet. The control plane VM is tagged `tag:admin`, all tenant VMs are tagged `tag:tenant`. ACL policy (see `docs/tailscale-acl-policy.jsonc`) ensures:

- Admin can access all tenant VMs (SSH, Temporal UI :8233, tenant API :3100)
- Tenant VMs CANNOT reach each other (implicit deny)
- Tenant VMs CANNOT initiate connections to admin

Individual VMs are identified by Tailscale hostname (`alfred-{customer_name}`).

### Layer 2: Cloudflare Tunnel (User-Facing)

Each tenant VM runs a `cloudflared` daemon that creates an outbound-only tunnel to Cloudflare's edge. User traffic flows: `{subdomain}.alfred.black` → Cloudflare edge → tunnel → `localhost:18789` (OpenClaw).

- No inbound ports needed for user traffic
- HTTPS termination at Cloudflare edge
- DNS records: CNAME `{subdomain}.alfred.black` → `{tunnel-id}.cfargotunnel.com`

### Layer 3: Acme Cloud Cloud Firewall

Inbound rules (everything else denied):

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 22/tcp | TCP | Admin CIDRs | Emergency SSH |
| 41641/udp | UDP | 0.0.0.0/0 | Tailscale WireGuard |
| ICMP | ICMP | 0.0.0.0/0 | Health/reachability |

### Layer 4: Host Firewall (UFW)

Mirrors Acme Cloud firewall rules plus Tailscale UDP. SSH hardened with:
- MaxAuthTries 3, MaxSessions 3
- X11Forwarding, AllowTcpForwarding disabled
- ClientAlive 5min timeout
- fail2ban (3 tries, 1h ban)

### Provisioning Flow

1. Generate Ed25519 keypair
2. Upload SSH key to Acme Cloud
3. Create hardened firewall (Tailscale UDP + admin SSH)
4. Create LUKS-encrypted volume
5. Render cloud-init (installs Docker, Tailscale APT, cloudflared APT, SSH hardening)
6. Create server with firewall attached
7. Wait for cloud-init completion
8. Upload secrets via SSH (never in cloud-init user_data)
9. Configure restic backups (hard failure if backup fails)
10. Upload docker-compose.yaml (mode 0600)
11. Start containers
12. Bootstrap OpenClaw + Tailscale
13. Backup LUKS key
14. **Create Cloudflare Tunnel + DNS record**
15. Deploy tenant API
16. Health check + subdomain reachability verification

### Destroy Flow

1. Delete Cloudflare Access app (if configured)
2. Delete Cloudflare DNS record
3. Delete Cloudflare Tunnel
4. Delete Acme Cloud server
5. Delete Acme Cloud volume
6. Delete Acme Cloud SSH key

## Priority Remediation Order (Remaining)

1. SSH host key verification via `hostVerify` callback (#1)
2. Encrypt local LUKS key backup (#2)
3. Remove dead LUKS passphrase code (#3)
4. Pin Docker images by digest (#20)
5. Add egress filtering (#19)
6. Increase fail2ban bantime (#13)
7. Run backup as non-root (#18)
8. Use Tailscale hostnames in alerts (#12)
