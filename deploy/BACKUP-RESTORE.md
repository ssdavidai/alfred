# Backup and restore contract

This runbook is the supported backup contract for the single-VM Alfred Black stack.
It is deliberately application-level: it names the durable Docker volumes, gives a
manual backup command, and defines a restore drill that can be repeated before a
production incident.

## Contract

Default deployments do not start any backup sidecar and do not upload tenant data
anywhere. Operators must choose one of these models before treating a tenant as
protected:

1. Application-level volume archives using `scripts/backup-volumes.sh``, stored in
   an encrypted destination controlled by the operator or principal.
2. Provider snapshots, for example Hetzner server or volume snapshots, with this
   runbook used as the restore verification drill.
3. A staged hybrid: provider snapshots for fast VM rollback, plus application
   archives for selective file/database restore.

The recommended baseline is the staged hybrid. Minimum production target:

| Target | Requirement |
| --- | --- |
| RPO | 24 hours for routine backup; lower only if the operator schedules the script more often |
| RTO | 4 hours for full VM restore;1 hour for selective archive restore of one volume |
| Encryption | Backups must be encrypted at the storage layer or before upload |
| Verification | At least one restore drill per tenant before handoff, then after material volume/schema changes |

Do not mark a tenant as protected merely because `docker compose up -d` works.
There must be a backup artifact outside the Docker host, or a documented provider
snapshot policy with restore evidence.

## In-scope volumes

Docker Compose project name defaults to `alfred-black`, so Docker stores named
volumes as `alfred-black_volume>`. If the project name changes, use `docker
compose config --volumes` and `docker volume ls` to confirm the prefix.

| Volume | Contents | Loss impact | Backup priority |
| --- | --- | --- | --- |
| `vault_data` | Principal-facing vault markdown | Loss of the principal's published memory, matters, tasks, decisions, briefings | Critical |
| `files_data` | Principal-uploaded opaque files | Loss of uploaded documents/images/audio and generated artefacts | Critical |
| `files_cold_data` | Compressed cold file blobs | Loss of archived cold blobs; live metadata may point at missing bytes | High |
| `state_data` | `alfred-state.db`, WAL, sqlite-vec machine memory | Loss of signals, observations, embeddings, audit, learning state | Critical |
| `ingest_data` | `ingest.db`, WAL raw inbound streams | Loss of short-retention ingest evidence and replay inputs | High |
| `cold_data` | Cold archive store | Loss of forensic long-tail history | Medium |
| `hermes_data` | Hermes profiles, sessions, skills, memory, plugin state | Loss of assistant runtime continuity and channel/session state | Critical |
| `alfred_data` | Shared Alfred scratch/config (`.gateway-token`, settings, runtime files) | Broken service coordination until regenerated; loss of local runtime state | High |
| `caddy_data` | Let's Encrypt certificates and account data | TLS interruption and possible LE rate-limit pressure on rebuild | High |
| `caddy_config` | Caddy runtime config cache | Reconstructable from repo, but useful for exact rollback | Low |
| `vaultwarden_data` | Vaultwarden database and attachments | Loss of tenant secrets unless independently exported | Critical |
| `web_db_data` | Dashboard auth/application Postgres data | Loss of users, auth state, dashboard metadata | Critical |
| `temporal_data` | Temporal state store | Loss of workflow execution history and in-flight workflow state | High |
| `mcp_server_data` | MCP server local state | Loss of local integration/cache state | Medium |
| `sure_pgdata` | Sure Postgres | Loss of finance application data | Critical |
| `sure_redis` | Sure Redis | Mostly cache/queue state | Medium |
| `paperclip_data` | Paperclip SQLite/data workspace | Loss of Paperclip company/issue/agent state | High |
| `tailscale_data` | Optional Tailscale node identity | Device must be re-approved in the principal's tailnet | Medium, if profile enabled |
| `ollama_data` | Optional local model cache | Re-download required | Low |
| `hermes_codex_work` | Sealed builder workspaces | Usually disposable; preserve only for active unmerged work | Low |

## Manual backup

The helper creates one compressed tarball per named volume. It never uploads
anything and prints only file names, sizes, and checksums.

For a quiesced, database-consistent backup:

```sh
cd /opt/alfred
docker compose stop
./scripts/backup-volumes.sh --output /mnt/encrypted/alfred-backups/$(date -u +%Y%m%dT%H%M%MZ)
docker compose up -d
```

For a best-effort online backup, use `--online`. This is acceptable for
`vault_data`, `files_data`, `hermes_data`, `alfred_data`, and Caddy data; it is
not a substitute for a quiesced or database-native backup of Postgres/SQLite
volumes.

```sh
cd /opt/alfred
./scripts/backup-volumes.sh --online --output /mnt/encrypted/alfred-backups/$(date -u +%Y%m%dTH%M%SZ)
```

Store the resulting directory somewhere other than the Docker host. Recommended:
an encrypted disk, an encrypted object-store repository, or a provider snapshot
whose restore path has been tested.

## Full restore from application archives

1. Provision a VM with Docker and the Alfred repo checked out at `/opt/alfred`.
2. Copy `.env`, `docker-compose.yaml`, `caddy/Caddyfile`, and the backup archive
   directory to the VM.
3. Stop the stack if it exists:

```sh
cd /opt/alfred
docker compose down
```

4. Restore selected volumes. Example for the vault and state database:

```sh
BACKUP=/mnt/encrypted/alfred-backups/20260603T120000Z
for volume in vault_data state_data; do
  docker volume create alfred-black_${volume}
  docker run --rm \
    -v alfred-black_${volume}:/restore \
    -v "${BACKUP}:/backup:ro" \
    alpine:3.20 \
    sh -c "cd /restore && tar -xzf /backup/${volume}.tgz"
done
```

5. Repeat for every required volume from the in-scope table.
6. Start the stack:

```sh
docker compose up -d
```

7. Verify:


```sh
docker compose ps
curl -fsS https://${DOMAIN}/desk >/dev/null
curl -fsS https://api.${DOMAIN}/health >/dev/null || true
```

8. Confirm from the UI that the restored vault record/file/issue/transaction is
   visible. If Caddy certificates were not restored, allow Caddy to re-issue TLS
   after DNS points at the restored VM.

## Selective restore drill

Run this drill before handoff and whenever the backup set changes.

1. Create or identify a harmless test file in `/files` through the application UI
   or API.
2. Create a backup with the stack quiesced.
3. Restore `files_data` into a disposable Docker volume, not production:

```sh
BACKUP=/mnt/encrypted/alfred-backups/20260603T120000Z
docker volume rm -f alfred-black_restore_drill_files >/dev/null 2>&1 || true
docker volume create alfred-black_restore_drill_files
docker run --rm \
  -v alfred-black_restore_drill_files:/restore \
  -v "${BACKUP}:/backup:ro" \
  alpine:3.20 \
  sh -c "cd /restore && tar -xzf /backup/files_data.tgz && find . -type f | head"
```

4. Restore `state_data` into a disposable Docker volume and check that the SQLite
   files are present:

```sh
docker volume rm -f alfred-black_restore_drill_state >/dev/null 2>&1 || true
docker volume create alfred-black_restore_drill_state
docker run --rm \
  -v alfred-black_restore_drill_state:/restore \
  -v "${BACKUP}:/backup:ro" \
  alpine:3.20 \
  sh -c "cd /restore && tar -xzf /backup/state_data.tgz && ls -la"
```

5. Record the drill date, backup path, and restored artefacts in the tenant's
   operator notes. Do not paste file contents, secrets, or raw tenant data into
   GitHub or Paperclip comments.

## Provider snapshot drill

If the chosen model is provider snapshots instead of application archives, the
same evidence is still required:

1. Identify the snapshot policy, retention, encryption posture, and expected RPO.
2. Boot a disposable VM or volume clone from the snapshot.
3. Start Alfred from the restored Docker data-root or mounted volume.
4. Verify one principal file and one state-bearing database artifact.
5. Record the snapshot ID, restore time, and verification outcome in operator
   notes.

Without that evidence, provider snapshots are an assumption, not a backup
contract.
