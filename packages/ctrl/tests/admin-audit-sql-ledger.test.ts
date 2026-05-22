// F4 (C12) — GET /api/v1/admin/audit reads the state.db `audit` SQL ledger
// (via queryAuditCrossTier), not the legacy vault/event/*.md walk: surfaces the
// first-class `decision` rows the filesystem reader never showed, in the frozen
// C12 shape, hiding automated noise by default.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-audit-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { appendAudit } = await import("../src/api/routes/state.js");
const { registerAdminRoutes } = await import("../src/api/routes/admin.js");
const { matchRoute } = await import("../src/api/server.js");

registerAdminRoutes();

async function getAudit(qs = ""): Promise<any> {
  const m = matchRoute("GET", "/api/v1/admin/audit");
  assert.ok(m, "GET /api/v1/admin/audit must be registered");
  let payload: any;
  const res = {
    writeHead() { return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({
    req: { url: `/api/v1/admin/audit${qs}` } as any,
    res, params: {}, body: undefined,
    query: new URLSearchParams(qs.replace(/^\?/, "")),
  });
  return payload;
}

describe("GET /api/v1/admin/audit — SQL ledger reader (F4/C12)", () => {
  before(() => {
    getStateDb();
    appendAudit({
      ts: "2026-05-22T06:21:17.000Z", action_type: "decision", actor: "principal",
      source: "needs_attention", target_path: "decision/d1.md",
      summary: "decision: done on needs_attention",
      changes: { intent: "done", note: "this is already done" },
      payload: { is_reversible: true },
    });
    // Hyphenated input — appendAudit normalises it to steward_action (F5).
    appendAudit({
      ts: "2026-05-22T06:00:00.000Z", action_type: "steward-action",
      actor: "alfred", summary: "Reviewed a task",
    });
  });

  it("surfaces the decision row from state.db in C12 shape", async () => {
    const p = await getAudit("?limit=50");
    const dec = p.items.find((i: any) => i.action_type === "decision");
    assert.ok(dec, "the decision audit row must surface");
    assert.deepEqual(
      { actor: dec.actor, headline: dec.headline, note: dec.note, reversible: dec.reversible },
      { actor: "principal", headline: "decision: done on needs_attention", note: "this is already done", reversible: true },
    );
    assert.ok("reversed_at" in dec && typeof p.total === "number");
  });

  it("hides automated steward noise by default; include_automated=1 reveals it", async () => {
    const hidden = await getAudit("?limit=50");
    assert.ok(!hidden.items.find((i: any) => i.action_type === "steward_action"));
    const shown = await getAudit("?limit=50&include_automated=1");
    assert.ok(shown.items.find((i: any) => i.action_type === "steward_action"));
  });
});
