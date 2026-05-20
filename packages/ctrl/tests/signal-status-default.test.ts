// C2 — signal status default = `unrouted`.
//
// POST /api/v1/state/signals defaulted an absent `status` to "open"
// (state.ts:153). But SignalRouterWorkflow (learn) only routes status='unrouted',
// so a signal created without an explicit status was never surfaced on the Desk
// — it sat at "open" forever. Frozen contract C2: the INSERT default is
// `unrouted`. This test posts a signal with no status and asserts the persisted
// row is `unrouted`, and that an explicit status is still honoured.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signal-status-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { matchRoute } = await import("../src/api/server.js");
const { registerStateRoutes } = await import("../src/api/routes/state.js");
const { getStateDb } = await import("../src/db/state.js");

registerStateRoutes();

// Minimal ServerResponse stand-in capturing the status + JSON body.
function mockRes(): { res: ServerResponse; captured: { status: number; body: any } } {
  const captured = { status: 0, body: undefined as any };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      if (payload) captured.body = JSON.parse(payload);
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function postSignal(body: Record<string, unknown>): Promise<string> {
  const matched = matchRoute("POST", "/api/v1/state/signals");
  assert.ok(matched, "POST /api/v1/state/signals must be registered");
  const { res, captured } = mockRes();
  await matched!.handler({
    req: {} as any,
    res,
    params: {},
    body,
    query: new URLSearchParams(),
  });
  assert.equal(captured.status, 201, "signal create returns 201");
  return captured.body.id as string;
}

describe("POST /state/signals status default (C2)", () => {
  it("defaults an absent status to 'unrouted' (not 'open')", async () => {
    const id = await postSignal({ kind: "mail", source: "gmail", headline: "hi" });
    const row = getStateDb()
      .prepare("SELECT status FROM signal WHERE id = ?")
      .get(id) as { status: string };
    assert.equal(row.status, "unrouted", "absent status must default to unrouted");
  });

  it("honours an explicit status", async () => {
    const id = await postSignal({
      kind: "mail",
      source: "gmail",
      headline: "hi",
      status: "routed_human",
    });
    const row = getStateDb()
      .prepare("SELECT status FROM signal WHERE id = ?")
      .get(id) as { status: string };
    assert.equal(row.status, "routed_human");
  });
});
