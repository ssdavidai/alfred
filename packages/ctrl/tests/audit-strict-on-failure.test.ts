// audit-201-on-failure — POST /api/v1/state/audit returned 201 {ok,id} even
// when the underlying INSERT threw, because appendAudit() swallows the error
// (best-effort mirror for vault-write callers). When the audit row IS the
// primary write (the POST /audit route), a failed insert must surface as a 5xx,
// not a false success.
//
// Fix: appendAudit gains an opt-in { strict: true } that RETHROWS on insert
// failure; the route passes strict:true. Default behaviour (no opts) stays
// swallow-and-return-id so the existing best-effort mirror callers
// (decisions.ts / attention.ts / stateChanges.ts) are unaffected.
//
// To force a deterministic insert failure we drop the `audit` table after the
// db is initialised, so the prepared INSERT hits "no such table".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-strict-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { appendAudit } = await import("../src/api/routes/state.js");

const input = {
  action_type: "vault_write",
  actor: "alfred",
  summary: "test audit row",
};

describe("appendAudit failure handling (audit-201-on-failure)", () => {
  it("default (best-effort) swallows insert failure and still returns an id", () => {
    const db = getStateDb();
    db.exec("DROP TABLE IF EXISTS audit"); // force the INSERT to fail
    const id = appendAudit(input); // must NOT throw — best-effort mirror path
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
  });

  it("strict mode rethrows on insert failure (so the POST /audit route 5xx's)", () => {
    const db = getStateDb();
    db.exec("DROP TABLE IF EXISTS audit"); // still gone — INSERT fails
    assert.throws(
      () => appendAudit(input, { strict: true }),
      /no such table|audit/i,
      "strict appendAudit must propagate the insert error",
    );
  });
});
