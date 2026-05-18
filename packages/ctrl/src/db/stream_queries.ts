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

import fs from "node:fs";
import path from "node:path";
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

// --- stuck pipeline detection (STORE-P4-2) ---------------------------------

export interface StuckPipelineReport {
  unprocessed_old_count: number;
  oldest_date: string | null;
  oldest_age_days: number;
  sample_event_ids: string[];
  consumer_lag_by_date: Array<{
    date: string;
    total: number;
    processed: number;
  }>;
}

/**
 * Walk /vault/_raw/*.jsonl partitions older than `stuck_after_days` (default
 * 7), counting events in each partition vs. how many of those event ids
 * have a corresponding row in stream_event_processed. Anything in an
 * old partition that's not marked processed = stuck.
 *
 * Returns:
 *   * unprocessed_old_count — total events sitting in partitions older
 *     than the cutoff that are NOT marked processed
 *   * oldest_date / oldest_age_days — the most-stuck partition
 *   * sample_event_ids — up to `sample_size` (default 10) ids the
 *     operator can grep for
 *   * consumer_lag_by_date — per-partition (total, processed) pairs
 *
 * The raw event being old isn't the problem on its own — the daily
 * compactor (STORE-P4-1) garbage-collects processed events at 7d.
 * Anything past 7d that's *not* marked processed = a stuck consumer.
 */
export function detectStuckPipeline(
  db: DatabaseSync,
  opts: { stuck_after_days?: number; sample_size?: number } = {},
): StuckPipelineReport {
  const stuckAfterDays = Math.max(1, opts.stuck_after_days ?? 7);
  const sampleSize = Math.max(1, Math.min(opts.sample_size ?? 10, 100));

  const vaultPath = process.env.VAULT_PATH ?? "/mnt/encrypted/vault";
  const rawDir = path.join(vaultPath, "_raw");

  let dates: string[];
  try {
    dates = fs
      .readdirSync(rawDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch {
    return {
      unprocessed_old_count: 0,
      oldest_date: null,
      oldest_age_days: 0,
      sample_event_ids: [],
      consumer_lag_by_date: [],
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();

  // Helper: age of a partition in whole UTC days from today.
  const ageDays = (date: string): number => {
    const partitionMs = new Date(`${date}T00:00:00Z`).getTime();
    return Math.floor((todayMs - partitionMs) / 86_400_000);
  };

  const lag: Array<{ date: string; total: number; processed: number }> = [];
  const samples: string[] = [];
  let unprocessedOld = 0;
  let oldestDate: string | null = null;
  let oldestAge = 0;

  for (const date of dates) {
    const age = ageDays(date);
    if (age < stuckAfterDays) continue;

    // Count lines + collect unprocessed ids from the partition. Read the
    // file once and walk line by line. Partitions in the david fleet are
    // ~MB-scale even on the heaviest day, so the simple readFile is fine
    // — same assumption as readStreamLogSlice / compactPartition.
    const file = path.join(rawDir, `${date}.jsonl`);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    // Build the set of processed event_ids for this partition once
    // (single SELECT vs. one per line).
    const processedIds = listProcessedIdsForDate(db, date);

    let total = 0;
    let processed = 0;
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line) continue;
      total++;
      let id: string | undefined;
      try {
        id = (JSON.parse(line) as { id?: string }).id;
      } catch {
        // Malformed lines — treat as unprocessed so the operator
        // notices, but skip the id sampling.
        unprocessedOld++;
        continue;
      }
      if (id && processedIds.has(id)) {
        processed++;
      } else {
        unprocessedOld++;
        if (id && samples.length < sampleSize) {
          samples.push(id);
        }
      }
    }

    lag.push({ date, total, processed });

    if (total - processed > 0 && (oldestDate === null || age > oldestAge)) {
      oldestDate = date;
      oldestAge = age;
    }
  }

  return {
    unprocessed_old_count: unprocessedOld,
    oldest_date: oldestDate,
    oldest_age_days: oldestAge,
    sample_event_ids: samples,
    consumer_lag_by_date: lag,
  };
}
