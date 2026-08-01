// #380 — audit-table retention sweep.
//
// Live motivation (home): 341,699 audit rows, 129,876 from one resolved
// recovery-loop incident; GROUP BY scans paid 1.45s. The sweep deletes
// rows past AUDIT_RETENTION_DAYS (default 180, floor 30) at boot.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ret-"));
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");

const { getStateDb } = await import("../src/db/state.js");
const { sweepAuditRetention } = await import("../src/db/auditRetention.js");

function seed(ts: string, source: string, type = "workflow_run"): void {
  getStateDb()
    .prepare(
      `INSERT INTO audit (id, ts, action_type, actor, source, summary)
       VALUES (?, ?, ?, 'test', ?, 's')`,
    )
    .run(`${source}-${ts}-${Math.random().toString(36).slice(2, 8)}`, ts, type, source);
}

test("old rows deleted, recent rows kept, floor enforced", () => {
  const now = new Date("2026-08-01T00:00:00Z");
  seed("2026-01-01T00:00:00Z", "decision_router.recovery");   // incident, old
  seed("2026-01-02T00:00:00Z", "steward");                    // aged generic
  seed("2026-07-30T00:00:00Z", "decision_router.recovery");   // recent recovery
  seed("2026-07-31T00:00:00Z", "steward");                    // recent generic

  const res = sweepAuditRetention(now);
  assert.equal(res.retention_days, 180);
  assert.equal(res.incident_rows_deleted, 1);
  assert.equal(res.aged_rows_deleted, 1);

  const left = getStateDb()
    .prepare("SELECT COUNT(*) AS n FROM audit")
    .get() as { n: number };
  assert.equal(left.n, 2); // both recent rows survive
});

test("AUDIT_RETENTION_DAYS below floor is clamped to default", () => {
  process.env.AUDIT_RETENTION_DAYS = "5";
  const res = sweepAuditRetention(new Date("2026-08-01T00:00:00Z"));
  assert.equal(res.retention_days, 180);
  delete process.env.AUDIT_RETENTION_DAYS;
});

test("custom window honored", () => {
  seed("2026-06-01T00:00:00Z", "whatever");
  process.env.AUDIT_RETENTION_DAYS = "30";
  const res = sweepAuditRetention(new Date("2026-08-01T00:00:00Z"));
  assert.equal(res.retention_days, 30);
  assert.ok(res.aged_rows_deleted >= 1);
  delete process.env.AUDIT_RETENTION_DAYS;
});
