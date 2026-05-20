// B3 — compaction must preserve routing_decision.signal_id.
//
// routing_decision.signal_id is `REFERENCES signal(id) ON DELETE SET NULL`
// (schema.sql). The compactor ran PLANS in order signal[0] → … →
// routing_decision[2], deleting aged signals from hot BEFORE archiving the
// routing_decisions that reference them. With foreign_keys=ON, deleting the
// signal NULLs the still-hot routing_decision.signal_id; the compactor then
// archived that NULLed body, permanently losing the link and breaking the
// cross-tier "decisions for signal X" join.
//
// Fix: archive (and delete) routing_decision before its parent signal, OR
// otherwise ensure the archived signal_id survives. This test asserts the
// archived routing_decision still carries its signal_id after compaction.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compact-fk-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.COLD_DB_PATH = path.join(tmp, "cold.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { getColdDb, coldDecompress } = await import("../src/db/cold.js");
const { runCompaction } = await import("../src/db/compactor.js");

const OLD_TS = "2000-01-01T00:00:00.000Z"; // past every TTL → compactable.

const RECENT_TS = new Date().toISOString(); // NOT aged → stays hot.

before(() => {
  const hot = getStateDb();
  // Case A: a signal and a routing_decision that references it — both aged out.
  hot
    .prepare(`INSERT INTO signal (id, ts, kind, source, headline, status)
              VALUES ('sig-fk', ?, 'deadline', 'x', 'parent signal', 'routed')`)
    .run(OLD_TS);
  hot
    .prepare(`INSERT INTO routing_decision (id, ts, signal_id, tier, chosen_path, outcome)
              VALUES ('rd-fk', ?, 'sig-fk', 'act', 'agent', 'completed')`)
    .run(OLD_TS);

  // Case B: an aged signal whose routing_decision is NEWER and stays hot. The
  // FK SET NULL would null the still-hot rd's signal_id when the signal is
  // compacted, breaking the hot-rd → cold-signal join.
  hot
    .prepare(`INSERT INTO signal (id, ts, kind, source, headline, status)
              VALUES ('sig-old', ?, 'deadline', 'x', 'old signal', 'routed')`)
    .run(OLD_TS);
  hot
    .prepare(`INSERT INTO routing_decision (id, ts, signal_id, tier, chosen_path, outcome)
              VALUES ('rd-new', ?, 'sig-old', 'act', 'agent', 'completed')`)
    .run(RECENT_TS);
});

describe("compactor FK order (B3)", () => {
  it("archived routing_decision retains its signal_id after the signal is compacted", () => {
    runCompaction();

    const cold = getColdDb();
    // Both rows must have moved to cold.
    const rdRow = cold
      .prepare("SELECT signal_id, codec, body FROM archive_routing_decision WHERE id = 'rd-fk'")
      .get() as { signal_id: string | null; codec: string; body: Buffer } | undefined;
    assert.ok(rdRow, "routing_decision must be archived");

    // The plain index column must still carry the link.
    assert.equal(rdRow!.signal_id, "sig-fk", "archive_routing_decision.signal_id must survive compaction");

    // …and the compressed body too, so the cross-tier join reconstitutes it.
    const body = JSON.parse(coldDecompress(rdRow!.body, rdRow!.codec)) as Record<string, unknown>;
    assert.equal(body.signal_id, "sig-fk", "archived body must retain signal_id, not a NULLed value");

    // Sanity: the parent signal was also archived.
    const sigCount = (
      cold.prepare("SELECT COUNT(*) AS n FROM archive_signal WHERE id = 'sig-fk'").get() as { n: number }
    ).n;
    assert.equal(sigCount, 1, "parent signal must also be archived");

    // Hot tier is drained of both.
    const hot = getStateDb();
    assert.equal(
      (hot.prepare("SELECT COUNT(*) AS n FROM routing_decision WHERE id = 'rd-fk'").get() as { n: number }).n,
      0,
    );
    assert.equal(
      (hot.prepare("SELECT COUNT(*) AS n FROM signal WHERE id = 'sig-fk'").get() as { n: number }).n,
      0,
    );
  });

  it("a NEWER still-hot routing_decision keeps its signal_id when the signal is compacted", () => {
    // sig-old aged out and was archived; rd-new is recent and stays hot. The FK
    // must NOT have NULLed rd-new.signal_id — the signal still exists (in cold),
    // so the hot-rd → cold-signal cross-tier join must remain joinable.
    const hot = getStateDb();
    const rdNew = hot
      .prepare("SELECT signal_id FROM routing_decision WHERE id = 'rd-new'")
      .get() as { signal_id: string | null } | undefined;
    assert.ok(rdNew, "rd-new must still be in the hot tier (it is recent)");
    assert.equal(rdNew!.signal_id, "sig-old", "hot rd signal_id must survive the parent's compaction");

    const sigOld = (
      getColdDb().prepare("SELECT COUNT(*) AS n FROM archive_signal WHERE id = 'sig-old'").get() as { n: number }
    ).n;
    assert.equal(sigOld, 1, "sig-old must have been archived");
  });

  it("foreign_keys is restored to ON after compaction (no leaked OFF)", () => {
    const fk = (getStateDb().prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
    assert.equal(fk, 1, "the compactor must leave foreign_keys = ON for normal writes");
  });
});
