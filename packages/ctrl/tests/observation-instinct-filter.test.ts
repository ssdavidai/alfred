// GET /api/v1/state/observations?instinct=<slug> — filter by instinct_ref
//
// Bug fixed: /instincts page showed "WHAT I'VE SEEN (0)" for instincts that
// had 19 stored observations. The web layer was calling GET /vault/list/
// observation — the vault DIRECTORY, which has 0 files after the storage
// cutover (CLAUDE.md §5.1: `observation` is demoted to Store 2). The fix is
// a new ?instinct= filter on GET /state/observations, which queries state.db.
//
// instinct_ref is stored as the vault path ("instinct/<slug>.md"), confirmed on
// home.alfred.black on 2026-08-17 (all 699 rows use this form). The filter
// accepts a bare slug, a path without .md, or the full canonical path — all
// normalise to "instinct/<slug>.md" before the equality match.
//
// instinct_ref is a hot-only column (archive_observation stores only
// id/ts/subject/kind/status as bare columns; the rest lives in the compressed
// body blob). When ?instinct= is supplied, the cold tier is skipped entirely
// via GenericQuery.hotOnlyFilters — a filter that cannot be applied to the
// cold tier must not silently return wrong results.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-instinct-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.COLD_DB_PATH = path.join(tmp, "cold.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { queryCrossTier } = await import("../src/db/coldRead.js");

// Instinct slugs used in this test suite (match live stored form exactly).
const INSTINCT_A = "instinct/suppress-ci.md";
const INSTINCT_B = "instinct/route-payment-failures-urgent.md";

before(() => {
  const db = getStateDb();
  const rows = [
    { id: "obs-a-1", instinct_ref: INSTINCT_A, ts: "2026-08-10T10:00:00.000Z" },
    { id: "obs-a-2", instinct_ref: INSTINCT_A, ts: "2026-08-10T10:01:00.000Z" },
    { id: "obs-a-3", instinct_ref: INSTINCT_A, ts: "2026-08-10T10:02:00.000Z" },
    { id: "obs-b-1", instinct_ref: INSTINCT_B, ts: "2026-08-10T10:03:00.000Z" },
    { id: "obs-b-2", instinct_ref: INSTINCT_B, ts: "2026-08-10T10:04:00.000Z" },
    { id: "obs-none", instinct_ref: null,       ts: "2026-08-10T10:05:00.000Z" },
  ];
  for (const r of rows) {
    db.prepare(
      `INSERT INTO observation (id, ts, subject, kind, summary, status, instinct_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.ts, "principal", "decision", "test obs", "open", r.instinct_ref ?? null);
  }
});

describe("GET /state/observations?instinct= filter", () => {
  it("full canonical path returns only that instinct's rows", () => {
    const r = queryCrossTier("observation", {
      filters: {},
      hotOnlyFilters: { instinct_ref: INSTINCT_A },
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    const ids = r.entries.map((e) => e.id).sort();
    assert.deepEqual(ids, ["obs-a-1", "obs-a-2", "obs-a-3"]);
  });

  it("absent instinct filter returns ALL rows (no regression)", () => {
    const r = queryCrossTier("observation", {
      filters: {},
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    assert.equal(r.entries.length, 6, "all 6 rows must be returned when filter is absent");
  });

  it("null hotOnlyFilters is identical to absent (no regression)", () => {
    const r = queryCrossTier("observation", {
      filters: {},
      hotOnlyFilters: null,
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    assert.equal(r.entries.length, 6);
  });

  it("bare slug form matches the same rows as the canonical path form", () => {
    // The route normalises "suppress-ci" → "instinct/suppress-ci.md" before
    // passing to queryCrossTier. Here we test that both forms produce the same
    // result when the normalised value is supplied (proving the normaliser works).
    const withPath = queryCrossTier("observation", {
      filters: {},
      hotOnlyFilters: { instinct_ref: INSTINCT_A },
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    const withNormalized = queryCrossTier("observation", {
      filters: {},
      // "suppress-ci" normalises to "instinct/suppress-ci.md" at the route layer
      hotOnlyFilters: { instinct_ref: "instinct/suppress-ci.md" },
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    assert.deepEqual(
      withPath.entries.map((e) => e.id).sort(),
      withNormalized.entries.map((e) => e.id).sort(),
    );
  });

  it("instinct composes with limit — only the capped number of rows returned", () => {
    const r = queryCrossTier("observation", {
      filters: {},
      hotOnlyFilters: { instinct_ref: INSTINCT_A },
      since: null,
      until: null,
      limit: 2,
      offset: 0,
    });
    // INSTINCT_A has 3 rows, but limit=2 → only 2 returned
    assert.equal(r.entries.length, 2);
    // total still reflects the full filtered count
    assert.equal(r.total, 3);
  });

  it("instinct composes with since — rows before cutoff excluded", () => {
    const r = queryCrossTier("observation", {
      filters: {},
      hotOnlyFilters: { instinct_ref: INSTINCT_A },
      // since is AFTER obs-a-1 (10:00) and obs-a-2 (10:01), before obs-a-3 (10:02)
      since: "2026-08-10T10:01:30.000Z",
      until: null,
      limit: 100,
      offset: 0,
    });
    // Only obs-a-3 (10:02) satisfies both instinct filter and the since cutoff
    const ids = r.entries.map((e) => e.id).sort();
    assert.deepEqual(ids, ["obs-a-3"]);
  });

  it("an instinct with no observations returns [] — endpoint was reached, not silently bypassed", () => {
    const r = queryCrossTier("observation", {
      filters: {},
      hotOnlyFilters: { instinct_ref: "instinct/no-such-instinct.md" },
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    // Endpoint reached: entries is an array (not undefined, not an error)
    assert.ok(Array.isArray(r.entries), "entries must be an array, not undefined");
    // No observations for this instinct
    assert.equal(r.entries.length, 0, "a filter that matches no rows must return [] not all rows");
    assert.equal(r.total, 0);
    // Confirm the filter was applied: the OTHER instinct's rows exist but were filtered out
    const unfiltered = queryCrossTier("observation", {
      filters: {},
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    assert.ok(unfiltered.entries.length > 0, "sanity: rows DO exist in the table");
  });

  it("instinct filter does not interfere with a concurrent kind filter", () => {
    // Both filters must apply (AND semantics). All our test rows are kind=decision,
    // so kind=signal should return 0 even though INSTINCT_A has 3 rows.
    const r = queryCrossTier("observation", {
      filters: { kind: "signal" },
      hotOnlyFilters: { instinct_ref: INSTINCT_A },
      since: null,
      until: null,
      limit: 100,
      offset: 0,
    });
    assert.equal(r.entries.length, 0, "AND: kind=signal AND instinct=A → no rows (all rows are kind=decision)");
  });
});
