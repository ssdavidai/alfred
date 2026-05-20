// B4 — cold cross-tier reads for the 4 non-audit tables.
//
// coldRead.ts only exposed queryAuditCrossTier / getAuditCrossTier. The
// signal / observation / routing_decision / link list + GET-by-id routes
// queried hot state.db ONLY, so after TTL compaction (rows rolled into
// cold.db then deleted from hot) those rows were unreachable from every API.
// This proves the generic cross-tier reader surfaces a row living ONLY in the
// cold archive, for each of the four tables, in both list and by-id paths.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cold-xtier-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.COLD_DB_PATH = path.join(tmp, "cold.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { getColdDb, coldCompress, COLD_CODEC } = await import("../src/db/cold.js");
const { queryCrossTier, getCrossTier } = await import("../src/db/coldRead.js");

const OLD_TS = "2000-01-01T00:00:00.000Z"; // past every TTL → cold-scoped.

// One cold-only archive row per table: full body JSON compressed + plain cols.
const FIXTURES: Array<[string, string, string[], Record<string, unknown>]> = [
  ["signal", "archive_signal", ["id", "ts", "kind", "source", "status", "matter_ref"],
    { id: "sig-cold-1", ts: OLD_TS, kind: "deadline", source: "x.email", status: "routed", matter_ref: "matter/x.md", headline: "cold signal" }],
  ["observation", "archive_observation", ["id", "ts", "subject", "kind", "status"],
    { id: "obs-cold-1", ts: OLD_TS, subject: "principal", kind: "preference", status: "promoted", summary: "cold obs" }],
  ["routing_decision", "archive_routing_decision", ["id", "ts", "tier", "chosen_path", "outcome", "signal_id"],
    { id: "rd-cold-1", ts: OLD_TS, tier: "act", chosen_path: "agent", outcome: "completed", signal_id: "sig-cold-1", reason: "cold rd" }],
  ["link", "archive_link", ["id", "ts", "src_ref", "dst_ref", "rel"],
    { id: "link-cold-1", ts: OLD_TS, src_ref: "matter/x.md", dst_ref: "signal:sig-cold-1", rel: "mentions", weight: 1 }],
];

before(() => {
  getStateDb(); // materialize hot schema (cross-tier reader queries it)
  const cold = getColdDb();
  for (const [, archive, cols, row] of FIXTURES) {
    const blob = coldCompress(JSON.stringify(row));
    const all = [...cols, "codec", "body"];
    cold
      .prepare(`INSERT INTO ${archive} (${all.join(", ")}) VALUES (${all.map(() => "?").join(", ")})`)
      .run(...cols.map((c) => row[c] ?? null), COLD_CODEC, blob);
  }
});

describe("cross-tier — cold-only rows reachable", () => {
  for (const [table, , , row] of FIXTURES) {
    const id = row.id as string;
    it(`${table}: list surfaces the cold row (tier=cold) and reconstitutes its body`, () => {
      const r = queryCrossTier(table, { since: null, until: null, filters: {}, limit: 100, offset: 0 });
      const hit = r.entries.find((e) => e.id === id);
      assert.ok(hit, `cold ${table} must surface in list`);
      assert.ok(r.tiers.includes("cold"));
    });
    it(`${table}: GET-by-id returns the cold row`, () => {
      assert.ok(getCrossTier(table, id), `cold ${table} must be fetchable by id`);
    });
  }

  it("body is fully reconstituted from the cold blob (not just index cols)", () => {
    const r = queryCrossTier("signal", { since: null, until: null, filters: {}, limit: 100, offset: 0 });
    assert.equal((r.entries.find((e) => e.id === "sig-cold-1") as any).headline, "cold signal");
  });
  it("an equality filter excludes a non-matching cold row", () => {
    const r = queryCrossTier("signal", { since: null, until: null, filters: { status: "dismissed" }, limit: 100, offset: 0 });
    assert.ok(!r.entries.some((e) => e.id === "sig-cold-1"));
  });
  it("link anyOf (ref) matches either endpoint across tiers", () => {
    const r = queryCrossTier("link", {
      since: null, until: null, filters: {}, anyOf: { cols: ["src_ref", "dst_ref"], value: "signal:sig-cold-1" }, limit: 100, offset: 0,
    });
    assert.ok(r.entries.some((e) => e.id === "link-cold-1"));
  });
  it("GET-by-id returns null for an unknown id", () => {
    assert.equal(getCrossTier("signal", "nope"), null);
  });
});
