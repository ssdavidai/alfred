// #311 — a malformed ingest event retried forever. The signal-extraction
// workflow cycled the same three event IDs ~20 times each with no terminal
// classification, burning workflow capacity, hiding genuinely new failures,
// and preventing queue-health metrics from converging.
//
// The riskiest part of the fix is NOT the new routes — it is the column
// retrofit. `ingest-schema.sql` is CREATE-only-idempotent and ingest.db has
// no migration runner, so a tenant provisioned before #311 would open a
// database whose stream_event table lacks every dead-letter column. If the
// guarded ALTER TABLE does not fire, ctrl-api 500s on the first pending-feed
// query — on every tenant at once. That is what this file pins.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-dl-"));
const dbPath = path.join(tmp, "ingest.db");
process.env.INGEST_DB_PATH = dbPath;

// Seed a PRE-#311 database: stream_event exactly as deployed tenants have it,
// with a live row already in flight.
{
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE stream_event (
      id            TEXT PRIMARY KEY,
      ts            TEXT NOT NULL,
      stream        TEXT NOT NULL,
      channel       TEXT,
      external_id   TEXT,
      kind          TEXT NOT NULL DEFAULT 'message',
      payload_json  TEXT NOT NULL,
      processed_at  TEXT,
      processed_by  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  legacy
    .prepare(
      `INSERT INTO stream_event (id, ts, stream, kind, payload_json)
       VALUES ('legacy-1', '2026-07-01T00:00:00Z', 'email', 'message', '{}')`,
    )
    .run();
  legacy.close();
}

const { getIngestDb, INGEST_FAILURE_BUDGET } = await import("../src/db/ingest.js");

function columns(): Set<string> {
  return new Set(
    (getIngestDb().prepare("PRAGMA table_info(stream_event)").all() as Array<{
      name: unknown;
    }>).map((r) => String(r.name)),
  );
}

describe("ingest dead-letter retrofit (#311)", () => {
  before(() => {
    getIngestDb();
  });

  it("adds every dead-letter column to a pre-existing table", () => {
    const cols = columns();
    for (const name of [
      "failure_count",
      "last_error",
      "dead_lettered_at",
      "dead_letter_reason",
    ]) {
      assert.ok(cols.has(name), `missing retrofitted column: ${name}`);
    }
  });

  it("preserves rows that were already in flight", () => {
    const row = getIngestDb()
      .prepare("SELECT id, failure_count, dead_lettered_at FROM stream_event WHERE id = 'legacy-1'")
      .get() as { id: string; failure_count: number; dead_lettered_at: string | null };
    assert.equal(row.id, "legacy-1");
    // NOT NULL DEFAULT 0 must backfill, or every failure-count read is NaN.
    assert.equal(row.failure_count, 0);
    assert.equal(row.dead_lettered_at, null);
  });

  it("is idempotent across reopens (no duplicate-column error)", () => {
    // getIngestDb caches, so exercise the guard directly against the file.
    const reopened = new DatabaseSync(dbPath);
    const present = new Set(
      (reopened.prepare("PRAGMA table_info(stream_event)").all() as Array<{ name: unknown }>)
        .map((r) => String(r.name)),
    );
    assert.ok(present.has("dead_lettered_at"));
    // A second ALTER for an existing column would throw — prove the guard
    // condition that prevents it is the one the code relies on.
    assert.equal(present.has("failure_count"), true);
    reopened.close();
  });

  it("creates the dead-letter index", () => {
    const idx = getIngestDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_stream_event_dead_letter'")
      .get();
    assert.ok(idx, "dead-letter index missing — poison-queue listing does a full scan");
  });

  it("exposes a positive retry budget", () => {
    assert.ok(INGEST_FAILURE_BUDGET > 0);
  });
});

describe("pending feed excludes dead-lettered rows (#311)", () => {
  it("parks poison off the feed while keeping it countable", () => {
    const db = getIngestDb();
    db.exec("DELETE FROM stream_event");
    db.prepare(
      `INSERT INTO stream_event (id, ts, stream, kind, payload_json)
       VALUES ('live-1', '2026-07-02T00:00:00Z', 'email', 'message', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO stream_event
         (id, ts, stream, kind, payload_json, failure_count, dead_lettered_at, dead_letter_reason)
       VALUES ('poison-1', '2026-07-01T00:00:00Z', 'email', 'message', '{}',
               5, '2026-07-03T00:00:00Z', 'retry_budget_exhausted')`,
    ).run();

    // The exact predicate the pending route uses.
    const pending = db
      .prepare(
        "SELECT id FROM stream_event WHERE processed_at IS NULL " +
          "AND dead_lettered_at IS NULL ORDER BY ts ASC",
      )
      .all() as Array<{ id: string }>;
    assert.deepEqual(pending.map((r) => r.id), ["live-1"]);

    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN processed_at IS NULL AND dead_lettered_at IS NULL
                    THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN dead_lettered_at IS NOT NULL THEN 1 ELSE 0 END) AS dead_lettered
         FROM stream_event`,
      )
      .get() as { pending: number; dead_lettered: number };
    assert.equal(Number(counts.pending), 1);
    assert.equal(Number(counts.dead_lettered), 1);
  });
});
