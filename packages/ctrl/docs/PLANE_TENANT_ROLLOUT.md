# Plane tenant rollout checklist

Run this end-to-end when enabling Plane on a new tenant (e.g. Miguel,
Rapali, or whoever is next). Every step is idempotent; you can re-run
the whole procedure and it will only do the work that hasn't happened
yet.

For day-2 operations (failure modes, cursor files, loop guards), see
[`packages/learn/docs/PLANE_SYNC_OPERATIONS.md`](../../learn/docs/PLANE_SYNC_OPERATIONS.md).
For field mapping, see
[`packages/learn/docs/PLANE_SYNC_DATA_MODEL.md`](../../learn/docs/PLANE_SYNC_DATA_MODEL.md).

## Prerequisites

- Tenant VPS is up and healthy: `docker compose ps` shows `ctrl-api`,
  `openclaw`, `temporal`, `alfred`, `alfred-learn` in `Up (healthy)`.
- Tenant ctrl-api :3100 responds to a bearer-authed probe:
  ```bash
  AAS=$(grep ^AAS_API_KEY /opt/alfred/compose/.env | cut -d= -f2)
  curl -s -H "Authorization: Bearer $AAS" http://localhost:3100/api/v1/vault/context | jq .status
  # expect: "ok"
  ```
- Host has ≥ 12 GiB free RAM and ≥ 30 GiB free disk for the Plane
  stack (12 extra containers). `cx53` (the default) has enough.
- LUKS-encrypted volume mounted at `/mnt/encrypted`.
- You have SSH access with an identity file: `ssh -o IdentityAgent=none
  -i ~/.ssh/alfred-<slug>-<id> deploy@<tailscale-ip>`.
- You have `ctrl` built locally, or access to an `alfred-ctrl` admin
  shell that can run `deployPlane(instanceId)`.
- Cloudflare API token (for step 3) in your local
  `packages/ctrl/.env` as `CLOUDFLARE_API_TOKEN`.

## Worked example: David

We'll use David as the concrete example throughout.

| Placeholder      | David's value                            |
|------------------|------------------------------------------|
| `<tenant-slug>`  | `david`                                  |
| `<domain>`       | `alfred.black`                           |
| `<subdomain>`    | `david`                                  |
| `<tailscale-ip>` | `100.119.63.29`                          |
| `<ssh-key>`      | `~/.ssh/alfred-david-99`                 |
| `<compose-dir>`  | `/opt/alfred/compose`                    |

## Step 1 — enable Plane in compose

The compose block is gated by `plane_enabled: true` at render time. The
easiest path is to let the provisioner do it via `deployPlane`.

### Option A — from the ctrl admin host (preferred)

```bash
# On your laptop, in the alfred-ctrl repo root.
node dist/index.mjs deploy-plane <tenant-slug>
# e.g.
node dist/index.mjs deploy-plane david
```

`deployPlane` in `packages/ctrl/src/infra/provisioner.ts`:

1. Connects via SSH.
2. Creates `/mnt/encrypted/plane/{pgdata,redis,rabbitmq,uploads}` (mode 700).
3. Re-renders `docker-compose.yaml` with `plane_enabled: true` and
   uploads it to `<compose-dir>/docker-compose.yaml` (mode 600).
4. Seeds baseline secrets in `.env` if missing:
   `DJANGO_SECRET_KEY`, `REDIS_PASSWORD`, `POSTGRES_PASSWORD`,
   `MINIO_ROOT_PASSWORD`, `LIVE_SERVER_SECRET_KEY` (32 hex bytes each).
5. `docker compose pull plane-db plane-redis plane-mq plane-minio
   plane-api plane-worker plane-beat plane-web plane-space plane-admin
   plane-live plane-proxy` (up to ~3 min on first pull).
6. `docker compose up -d` for the same 12 services.
7. Calls `setupPlane` (step 2 below).

### Option B — manual

Useful when the provisioner can't reach the tenant, or you want to inspect
each step.

```bash
# SSH to the tenant.
ssh -o IdentityAgent=none -i <ssh-key> deploy@<tailscale-ip>

# Seed baseline secrets.
cd /opt/alfred/compose
for K in DJANGO_SECRET_KEY REDIS_PASSWORD POSTGRES_PASSWORD MINIO_ROOT_PASSWORD LIVE_SERVER_SECRET_KEY; do
  grep -q "^$K=" .env || printf "%s=%s\n" "$K" "$(openssl rand -hex 32)" | sudo tee -a .env > /dev/null
done
sudo chmod 600 .env

# Ensure persistent dirs exist.
sudo mkdir -p /mnt/encrypted/plane/{pgdata,redis,rabbitmq,uploads}
sudo chmod 700 /mnt/encrypted/plane

# Upload the new compose yaml (produced locally with plane_enabled=true).
# From your laptop, in packages/ctrl:
node -e '
  const nunjucks = require("nunjucks");
  const fs = require("fs");
  const tpl = fs.readFileSync("src/templates/docker-compose.yaml.njk", "utf-8");
  console.log(nunjucks.renderString(tpl, { plane_enabled: true }));
' > /tmp/docker-compose.yaml

scp -o IdentityAgent=none -i <ssh-key> /tmp/docker-compose.yaml \
  deploy@<tailscale-ip>:/opt/alfred/compose/docker-compose.yaml

# Back on the tenant.
docker compose pull plane-db plane-redis plane-mq plane-minio plane-api \
  plane-worker plane-beat plane-web plane-space plane-admin plane-live plane-proxy
docker compose up -d plane-db plane-redis plane-mq plane-minio plane-api \
  plane-worker plane-beat plane-web plane-space plane-admin plane-live plane-proxy
```

### Verification

```bash
docker compose ps --filter name=plane-
# Expect 12 services; plane-migrator should show "Exited (0)", the other 11
# eventually go "Up (healthy)". Full pull + first-boot migrations take
# 3-8 min depending on disk speed. plane-worker + plane-beat are healthy
# once plane-migrator completes.
```

Common pitfalls at this step — see
[PLANE_SYNC_OPERATIONS.md failure modes](../../learn/docs/PLANE_SYNC_OPERATIONS.md#failure-modes)
for the full table. Short list:

- `plane-api` stuck unhealthy: check `plane-migrator` completed cleanly
  (`docker compose logs plane-migrator`). If not, migrator died; restart
  it with `docker compose up -d --force-recreate plane-migrator` and
  tail its logs.
- `plane-proxy` crash-loops with `SITE_ADDRESS` missing: the compose
  template already sets it, but double-check with
  `docker inspect compose-plane-proxy-1 | jq '.[0].Config.Env'`.

## Step 2 — setup_plane bootstrap

`setupPlane` in `packages/ctrl/src/infra/provisioner.ts` runs one
Django `manage.py shell` script inside `plane-api` that:

1. Ensures the Instance row has `is_setup_done=True`.
2. Creates super-admin `admin@<subdomain>.<domain>` (or reuses existing
   by email). Password is auto-generated and persisted to `.env` first
   so a crash mid-bootstrap leaves a resumable state.
3. Creates the `Alfred Black` Plane user `alfred@<subdomain>.<domain>`
   (unusable password; he acts via API token).
4. Creates the workspace (slug from `planeSlug(subdomain)` — lowercased,
   `[a-z0-9-]+`-only, 2–48 chars, fallback prefix `alfred-` if too short).
5. Adds both users as workspace members with role `20` (admin).
6. Creates an `APIToken` for `alfred` labelled `alfred-ctrl`.
7. Creates the workspace webhook pointing at
   `https://<subdomain>.<domain>/api/v1/plane/webhook` with the
   HMAC secret.
8. Prints `__PLANE_BOOT__{...JSON...}` with the generated values.

The provisioner parses the JSON and writes to `.env`:

```
PLANE_ADMIN_EMAIL=admin@<subdomain>.<domain>
PLANE_ADMIN_PASSWORD=<auto-generated>
PLANE_API_TOKEN=<alfred-api-token>
PLANE_WORKSPACE_SLUG=<workspace-slug>
PLANE_ALFRED_USER_ID=<alfred-user-uuid>
PLANE_WEBHOOK_SECRET=<32-hex-bytes>
PLANE_API_BASE_URL=http://plane-proxy/
PLANE_SYNC_ENABLED=true
```

Idempotency fast-path: if `PLANE_API_TOKEN`, `PLANE_WORKSPACE_SLUG`,
`PLANE_ALFRED_USER_ID`, `PLANE_WEBHOOK_SECRET` are all present,
`setupPlane` returns immediately without running the bootstrap.

If `deployPlane` failed at a later step and you need just the bootstrap:

```bash
# On the tenant.
docker exec compose-plane-api-1 python manage.py shell <<'PY'
# (inspect — don't re-run blind; setupPlane handles the idempotent path)
from plane.db.models import User, Workspace, APIToken, Webhook
print("admins:", [u.email for u in User.objects.filter(is_superuser=True)])
print("workspaces:", [ws.slug for ws in Workspace.objects.all()])
print("webhooks:", [wh.url for wh in Webhook.objects.all()])
PY
```

### Verification

```bash
# On the tenant.
for K in PLANE_API_TOKEN PLANE_WORKSPACE_SLUG PLANE_ALFRED_USER_ID \
         PLANE_WEBHOOK_SECRET PLANE_API_BASE_URL PLANE_SYNC_ENABLED; do
  grep -E "^$K=" /opt/alfred/compose/.env | head -1 \
    | sed -E "s/(PASSWORD|TOKEN|SECRET)=.*/\1=<redacted>/"
done
```

## Step 3 — DNS + Cloudflared ingress for the Plane UI

Plane's UI is served by `plane-proxy` on compose-network port 80,
host-side `127.0.0.1:8080`. To expose it externally you add a new
Cloudflare DNS record + ingress rule.

**Critical**: use a single-level subdomain like
`<subdomain>-plane.<domain>` (e.g. `david-plane.alfred.black`). The
wildcard cert for `*.alfred.black` covers one level only —
`plane.<subdomain>.alfred.black` would need a multi-level wildcard that
we don't have.

### 3a — Cloudflare DNS record

Either via the Cloudflare dashboard, or scripted from the local
`alfred-ctrl`:

```bash
# On your laptop, assuming CLOUDFLARE_API_TOKEN + zone id available.
TUNNEL_ID=$(sqlite3 packages/ctrl/data/alfred-ctrl.db \
  "SELECT tunnel_id FROM instances WHERE subdomain='<subdomain>'")
ZONE_ID=<alfred.black-zone-id>

curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data @- <<JSON
{
  "type": "CNAME",
  "name": "<subdomain>-plane",
  "content": "${TUNNEL_ID}.cfargotunnel.com",
  "proxied": true,
  "ttl": 1
}
JSON
```

Worked example (David):

```
name:     david-plane
content:  3a1c…-…-…-….cfargotunnel.com    (David's tunnel id)
proxied:  true
```

### 3b — cloudflared ingress

Extend the existing cloudflared config on the tenant. The shipped
template (`packages/ctrl/src/templates/cloudflared-config.yaml.njk`)
only includes the base subdomain. Add the Plane rule by hand OR extend
the template locally and re-upload:

```yaml
# /etc/cloudflared/config.yml on the tenant
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: <subdomain>.<domain>
    path: /api/v1/*
    service: http://localhost:3100
  - hostname: <subdomain>.<domain>
    path: /terminal
    service: http://localhost:3100
  - hostname: <subdomain>.<domain>
    service: http://localhost:18789
  # NEW — Plane UI on a dedicated subdomain.
  - hostname: <subdomain>-plane.<domain>
    service: http://localhost:8080
  - service: http_status:404
```

Reload cloudflared:

```bash
# On the tenant.
sudo systemctl reload cloudflared
# or, if running under systemd: sudo systemctl restart cloudflared
# verify:
sudo journalctl -u cloudflared --since "1 min ago" | tail -20
```

### Verification

```bash
# From your laptop.
curl -I https://<subdomain>-plane.<domain>/
# expect: HTTP/2 200 (or 301 to /spaces/)
```

## Step 4 — WEB_URL in tenant .env

`plane-api` uses `WEB_URL` to build absolute URLs in webhook payloads,
email links, etc. Currently the compose template sets
`WEB_URL=http://plane-proxy:8080` (internal network address) by default.
Override to the external URL:

```bash
# On the tenant.
sudo sed -i '/^WEB_URL=/d' /opt/alfred/compose/.env
echo "WEB_URL=https://<subdomain>-plane.<domain>" | sudo tee -a /opt/alfred/compose/.env
sudo chmod 600 /opt/alfred/compose/.env

# Recreate plane-api + plane-worker to pick up the new env.
cd /opt/alfred/compose
docker compose up -d --force-recreate plane-api plane-worker plane-beat
```

Worked example (David):
`WEB_URL=https://david-plane.alfred.black`

**Do not** change `PLANE_API_BASE_URL`. That's the address alfred-learn
uses to reach Plane inside the compose network — it stays
`http://plane-proxy/`. The two env vars serve different purposes.

## Step 5 — enable PLANE_SYNC_ENABLED

`setupPlane` writes `PLANE_SYNC_ENABLED=true` as part of step 2. If you
got here via a manual path, set it now:

```bash
# On the tenant.
sudo sed -i 's/^PLANE_SYNC_ENABLED=.*/PLANE_SYNC_ENABLED=true/' /opt/alfred/compose/.env
grep -q '^PLANE_SYNC_ENABLED=' /opt/alfred/compose/.env || \
  echo "PLANE_SYNC_ENABLED=true" | sudo tee -a /opt/alfred/compose/.env

# Recreate alfred-learn so register_schedules.py runs with the new env.
cd /opt/alfred/compose
docker compose up -d --force-recreate alfred-learn

# Tail the schedule registration.
docker compose logs --tail=50 alfred-learn 2>&1 | grep -E 'register-schedules|al-plane'
# Expect:
#   Created schedule: al-plane-sync → PlaneSyncWorkflow (15s, SKIP overlap)
#   Created schedule: al-plane-reverse-sync → PlaneReverseSyncWorkflow (10s, SKIP overlap)
```

## Step 6 — verify end-to-end

### 6a — schedules registered

```bash
docker exec compose-temporal-1 tctl --address 127.0.0.1:7233 schedule list \
  | grep -E 'al-plane-(sync|reverse-sync)'
# Expect two lines.
```

### 6b — forward sync creates projects

The first successful forward tick will create one Plane project per
matter in the vault, plus the Inbox project, plus one issue per task.

```bash
# On the tenant — wait up to 60s after alfred-learn recreate.
docker compose logs --tail=200 alfred-learn 2>&1 | grep -E 'plane_sync\.(start|done|project_upsert)'
```

Expected counter progression on first run (David, with 12 matters +
~280 tasks):

```
plane_sync.start
plane_sync.project_upsert slug=client-acme plane_id=<uuid> action=create
plane_sync.project_upsert slug=... action=create  (12 times)
plane_sync.inbox_project_created plane_id=<uuid>
plane_sync.issue_upsert slug=... action=create   (up to 188 times in this tick,
                                                  remainder spills to next tick)
plane_sync.done matters=12 tasks=188 skipped=0 errors=0 cursor=<epoch>
```

If the count stays at 0 for a minute, check the Failure modes table in
`PLANE_SYNC_OPERATIONS.md` — most common cause is
[`_iso_to_epoch` filtering out every record](../../learn/docs/PLANE_SYNC_OPERATIONS.md#failure-modes)
(fixed in #569 but watch for regressions).

### 6c — webhook round-trip

Synthetic POST with a correct HMAC:

```bash
# On the tenant.
SECRET=$(grep ^PLANE_WEBHOOK_SECRET /opt/alfred/compose/.env | cut -d= -f2)
BODY='{"event":"project","action":"updated","data":{"id":"synthetic-test","name":"smoke","external_id":"alfred:does-not-exist"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -s -X POST "http://localhost:3100/api/v1/plane/webhook" \
  -H "Content-Type: application/json" \
  -H "X-Plane-Signature: sha256=$SIG" \
  -H "X-Plane-Delivery: synthetic-$(date +%s)" \
  --data-raw "$BODY"
# Expect: {"ok":true,"delivery":"synthetic-...","forwarded":true}

# The event will surface in al-plane-reverse-sync's next tick as an
# "unknown_events" increment (because alfred:does-not-exist doesn't
# match any vault record). Confirms the webhook → stream → workflow
# path works.
docker compose logs --tail=50 alfred-learn 2>&1 | grep plane_reverse_sync.done | tail -1
```

### 6d — open the Plane UI

```
https://<subdomain>-plane.<domain>/
```

Log in with `PLANE_ADMIN_EMAIL` + `PLANE_ADMIN_PASSWORD` from the tenant
`.env`. You should see one workspace (`<workspace-slug>`) containing
12+ projects plus `Inbox`.

## Post-provision: optional matter backfill

If the tenant already had orphan tasks (no `matter` / `related_matter` /
`related_matters`) when sync flipped on, those tasks routed to Inbox.
That's working as designed, but you may want to:

1. Open the `Inbox` project in the Plane UI.
2. Drag each issue into its right matter project.
3. Reverse-sync picks up the `issue.updated` event, looks up the new
   project's slug via `plane_project_to_slug`, writes
   `related_matters=[<slug>]` + scalar `matter=<slug>` onto the vault
   task.
4. On the next forward tick, the issue gets updated in-place — no
   duplicate is created.

You can also do the reassignment directly in the vault
(`related_matters: [<slug>]`), but the Plane UI is faster for bulk work.

## Smoke tests (humans-in-the-loop)

Run each of these and time the round-trip. All three should complete
within the specified budget. If any takes longer than 2x budget, stop
and diagnose — probably a stuck workflow run; see
[deploying-code-changes](../../learn/docs/PLANE_SYNC_OPERATIONS.md#deploying-code-changes-to-running-tenants).

| Scenario                                              | Expected budget     | What to watch                                                      |
|-------------------------------------------------------|---------------------|--------------------------------------------------------------------|
| Edit a matter description in the vault (via API).     | Plane reflects ≤15s | `al-plane-sync` next tick; project `description_text` updates.    |
| Rename a matter in Plane UI.                          | Vault reflects ≤10s | `al-plane-reverse-sync` picks up `project.updated`; matter `name` changes. |
| Drag an Inbox issue into a matter project in Plane.   | Vault reflects ≤10s | Task `related_matters` + scalar `matter` update.                   |
| Create a fresh issue in Plane UI (human-created, no `external_id`). | Vault creates ≤10s | `tasks_created: 1` in reverse-sync summary. New `task/<slug>.md`. |
| Mark a vault task `done`.                             | Plane reflects ≤15s | Issue state changes to the project's "Completed" state.            |

Observe counters stay stable — no forward/reverse oscillation:

```bash
# Watch for 5 minutes. Counters should return to 0 within 2-3 ticks
# after the last edit.
watch -n 10 "docker compose logs --tail=50 alfred-learn 2>/dev/null \
  | grep -E 'plane_sync\.done|plane_reverse_sync\.done' | tail -6"
```

If you see counters climbing for the same slug across ticks, a loop
guard is mis-computing. Stop and read
[PLANE_SYNC_OPERATIONS.md loop guards](../../learn/docs/PLANE_SYNC_OPERATIONS.md#loop-guards).

## Rollback procedure

Take these in order. Anything past step 3 means you're destroying data
(Plane's own Postgres); get explicit sign-off first.

### Step R1 — disable the sync

```bash
# On the tenant. Vault + Plane stop talking but both keep running.
sudo sed -i 's/^PLANE_SYNC_ENABLED=.*/PLANE_SYNC_ENABLED=false/' /opt/alfred/compose/.env
cd /opt/alfred/compose
docker compose up -d --force-recreate alfred-learn
```

Both schedules get deleted on the next worker boot. Workflows
short-circuit at the feature-flag check. Plane UI still works, vault
still works — they're just independent again.

### Step R2 — delete the Plane webhook (optional)

Stops Plane from even attempting to deliver events. The webhook
endpoint on ctrl-api will keep accepting them, but the stream queue
stops growing.

```bash
# On the tenant.
docker exec compose-plane-api-1 python manage.py shell <<'PY'
from plane.db.models import Webhook
w = Webhook.objects.filter(url__endswith="/api/v1/plane/webhook").first()
if w: w.delete()
print("deleted" if w else "no webhook")
PY
```

### Step R3 — stop the 12 Plane services

```bash
# On the tenant.
cd /opt/alfred/compose
docker compose stop plane-db plane-redis plane-mq plane-minio plane-api \
  plane-worker plane-beat plane-web plane-space plane-admin plane-live plane-proxy
# Optional: docker compose rm -f <same list>
```

The rest of the Alfred stack is unaffected.

### Step R4 — purge Plane state (destructive)

Only if you want a clean re-provision. Destroys Plane's Postgres, Redis,
Rabbitmq, and minio uploads. Vault is untouched.

```bash
# On the tenant.
cd /opt/alfred/compose
docker compose down plane-db plane-redis plane-mq plane-minio plane-api \
  plane-worker plane-beat plane-web plane-space plane-admin plane-live \
  plane-proxy plane-migrator
sudo rm -rf /mnt/encrypted/plane/{pgdata,redis,rabbitmq,uploads}

# Remove Plane-specific env keys so a future setupPlane starts fresh.
for K in PLANE_API_TOKEN PLANE_WORKSPACE_SLUG PLANE_ALFRED_USER_ID \
         PLANE_WEBHOOK_SECRET PLANE_ADMIN_EMAIL PLANE_ADMIN_PASSWORD \
         PLANE_API_BASE_URL WEB_URL; do
  sudo sed -i "/^$K=/d" /opt/alfred/compose/.env
done
sudo chmod 600 /opt/alfred/compose/.env

# Re-render compose without plane_enabled and re-upload if you want
# the services gone from the file too. Otherwise `docker compose up -d`
# would bring them back on next deploy.
```

### Step R5 — remove DNS + ingress

1. Delete the Cloudflare DNS record for `<subdomain>-plane`.
2. Remove the `hostname: <subdomain>-plane.<domain>` rule from
   `/etc/cloudflared/config.yml` on the tenant.
3. `sudo systemctl reload cloudflared`.

The vault-side state files
(`state/plane_sync_cursor.json`, `state/plane_reverse_sync_cursor.json`,
`state/plane_outbound_signatures.json`, `state/plane_self_comments.json`,
`state/plane_pending_approvals.json`) are harmless to leave — they'll
be ignored by a vault without a running forward/reverse sync. Delete
them if you want to fully reset a future re-enable.
