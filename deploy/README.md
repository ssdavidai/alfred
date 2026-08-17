# deploy/ — fleet ops

Operator notes for the live alfred-black tenant fleet. Per-tenant install
instructions for a fresh box still live in the top-level [README](../README.md);
this directory is for cross-tenant ops.

## Fleet roster

The known live tenants as of 2026-05-29 (each is a single-VM, single-tenant
deployment — no shared infrastructure):

The fleet roster — hostnames and who each tenant belongs to — is deliberately
NOT in this repository. This repo is public and a tenant hostname identifies a
client. The canonical list lives in the `ALFRED_FLEET_HOSTS` repo secret; every
workflow that touches tenants reads it from there and refers to tenants by
index in any output.

The list is held in one place:

- the `ALFRED_FLEET_HOSTS` repo secret
- `Makefile` (`FLEET` variable, `sync-compose-fleet` target)

When a tenant is added or retired, update both. There is no tenant directory
to pull this from, so it stays explicit — and the cost of a stale list is "a
tenant silently misses a deploy", exactly the failure mode this directory
exists to prevent.

## What CI deploys vs. what it does NOT

The `build-*.yml` workflows push images to DockerHub. They do **not** touch
any tenant. Each tenant pulls images on the next `docker compose up -d`.

`deploy-compose.yml` (this directory's concern) syncs the host-side static
files that compose loads at boot:

- `docker-compose.yaml` — the service definitions
- `caddy/Caddyfile` — public ingress + Let's Encrypt
- `.env.example` — operator reference (never overwrites a tenant's `.env`)

It runs automatically on every push to `main` that touches one of those
files. Backups live at `/opt/alfred/<file>.bak-<sha>-<timestamp>` on the
tenant; restore with a single `mv` if a deploy breaks something.

The deploy is idempotent — `docker compose up -d` only restarts services
whose definition hashed differently, and Caddy gets a graceful `caddy reload`
that does not drop connections.

## One-shot operator backfill

Use this when a tenant was offline during a CI deploy (the workflow's
pre-flight ssh check skips unreachable hosts), or when you want to push a
local edit without rolling main:

```sh
# All five tenants:
make sync-compose-fleet

# A single tenant:
make FLEET="a client tenant" sync-compose-fleet

# Override the SSH key:
make SSH_KEY=~/.ssh/id_ed25519 sync-compose-fleet
```

Default key path is `~/.ssh/alfred-black-verify`. The target validates the
compose file locally before touching any tenant; if `docker compose config`
fails, nothing ships.

## Gotcha: Caddyfile edits + the bind-mount inode

Editing `/opt/alfred/caddy/Caddyfile` on a running host with `sed -i` (or
any editor that rewrites the file rather than truncating-and-writing in
place) changes the host inode. The Caddy container is bind-mounting the
old inode, so it keeps serving stale content even after `caddy reload`.

Fix is one of:

```sh
docker restart alfred-black-caddy-1
# or
docker compose -p alfred-black up -d caddy
```

Both remount the path and pick up the new inode. The `deploy-compose.yml`
workflow uses `scp -p` (which truncates rather than re-inodes), followed
by `caddy reload`, so the CI path is unaffected — this only bites
operators doing one-off edits on a tenant.

Live evidence (home, 2026-05-29 HA wiring): host inode 257610, container
inode 257899 after a `sed -i` patch; `caddy reload` returned success but
the matcher still 405'd until the container was restarted.

## Why this directory exists

PR #121 (2026-05-29) added the `tailscale` profile to `docker-compose.yaml`.
The image rebuild and ctrl-api routes landed correctly, but the compose
file itself never reached any tenant because no CI step copied it. Live
evidence on `home.alfred.black`:

```
$ stat -c '%y' /opt/alfred/docker-compose.yaml
2026-05-28 20:50:13
$ docker compose --profile tailscale config --services
(empty — the tailscale block isn't in the file)
```

Sir had to `scp docker-compose.yaml root@home.alfred.black:/opt/alfred/`
by hand. The other four tenants were still on May-28 compose. This
directory + the `deploy-compose.yml` workflow close that loop so a host-side
file change in `main` reaches every tenant the same way an image change
does.

## Secrets

- `FLEET_SSH_KEY` — repo-level GitHub Actions secret; the private half of
  `~/.ssh/alfred-black-verify`. Authorised on every tenant's `root@`
  account.

## Enabling Tailscale on an existing tenant (#109)

The Tailscale sidecar is off by default — `docker compose up -d` will
not start it on any tenant. To enable on a tenant whose principal wants
to join their own tailnet:

```bash
# 1. SSH to the tenant.
ssh -o IdentityAgent=none -i ~/.ssh/alfred-black-verify \
    root@<tenant>.alfred.black

# 2. Flip the env flag.
cd /opt/alfred
sed -i 's/^TAILSCALE_ENABLED=false$/TAILSCALE_ENABLED=true/' .env

# 3. Start the sidecar (still authenticated to nothing).
docker compose --profile tailscale up -d tailscale

# 4. Hand control to the principal — they open the dashboard at
#    https://<tenant>.alfred.black/channels, find the Tailscale card,
#    and either:
#      • paste a tskey-auth-… key generated in their Tailscale admin
#        console (the "Advanced" path), or
#      • click "Use device auth URL" — the card surfaces a
#        login.tailscale.com/a/<code> URL they open in a new tab and
#        approve against their own Tailscale account.

# 5. Once the card shows "Connected" with a 100.x IP, the operator can
#    provision the tailnet hostname's LE cert + bind it into Caddy:
TAILNET_HOST=$(docker exec alfred-black-tailscale-1 \
    tailscale status --json | \
    python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
AAS_API_KEY=$(grep -E '^AAS_API_KEY=' /opt/alfred/.env | cut -d= -f2)
docker exec alfred-black-ctrl-api-1 sh -c \
    "curl -s -X POST -H 'Authorization: Bearer $AAS_API_KEY' \
     -H 'Content-Type: application/json' \
     -d '{\"domain\":\"$TAILNET_HOST\"}' \
     http://127.0.0.1:3100/api/v1/channels/tailscale/cert"
```

Verify by opening `https://<tailnet-host>` from any device on the
principal's tailnet — should load the dashboard with a valid LE cert.

Caveats:
- The public `<tenant>.alfred.black` hostname keeps working unchanged.
  Tailscale is additive.
- If `caddy_reload_ok` returns `false` from the cert call, check the
  Caddy container's `pids_limit` (`docker inspect alfred-black-caddy-1
  --format '{{.HostConfig.PidsLimit}}'`) — the reload spawns ~50
  goroutines and the historical 1024 cap can starve newer Go runtimes.
  PR #159 raised the limit; a `docker compose up -d caddy` re-applies
  the new value on existing tenants.
- Outbound MagicDNS from inside Alfred containers (e.g. the Hermes
  agent calling `homeassistant.tail-xxxx.ts.net`) is NOT wired by
  default — open a follow-up issue if the principal needs that surface.
