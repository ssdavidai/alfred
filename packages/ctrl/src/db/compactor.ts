// ============================================================================
// TTL compactor — rolls aged-out state.db rows into the cold archive (Store 3).
//
// For each hot table (signal / observation / routing_decision / audit / link):
//   1. compute the cutoff = now - TTL_DAYS,
//   2. select every hot row with ts < cutoff,
//   3. zstd/gzip-compress the row JSON, INSERT it into the matching
//      archive_* table in cold.db (idempotent — PRIMARY KEY id, INSERT OR
//      REPLACE so a re-run after a partial failure is safe),
//   4. only once the cold write committed, DELETE the rows from state.db.
//
// Ordering matters: cold-write-then-hot-delete means a crash between the two
// leaves a row in BOTH tiers (the cross-tier reader de-dupes by id) — never a
// row in NEITHER. Data is never lost to a mid-compaction crash.
//
// The compactor batches to keep each transaction small (a year of audit rows
// could be large) and writes a cold_compact_log row per table per run.
// ============================================================================

import { getStateDb } from "./state.js";
import { getColdDb, coldCompress, COLD_CODEC, COLD_TTL_DAYS } from "./cold.js";

// How many rows to move per transaction. Bounds memory + lock-hold time.
const BATCH_SIZE = Number(process.env.COLD_COMPACT_BATCH ?? "500");

// Mapping from a hot table to (archive table, the plain index columns to copy
// out of the row alongside the compressed body). The first two columns are
// always id + ts; `extra` lists the table-specific filter columns.
interface TablePlan {
  hot: string;
  archive: string;
  extra: string[]; // filter columns kept uncompressed in the archive table
}

// B3: routing_decision.signal_id is `REFERENCES signal(id) ON DELETE SET NULL`
// (schema.sql) and ctrl-api opens state.db with `PRAGMA foreign_keys = ON`.
// Deleting an aged `signal` from hot would otherwise fire that FK and NULL the
// signal_id of routing_decisions that reference it — both ones being archived
// in the same run AND newer ones that stay hot — severing the cross-tier
// "decisions for signal X" join. The compactor disables foreign_keys for the
// duration of each hot-delete batch (see compactTable) so a compacted signal's
// inbound references are PRESERVED: the signal still exists, in cold. The PLANS
// order is therefore not load-bearing for correctness.
const PLANS: TablePlan[] = [
  { hot: "signal", archive: "archive_signal", extra: ["kind", "source", "status", "matter_ref"] },
  { hot: "observation", archive: "archive_observation", extra: ["subject", "kind", "status"] },
  {
    hot: "routing_decision",
    archive: "archive_routing_decision",
    extra: ["tier", "chosen_path", "outcome", "signal_id"],
  },
  {
    hot: "audit",
    archive: "archive_audit",
    extra: ["action_type", "actor", "source", "target_path", "subject_ref", "mode"],
  },
  { hot: "link", archive: "archive_link", extra: ["src_ref", "dst_ref", "rel"] },
];

export interface CompactTableResult {
  table: string;
  cutoff_ts: string;
  rows_moved: number;
  bytes_cold: number;
  duration_ms: number;
  ok: boolean;
  note?: string;
}

export interface CompactRunResult {
  ran_at: string;
  tables: CompactTableResult[];
  total_rows_moved: number;
}

function cutoffFor(ttlDays: number): string {
  return new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Compact a single table. Returns the per-table result. */
function compactTable(plan: TablePlan): CompactTableResult {
  const started = Date.now();
  const hot = getStateDb();
  const cold = getColdDb();
  const ttlDays = COLD_TTL_DAYS[plan.hot] ?? 90;
  const cutoff = cutoffFor(ttlDays);

  let rowsMoved = 0;
  let bytesCold = 0;
  let ok = true;
  let note: string | undefined;

  // Archive INSERT — columns are id, ts, ...extra, codec, body.
  const archiveCols = ["id", "ts", ...plan.extra, "codec", "body"];
  const placeholders = archiveCols.map(() => "?").join(", ");
  const insertSql =
    `INSERT OR REPLACE INTO ${plan.archive} (${archiveCols.join(", ")}) ` +
    `VALUES (${placeholders})`;

  try {
    const insertStmt = cold.prepare(insertSql);
    // Loop in batches until no hot rows remain past the cutoff.
    for (;;) {
      const batch = hot
        .prepare(`SELECT * FROM ${plan.hot} WHERE ts < ? ORDER BY ts ASC LIMIT ?`)
        .all(cutoff, BATCH_SIZE) as Array<Record<string, unknown>>;
      if (batch.length === 0) break;

      // ── cold write (one transaction) ──────────────────────────────────────
      cold.exec("BEGIN");
      try {
        for (const row of batch) {
          const json = JSON.stringify(row);
          const blob = coldCompress(json);
          bytesCold += blob.length;
          const args: unknown[] = [
            row.id,
            row.ts,
            ...plan.extra.map((c) => row[c] ?? null),
            COLD_CODEC,
            blob,
          ];
          insertStmt.run(...args);
        }
        cold.exec("COMMIT");
      } catch (err) {
        cold.exec("ROLLBACK");
        throw err;
      }

      // ── hot delete (only after the cold write committed) ──────────────────
      // A crash between the two steps duplicates rows across tiers; the
      // cross-tier reader de-dupes by id, so no row is lost and none surfaces
      // twice. Deleting by explicit id list keeps it exact even if a row's ts
      // changed concurrently (it cannot — these rows are far past any TTL).
      //
      // B3: deleting an aged `signal` would, with foreign_keys=ON, fire the
      // `routing_decision.signal_id … ON DELETE SET NULL` FK and NULL the
      // signal_id of any routing_decision that is NEWER than its signal and so
      // still hot — silently severing the (now hot-rd → cold-signal) join. The
      // signal is not gone, it is in cold; so the reference must be PRESERVED.
      // foreign_keys cannot be toggled inside a transaction (SQLite ignores it
      // there), so we drop it for the duration of the delete batch and restore
      // it after. Only `signal` has inbound FKs, but doing it unconditionally
      // is harmless and keeps the delete uniform.
      const ids = batch.map((r) => String(r.id));
      hot.exec("PRAGMA foreign_keys = OFF");
      hot.exec("BEGIN");
      try {
        const delStmt = hot.prepare(`DELETE FROM ${plan.hot} WHERE id = ?`);
        for (const id of ids) delStmt.run(id);
        hot.exec("COMMIT");
      } catch (err) {
        hot.exec("ROLLBACK");
        throw err;
      } finally {
        hot.exec("PRAGMA foreign_keys = ON");
      }

      rowsMoved += batch.length;
      // A short batch means we drained the backlog.
      if (batch.length < BATCH_SIZE) break;
    }
  } catch (err) {
    ok = false;
    note = err instanceof Error ? err.message : String(err);
    console.error(`[compactor] ${plan.hot} → ${plan.archive} failed: ${note}`);
  }

  const durationMs = Date.now() - started;

  // Observability row in cold.db.
  try {
    cold
      .prepare(
        `INSERT INTO cold_compact_log
           (table_name, cutoff_ts, rows_moved, bytes_cold, duration_ms, ok, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(plan.hot, cutoff, rowsMoved, bytesCold, durationMs, ok ? 1 : 0, note ?? null);
  } catch (err) {
    console.error(`[compactor] cold_compact_log write failed: ${err}`);
  }

  if (rowsMoved > 0) {
    console.log(
      `[compactor] ${plan.hot}: moved ${rowsMoved} row(s) older than ${cutoff} ` +
        `→ ${plan.archive} (${bytesCold} cold bytes, ${durationMs}ms)`,
    );
  }

  return {
    table: plan.hot,
    cutoff_ts: cutoff,
    rows_moved: rowsMoved,
    bytes_cold: bytesCold,
    duration_ms: durationMs,
    ok,
    note,
  };
}

/** Run the compactor across every hot table. Safe to call repeatedly. */
export function runCompaction(): CompactRunResult {
  const ranAt = new Date().toISOString();
  const tables: CompactTableResult[] = [];
  for (const plan of PLANS) {
    tables.push(compactTable(plan));
  }
  const totalRowsMoved = tables.reduce((a, t) => a + t.rows_moved, 0);
  return { ran_at: ranAt, tables, total_rows_moved: totalRowsMoved };
}

// ── periodic scheduler ───────────────────────────────────────────────────────
// Daily by default. Runs once shortly after boot (offset so it doesn't pile on
// the boot-time vault reconcile / ingest sweep), then on a 24h timer.

let _timer: NodeJS.Timeout | null = null;

const COMPACT_INTERVAL_MS = Number(
  process.env.COLD_COMPACT_INTERVAL_MS ?? String(24 * 60 * 60 * 1000),
);
// Delay the first run so boot stays light; default 5 min.
const COMPACT_BOOT_DELAY_MS = Number(
  process.env.COLD_COMPACT_BOOT_DELAY_MS ?? String(5 * 60 * 1000),
);

export function startCompactor(): void {
  if (_timer) return;
  // First run after a short boot delay.
  const bootTimer = setTimeout(() => {
    try {
      runCompaction();
    } catch (err) {
      console.error(`[compactor] boot run failed: ${err}`);
    }
  }, COMPACT_BOOT_DELAY_MS);
  bootTimer.unref?.();

  _timer = setInterval(() => {
    try {
      runCompaction();
    } catch (err) {
      console.error(`[compactor] periodic run failed: ${err}`);
    }
  }, COMPACT_INTERVAL_MS);
  _timer.unref?.();
  console.log(
    `[compactor] scheduled — first run in ${Math.round(COMPACT_BOOT_DELAY_MS / 1000)}s, ` +
      `then every ${Math.round(COMPACT_INTERVAL_MS / 3600000)}h`,
  );
}

export function stopCompactor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
