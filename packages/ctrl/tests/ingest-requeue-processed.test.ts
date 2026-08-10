// The requeue route only cleared dead_lettered_at, leaving processed_at
// untouched. An event consumed by a buggy consumer — marked processed but
// dropped with zero signals written — could never be put back on the feed
// through the API even though its payload still sat in ingest.db.
//
// Fix: requeue also clears processed_at / processed_by, but only when
// the caller passes force_replay: true. Without the flag a processed-but-not-
// dead-lettered event returns 200 with replayed: false — safe for inspection.
// Dead-lettered events clear unconditionally (they were never consumed).
//
// Tests are DB-layer: they run the same SQL the route executes and verify
// the pending-feed predicate directly, matching the established pattern in
// ingest-dead-letter.test.ts.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-requeue-"));
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");

const { getIngestDb } = await import("../src/db/ingest.js");

// ── helpers ─────────────────────────────────────────────────────────────────

type EventOpts = {
  processedAt?: string | null;
  processedBy?: string | null;
  deadLetteredAt?: string | null;
  deadLetterReason?: string | null;
  failureCount?: number;
};

function insert(id: string, opts: EventOpts = {}): void {
  const {
    processedAt = null,
    processedBy = null,
    deadLetteredAt = null,
    deadLetterReason = null,
    failureCount = 0,
  } = opts;
  getIngestDb()
    .prepare(
      `INSERT INTO stream_event
         (id, ts, stream, kind, payload_json,
          processed_at, processed_by,
          dead_lettered_at, dead_letter_reason, failure_count)
       VALUES (?, datetime('now'), 'email', 'message', '{}', ?, ?, ?, ?, ?)`,
    )
    .run(id, processedAt, processedBy, deadLetteredAt, deadLetterReason, failureCount);
}

/** Is this event on the pending feed? (matches the route's WHERE clause) */
function isPending(id: string): boolean {
  const row = getIngestDb()
    .prepare(
      "SELECT id FROM stream_event WHERE id = ? " +
        "AND processed_at IS NULL AND dead_lettered_at IS NULL",
    )
    .get(id) as { id: string } | undefined;
  return Boolean(row);
}

/**
 * Simulate what the route does.  Returns the JSON-equivalent response object
 * or null if the event doesn't exist.
 */
function simulateRequeue(
  id: string,
  forceReplay: boolean,
): {
  ok: boolean;
  id: string;
  was_dead_lettered: boolean;
  was_processed: boolean;
  replayed: boolean;
} | null {
  const db = getIngestDb();
  const row = db
    .prepare("SELECT dead_lettered_at, processed_at FROM stream_event WHERE id = ?")
    .get(id) as { dead_lettered_at: string | null; processed_at: string | null } | undefined;
  if (!row) return null;

  const wasDeadLettered = Boolean(row.dead_lettered_at);
  const wasProcessed = Boolean(row.processed_at);

  if (wasProcessed && !wasDeadLettered && !forceReplay) {
    return { ok: true, id, was_dead_lettered: false, was_processed: true, replayed: false };
  }

  db.prepare(
    `UPDATE stream_event
        SET dead_lettered_at = NULL, dead_letter_reason = NULL, failure_count = 0,
            processed_at = NULL, processed_by = NULL
      WHERE id = ?`,
  ).run(id);

  return {
    ok: true,
    id,
    was_dead_lettered: wasDeadLettered,
    was_processed: wasProcessed,
    replayed: wasDeadLettered || wasProcessed,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  getIngestDb().exec("DELETE FROM stream_event");
});

describe("requeue clears processed_at (fix for consumed-under-a-bug events)", () => {
  it("processed event WITHOUT force_replay: no-op, replayed=false", () => {
    insert("proc-1", { processedAt: "2026-08-01T10:00:00Z", processedBy: "event_processor" });
    const resp = simulateRequeue("proc-1", false);
    assert.ok(resp);
    assert.equal(resp.was_processed, true);
    assert.equal(resp.was_dead_lettered, false);
    assert.equal(resp.replayed, false);
    // Event must NOT be on the pending feed — it was processed and we didn't clear it.
    assert.equal(isPending("proc-1"), false, "processed event must stay off feed without force_replay");
  });

  it("processed event WITH force_replay: cleared, replayed=true, back on feed", () => {
    insert("proc-2", { processedAt: "2026-08-01T10:00:00Z", processedBy: "event_processor" });
    const resp = simulateRequeue("proc-2", true);
    assert.ok(resp);
    assert.equal(resp.was_processed, true);
    assert.equal(resp.replayed, true);
    assert.equal(isPending("proc-2"), true, "force_replay must put event back on pending feed");
  });

  it("dead-lettered event: cleared unconditionally, replayed=true", () => {
    insert("dl-1", {
      deadLetteredAt: "2026-08-01T09:00:00Z",
      deadLetterReason: "retry_budget_exhausted after 5 attempts",
      failureCount: 5,
    });
    const resp = simulateRequeue("dl-1", false); // no force_replay needed
    assert.ok(resp);
    assert.equal(resp.was_dead_lettered, true);
    assert.equal(resp.was_processed, false);
    assert.equal(resp.replayed, true);
    assert.equal(isPending("dl-1"), true, "dead-lettered event must be back on pending feed");
    // failure_count must be reset
    const row = getIngestDb()
      .prepare("SELECT failure_count, dead_lettered_at FROM stream_event WHERE id = 'dl-1'")
      .get() as { failure_count: number; dead_lettered_at: string | null };
    assert.equal(row.failure_count, 0);
    assert.equal(row.dead_lettered_at, null);
  });

  it("dead-lettered AND processed (edge): clears both fields, replayed=true", () => {
    // This state can't arise from normal operation but the route should handle
    // it deterministically (dead-letter takes priority — clear all).
    insert("both-1", {
      processedAt: "2026-08-01T08:00:00Z",
      deadLetteredAt: "2026-08-01T09:00:00Z",
      deadLetterReason: "non_retryable",
      failureCount: 1,
    });
    const resp = simulateRequeue("both-1", false); // dead-lettered path — no force_replay needed
    assert.ok(resp);
    assert.equal(resp.was_dead_lettered, true);
    assert.equal(resp.was_processed, true);
    assert.equal(resp.replayed, true);
    assert.equal(isPending("both-1"), true, "both-cleared event must appear on pending feed");
  });

  it("live event (neither processed nor dead-lettered): no-op, replayed=false", () => {
    insert("live-1"); // all nulls — already on the pending feed
    const resp = simulateRequeue("live-1", false);
    assert.ok(resp);
    assert.equal(resp.was_dead_lettered, false);
    assert.equal(resp.was_processed, false);
    assert.equal(resp.replayed, false);
    // Still on the feed.
    assert.equal(isPending("live-1"), true, "live event must stay on pending feed");
  });

  it("response distinguishes the three observable cases", () => {
    // Case A: dead-lettered
    insert("case-a", { deadLetteredAt: "2026-08-01T00:00:00Z", failureCount: 5 });
    const a = simulateRequeue("case-a", false)!;
    assert.equal(a.was_dead_lettered, true);
    assert.equal(a.replayed, true);

    // Case B: processed, no force_replay
    insert("case-b", { processedAt: "2026-08-01T00:00:00Z" });
    const b = simulateRequeue("case-b", false)!;
    assert.equal(b.was_processed, true);
    assert.equal(b.replayed, false);

    // Case C: live
    insert("case-c");
    const c = simulateRequeue("case-c", false)!;
    assert.equal(c.was_dead_lettered, false);
    assert.equal(c.was_processed, false);
    assert.equal(c.replayed, false);

    // All three are distinguishable by (was_dead_lettered, was_processed, replayed).
    assert.notDeepEqual(
      [a.was_dead_lettered, a.was_processed, a.replayed],
      [b.was_dead_lettered, b.was_processed, b.replayed],
    );
    assert.notDeepEqual(
      [b.was_dead_lettered, b.was_processed, b.replayed],
      [c.was_dead_lettered, c.was_processed, c.replayed],
    );
  });
});
