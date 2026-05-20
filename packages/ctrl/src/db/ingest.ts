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

// Hard TTL. A stream event older than this is dropped whether or not it was
// ever consumed.
const INGEST_TTL_DAYS = Number(process.env.INGEST_TTL_DAYS ?? "7");

// How often the in-process sweep runs.
const SWEEP_INTERVAL_MS = Number(
  process.env.INGEST_SWEEP_INTERVAL_MS ?? String(6 * 60 * 60 * 1000),
);

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
 * Enforce the 7-day TTL: delete every stream_event with `ts` older than the
 * cutoff. Records a row in ingest_sweep_log. `stale_dropped` (unprocessed
 * events that aged out) is the alert signal — it means the EventProcessor has
 * fallen behind.
 */
export function sweepIngestTTL(): SweepResult {
  const db = getIngestDb();
  const cutoff = new Date(Date.now() - INGEST_TTL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString();

  const staleRow = db
    .prepare(
      "SELECT COUNT(*) AS n FROM stream_event WHERE ts < ? AND processed_at IS NULL",
    )
    .get(cutoff) as { n: number };
  const totalRow = db
    .prepare("SELECT COUNT(*) AS n FROM stream_event WHERE ts < ?")
    .get(cutoff) as { n: number };

  const staleDropped = staleRow?.n ?? 0;
  const totalDeleted = totalRow?.n ?? 0;
  const processedDeleted = totalDeleted - staleDropped;

  db.prepare("DELETE FROM stream_event WHERE ts < ?").run(cutoff);
  db.prepare(
    `INSERT INTO ingest_sweep_log
       (cutoff_ts, total_deleted, processed_deleted, stale_dropped)
     VALUES (?, ?, ?, ?)`,
  ).run(cutoff, totalDeleted, processedDeleted, staleDropped);

  if (staleDropped > 0) {
    console.warn(
      `[ingest.db] TTL sweep dropped ${staleDropped} UNPROCESSED stream events ` +
        `older than ${INGEST_TTL_DAYS}d — EventProcessor may be behind.`,
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
