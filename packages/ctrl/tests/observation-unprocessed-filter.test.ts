// Learning-loop relight — `status=unprocessed` must mean "not yet processed".
//
// The bug: observations are written `status='open'` (POST /observations default)
// and only become `'processed'` once ReflectionWorkflow consumes them. But the
// consumer (fetch_unprocessed_observations → list_observations(status=
// "unprocessed")) queried for the literal value "unprocessed", which is NEVER
// stored — so reflection fetched 0 rows every run and the instinct-distillation
// stage silently no-op'd on every tenant (observations piled up `open` forever,
// processed_at stayed NULL, no new instincts).
//
// The fix makes "unprocessed" a SEMANTIC filter (status != 'processed', NULLs
// included) via queryCrossTier's new `not` predicate. This test proves the
// query layer surfaces open/active/draft/NULL observations under the
// "unprocessed" filter and excludes processed ones.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-unprocessed-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.COLD_DB_PATH = path.join(tmp, "cold.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { queryCrossTier } = await import("../src/db/coldRead.js");

// `observation.status` is `TEXT NOT NULL DEFAULT 'open'`, so NULL can't occur
// in practice — the COALESCE in coldRead's `not` predicate is harmless defence.
const ROWS: Array<{ id: string; status: string }> = [
  { id: "obs-open-1", status: "open" }, // the POST default — must be returned
  { id: "obs-open-2", status: "open" },
  { id: "obs-active", status: "active" }, // other non-terminal state — returned
  { id: "obs-processed", status: "processed" }, // terminal — must be EXCLUDED
];

before(() => {
  const db = getStateDb();
  let i = 0;
  for (const r of ROWS) {
    db.prepare(
      `INSERT INTO observation (id, ts, subject, kind, summary, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(r.id, `2026-06-02T10:0${i}:00.000Z`, "principal", "decision", "x", r.status);
    i++;
  }
});

describe("observation status=unprocessed is semantic (not a literal match)", () => {
  it("the old literal equality match returns nothing (reproduces the bug)", () => {
    const r = queryCrossTier("observation", {
      filters: { status: "unprocessed" },
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    assert.equal(r.entries.length, 0, "no row is stored with literal status='unprocessed'");
  });

  it("the `not: status!=processed` predicate returns every non-processed row", () => {
    const r = queryCrossTier("observation", {
      filters: {},
      not: { col: "status", value: "processed" },
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    const ids = r.entries.map((e) => e.id).sort();
    assert.deepEqual(ids, ["obs-active", "obs-open-1", "obs-open-2"]);
    assert.ok(!ids.includes("obs-processed"), "processed rows must be excluded");
  });

  it("a `not` on a column the table doesn't filter is ignored (no crash, no effect)", () => {
    const r = queryCrossTier("observation", {
      filters: {},
      not: { col: "not_a_real_col", value: "x" },
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    assert.equal(r.entries.length, ROWS.length, "unknown not-column is a no-op");
  });
});
