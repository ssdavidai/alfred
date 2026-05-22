// F1 (C18, KEYSTONE) — POST /api/v1/decisions must index the record in-request.
//
// The writer wrote `decision/<ts>.md` with a raw fs.writeFileSync and mirrored
// a `state.db audit` row, but it NEVER called indexVaultWrite(). Every reader
// — GET /api/v1/decisions, the Desk ledger, and learn's
// list_decisions_by_state — queries `state.db vault_index WHERE
// record_type='decision'`, which the POST left empty. So a decision written
// after the last ctrl-api boot was invisible to every reader (live: 3 files on
// disk, 0 in the index, `opens=0`).
//
// This test POSTs a decision then immediately GETs the list. Against the
// pre-fix writer the GET returns 0 rows; it passes only when the POST indexes
// the record so the same-request reader sees it.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dec-idx-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { registerDecisionRoutes } = await import("../src/api/routes/decisions.js");
const { matchRoute } = await import("../src/api/server.js");

registerDecisionRoutes();

async function call(
  method: string,
  pathname: string,
  body?: unknown,
  qs = "",
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, pathname);
  assert.ok(m, `${method} ${pathname} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({
    req: { url: `${pathname}${qs}` } as any,
    res,
    params: m!.params,
    body,
    query: new URLSearchParams(qs.replace(/^\?/, "")),
  });
  return { status, payload };
}

describe("POST /api/v1/decisions — index-on-write (F1/C18)", () => {
  before(() => {
    getStateDb();
  });

  it("a decision is visible to GET /api/v1/decisions in the same request cycle", async () => {
    const post = await call("POST", "/api/v1/decisions", {
      source: "judgment",
      source_record: "judgment/x.md",
      intent: "done",
      note: "handled it",
    });
    assert.equal(post.status, 201, "POST must 201");
    const id = post.payload.id as string;
    assert.ok(id, "POST returns an id");

    // The reader queries vault_index — the record must already be there.
    const row = getStateDb()
      .prepare("SELECT path, record_type FROM vault_index WHERE path = ?")
      .get(`decision/${id}.md`) as { path: string; record_type: string } | undefined;
    assert.ok(row, "decision must be in vault_index after the POST");
    assert.equal(row!.record_type, "decision");

    const list = await call("GET", "/api/v1/decisions");
    assert.equal(list.status, 200);
    const ids = list.payload.decisions.map((d: any) => d.id);
    assert.ok(
      ids.includes(id),
      "GET /api/v1/decisions must return the just-written decision",
    );
  });

  it("a state-filtered list (open) returns a freshly-written open decision", async () => {
    const post = await call("POST", "/api/v1/decisions", {
      source: "needs_attention",
      source_record: "needs_attention/nope.md", // no NA file → stays open
      intent: "delegate",
    });
    assert.equal(post.status, 201);
    const id = post.payload.id as string;

    const open = await call("GET", "/api/v1/decisions", undefined, "?state=open");
    const ids = open.payload.decisions.map((d: any) => d.id);
    assert.ok(
      ids.includes(id),
      "delegate decision (state=open) must be listed by list_decisions_by_state('open')",
    );
  });
});
