// PR-1 / bug #1 — getInstinctCounts must read decision-sourced observations
// from state.db, not the vault/observation/ directory.
//
// The decision-observation writer (learn) posts to state.db with kind='decision'
// and instinct_ref=<instinct vault path>. The old getInstinctCounts walked
// vault/observation/*.md (empty in the cutover) so live_observation_count was
// frozen at 0 — which pinned the discretion gate at 0.95 and froze progressive
// autonomy at "Asking" forever. This test sets up state.db rows and an EMPTY
// vault, so it fails against the vault-walk implementation and passes only when
// the count is sourced from state.db.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ic-"));
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.VAULT_PATH = path.join(tmp, "vault"); // empty on purpose
process.env.SQLITE_VEC_PATH = ""; // vec disabled in the test

const { getStateDb } = await import("../src/db/state.js");
const { getInstinctCounts, invalidateInstinctCounts } = await import(
  "../src/api/instinctCounts.js"
);

function insertObs(
  db: ReturnType<typeof getStateDb>,
  id: string,
  kind: string,
  instinctRef: string | null,
): void {
  db.prepare(
    `INSERT INTO observation (id, ts, subject, kind, instinct_ref, summary)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, new Date().toISOString(), "principal", kind, instinctRef, "x");
}

describe("getInstinctCounts (state.db source)", () => {
  it("counts decision-sourced obs by instinct_ref; excludes signal-sourced + unlinked", async () => {
    const db = getStateDb();
    insertObs(db, "o1", "decision", "instinct/a.md");
    insertObs(db, "o2", "decision", "instinct/a.md");
    insertObs(db, "o3", "decision", "instinct/b.md");
    insertObs(db, "o4", "signal", "instinct/a.md"); // signal-sourced → excluded
    insertObs(db, "o5", "decision", null); // unlinked → excluded

    invalidateInstinctCounts();
    const counts = await getInstinctCounts();

    assert.equal(counts.get("instinct/a.md"), 2, "two decision obs on instinct a");
    assert.equal(counts.get("instinct/b.md"), 1, "one decision obs on instinct b");
    assert.equal(counts.size, 2, "signal-sourced and unlinked obs are not counted");
  });
});
