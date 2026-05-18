// vault_reconciler.ts
//
// STORE-P1-5: drift detector + repair workflow for `vault_index`.
//
// Background:
//   * P1-2 populates the table on boot.
//   * P1-3 keeps it in sync on every ctrl-api vault mutation.
//   * P1-4 serves list endpoints from it.
//
// Drift remains possible because the alfred container's curator pipeline
// and Obsidian-side hand-edits both write `.md` files into /mnt/encrypted/vault
// WITHOUT going through ctrl-api. This module is the fail-safe: a
// periodic walk that compares (path, mtime_ns) on disk vs. in the index
// and applies the diff.
//
// Scope:
//   * Light periodic sweep — INSERT missing, DELETE orphans, UPSERT on
//     mtime mismatch. Runs in the ctrl-api Node process via setInterval
//     (see standalone.ts).
//   * Heavy hammer — `reindexFull` truncates + repopulates from scratch.
//     Invoked only by the `reindex` CLI subcommand.
//
// Design rules (carried over from the P1-3 / P1-4 hotfix lessons):
//   * Any SELECT that surfaces `mtime_ns` MUST call `setReadBigInts(true)`.
//     The column holds unix nanoseconds (~1.78e18), above MAX_SAFE_INTEGER;
//     node:sqlite raises RangeError otherwise.
//   * Skip rules MUST match the indexer (`_migrated*` prefix +
//     INDEXER_EXTRA_IGNORE_DIRS) so the reconciler never re-adds rows
//     the indexer would have left out.
//   * Never throw out of the scheduled tick — log and return. Drift is
//     a recoverable condition; killing ctrl-api over it is not.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openStateDb } from "../../db/state.js";
import {
  VAULT_PATH as DEFAULT_VAULT_PATH,
  IGNORE_DIRS as VAULT_IGNORE_DIRS,
  walkMd,
} from "../routes/vault.js";
import {
  syncVaultIndexFromContent,
  deleteVaultIndexRow,
} from "../vault_index_sync.js";

// Same ignore set the boot-time indexer uses. Kept in sync with
// vault_indexer.ts INDEXER_EXTRA_IGNORE_DIRS / IGNORE_PREFIXES so the
// reconciler never re-introduces rows the indexer would have skipped.
const INDEXER_EXTRA_IGNORE_DIRS = new Set([
  "_archive",
  "_rescue",
  "__pycache__",
  "node_modules",
]);
const IGNORE_PREFIXES = ["_migrated"];

function buildIgnoreDirs(): Set<string> {
  const combined = new Set<string>(VAULT_IGNORE_DIRS);
  for (const name of INDEXER_EXTRA_IGNORE_DIRS) combined.add(name);
  return combined;
}

function shouldSkipRelPath(rel: string): boolean {
  const top = rel.split("/")[0] ?? "";
  for (const prefix of IGNORE_PREFIXES) {
    if (top.startsWith(prefix)) return true;
  }
  return false;
}

export interface ReconcileResult {
  scanned: number;
  inserted: number;
  updated: number;
  deleted: number;
  ms: number;
  ts: string;
}

export interface ReconcileResultWithBreakdown extends ReconcileResult {
  byTypeDisk: Record<string, number>;
  byTypeIndex: Record<string, number>;
  missingInIndex: number;
  missingInFs: number;
  mtimeMismatch: number;
}

// In-memory cache of the most recent reconcile run. Read by
// /admin/storage-metrics so the SaaS dashboard can show "drift is
// shrinking" vs "drift keeps growing". Reset on process restart, which
// is fine — the boot scan already establishes a baseline.
let _lastReconcile: (ReconcileResult & { missing_in_index?: number; alert?: boolean }) | null =
  null;

export function getLastReconcileResult():
  | (ReconcileResult & { missing_in_index?: number; alert?: boolean })
  | null {
  return _lastReconcile;
}

// Threshold for "something new is bypassing ctrl-api at scale". When a
// single reconcile run finds more than this many missing-in-index
// records, we log WARNING and set the `alert` flag in the metrics
// endpoint so the SaaS-side StorageDashboard banner turns red.
const MISSING_IN_INDEX_ALERT_THRESHOLD = 500;

interface DiskEntry {
  rel: string;
  mtimeNs: bigint;
  full: string;
}

function buildDiskMap(vaultPath: string): Map<string, DiskEntry> {
  const ignoreDirs = buildIgnoreDirs();
  const files = walkMd(vaultPath, vaultPath, ignoreDirs);
  const map = new Map<string, DiskEntry>();
  for (const relRaw of files) {
    const rel = relRaw.replace(/\\/g, "/");
    if (!rel) continue;
    if (shouldSkipRelPath(rel)) continue;
    const full = path.join(vaultPath, rel);
    let mtimeNs: bigint;
    try {
      const st = fs.statSync(full, { bigint: true });
      mtimeNs = st.mtimeNs;
    } catch {
      // File vanished mid-walk — skip; we'll catch it next tick.
      continue;
    }
    map.set(rel, { rel, mtimeNs, full });
  }
  return map;
}

function buildIndexMap(db: DatabaseSync): Map<string, bigint> {
  // mtime_ns column is bigint — required setReadBigInts(true) per the
  // P1-4 hotfix lesson; node:sqlite raises RangeError otherwise.
  const stmt = db.prepare("SELECT path, mtime_ns FROM vault_index");
  stmt.setReadBigInts(true);
  const rows = stmt.all() as unknown as Array<{ path: string; mtime_ns: bigint }>;
  const map = new Map<string, bigint>();
  for (const row of rows) {
    map.set(row.path, row.mtime_ns);
  }
  return map;
}

/**
 * Walk the vault, diff against vault_index, apply the diff. Idempotent.
 *
 * Insert / update flows through syncVaultIndexFromContent so it shares
 * the exact same column derivation as the write-through path (P1-3).
 * Deletes go through deleteVaultIndexRow.
 */
export async function reconcileVaultIndex(opts?: {
  vaultPath?: string;
  db?: DatabaseSync;
}): Promise<ReconcileResultWithBreakdown> {
  const t0 = Date.now();
  const vaultPath =
    opts?.vaultPath ?? process.env.VAULT_PATH ?? DEFAULT_VAULT_PATH;
  const db = opts?.db ?? openStateDb();

  const diskMap = buildDiskMap(vaultPath);
  const indexMap = buildIndexMap(db);

  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  let missingInIndex = 0;
  let missingInFs = 0;
  let mtimeMismatch = 0;

  const byTypeDisk: Record<string, number> = {};
  const byTypeIndex: Record<string, number> = {};
  for (const rel of diskMap.keys()) {
    const top = rel.split("/")[0] ?? "_";
    byTypeDisk[top] = (byTypeDisk[top] ?? 0) + 1;
  }
  for (const rel of indexMap.keys()) {
    const top = rel.split("/")[0] ?? "_";
    byTypeIndex[top] = (byTypeIndex[top] ?? 0) + 1;
  }

  // 1) Disk → index pass: insert missing + upsert on mtime mismatch.
  for (const [rel, entry] of diskMap) {
    const indexed = indexMap.get(rel);
    if (indexed === undefined) {
      missingInIndex++;
      let content: string;
      try {
        content = fs.readFileSync(entry.full, "utf-8");
      } catch {
        continue;
      }
      try {
        syncVaultIndexFromContent({
          db,
          vaultPath,
          relPath: rel,
          content,
        });
        inserted++;
      } catch (err) {
        console.warn(
          `[vault_reconciler] insert failed path=${rel} err=${(err as Error).message}`,
        );
      }
      continue;
    }
    if (indexed !== entry.mtimeNs) {
      mtimeMismatch++;
      let content: string;
      try {
        content = fs.readFileSync(entry.full, "utf-8");
      } catch {
        continue;
      }
      try {
        syncVaultIndexFromContent({
          db,
          vaultPath,
          relPath: rel,
          content,
        });
        updated++;
      } catch (err) {
        console.warn(
          `[vault_reconciler] update failed path=${rel} err=${(err as Error).message}`,
        );
      }
    }
  }

  // 2) Index → disk pass: drop orphan rows.
  for (const rel of indexMap.keys()) {
    if (!diskMap.has(rel)) {
      missingInFs++;
      try {
        deleteVaultIndexRow(db, rel);
        deleted++;
      } catch (err) {
        console.warn(
          `[vault_reconciler] delete failed path=${rel} err=${(err as Error).message}`,
        );
      }
    }
  }

  const ms = Date.now() - t0;
  const result: ReconcileResultWithBreakdown = {
    scanned: diskMap.size,
    inserted,
    updated,
    deleted,
    ms,
    ts: new Date().toISOString(),
    byTypeDisk,
    byTypeIndex,
    missingInIndex,
    missingInFs,
    mtimeMismatch,
  };

  const alert = missingInIndex > MISSING_IN_INDEX_ALERT_THRESHOLD;
  _lastReconcile = {
    scanned: result.scanned,
    inserted: result.inserted,
    updated: result.updated,
    deleted: result.deleted,
    ms: result.ms,
    ts: result.ts,
    missing_in_index: missingInIndex,
    alert,
  };

  if (alert) {
    console.warn(
      `[vault_reconciler] WARNING: missing_in_index=${missingInIndex} > ${MISSING_IN_INDEX_ALERT_THRESHOLD}; ` +
        `some writer is bypassing ctrl-api at scale`,
    );
  }

  return result;
}

/**
 * Diff-only: walk the vault, build the (rel → mtimeNs) maps, and report
 * what reconcile WOULD do without mutating anything. Backs the
 * `index-diff` CLI subcommand.
 */
export async function diffVaultIndex(opts?: {
  vaultPath?: string;
  db?: DatabaseSync;
}): Promise<{
  scanned: number;
  indexRows: number;
  missingInIndex: number;
  missingInFs: number;
  mtimeMismatch: number;
  byTypeDisk: Record<string, number>;
  byTypeIndex: Record<string, number>;
  ms: number;
}> {
  const t0 = Date.now();
  const vaultPath =
    opts?.vaultPath ?? process.env.VAULT_PATH ?? DEFAULT_VAULT_PATH;
  const db = opts?.db ?? openStateDb();

  const diskMap = buildDiskMap(vaultPath);
  const indexMap = buildIndexMap(db);

  let missingInIndex = 0;
  let missingInFs = 0;
  let mtimeMismatch = 0;
  const byTypeDisk: Record<string, number> = {};
  const byTypeIndex: Record<string, number> = {};
  for (const rel of diskMap.keys()) {
    const top = rel.split("/")[0] ?? "_";
    byTypeDisk[top] = (byTypeDisk[top] ?? 0) + 1;
  }
  for (const rel of indexMap.keys()) {
    const top = rel.split("/")[0] ?? "_";
    byTypeIndex[top] = (byTypeIndex[top] ?? 0) + 1;
  }
  for (const [rel, entry] of diskMap) {
    const indexed = indexMap.get(rel);
    if (indexed === undefined) {
      missingInIndex++;
    } else if (indexed !== entry.mtimeNs) {
      mtimeMismatch++;
    }
  }
  for (const rel of indexMap.keys()) {
    if (!diskMap.has(rel)) missingInFs++;
  }
  return {
    scanned: diskMap.size,
    indexRows: indexMap.size,
    missingInIndex,
    missingInFs,
    mtimeMismatch,
    byTypeDisk,
    byTypeIndex,
    ms: Date.now() - t0,
  };
}

/**
 * Heavy hammer: TRUNCATE vault_index and rerun the boot scan from
 * scratch. Used only by the `reindex` CLI subcommand for "the index is
 * suspected to be wildly wrong" cases. Output shape matches the boot
 * scan's `vault_indexer.scan` log line.
 */
export async function reindexFull(opts?: {
  vaultPath?: string;
  db?: DatabaseSync;
}): Promise<{ scanned: number; inserted: number; ms: number }> {
  const { scanVaultAndPopulate } = await import("../vault_indexer.js");
  const db = opts?.db ?? openStateDb();
  // DELETE not DROP — preserves the schema + indices created by
  // migration 002. Same transaction wraps the truncate so a failed
  // repopulate doesn't leave an empty table behind.
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM vault_index");
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }
  return scanVaultAndPopulate({ db, vaultPath: opts?.vaultPath });
}

// ---------------------------------------------------------------------------
// Scheduled tick — wired up from standalone.ts.
// ---------------------------------------------------------------------------

// 1 hour between reconcile ticks. The walk is ~88k stats + ~88k
// SELECTs + a small diff; on david's volume this is well under a
// second of CPU and the dominant cost is the readdir tree, which the
// kernel caches.
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
// 5 minute delay before the FIRST tick fires. The boot scan races with
// the SaaS proxy's first poll, and the reconciler reads the same files
// the boot scan just wrote; spacing them out avoids stat-cache thrash.
const RECONCILE_INITIAL_DELAY_MS = 5 * 60 * 1000;

let _intervalHandle: ReturnType<typeof setInterval> | null = null;
let _initialTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

/** Start the scheduled reconciler. Safe to call once at boot. Returns a
 *  stop() for tests. */
export function startScheduledReconciler(): () => void {
  if (_intervalHandle || _initialTimeoutHandle) {
    // Already started — caller likely doubled up. No-op.
    return () => {};
  }

  const tick = async () => {
    try {
      const result = await reconcileVaultIndex();
      console.log(
        `vault_reconciler.tick: scanned=${result.scanned} inserted=${result.inserted} ` +
          `updated=${result.updated} deleted=${result.deleted} ` +
          `missing_in_index=${result.missingInIndex} missing_in_fs=${result.missingInFs} ` +
          `mtime_mismatch=${result.mtimeMismatch} elapsed_ms=${result.ms}`,
      );
    } catch (err) {
      // Drift is recoverable; killing ctrl-api over it is not.
      console.warn(
        `[vault_reconciler] tick failed: ${(err as Error).message}`,
      );
    }
  };

  _initialTimeoutHandle = setTimeout(() => {
    _initialTimeoutHandle = null;
    void tick();
    _intervalHandle = setInterval(tick, RECONCILE_INTERVAL_MS);
  }, RECONCILE_INITIAL_DELAY_MS);

  return () => {
    if (_initialTimeoutHandle) {
      clearTimeout(_initialTimeoutHandle);
      _initialTimeoutHandle = null;
    }
    if (_intervalHandle) {
      clearInterval(_intervalHandle);
      _intervalHandle = null;
    }
  };
}
