// B5 — embedding re-embed atomicity.
//
// POST /api/v1/state/embeddings re-embed ran DELETE embedding / DELETE meta /
// INSERT meta / INSERT embedding as four autocommit statements with a reusable
// INTEGER PRIMARY KEY rowid (schema.sql, NOT AUTOINCREMENT) — a crash
// mid-sequence could orphan a meta/vector or mis-pair a reused rowid. The fix
// wraps the re-embed (and the DELETE /embeddings loop) in runInTx().
//
// The vec0 `embedding` table needs the sqlite-vec extension, which is not
// loaded in tests, so the embedding HTTP route 503s here. We test the
// load-bearing atomicity primitive — runInTx() — directly against a real
// state.db using the always-present `signal` table, proving all-or-nothing on
// commit AND rollback (the exact invariant the embedding pair-write relies on).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "embedding-tx-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { runInTx } = await import("../src/api/routes/state.js");
const { getStateDb } = await import("../src/db/state.js");

const count = (): number =>
  (getStateDb().prepare("SELECT COUNT(*) AS n FROM signal").get() as { n: number }).n;

const insert = (id: string): void => {
  getStateDb()
    .prepare(`INSERT INTO signal (id, ts, kind, source, headline, status)
              VALUES (?, ?, 'mail', 'gmail', 'tx test', 'unrouted')`)
    .run(id, new Date().toISOString());
};

describe("runInTx — B5 all-or-nothing", () => {
  it("commits every statement when the body succeeds", () => {
    const before = count();
    runInTx(getStateDb(), () => { insert("tx-ok-1"); insert("tx-ok-2"); });
    assert.equal(count(), before + 2, "both inserts must persist");
  });

  it("rolls back ALL statements when the body throws mid-sequence", () => {
    const before = count();
    assert.throws(
      () => runInTx(getStateDb(), () => { insert("tx-bad-1"); throw new Error("crash"); }),
      /crash/,
    );
    // The first insert must NOT survive — the orphan a non-tx re-embed leaves.
    assert.equal(count(), before, "a thrown body must leave no rows");
    // The tx must be closed: a follow-up tx begins cleanly (no "transaction
    // within a transaction") and commits.
    runInTx(getStateDb(), () => insert("tx-after-1"));
    assert.equal(count(), before + 1);
  });
});
