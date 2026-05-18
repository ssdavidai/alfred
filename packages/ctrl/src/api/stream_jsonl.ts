// stream_jsonl.ts
//
// STORE-P4-1: Phase 4 of the Storage Architecture migration (epic #898).
//
// Store 4 is a date-partitioned JSONL log at /vault/_raw/YYYY-MM-DD.jsonl.
// Replaces the legacy per-event markdown files under
// /vault/stream_event/<event-id>.md (~7k files on david at steady state).
//
// One line per event, schema:
//   { "id":           string,    // gmail msg id / gcal event id / composio id
//     "ts_ns":        string,    // unix nanoseconds (stringified to keep JSON precision)
//     "source_type":  string,    // 'gmail' | 'gcal' | 'composio' | 'omi' | 'webhook:<label>' | ...
//     "source_id":    string,    // the upstream provider's stable id (== id)
//     "received_at":  string,    // ISO-8601 UTC
//     "headers":      object?,   // optional source-specific headers
//     "payload":      object     // raw event body
//   }
//
// Idempotency: `id` is the upstream id (gmail message id, gcal event id,
// composio event id), so a re-delivery of the same upstream event is a
// no-op append-but-marked-duplicate. The consumer-side processed_at
// table (migration 005) keeps the dedup honest across consumer restarts.
//
// During the Phase 4 soak the legacy markdown write path stays gated on
// STREAM_LOG_ENFORCEMENT:
//   shadow  — write JSONL AND legacy markdown (default)
//   warn    — write JSONL only, log a warning when callers try the markdown path
//   reject  — write JSONL only, refuse markdown writes with 410 Gone

import fs from "node:fs";
import path from "node:path";

const VAULT_PATH = process.env.VAULT_PATH ?? "/mnt/encrypted/vault";
const RAW_DIR = path.join(VAULT_PATH, "_raw");

export type EnforcementMode = "shadow" | "warn" | "reject";

export function getEnforcementMode(): EnforcementMode {
  const v = (process.env.STREAM_LOG_ENFORCEMENT ?? "shadow").toLowerCase();
  if (v === "warn" || v === "reject") return v;
  return "shadow";
}

export interface StreamLogEntry {
  id: string;
  ts_ns: string;
  source_type: string;
  source_id: string;
  received_at: string;
  headers?: Record<string, unknown>;
  payload: unknown;
}

export interface AppendOptions {
  /** Override the partition date (default: today UTC). */
  date?: string;
}

function utcDateString(d: Date = new Date()): string {
  // YYYY-MM-DD in UTC. Stable for date-partitioning across timezones.
  return d.toISOString().slice(0, 10);
}

export function rawLogPath(date: string): string {
  return path.join(RAW_DIR, `${date}.jsonl`);
}

/**
 * Append one stream-log entry to /vault/_raw/<date>.jsonl. Creates the
 * file on first write of a day. Caller is responsible for upstream
 * idempotency on `id` (we don't scan the file before append — that
 * would dominate hot-path latency). Duplicate ids are tolerated; the
 * consumer-side stream_event_processed table is the authoritative
 * dedup.
 *
 * Returns the absolute path written and the wall-clock byte length of
 * the line (useful for tests/metrics).
 */
export function appendStreamLogEntry(
  entry: StreamLogEntry,
  opts: AppendOptions = {},
): { path: string; bytes: number; date: string } {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const date = opts.date ?? utcDateString();
  const file = rawLogPath(date);
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(file, line);
  return { path: file, bytes: Buffer.byteLength(line, "utf-8"), date };
}

/**
 * Read a slice of a date partition starting at `lineOffset`. Used by
 * the consumer endpoint (GET /api/v1/streams/events) to hand the next N
 * unprocessed events to event_processor.
 *
 * Returns at most `max` entries plus the new `nextOffset` the caller
 * should write back into stream_consumer_offset.
 *
 * Implementation note: for partitions under ~50 MB (well above david's
 * ~7k events ≈ a few MB/day on the heaviest day) we just read the file
 * and slice. If a single day ever crosses 50 MB we'll need to keep a
 * byte-offset alongside the line index so we can pread() directly. Not
 * worth the complexity until we have evidence.
 */
export function readStreamLogSlice(
  date: string,
  lineOffset: number,
  max: number,
): { entries: StreamLogEntry[]; nextOffset: number; reachedEnd: boolean } {
  const file = rawLogPath(date);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { entries: [], nextOffset: lineOffset, reachedEnd: true };
  }
  // split() leaves an empty trailing element when the file ends with
  // "\n" (which appendStreamLogEntry guarantees) — filter that out so
  // the offset arithmetic matches the actual event count.
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const total = lines.length;
  const start = Math.max(0, lineOffset);
  const end = Math.min(total, start + Math.max(1, max));
  const slice = lines.slice(start, end);

  const entries: StreamLogEntry[] = [];
  for (const line of slice) {
    try {
      entries.push(JSON.parse(line) as StreamLogEntry);
    } catch {
      // Skip malformed lines so a single corrupt entry can't wedge the
      // consumer. The line is still counted in nextOffset so we don't
      // re-read it next tick.
    }
  }
  return {
    entries,
    nextOffset: end,
    reachedEnd: end >= total,
  };
}

/**
 * Return the list of partition dates (YYYY-MM-DD) present in /vault/_raw,
 * ordered ascending. Used by the compactor and by the consumer endpoint
 * to walk forward when one day is fully consumed.
 */
export function listPartitionDates(): string[] {
  try {
    return fs
      .readdirSync(RAW_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Count lines in a partition without loading it. Used by /metrics-style
 * endpoints and by the compactor to skip empty files.
 */
export function countPartitionLines(date: string): number {
  const file = rawLogPath(date);
  let count = 0;
  try {
    const BUF_SIZE = 64 * 1024;
    const buf = Buffer.alloc(BUF_SIZE);
    const fd = fs.openSync(file, "r");
    try {
      let n: number;
      while ((n = fs.readSync(fd, buf, 0, BUF_SIZE, null)) > 0) {
        for (let i = 0; i < n; i++) if (buf[i] === 0x0a) count++;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
  return count;
}

/**
 * Rewrite a partition keeping only the lines whose id is NOT in
 * `dropIds`. Returns counts. If the resulting slim file is empty, the
 * file is removed and `removed=true`.
 *
 * Used by the daily compactor: events processed AND older than 7d are
 * removed; the remaining unprocessed lines stay until they either
 * (a) get processed (next run drops them) or (b) cross the 30d hard
 * drop (caller invokes deletePartition).
 */
export function compactPartition(
  date: string,
  dropIds: Set<string>,
): { kept: number; dropped: number; removed: boolean } {
  const file = rawLogPath(date);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { kept: 0, dropped: 0, removed: false };
  }
  const lines = raw.split("\n").filter((l) => l !== "");
  const kept: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    let id: string | undefined;
    try {
      id = (JSON.parse(line) as StreamLogEntry).id;
    } catch {
      // Malformed — keep, so an operator can inspect it later.
      kept.push(line);
      continue;
    }
    if (id && dropIds.has(id)) {
      dropped++;
    } else {
      kept.push(line);
    }
  }
  if (kept.length === 0) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
    return { kept: 0, dropped, removed: true };
  }
  fs.writeFileSync(file, kept.join("\n") + "\n");
  return { kept: kept.length, dropped, removed: false };
}

export function deletePartition(date: string): boolean {
  const file = rawLogPath(date);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
