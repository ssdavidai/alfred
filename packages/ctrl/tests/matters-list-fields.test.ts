// `GET /api/v1/matters?fields=a,b` — compact projection (#541).
// Identity (id, path, name) always present. Unknown fields silently ignored.
// No ?fields= → full shape unchanged.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mat-flds-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH!;
fs.mkdirSync(path.join(VAULT, "matter"), { recursive: true });

const { matchRoute } = await import("../src/api/server.js");
const { registerMatterRoutes } = await import("../src/api/routes/matters.js");
registerMatterRoutes();

before(() => {
  fs.writeFileSync(path.join(VAULT, "matter/alpha.md"), [
    "---", "type: matter", "name: Alpha", "status: active",
    "summary: " + "Long text. ".repeat(30),
    "current_state: " + "Narrative. ".repeat(30),
    "---",
  ].join("\n") + "\n");
});

async function call(qs: string): Promise<any> {
  const m = matchRoute("GET", "/api/v1/matters");
  assert.ok(m);
  let payload: any;
  const res = { writeHead() { return res; }, end(j: string) { payload = JSON.parse(j); } } as unknown as ServerResponse;
  await m!.handler({ req: { url: `/api/v1/matters${qs}` } as any, res, params: {}, body: undefined, query: new URLSearchParams(qs.replace(/^\?/, "")) });
  return payload;
}

describe("GET /api/v1/matters?fields=", () => {
  it("no ?fields= → all 9 keys present", async () => {
    const row = (await call("")).matters.find((m: any) => m.id === "alpha");
    for (const k of ["id","path","name","summary","last","next","counts","state","current_state"])
      assert.ok(k in row, `${k} must be present`);
  });

  it("?fields=state → identity + requested, narrative dropped", async () => {
    const row = (await call("?fields=state")).matters.find((m: any) => m.id === "alpha");
    assert.ok("id" in row && "path" in row && "name" in row, "identity always present");
    assert.ok("state" in row, "requested field present");
    assert.ok(!("summary" in row) && !("current_state" in row), "narrative absent");
  });

  it("unknown field names silently ignored", async () => {
    const row = (await call("?fields=state,bogus")).matters.find((m: any) => m.id === "alpha");
    assert.ok("state" in row && !("bogus" in row));
  });

  it("?fields= (empty) → full shape returned", async () => {
    const row = (await call("?fields=")).matters.find((m: any) => m.id === "alpha");
    assert.ok("current_state" in row);
  });
});
