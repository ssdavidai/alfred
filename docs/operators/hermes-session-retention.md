# Hermes session-store retention runbook

**Script:** `scripts/hermes-session-retention.py`
**Refs:** #430, #434

---

## Why per-profile windows?

A flat 30-day window is the wrong shape for this data.  The three Hermes
profiles have fundamentally different audit value:

| Profile | Character | Default window | Rationale |
|---------|-----------|---------------|-----------|
| `workers` | Ephemeral background agents (clerk, curator, janitor, distiller). Runs thousands of short sessions per day. | **14 days** | Durable output already in `alfred-state.db` and the vault. Raw transcripts are scaffolding — high volume, low durable value. |
| `main` | The principal's own conversation history. | **90 days** | Highest audit value. Far fewer sessions. The 30-day naive window would silently erase recent conversation context. |
| `heavy` | Reflection and onboarding reasoning sessions. | **90 days** | Low volume (~600 sessions). Reasoning traces are meaningful to audit. Not worth aggressive pruning. |

These windows are explicit in `PROFILE_RETENTION` at the top of the script.
Override a single profile with `--profile <name>:<days>` without touching
the defaults for the others.

---

## Liveness predicate

A session is **never** deleted if any of these hold:

1. `ended_at IS NULL` — session is still in progress (gateway holds the connection)
2. `started_at > cutoff` — newer than the configured retention window
3. `id` is referenced by a row in `compression_locks` where `released_at IS NULL`
   — LCM compression is in flight; removing the session would corrupt the result

The script evaluates all three conditions in a single SQL WHERE clause before
touching anything.

---

## FTS5 handling

The `messages_fts` table in the Hermes schema is a **content table**
(`content='messages'`), meaning it does not store a copy of the data — it
delegates to the `messages` table.  For this type of FTS:

- You **cannot** `DELETE FROM messages_fts WHERE rowid=...` — SQLite raises
  `database disk image is malformed` on content tables.
- The correct cleanup is: delete from `messages`, then run
  `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`.
  The rebuild rescans the remaining rows in `messages` and updates the index.

The script detects this at runtime by reading the `CREATE VIRTUAL TABLE`
DDL from `sqlite_master`, so it does not hard-code an assumption.  If the
live schema ever changes to a standalone FTS (storing its own copy), the
script will automatically use the `DELETE WHERE rowid` path instead.

---

## Operator procedure (copy-paste ready)

### 1. Dry run first — no writes

```bash
docker exec hermes python3 /opt/alfred/scripts/hermes-session-retention.py
```

Expected output:

```
=== workers (window: 14d, db: /hermes-state/profiles/workers/state.db) ===
  DB size: 14.00 GB (15,032,385,536 bytes)
  Eligible sessions: 123,113  messages: 497,807
  Date range of eligible: 2026-01-01 → 2026-07-26

=== main (window: 90d, db: /hermes-state/profiles/main/state.db) ===
  DB size: 7.10 GB (7,621,550,080 bytes)
  Eligible sessions: 1,334  messages: 24,652
  Date range of eligible: 2026-01-01 → 2026-05-11

=== heavy (window: 90d, db: /hermes-state/profiles/heavy/state.db) ===
  DB size: 1.10 GB (1,181,116,006 bytes)
  Eligible sessions: 103  messages: 580
  Date range of eligible: 2026-01-15 → 2026-05-09

[DRY RUN — no changes made.  Re-run with --apply --backup-ok to prune.]
```

### 2. Checkpoint first — free WAL without any deletion

The workers WAL can be several GB.  Checkpoint is safe to run at any time,
takes seconds, and does not require a backup:

```bash
docker exec hermes python3 /opt/alfred/scripts/hermes-session-retention.py --checkpoint
```

### 3. Take a backup of the Hermes data volume

```bash
# On the VM:
docker run --rm \
  -v alfred-black_hermes_data:/src:ro \
  -v /opt/backups:/dst \
  alpine tar czf /dst/hermes-data-$(date +%Y%m%d-%H%M).tar.gz -C /src .
```

Verify the backup completed before continuing.

### 4. Apply the prune (run detached — takes up to 2 hours for workers)

```bash
nohup docker exec hermes python3 /opt/alfred/scripts/hermes-session-retention.py \
  --apply --backup-ok --verbose \
  > /tmp/hermes-retention.log 2>&1 &
echo "PID $!"

# Tail progress:
tail -f /tmp/hermes-retention.log
```

Expected runtime:
- `workers` 14-day window (123k sessions, 498k messages): **60–90 minutes**
- `main` 90-day window (1.3k sessions): **under 5 minutes**
- `heavy` 90-day window (103 sessions): **under 1 minute**

The `--verbose` flag prints a progress line after each 500-session batch.
An interrupted run is safe: each batch is committed independently; re-running
continues from where it left off (eligible sessions that were already deleted
are simply not found again).

### 5. Checkpoint after deletion (reclaim WAL)

```bash
docker exec hermes python3 /opt/alfred/scripts/hermes-session-retention.py --checkpoint
```

### 6. VACUUM (optional — reclaim disk from the main DB file)

VACUUM requires approximately 2× the current file size in free disk space
and rewrites the entire database file.  Run it only if disk space is
critically low and the deletion alone did not free enough.  It takes
**1–2 hours for workers**.

```bash
nohup docker exec hermes python3 /opt/alfred/scripts/hermes-session-retention.py \
  --apply --backup-ok --vacuum \
  > /tmp/hermes-vacuum.log 2>&1 &
```

**Never** run VACUUM as part of routine pruning.  The page-level freed space
from deletion is reclaimable by SQLite's internal free-list on the next write.
Disk shows freed space only after VACUUM.

### 7. Verify gateway health

```bash
# Hermes main profile should respond:
curl -s http://localhost:18789/health
# Workers:
curl -s http://localhost:18790/health
# Heavy:
curl -s http://localhost:18791/health
```

All three should return 200.  If a profile is unhealthy after the prune,
check `docker logs hermes` and restore from the backup (see §Rollback).

---

## Rollback

If the gateway is unhealthy after applying:

```bash
# Stop Hermes
docker compose stop hermes

# Restore the backup
docker run --rm \
  -v alfred-black_hermes_data:/dst \
  -v /opt/backups:/src \
  alpine sh -c "cd /dst && tar xzf /src/<backup-file>.tar.gz"

# Restart
docker compose up -d hermes
```

---

## Override a single profile

```bash
# Prune workers more aggressively (7 days) without touching main/heavy:
docker exec hermes python3 /opt/alfred/scripts/hermes-session-retention.py \
  --profile workers:7 --apply --backup-ok
```

---

## Appending to the CI lessons ledger

After any real retention run, append to `~/.claude/alfred-code/docs/ci-lessons.md`:

```
- YYYY-MM-DD · hermes session store · <what was found> · <rule that prevents recurrence>
```
