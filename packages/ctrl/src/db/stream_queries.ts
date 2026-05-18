// stream_queries.ts
//
// STORE-P4-1: typed query helpers for the Phase 4 stream tables
// (migration 005). These wrap stream_consumer_offset (next-unread line
// per (consumer, date)) and stream_event_processed (idempotency +
// compaction record).
//
// All `processed_at` / `updated_at` columns are unix nanoseconds and
// exceed Number.MAX_SAFE_INTEGER, so every SELECT that returns them
// calls `stmt.setReadBigInts(true)`. Without that flag node:sqlite
// throws RangeError when materialising the row (STORE-P1-4 lesson).

import type { DatabaseSync } from "node:sqlite";

export interface ConsumerOffsetRow {
  consumer: string;
  date: string;
  line_offset: number;
  updated_at: bigint;
}

export interface ProcessedEventRow {
  event_id: string;
  date: string;
  processed_at: bigint;
  consumer: string;
}

// --- stream_consumer_offset -------------------------------------------------

export function getConsumerOffset(
  db: DatabaseSync,
  consumer: string,
  date: string,
): number {
  const stmt = db.prepare(
    "SELECT line_offset FROM stream_consumer_offset WHERE consumer = ? AND date = ?",
  );
  // line_offset fits in a JS number (it's a file line index, not ns),
  // but updated_at on adjacent rows is bigint — we select only the
  // line_offset column so no bigint flag needed here.
  const row = stmt.get(consumer, date) as { line_offset: number } | undefined;
  return row?.line_offset ?? 0;
}

export function setConsumerOffset(
  db: DatabaseSync,
  consumer: string,
  date: string,
  lineOffset: number,
): void {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const stmt = db.prepare(
    `INSERT INTO stream_consumer_offset (consumer, date, line_offset, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(consumer, date) DO UPDATE SET
       line_offset = excluded.line_offset,
       updated_at  = excluded.updated_at`,
  );
  stmt.run(consumer, date, lineOffset, nowNs);
}

/**
 * Return all (date, line_offset) rows for a consumer ordered by date asc.
 * Used by the read endpoint to walk forward across day boundaries when
 * the consumer is fully caught up on an older file.
 */
export function listConsumerOffsets(
  db: DatabaseSync,
  consumer: string,
): { date: string; line_offset: number }[] {
  const stmt = db.prepare(
    "SELECT date, line_offset FROM stream_consumer_offset WHERE consumer = ? ORDER BY date ASC",
  );
  return stmt.all(consumer) as { date: string; line_offset: number }[];
}

// --- stream_event_processed -------------------------------------------------

export function markEventProcessed(
  db: DatabaseSync,
  eventId: string,
  date: string,
  consumer: string,
): void {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const stmt = db.prepare(
    `INSERT INTO stream_event_processed (event_id, date, processed_at, consumer)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       processed_at = excluded.processed_at,
       consumer     = excluded.consumer,
       date         = excluded.date`,
  );
  stmt.run(eventId, date, nowNs, consumer);
}

export function getEventProcessed(
  db: DatabaseSync,
  eventId: string,
): ProcessedEventRow | null {
  const stmt = db.prepare(
    "SELECT event_id, date, processed_at, consumer FROM stream_event_processed WHERE event_id = ?",
  );
  // processed_at is unix-ns bigint.
  stmt.setReadBigInts(true);
  const row = stmt.get(eventId) as ProcessedEventRow | undefined;
  return row ?? null;
}

/**
 * Return the set of event_ids on a given date partition that are marked
 * processed. Used by the compactor to filter a JSONL down to only the
 * unprocessed lines (kept) vs. dropped.
 */
export function listProcessedIdsForDate(
  db: DatabaseSync,
  date: string,
): Set<string> {
  const stmt = db.prepare(
    "SELECT event_id FROM stream_event_processed WHERE date = ?",
  );
  const rows = stmt.all(date) as { event_id: string }[];
  return new Set(rows.map((r) => r.event_id));
}

/**
 * Drop processed rows whose processed_at is older than the cutoff (unix ns).
 * Called by the compactor after a partition is fully rewritten or deleted,
 * so the row store doesn't accumulate forever.
 */
export function deleteProcessedOlderThan(
  db: DatabaseSync,
  cutoffNs: bigint,
): number {
  const stmt = db.prepare(
    "DELETE FROM stream_event_processed WHERE processed_at < ?",
  );
  const result = stmt.run(cutoffNs);
  return Number(result.changes);
}
