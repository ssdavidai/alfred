# Alfred Black backup and restore contract

This runbook is the supported backup contract for a single-VM Alfred Black tenant.
It is deliberately application-level: the operator backs up Docker's named-volume
payloads and the live compose directory, then proves restore against disposable
volumes before treating the tenant as protected.

## Contract summary

- Backup model: encrypted, off-host restic/borg/compatible repository run by the
  VM operator. Hetzner or other provider snapshots are useful secondary cover,
  but they are not sufficient as the only Alfred backup unless the operator has
  explicitly documented, scheduled, and restore-tested them for the tenant.
- Default stack behaviour: unchanged. `docker compose up -d` starts no backup
  sidecar, requires no backup credentials, and uploads no data. The backup job is
  an operator/systemd concern until a future compose profile lands.
- RPO: 24 hours for production tenants; 6 hours for managed customer tenants once
  customer data has been onboarded.
- RTO: 4 hours to bring a fresh VM to a working dashboard with vault, files,
  state, channels, and Paperclip/Sure/Plane state restored.
- Encryption: repository encryption is mandatory. Keep the repository password or
  key in Vaultwarden or the operator's offline secret store; never commit it to
  the repo, `.env`, Paperclip comments, or CI logs.
- Restore proof: before marking a tenant protected, restore at least one user file
  from `files_data` and one state database artifact from `state_data` into a
  temporary location and verify them without starting the production stack.

## Scope and loss impact

| Volume / path | What it contains | Loss impact | Backup priority |
|---|---|---|---|
| `/opt/alfred/.env` | Tenant secrets and generated passwords | Stack cannot reliably restart or authenticate sidecars | Critical |
| `/opt/alfred/docker-compose.yaml`, `caddy/`, scripts | Active deployment contract and ingress config | Fresh VM rebuild is slower and error-prone | Critical |
| `vault_data` | Principal-facing markdown vault | Principal knowledge loss | Critical |
| `files_data` | Principal-facing uploaded blobs | Uploaded documents/media loss | Critical |
| `state_data` | `alfred-state.db` plus WAL | Machine memory, observations, signals, audit, vector state | Critical |
| `hermes_data` | Hermes profiles, SOUL/user memory, sessions, skills, channel pairing state | Assistant continuity and channel/tool config loss | Critical |
| `alfred_data` | Gateway token, settings, generated bootstrap artifacts, shared sidecar scratch | Cross-service auth/settings recovery work | High |
| `caddy_data`, `caddy_config` | Let's Encrypt account, certs, Caddy state | TLS rate-limit risk and ingress recovery delay | High |
| `web_db_data` | Dashboard auth/users/API keys | Owner login/API key loss | Critical |
| `vaultwarden_data` | Secrets vault | Credential loss; services may become unrecoverable | Critical |
| `paperclip_data` | Paperclip company, issues, runs, embedded DB | Company/task/governance history loss | Critical |
| `plane_pgdata`, `plane_redis`, `plane_rabbitmq`, `plane_uploads` | Plane issues and attachments | Issue tracker mirror/workflow loss | High |
| `sure_pgdata`, `sure_redis` | Sure finance state | Finance history/categorisation loss | Critical when Sure is used |
| `ingest_data` | Short-lived raw inbound stream events | Recent forensic/event replay loss | Medium |
| `cold_data`, `files_cold_data` | Cold archive and compressed aged files | Long-tail archive loss | High when populated |
| `temporal_data` | Temporal workflow history | Running workflow recovery/history loss | Medium |
| `mcp_server_data` | MCP bundle state/cache | Rebuildable integration cache | Medium |
| `tailscale_data` | Optional sidecar node identity | Principal must re-approve the Tailscale device | Medium when Tailscale is enabled |
| `ollama_data`, `hermes_codex_work` | Local models and sealed builder run workspace | Re-download/rebuild; no principal data expected | Low |

The canonical volume prefix is `alfred-black_`, e.g.
`/var/lib/docker/volumes/alfred-black_vault_data/_data/`. Confirm with
`docker volume ls --filter label=com.docker.compose.project=alfred-black` on the
host before wiring the job.

## Backup command pattern

Stop write-heavy services before taking a filesystem backup of SQLite/Postgres
volumes. For a low-risk nightly window:

1. Announce a maintenance window if this is a managed customer tenant.
2. From `/opt/alfred`, stop the stack:
   `docker compose stop web web-client ctrl-api alfred-learn hermes alfred paperclip plane-api plane-worker plane-beat plane-db sure-web sure-worker sure-db vaultwarden temporal`.
3. Run the encrypted off-host backup over:
   - `/opt/alfred/.env`
   - `/opt/alfred/docker-compose.yaml`
   - `/opt/alfred/caddy/`
   - `/var/lib/docker/volumes/alfred-black_*_data/_data/`
   - `/var/lib/docker/volumes/alfred-black_plane_pgdata/_data/`
   - `/var/lib/docker/volumes/alfred-black_plane_uploads/_data/`
   - `/var/lib/docker/volumes/alfred-black_sure_pgdata/_data/`
   - `/var/lib/docker/volumes/alfred-black_sure_redis/_data/`
4. Start the stack again: `docker compose up -d`.
5. Record the backup id/snapshot id and the restore-test result in the tenant's
   operator log.

For restic, the shape is:

`RESTIC_REPOSITORY=s3:<endpoint>/<bucket>/<tenant> RESTIC_PASSWORD_FILE=*** restic backup /opt/alfred/.env /opt/alfred/docker-compose.yaml /opt/alfred/caddy /var/lib/docker/volumes/alfred-black_*_data/_data /var/lib/docker/volumes/alfred-black_plane_pgdata/_data /var/lib/docker/volumes/alfred-black_plane_uploads/_data /var/lib/docker/volumes/alfred-black_sure_pgdata/_data`

Prefer an include file rather than expanding globs in a systemd unit. Exclude
`hermes_codex_work` unless a live builder run must be forensically preserved.

## Fresh-VM restore procedure

1. Provision a Linux VM with Docker and Compose.
2. Clone or copy the Alfred repository into `/opt/alfred`.
3. Restore `/opt/alfred/.env`, `docker-compose.yaml`, and `caddy/` from the
   backup. Do not run `scripts/bootstrap.sh` after restoring `.env`; it may
   rotate generated values that the restored volumes expect.
4. Create missing named volumes with `docker compose create --no-start` or
   `docker volume create alfred-black_<name>`.
5. Restore each backed-up `_data` directory into the matching Docker volume.
   Preserve ownership and modes.
6. Bring the stack up: `docker compose up -d`.
7. Verify:
   - `docker compose ps` shows the core services healthy.
   - `https://<DOMAIN>/desk` loads and the owner can sign in.
   - A vault record can be read.
   - A previously uploaded file appears in `/files` and can be opened.
   - Paperclip, Sure, Plane, and Vaultwarden load if they were in use.
   - `caddy` serves a valid certificate without requesting a new account unless
     the target domain has changed.

## Disposable restore drill

Run this after first backup setup and at least monthly for managed tenants.

1. Choose the latest backup snapshot.
2. Restore `alfred-black_files_data/_data` and `alfred-black_state_data/_data`
   into `/tmp/alfred-restore-drill/files_data` and
   `/tmp/alfred-restore-drill/state_data`; do not overwrite production volumes.
3. Verify a files artifact exists:
   `find /tmp/alfred-restore-drill/files_data -type f | head -1`.
4. Verify the state database is readable without writing to it:
   `sqlite3 'file:/tmp/alfred-restore-drill/state_data/alfred-state.db?mode=ro' 'PRAGMA integrity_check;'`.
5. If `alfred-state.db-wal` exists, keep it beside the DB for the integrity
   check; SQLite needs the WAL for a consistent read.
6. Record the snapshot id, commands, and outputs in the operator log.
7. Remove `/tmp/alfred-restore-drill`.

A backup without this drill is only a hope. Treat the tenant as unprotected until
one successful drill has been recorded.

## Incident restore notes

- Stop the stack before replacing live volume contents.
- Restore `state_data` as a unit: DB, WAL, SHM, and sqlite-vec sidecar artifacts
  belong together.
- Restore service databases as whole volumes, not individual table files.
- Preserve `vaultwarden_data` and `.env` together; Vaultwarden-derived secrets
  are how other services recover credentials.
- If `caddy_data` is lost, expect Let's Encrypt re-issuance. Check rate limits
  before repeated rebuild attempts.
- If `tailscale_data` is lost, the optional sidecar must be reconnected by the
  principal from their Tailscale account.