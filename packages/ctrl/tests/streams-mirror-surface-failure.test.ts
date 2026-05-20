// #8 — ingest mirror was best-effort-and-swallowed. mirrorEventToIngestDb
// logged+swallowed any non-UNIQUE error while POST /streams/ingest still
// returned 201 → the event showed in the UI (JSONL) but was invisible to the
// extractor forever (the only path that lands it in ingest.db / Store 4).
//
// Fix: swallow ONLY the UNIQUE(stream, external_id) collision (genuinely
// idempotent — already mirrored). Any OTHER failure rethrows so the request
// 5xx's instead of falsely 201-ing a dropped event.
//
// We exercise mirrorEventToIngestDb through the public POST /streams/ingest
// handler (matchRoute) to prove the request surfaces the failure end-to-end.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "streams-mirror-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { matchRoute } = await import("../src/api/server.js");
const { registerStreamRoutes } = await import("../src/api/routes/streams.js");
const { getIngestDb } = await import("../src/db/ingest.js");

registerStreamRoutes();

function mockRes(): { res: ServerResponse; captured: { status: number; body: any } } {
  const captured = { status: 0, body: undefined as any };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      if (payload) {
        try {
          captured.body = JSON.parse(payload);
        } catch {
          captured.body = payload;
        }
      }
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function ingest(body: Record<string, unknown>): Promise<{ status: number; body: any; error?: unknown }> {
  const matched = matchRoute("POST", "/api/v1/streams/ingest");
  assert.ok(matched, "POST /api/v1/streams/ingest must be registered");
  const { res, captured } = mockRes();
  try {
    await matched!.handler({
      req: {} as any,
      res,
      params: {},
      body,
      query: new URLSearchParams(),
    });
  } catch (err) {
    // The server's top-level try/catch turns a thrown handler error into a 5xx
    // (handleError). Capturing it here proves the failure is surfaced rather
    // than swallowed into a false 201.
    return { status: captured.status, body: captured.body, error: err };
  }
  return { status: captured.status, body: captured.body };
}

describe("POST /streams/ingest mirror failure surfacing (#8)", () => {
  it("returns 201 on a healthy mirror", async () => {
    const r = await ingest({
      stream_id: "email",
      stream_type: "email",
      source_ref: "msg-healthy",
      raw: { body: "hi" },
    });
    assert.equal(r.status, 201);
    const row = getIngestDb()
      .prepare("SELECT COUNT(*) AS n FROM stream_event")
      .get() as { n: number };
    assert.ok(row.n >= 1, "event landed in ingest.db");
  });

  it("does NOT falsely 201 when the ingest.db mirror genuinely fails", async () => {
    // Force a genuine (non-UNIQUE) failure: drop the table the mirror writes.
    getIngestDb().exec("DROP TABLE IF EXISTS stream_event");

    const r = await ingest({
      stream_id: "email",
      stream_type: "email",
      source_ref: "msg-dropped",
      raw: { body: "would be invisible to the extractor" },
    });

    assert.ok(r.error, "a genuine mirror failure must propagate (not be swallowed)");
    assert.notEqual(r.status, 201, "a dropped event must NOT report a 201 success");
  });
});
