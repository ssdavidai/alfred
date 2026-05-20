// list_decisions status-vs-state.
//
// GET /api/v1/decisions filtered `WHERE status = ?` on the vault_index `status`
// column ONLY. But the index `status` column mirrors frontmatter `status`, and
// a `decision` record's canonical lifecycle field is `state`. A decision
// indexed with only `state` (status column NULL) was silently dropped by the
// SQL filter — exactly the case the in-code comment warned about ("older rows
// may carry `state` only — filter defensively on both") but the code did NOT
// honor. This proves the filter now matches the index status OR the
// frontmatter state/status.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dec-state-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { registerDecisionRoutes } = await import("../src/api/routes/decisions.js");
const { matchRoute } = await import("../src/api/server.js");

registerDecisionRoutes();

function indexDecision(p: string, fm: Record<string, unknown>, statusCol: string | null): void {
  getStateDb()
    .prepare(
      `INSERT INTO vault_index (path, record_type, title, status, frontmatter_json, mtime)
       VALUES (?, 'decision', ?, ?, ?, ?)`,
    )
    .run(p, String(fm.title ?? p), statusCol, JSON.stringify(fm), "2026-05-01T00:00:00.000Z");
}

before(() => {
  getStateDb();
  // Modern row: index status column populated AND frontmatter status.
  indexDecision("decision/modern.md", { source: "judgment", status: "open", state: "open" }, "open");
  // Legacy row: frontmatter carries `state` ONLY, index status column is NULL.
  indexDecision("decision/legacy.md", { source: "judgment", state: "open" }, null);
  // A non-matching row so the filter is doing real work.
  indexDecision("decision/done.md", { source: "judgment", status: "completed", state: "completed" }, "completed");
});

async function listDecisions(qs: string): Promise<any> {
  const m = matchRoute("GET", "/api/v1/decisions");
  assert.ok(m, "GET /api/v1/decisions must be registered");
  let payload: any;
  const res = {
    writeHead() { return res; },
    end(json: string) { payload = JSON.parse(json); },
  } as unknown as ServerResponse;
  await m!.handler({
    req: { url: `/api/v1/decisions${qs}` } as any,
    res,
    params: {},
    body: undefined,
    query: new URLSearchParams(qs.replace(/^\?/, "")),
  });
  return payload;
}

describe("GET /api/v1/decisions — state filter (status-vs-state)", () => {
  it("returns a legacy decision indexed with only `state` when filtering state=open", async () => {
    const out = await listDecisions("?state=open");
    const ids = out.decisions.map((d: any) => d.id);
    assert.ok(ids.includes("modern"), "modern decision must match");
    assert.ok(ids.includes("legacy"), "legacy decision (state only, status NULL) must NOT be dropped");
    assert.ok(!ids.includes("done"), "completed decision must be excluded");
  });

  it("an unfiltered list returns every decision", async () => {
    const out = await listDecisions("");
    assert.equal(out.decisions.length, 3);
  });

  it("state=completed still filters correctly", async () => {
    const out = await listDecisions("?state=completed");
    const ids = out.decisions.map((d: any) => d.id);
    assert.deepEqual(ids.sort(), ["done"]);
  });
});
