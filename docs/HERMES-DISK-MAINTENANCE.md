# Hermes profile disk maintenance runbook

## Why this exists

Hermes profile gateways write request/session artifacts under the shared `hermes_data` volume:

- `/opt/data/profiles/<profile>/sessions/*` inside the container
- `/var/lib/docker/volumes/alfred-black_hermes_data/_data/profiles/<profile>/sessions/*` on the host
- `/opt/data/profiles/<profile>/state.db` inside the container
- `/var/lib/docker/volumes/alfred-black_hermes_data/_data/profiles/<profile>/state.db` on the host

A busy workers profile can grow these paths until the VM disk fills. Once the disk reaches 100%, sibling containers such as Postgres can crash-loop with `No space left on device`.

## Runtime guard

`packages/hermes/docker/hermes-maintenance.sh` runs under the Hermes supervisor as the `hermes-maintenance` process.

Defaults:

- `HERMES_SESSION_RETENTION_DAYS=2` — remove children of every `profiles/*/sessions/` directory older than 2 days.
- `HERMES_STATE_DB_VACUUM_INTERVAL_SECONDS=86400` — checkpoint and `VACUUM` each `profiles/*/state.db` once per day.
- `HERMES_MAINTENANCE_INTERVAL_SECONDS=3600` — run the maintenance loop hourly.
- `HERMES_DISK_ALERT_THRESHOLD=80` — emit a high-urgency principal alert when the `HERMES_HOME` filesystem reaches 80% used.
- `HERMES_DISK_ALERT_COOLDOWN_SECONDS=21600` — suppress repeated disk alerts for 6 hours.
- `HERMES_MAINTENANCE_ENABLED=true` — set to `false`, `0`, `no`, or `off` to disable the watchdog.

The disk alert posts through ctrl-api `/api/v1/notifications` when the main profile `.env` contains `AAS_API_KEY`; otherwise the alert is logged by the supervisor container.

## Emergency cleanup

If the host is already at or near 100% disk:

1. Stop Hermes first so active gateways are not writing into the same session directories:
   `docker compose stop hermes`
2. Inspect the shared volume size:
   `du -sh /var/lib/docker/volumes/alfred-black_hermes_data/_data/profiles/*/sessions /var/lib/docker/volumes/alfred-black_hermes_data/_data/profiles/*/state.db`
3. Remove old session artifacts. It is safe to clear the children of `sessions/` while Hermes is stopped:
   `find /var/lib/docker/volumes/alfred-black_hermes_data/_data/profiles -mindepth 3 -maxdepth 3 -type d -path '*/sessions/*' -mtime +2 -exec rm -rf -- {} +`
4. If a profile `state.db` is enormous and the tenant can tolerate losing transient gateway session state, move it aside while Hermes is stopped:
   `mv .../profiles/workers/state.db .../profiles/workers/state.db.bak.$(date -u +%Y%m%dT%H%M%SZ)`
5. Start Hermes again:
   `docker compose up -d hermes`
6. Confirm disk headroom:
   `df -h` and `docker compose ps hermes`

Do not delete `auth.json`, `config.yaml`, `.env`, `skills/`, `memory.json`, or vault data during this cleanup.
