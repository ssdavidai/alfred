// #17 — the 7-day ingest TTL was a hard data-loss deadline. sweepIngestTTL
// deleted every stream_event with `ts < cutoff` regardless of processed_at, so
// any wedge upstream of mark_stream_event_processed became permanent loss at
// day 7 (signalled only by an un-alerted ingest_sweep_log.stale_dropped).
//
// Fix: only delete rows that have actually been processed
// (processed_at IS NOT NULL). Aged-out UNPROCESSED rows are RETAINED and still
// counted as stale_dropped (the alert signal that EventProcessor is behind).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-ttl-"));
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.INGEST_TTL_DAYS = "7";

const { getIngestDb, sweepIngestTTL } = await import("../src/db/ingest.js");

const DAY = 24 * 60 * 60 * 1000;
const oldTs = new Date(Date.now() - 10 * DAY).toISOString(); // older than 7d cutoff
const freshTs = new Date(Date.now() - 1 * DAY).toISOString(); // within window

function insert(id: string, ts: string, processed: boolean): void {
  getIngestDb()
    .prepare(
      `INSERT INTO stream_event (id, ts, stream, kind, payload_json, processed_at)
       VALUES (?, ?, 'email', 'message', '{}', ?)`,
    )
    .run(id, ts, processed ? ts : null);
}

function countRows(): number {
  const r = getIngestDb()
    .prepare("SELECT COUNT(*) AS n FROM stream_event")
    .get() as { n: number };
  return r.n;
}

beforeEach(() => {
  getIngestDb().exec("DELETE FROM stream_event");
});

describe("sweepIngestTTL only deletes processed rows (#17)", () => {
  it("retains aged-out UNPROCESSED events; deletes aged-out PROCESSED events", () => {
    insert("old-unprocessed", oldTs, false); // aged out, never consumed → RETAIN
    insert("old-processed", oldTs, true); // aged out, consumed → DELETE
    insert("fresh-unprocessed", freshTs, false); // within window → keep
    insert("fresh-processed", freshTs, true); // within window → keep

    const result = sweepIngestTTL();

    assert.equal(result.processed_deleted, 1, "only the aged-out processed row is deleted");
    assert.equal(result.total_deleted, 1, "total deleted excludes the unprocessed stale row");
    assert.equal(result.stale_dropped, 1, "the aged-out unprocessed row is counted as stale (alert)");

    const ids = (getIngestDb()
      .prepare("SELECT id FROM stream_event ORDER BY id")
      .all() as { id: string }[]).map((r) => r.id);
    assert.deepEqual(ids, ["fresh-processed", "fresh-unprocessed", "old-unprocessed"]);
    assert.equal(countRows(), 3, "old-unprocessed survives the sweep");
  });

  it("does not drop an unprocessed event sitting past the TTL (no data loss)", () => {
    insert("wedged", oldTs, false);
    sweepIngestTTL();
    const row = getIngestDb()
      .prepare("SELECT id FROM stream_event WHERE id = 'wedged'")
      .get();
    assert.ok(row, "an unprocessed wedged event must survive the TTL sweep");
  });
});
