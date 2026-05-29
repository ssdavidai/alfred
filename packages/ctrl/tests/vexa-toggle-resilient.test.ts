// Vexa retirement (#113 PR1) — 410 Gone stub coverage.
//
// The old F29 toggle is gone (spec deleted the entire Vexa stack —
// compose services, ctrl-api .env writes, Temporal schedules, the lot).
// Both /api/v1/admin/vexa/auto-join surfaces now return 410 Gone with a
// migration body pointing at issue #113. This file keeps its old name
// so the historical test discovery still picks it up, and can be
// deleted alongside the vexa.ts stub when Recall lands (#113 PR2/PR3a).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vexa-retired-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const { matchRoute } = await import("../src/api/server.js");
const { registerVexaRoutes } = await import("../src/api/routes/vexa.js");
registerVexaRoutes();

async function call(
  method: string,
  p: string,
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as unknown as ServerResponse;
  await m!.handler({
    req: { url: p } as any,
    res,
    params: m!.params,
    body: undefined,
    query: new URLSearchParams(),
  });
  return { status, payload };
}

describe("vexa retirement (#113 PR1) — 410 Gone stub", () => {
  it("GET /api/v1/admin/vexa/auto-join returns 410 with migration body", async () => {
    const { status, payload } = await call("GET", "/api/v1/admin/vexa/auto-join");
    assert.equal(status, 410, `expected 410, got ${status}`);
    assert.equal(payload.deprecated, true);
    assert.match(String(payload.replacement), /recall\.ai/i);
    assert.match(String(payload.replacement), /#113/);
  });

  it("POST /api/v1/admin/vexa/auto-join returns 410 with migration body", async () => {
    const { status, payload } = await call("POST", "/api/v1/admin/vexa/auto-join");
    assert.equal(status, 410, `expected 410, got ${status}`);
    assert.equal(payload.deprecated, true);
    assert.match(String(payload.replacement), /recall\.ai/i);
  });
});
