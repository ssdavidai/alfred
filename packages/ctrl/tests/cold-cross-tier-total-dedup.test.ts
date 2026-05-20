// B1 — cross-tier `total` must not double-count a straddling row.
//
// The compactor writes cold-then-deletes-hot; a crash between the two leaves a
// row in BOTH tiers. The cross-tier reader de-dupes the entries[] by id, but
// `total = hotTotal + coldTotal` counted such a row twice — so a paginating
// client over-allocates pages and the UI shows a phantom extra entry. The fix
// subtracts the hot∩cold overlap from the total.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cold-total-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.COLD_DB_PATH = path.join(tmp, "cold.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { getColdDb, coldCompress, COLD_CODEC } = await import("../src/db/cold.js");
const { queryAuditCrossTier, queryCrossTier } = await import("../src/db/coldRead.js");

const OLD_TS = "2000-01-01T00:00:00.000Z"; // past every TTL → cold in scope.

before(() => {
  const hot = getStateDb();
  const cold = getColdDb();

  // ── audit: one row that straddles BOTH tiers (mid-compaction crash) ────────
  const auditRow = {
    id: "aud-straddle",
    ts: OLD_TS,
    action_type: "vault.create",
    actor: "alfred",
    source: null,
    target_path: null,
    subject_ref: null,
    summary: "straddling audit row",
    mode: "live",
  };
  hot
    .prepare(`INSERT INTO audit (id, ts, action_type, actor, summary, mode)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(auditRow.id, auditRow.ts, auditRow.action_type, auditRow.actor, auditRow.summary, auditRow.mode);
  cold
    .prepare(`INSERT INTO archive_audit (id, ts, action_type, actor, codec, body)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(auditRow.id, auditRow.ts, auditRow.action_type, auditRow.actor, COLD_CODEC, coldCompress(JSON.stringify(auditRow)));

  // ── signal: same straddle, exercising the generic reader ───────────────────
  hot
    .prepare(`INSERT INTO signal (id, ts, kind, source, headline, status)
              VALUES ('sig-straddle', ?, 'deadline', 'x', 'straddle', 'routed')`)
    .run(OLD_TS);
  cold
    .prepare(`INSERT INTO archive_signal (id, ts, kind, source, status, codec, body)
              VALUES ('sig-straddle', ?, 'deadline', 'x', 'routed', ?, ?)`)
    .run(OLD_TS, COLD_CODEC, coldCompress(JSON.stringify({ id: "sig-straddle", ts: OLD_TS, headline: "straddle" })));
});

describe("cross-tier total dedup (B1)", () => {
  it("audit: a straddling row counts once in total, not twice", () => {
    const r = queryAuditCrossTier({ limit: 100, offset: 0 } as any);
    assert.equal(r.hot_total, 1);
    assert.equal(r.cold_total, 1);
    // The single straddling row appears once in entries — total must match.
    assert.equal(r.entries.filter((e) => e.id === "aud-straddle").length, 1);
    assert.equal(r.total, 1, "total must dedup the hot∩cold overlap, not be 2");
  });

  it("signal: generic reader dedups the straddling row in total", () => {
    const r = queryCrossTier("signal", { since: null, until: null, filters: {}, limit: 100, offset: 0 });
    assert.equal(r.hot_total, 1);
    assert.equal(r.cold_total, 1);
    assert.equal(r.entries.filter((e) => e.id === "sig-straddle").length, 1);
    assert.equal(r.total, 1, "total must dedup the hot∩cold overlap, not be 2");
  });
});
