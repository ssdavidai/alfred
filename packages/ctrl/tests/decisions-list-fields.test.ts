// `GET /api/v1/decisions?fields=a,b` — compact projection (#541).
// The decisions list spreads all frontmatter; large nested objects (notes,
// side_effects) can bulk up responses. ?fields= lets callers ask only for
// what they need. Identity (id, path) always present. Composes with ?state=.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dec-flds-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { registerDecisionRoutes } = await import("../src/api/routes/decisions.js");
const { matchRoute } = await import("../src/api/server.js");
registerDecisionRoutes();

function seed(p: string, fm: Record<string, unknown>): void {
  getStateDb().prepare(
    `INSERT INTO vault_index (path, record_type, title, status, frontmatter_json, mtime)
     VALUES (?, 'decision', ?, ?, ?, ?)`,
  ).run(p, p, fm.state ?? null, JSON.stringify(fm), "2026-08-01T00:00:00.000Z");
}

before(() => {
  getStateDb();
  seed("decision/r1.md", { state: "open", intent: "delegate", notes: "x".repeat(2000), side_effects: { a: 1 } });
  seed("decision/r2.md", { state: "completed", intent: "done" });
});

async function call(qs: string): Promise<any> {
  const m = matchRoute("GET", "/api/v1/decisions");
  assert.ok(m);
  let payload: any;
  const res = { writeHead() { return res; }, end(j: string) { payload = JSON.parse(j); } } as unknown as ServerResponse;
  await m!.handler({ req: { url: `/api/v1/decisions${qs}` } as any, res, params: {}, body: undefined, query: new URLSearchParams(qs.replace(/^\?/, "")) });
  return payload;
}

describe("GET /api/v1/decisions?fields=", () => {
  it("no ?fields= → full shape, notes and side_effects present", async () => {
    const d = (await call("")).decisions.find((r: any) => r.id === "r1");
    assert.ok("notes" in d && "side_effects" in d && "intent" in d);
  });

  it("?fields=intent → identity + requested, heavy fields absent", async () => {
    const d = (await call("?fields=intent")).decisions.find((r: any) => r.id === "r1");
    assert.ok("id" in d && "path" in d, "identity always present");
    assert.ok("intent" in d, "requested field present");
    assert.ok(!("notes" in d) && !("side_effects" in d), "heavy fields absent");
  });

  it("unknown field names silently ignored", async () => {
    const d = (await call("?fields=intent,bogus")).decisions.find((r: any) => r.id === "r1");
    assert.ok("intent" in d && !("bogus" in d));
  });

  it("?fields= (empty) → full shape returned", async () => {
    const d = (await call("?fields=")).decisions.find((r: any) => r.id === "r1");
    assert.ok("notes" in d);
  });

  it("?fields= composes with ?state= filter", async () => {
    const out = await call("?state=open&fields=intent");
    assert.equal(out.decisions.length, 1);
    assert.ok("intent" in out.decisions[0] && !("notes" in out.decisions[0]));
  });
});
