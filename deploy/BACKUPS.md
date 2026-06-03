# Backup contract and restore drill

This is the operating contract for a single-VM Alfred Black deployment. It is deliberately application-level: operators can back up and restore the Docker named volumes without relying on a particular cloud snapshot product.

## Contract

Default deployment remains unchanged. Backups are an operator action until a future release wires an opt-in scheduled sidecar or host timer.

Recommended model:

1. Run a daily application-level backup of the named Docker volumes listed below.
2. Store the backup bundle outside the VM, encrypted before upload.
3. Run the restore drill after initial setup, after every major upgrade, and quarterly.

RPO/RTO targets when the recommended daily schedule is followed:

| Target | Expectation |
| --- | --- |
| RPO | 24 hours for principal-facing and operational state; less if the operator triggers a manual backup before risky work. |
| RTO | 2 hours for a full single-VM rebuild once a fresh VM, DNS, `.env`, and encrypted backup bundle are available. |
| Consistency | Best when the stack is stopped before backup. Online backups of SQLite/Postgres volumes may be crash-consistent only. |

If an operator chooses Hetzner snapshots instead, that is an external infrastructure contract, not an Alfred application-level backup. The operator must record the snapshot schedule, retention, encryption posture, and a successful restore test outside this repository.

## Data classification by volume

The current compose file defines these named volumes.

| Volume | Loss impact | Backup priority | Notes |
| --- | --- | --- | --- |
| `vault_data` | Principal-facing vault records, decisions, briefings, daybook output. | Critical | Published user surface; always back up. |
| `files_data` | Principal-uploaded/generated file blobs if present in a deployment variant. | Critical | Not present in the current compose volume list, but must be included when enabled. |
| `state_data` | `alfred-state.db`, WAL, sqlite-vec memory, signals, observations, audit. | Critical | Stop `ctrl-api` or the full stack for the cleanest snapshot. |
| `ingest_data` | `ingest.db`, short-lived raw stream events. | High | Useful for replay/forensics; lower retention requirement than state. |
| `cold_data` | Long-tail archive store. | High | Include if Phase 3 cold archive has data. |
| `hermes_data` | Hermes profiles, sessions, channel state, generated profile config. | Critical | Needed for channel continuity and agent runtime recovery. |
| `alfred_data` | Shared Alfred runtime data, generated tokens, gateway token. | Critical | Some consumers mount this read-only; restore before starting services. |
| `caddy_data` | Let's Encrypt cert account/cert material. | High | Restorable by re-issuing, but backup avoids rate-limit and outage risk. |
| `caddy_config` | Caddy runtime config cache. | Medium | Less critical than `caddy_data`; include for completeness. |
| `web_db_data` | Wasp/web auth database. | Critical | Owner account/session and app records. |
| `vaultwarden_data` | Vaultwarden database and attachments. | Critical | Secrets store; backup must be encrypted. |
| `mcp_server_data` | MCP server local state. | Medium | Include to preserve connector-local state. |
| `temporal_data` | Temporal workflow history. | High | Workflows can often be restarted, but history aids recovery. |
| `ollama_data` | Downloaded embedding/model blobs. | Low | Re-downloadable; backup only to reduce rebuild time. |
| `plane_pgdata`, `plane_redis`, `plane_rabbitmq`, `plane_uploads` | Plane issue tracker data and artifacts. | High | Include if Plane is used as operational issue memory. |
| `sure_pgdata`, `sure_redis` | Sure finance database/cache. | Critical | Finance data; backup encrypted and test restore. |
| `paperclip_data` | Paperclip company/issues/agent state. | High | Include where Paperclip manages operations. |
| `vexa_redis`, `vexa_postgres`, `vexa_minio`, `vexa_recordings` | Optional Vexa transcript stack. | Medium/High | Include when `--profile vexa` is enabled and recordings/transcripts matter. |

## Manual backup procedure

1. SSH to the VM and enter the compose directory.

```bash
cd /opt/alfred
```

2. Create a local backup directory outside the repository checkout.

```bash
sudo install -d -m 0700 /var/backups/alfred
export BACKUP_DIR=/var/backups/alfred/$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -m 0700 "$BACKUP_DIR"
```

3. Stop the stack for a clean snapshot.

```bash
docker compose down
```

4. Archive each named volume.

```bash
for volume in $(docker compose config --volumes); do
  docker run --rm \
    -v "${volume}:/src:ro" \
    -v "${BACKUP_DIR}:/backup" \
    alpine:3.20 \
    sh -c 'cd /src && tar -czf "/backup/${0}.tgz" .' "$volume"
done
```

5. Save the compose inputs needed to rebuild the stack. Do not publish these files; they may contain secrets.

```bash
cp docker-compose.yaml "$BACKUP_DIR/docker-compose.yaml"
cp .env "$BACKUP_DIR/env"
docker compose config --volumes > "$BACKUP_DIR/volumes.txt"
```

6. Restart the stack.

```bash
docker compose up -d
```

7. Encrypt and upload the backup bundle to off-VM storage.

```bash
tar -C "$BACKUP_DIR" -czf - . \
  | age -r '<AGE_PUBLIC_KEY>' \
  > "${BACKUP_DIR}.tar.gz.age"
# Upload ${BACKUP_DIR}.tar.gz.age to the operator's backup store.
```

The Age private key, Vaultwarden master password, and any object-store credentials must be stored outside the VM as break-glass material. Do not commit them, paste them into Paperclip comments, or include them in CI logs.

## Full restore procedure

1. Provision a fresh Linux VM, install Docker/Compose, clone the repo, and place the restored `.env` in `/opt/alfred/.env`.
2. Decrypt the backup bundle into `/var/backups/alfred/restore`.
3. Ensure no old stack is running.

```bash
cd /opt/alfred
docker compose down || true
```

4. Recreate and populate every archived volume.

```bash
RESTORE_DIR=/var/backups/alfred/restore
while read -r volume; do
  docker volume create "$volume" >/dev/null
  docker run --rm \
    -v "${volume}:/dst" \
    -v "${RESTORE_DIR}:/backup:ro" \
    alpine:3.20 \
    sh -c 'cd /dst && tar -xzf "/backup/${0}.tgz"' "$volume"
done < "$RESTORE_DIR/volumes.txt"
```

5. Start the stack and verify the durable surfaces.

```bash
docker compose up -d
docker compose ps
```

Minimum verification:

- Desk and Brief load at `https://${DOMAIN}`.
- Vault records are visible.
- A previously uploaded file or generated file-store artifact is present if `files_data` exists for the deployment.
- `ctrl-api` can read `alfred-state.db` and the Desk decision/audit counts are plausible.
- Vaultwarden unlocks and existing items are present.
- Caddy serves HTTPS without re-issuing a storm of certificates.

## Restore drill

The non-destructive drill in `scripts/restore-drill.sh` proves the archive/restore mechanics for two representative artifacts:

- a user-facing vault file; and
- a SQLite state database with WAL mode enabled.

Run it from the repository root:

```bash
./scripts/restore-drill.sh
```

The drill uses only temporary directories under `/tmp`, does not touch Docker, and exits non-zero if either restored artifact fails verification. It is not a replacement for a live restore test against real Docker volumes; it is the minimum smoke evidence every PR touching this contract should run.

## PR smoke evidence template

Every PR changing backup behavior or this runbook should include:

```text
## Smoke evidence
- `docker compose config --volumes` — confirms the documented volume list still matches compose.
- `docker compose config` — confirms the default stack remains valid and no backup actor starts by default.
- `./scripts/restore-drill.sh` — confirms a user file and SQLite state artifact survive archive/restore.
```
