# Hermes session-store retention runbook  refs #430

The session stores grow without bound until this script prunes them.
Weekly execution is enough; the workers store dominates (87% of sessions,
14-day window).  The apply pass is batched and resumable — if it is
interrupted mid-run the state is consistent and the next run continues.

Script: `scripts/hermes-session-retention.py`
Default HERMES_HOME: `/hermes-state` (override with `--hermes-home`)

## Retention windows

| Profile | Window | Rationale |
|---------|--------|-----------|
| workers | 14 days | Ephemeral background-agent transcripts; durable output is in vault/state.db |
| main    | 90 days | Principal's conversation history; highest audit value |
| heavy   | 90 days | Reflection/onboarding reasoning; low volume, worth keeping |

Override per-profile: `--profile workers:7` (NAME:DAYS).

## Weekly procedure

Run from inside the hermes container, or from the host with `HERMES_HOME`
pointing at the mounted volume path.

### Step 1 — Backup attestation

Back up the three profile stores before applying any mutation:

```bash
BKUP=/opt/alfred/backup/hermes-$(date +%Y%m%d)
mkdir -p "$BKUP"
for p in workers main heavy; do
  src="/hermes-state/profiles/$p/state.db"
  cp "$src" "$BKUP/$p-state.db" && cp "${src}-wal" "$BKUP/$p-state.db-wal" 2>/dev/null || true
done
```

Expected time: under 30 seconds for stores totalling ~43 GB (copy, not compress).

### Step 2 — Dry-run (no mutations)

```bash
python3 scripts/hermes-session-retention.py
```

Review the output.  If `eligible_sessions` is unexpectedly high (e.g. the
window was 0 days on a misconfigured clone), stop here.

### Step 3 — WAL checkpoint  (fast — run before apply)

```bash
python3 scripts/hermes-session-retention.py --checkpoint --verbose
```

This flushes the WAL pages into the main database file.  The workers WAL
reached 3.8 GB before the first prune; checkpointing first reduces the
working set apply has to scan.

Expected time: under 60 seconds per profile.  A `busy=True` result means
another writer holds the WAL; wait and retry.

### Step 4 — Apply (session deletion)

**Run detached.**  The apply pass on the workers store (87% of sessions)
can take 5–10 minutes.  A tool with a 2-minute timeout will kill the
process mid-delete, leaving the database in a consistent but partially
pruned state.  Use `nohup` or `screen`:

```bash
# Option A — nohup (output to file)
nohup python3 scripts/hermes-session-retention.py \
  --apply --backup-ok --verbose \
  > /tmp/hermes-retention.log 2>&1 &
echo "PID $!"

# Option B — screen
screen -S retention
python3 scripts/hermes-session-retention.py --apply --backup-ok --verbose
# Ctrl-A D to detach; screen -r retention to reattach
```

`--backup-ok` is a required attestation flag; omitting it aborts with an
error before touching any data.

Expected times:
- workers (~29 k eligible sessions, 14d window): 5–10 min
- main (90d window, low session count): under 1 min
- heavy (90d window, very low volume): under 1 min

The output line `Freed: X GB ... [pre-VACUUM estimate]` is the freed
*logical* space.  The file will not shrink on disk until VACUUM runs (Step 5).

### Step 5 — VACUUM  (optional but recommended; run detached)

**Run detached.**  VACUUM creates a new copy of the database and then
atomically replaces the original.  On a 14 GB workers store this takes
20–40 minutes.  A mid-run kill leaves the old file intact (the swap is
atomic) but wastes the time already spent.

```bash
nohup python3 scripts/hermes-session-retention.py \
  --vacuum --verbose \
  > /tmp/hermes-vacuum.log 2>&1 &
```

The script pre-checks free disk and refuses if available space is less
than 2× the database file size.  If it refuses:

```
VACUUM ERROR: need ~28.0 GB free, have 15.0 GB
```

Free space first (`docker system prune -f` on unused images, or extend the
volume), then retry.

Expected time: 20–40 min for a 14 GB workers store.

## Rollback

No rollback is needed for `--checkpoint` (non-destructive WAL flush).

For `--apply`: the deletions are permanent.  Restore from the backup taken
in Step 1:

```bash
# Stop hermes first to release write locks
docker compose stop hermes

BKUP=/opt/alfred/backup/hermes-<YYYYMMDD>
for p in workers main heavy; do
  cp "$BKUP/$p-state.db" "/hermes-state/profiles/$p/state.db"
done

docker compose start hermes
```

For `--vacuum`: the VACUUM swap is atomic; if the process was killed
before completing, the original file is still in place and unchanged.
No restore needed.

## Flags reference

```
--apply                Run deletions (dry-run by default)
--backup-ok            Required with --apply; attests backup was taken
--checkpoint           WAL checkpoint (TRUNCATE) each profile store
--vacuum               VACUUM each profile store (pre-checks free disk)
--profile NAME:DAYS    Override window for one profile (repeatable)
--hermes-home PATH     Override HERMES_HOME (default: /hermes-state)
--verbose              Print per-batch and per-operation progress
```

## Scheduling

Add to the host crontab or a chore workflow.  Sunday 03:00 tenant-local
avoids the Monday brief-generation window (02:00) and the weekly
ChorePromotionReflectionWorkflow (also Sunday 03:00 — stagger by 30 min):

```
30 3 * * 0  root  nohup python3 /opt/alfred/scripts/hermes-session-retention.py \
              --apply --backup-ok >> /var/log/hermes-retention.log 2>&1
```

Run `--vacuum` monthly or when disk pressure exceeds 80%.
