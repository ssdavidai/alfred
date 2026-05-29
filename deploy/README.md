# deploy/ — fleet ops

Operator notes for the live alfred-black tenant fleet. Per-tenant install
instructions for a fresh box still live in the top-level [README](../README.md);
this directory is for cross-tenant ops.

## Fleet roster

The known live tenants as of 2026-05-29 (each is a single-VM, single-tenant
deployment — no shared infrastructure):

| Hostname               | Principal       |
| ---------------------- | --------------- |
| `home.alfred.black`    | Sir (operator)  |
| `rj.alfred.black`      | RJ              |
| `joe.alfred.black`     | Joe             |
| `zsolt.alfred.black`   | Zsolt           |
| `miguel.alfred.black`  | Miguel          |

These are hard-coded in two places that must stay in sync:

- `.github/workflows/deploy-compose.yml` (matrix)
- `Makefile` (`FLEET` variable, `sync-compose-fleet` target)

When a tenant is added or retired, update both. A future refactor will pull
this from the SaaS Plane app's tenant directory; for now we keep it explicit
because the cost of a stale list is "a tenant silently misses a deploy" —
exactly the failure mode this directory exists to prevent.

## What CI deploys vs. what it does NOT

The `build-*.yml` workflows push images to DockerHub. They do **not** touch
any tenant. Each tenant pulls images on the next `docker compose up -d`.

`deploy-compose.yml` (this directory's concern) syncs the host-side static
files that compose loads at boot:

- `docker-compose.yaml` — the service definitions
- `caddy/Caddyfile` — public ingress + Let's Encrypt
- `caddy/plane-proxy.Caddyfile`
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
make FLEET="zsolt.alfred.black" sync-compose-fleet

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
