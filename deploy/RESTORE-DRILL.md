# Restic Restore Drill — Runbook

> Status: **Active**. Tied to epic [#898](https://github.com/ssdavidai/alfred-platform/issues/898) (Storage Architecture) and STORE-X-1 (#925).
> Last drill: 2026-05-18 on `raj313` (success — see §4).
> Owner: Sir (one-stakeholder).

## 1. Why this exists

The Storage Architecture migration moves a growing share of vault state
out of markdown files and into a single SQLite database
(`/var/lib/alfred/state.db`, served from `compose-ctrl-api-1`). A
backup that we never restore is just a hope; this runbook is the proof
that the backup is actually usable.

Run this drill at least:

- Once per tenant immediately after STORE-X-1 ships there.
- Once per storage-phase rollout (P1 onward) before promoting to the
  next tenant in the rollout order.
- Quarterly on the principal-canary (`david`).

The canary tenant for STORE-X-1 onward is **raj313** — smallest vault,
cheapest to drill, no production-data risk.

## 2. What gets backed up (STORE-X-1)

Each tenant's `/opt/alfred/backup.sh` includes these paths in the
restic snapshot:

| Path | Source | Notes |
|---|---|---|
| `/mnt/encrypted` | host filesystem | encrypted vault root (existing) |
| `/opt/alfred/state.db.snap` | host bind mount of ctrl-api container | new (STORE-X-1) — VACUUM INTO snapshot of `/var/lib/alfred/state.db` |
| `/vault/_archive/` | host (when present) | reserved for STORE-P5 cold Parquet — included unconditionally so future archive writes are covered without re-touching `backup.sh` |

`/mnt/encrypted/temporal` is excluded — Temporal's volatile workflow
history is regenerated from Alfred's vault on restart.

### SQLite consistency

`state.db` runs in WAL mode, so a naive `cp` of the live `.db` file
produces a torn snapshot (main file disagrees with `-wal`). The
backup.sh runs SQLite's `VACUUM INTO` from inside `compose-ctrl-api-1`
(via `docker exec` + `node:sqlite`), which takes the right locks,
walks the pages, and writes a single consistent file. The output goes
to `/opt/alfred/state.db.snap` (a host-visible bind mount) and is
deleted by the backup.sh's `EXIT` trap after restic completes.

The local equivalent is `scripts/sqlite-snapshot.sh` — same pattern,
usable outside a container.

## 3. Drill procedure

Run on the target tenant, as the `deploy` user.

```bash
# 0. Pick a target tenant. Default is raj313 (canary). Never drill
#    onto a production-data tenant unless you have a specific reason.
TENANT=raj313
ssh -o IdentityAgent=none -i ~/.ssh/id_ed25519 "$TENANT"

# 1. Source restic creds. The env carries S3 creds + repo + password +
#    AWS_DEFAULT_REGION (Hetzner requires this — added in STORE-X-1).
set -a; source /opt/alfred/restic.env; set +a
echo "Repo: $RESTIC_REPOSITORY"

# 2. Confirm there is a recent snapshot to restore.
restic snapshots --latest 1

# 3. Restore just state.db.snap to a scratch dir.
RESTORE_DIR=/tmp/restic-drill-$(date +%Y%m%d-%H%M%S)
mkdir -p "$RESTORE_DIR"
restic restore latest --target "$RESTORE_DIR" \
  --include /opt/alfred/state.db.snap

# 4. Verify the file landed.
ls -la "$RESTORE_DIR/opt/alfred/state.db.snap"

# 5. Read the restored snap from inside ctrl-api (where node:sqlite
#    is available) and compare row counts against the live db.
docker cp "$RESTORE_DIR/opt/alfred/state.db.snap" \
  compose-ctrl-api-1:/tmp/restored.snap

docker exec compose-ctrl-api-1 node --experimental-sqlite -e "
  const { DatabaseSync } = require('node:sqlite');
  const live = new DatabaseSync('/var/lib/alfred/state.db', { readOnly: true });
  const restored = new DatabaseSync('/tmp/restored.snap', { readOnly: true });
  const liveN = live.prepare('SELECT count(*) AS n FROM vault_index').get().n;
  const resN = restored.prepare('SELECT count(*) AS n FROM vault_index').get().n;
  console.log('live vault_index rows    :', liveN);
  console.log('restored vault_index rows:', resN);
  console.log('match:', liveN === resN);
"

# 6. Clean up — never leave a restored db on disk.
docker exec compose-ctrl-api-1 rm -f /tmp/restored.snap
rm -rf "$RESTORE_DIR"
```

### Acceptance for a successful drill

- `restic restore` exits 0.
- `/opt/alfred/state.db.snap` materializes in the scratch dir, size > 0.
- `restored vault_index rows == live vault_index rows`.
  (A small drift — single-digit rows — is acceptable if writes
  happened during the drill; a delta of more than ~10 is a regression
  and should be investigated.)

A failed drill **blocks** STORE-X-1 from being declared shipped on
that tenant. Open an issue, link the epic (#898), and do not advance
the rollout.

## 4. Drill log

| Date | Tenant | Snapshot ID | Live rows | Restored rows | Result |
|---|---|---|---|---|---|
| 2026-05-18 | raj313 | `3aded238` | 844 | 844 | PASS |
| 2026-05-18 | miguel | `e956af83` | — | — | snapshot ✓ / drill pending (OPS-BACKUP-1) |
| 2026-05-18 | rapali | `e8b0ff2f` | — | — | snapshot ✓ / drill pending (OPS-BACKUP-1) |
| 2026-05-18 | david  | `df0989e1` | — | — | snapshot ✓ / drill pending (OPS-BACKUP-1) |

When a new drill runs, append a row to this table.

### Fleet backup status (post OPS-BACKUP-1)

STORE-X-1 left three tenants in a "deployed-but-undrilled" state because
the Hetzner S3 buckets were never initialised. OPS-BACKUP-1 added
`AWS_DEFAULT_REGION=fsn1` to `/opt/alfred/restic.env`, ran `restic init`,
and verified one backup landed (with `state.db.snap` present) on each.
Full restore drills are still pending — miguel/rapali/david have not yet
run the §3 procedure end-to-end.

## 5. Operational notes

- **Snapshot is host-visible only during a backup run.** The
  `EXIT` trap in `/opt/alfred/backup.sh` deletes
  `/opt/alfred/state.db.snap` after `restic backup` returns. The file
  should not be present between runs; if it is, the previous run died
  hard and that should be investigated.

- **Hetzner S3 region.** Hetzner Object Storage requires
  `AWS_DEFAULT_REGION` to match the endpoint suffix (e.g. `fsn1`).
  This is set in `/opt/alfred/restic.env`. Restic init and backup both
  fail with a misleading "bucket does not exist" error when the region
  is missing — that bit eight hours into the STORE-X-1 verification
  and is worth knowing.

- **Repo init.** If `restic snapshots` reports "bucket does not exist"
  but the bucket *should* exist, the repo has not been initialised.
  `set -a; source /opt/alfred/restic.env; set +a; restic init` will
  create both the bucket and the repo. STORE-X-1 verified this works
  on raj313 (the bucket was missing pre-flight and was created during
  the drill).

- **Restoring the full snapshot.** The drill above restores only
  `state.db.snap` because it's cheap and proves the backup-restore
  loop. To restore the whole vault, drop the `--include` flag and
  let restic restore `/mnt/encrypted` too. Don't do this on a live
  tenant without first stopping `alfred` and `openclaw`.

## 6. References

- `deploy/STORAGE-ROLLOUT.md` — per-phase rollout runbook; this drill
  is the §4 backup gate.
- `scripts/sqlite-snapshot.sh` — local helper that wraps
  `VACUUM INTO`; same algorithm the tenant backup.sh runs in-container.
- `/opt/alfred/backup.sh` (per tenant) — the deployed copy of the
  backup script described in STORE-X-1. Not checked into this repo;
  patched by hand per the rollout doc.
