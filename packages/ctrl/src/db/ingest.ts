// ============================================================================
// ingest.db — Store 4 open/init module + 7-day TTL sweep.
//
// A SECOND, distinct SQLite file (separate from state.db) so a firehose burst
// of inbound stream events never takes the write lock on state.db working
// memory. ctrl-api is still the sole writer.
//
// Stream events are raw input: consume-then-delete, hard 7d TTL, no archive.
// ============================================================================

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import ingestSchema from "./ingest-schema.sql";

const INGEST_DB_PATH =
  process.env.INGEST_DB_PATH ?? path.join(process.cwd(), "data", "ingest.db");

// TTL window. A PROCESSED stream event older than this is dropped; an
// UNPROCESSED one is retained (#17) and reported as stale_dropped instead.
const INGEST_TTL_DAYS = Number(process.env.INGEST_TTL_DAYS ?? "7");

// How often the in-process sweep runs.
const SWEEP_INTERVAL_MS = Number(
  process.env.INGEST_SWEEP_INTERVAL_MS ?? String(6 * 60 * 60 * 1000),
);

/** Retryable failures per event before it dead-letters (#311). */
export const INGEST_FAILURE_BUDGET = 5;

/**
 * Add any missing columns to an existing table.
 *
 * `ingest-schema.sql` is CREATE-only-idempotent: `CREATE TABLE IF NOT EXISTS`
 * is a no-op once the table exists, so new columns never reach a tenant that
 * was provisioned earlier. There is no migration runner on ingest.db (unlike
 * state.db), so the retrofit happens here, at open time, guarded by
 * PRAGMA table_info so it is safe to run on every boot.
 */
function ensureColumns(
  db: DatabaseSync,
  table: string,
  columns: Record<string, string>,
): void {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: unknown }>)
      .map((r) => String(r.name)),
  );
  for (const [name, decl] of Object.entries(columns)) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

let _db: DatabaseSync | null = null;
let _sweepTimer: NodeJS.Timeout | null = null;

export function getIngestDb(): DatabaseSync {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(INGEST_DB_PATH), { recursive: true });

  const db = new DatabaseSync(INGEST_DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(ingestSchema);
  // Retrofit the dead-letter columns onto tenants provisioned before #311.
  ensureColumns(db, "stream_event", {
    failure_count: "INTEGER NOT NULL DEFAULT 0",
    last_error: "TEXT",
    dead_lettered_at: "TEXT",
    dead_letter_reason: "TEXT",
  });
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_stream_event_dead_letter " +
      "ON stream_event(dead_lettered_at) WHERE dead_lettered_at IS NOT NULL",
  );

  _db = db;
  return db;
}

export interface SweepResult {
  cutoff_ts: string;
  total_deleted: number;
  processed_deleted: number;
  stale_dropped: number;
}

/**
 * Enforce the 7-day TTL: delete every PROCESSED stream_event with `ts` older
 * than the cutoff. Aged-out UNPROCESSED rows are RETAINED — deleting them is
 * silent inbound data loss (#17). Records a row in ingest_sweep_log.
 * `stale_dropped` counts the aged-out-but-retained unprocessed rows; it is the
 * alert signal that the EventProcessor has fallen behind.
 */
export function sweepIngestTTL(): SweepResult {
  const db = getIngestDb();
  const cutoff = new Date(Date.now() - INGEST_TTL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString();

  // #17: the TTL is consume-then-delete. Only PROCESSED rows are deleted —
  // an aged-out UNPROCESSED event is RETAINED (deleting it is silent data
  // loss whenever anything upstream of mark_stream_event_processed wedges).
  // staleDropped is now an alert count of aged-out-but-RETAINED rows: it means
  // the EventProcessor has fallen behind, not that data was discarded.
  const staleRow = db
    .prepare(
      "SELECT COUNT(*) AS n FROM stream_event WHERE ts < ? AND processed_at IS NULL",
    )
    .get(cutoff) as { n: number };
  const processedRow = db
    .prepare(
      "SELECT COUNT(*) AS n FROM stream_event WHERE ts < ? AND processed_at IS NOT NULL",
    )
    .get(cutoff) as { n: number };

  const staleDropped = staleRow?.n ?? 0;
  const processedDeleted = processedRow?.n ?? 0;
  const totalDeleted = processedDeleted;

  db.prepare(
    "DELETE FROM stream_event WHERE ts < ? AND processed_at IS NOT NULL",
  ).run(cutoff);
  db.prepare(
    `INSERT INTO ingest_sweep_log
       (cutoff_ts, total_deleted, processed_deleted, stale_dropped)
     VALUES (?, ?, ?, ?)`,
  ).run(cutoff, totalDeleted, processedDeleted, staleDropped);

  if (staleDropped > 0) {
    console.warn(
      `[ingest.db] TTL sweep RETAINED ${staleDropped} UNPROCESSED stream events ` +
        `older than ${INGEST_TTL_DAYS}d (not deleted) — EventProcessor is behind.`,
    );
  }

  return {
    cutoff_ts: cutoff,
    total_deleted: totalDeleted,
    processed_deleted: processedDeleted,
    stale_dropped: staleDropped,
  };
}

/** Start the periodic in-process TTL sweep. Runs once at boot, then on a timer. */
export function startIngestSweep(): void {
  if (_sweepTimer) return;
  try {
    sweepIngestTTL();
  } catch (err) {
    console.error(`[ingest.db] boot sweep failed: ${err}`);
  }
  _sweepTimer = setInterval(() => {
    try {
      sweepIngestTTL();
    } catch (err) {
      console.error(`[ingest.db] periodic sweep failed: ${err}`);
    }
  }, SWEEP_INTERVAL_MS);
  // Don't hold the event loop open for the sweep timer.
  _sweepTimer.unref?.();
}

export function closeIngestDb(): void {
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
  if (_db) {
    _db.close();
    _db = null;
  }
}

export { INGEST_DB_PATH, INGEST_TTL_DAYS };
