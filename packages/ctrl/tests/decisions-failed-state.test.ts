// #282 — terminal `failed` dead-letter decision state.
//
// recover_stuck_dispatching (Lane II, decision_router.py) resets any
// state=dispatching decision with agent_dispatched=false back to `open` on
// every DecisionRouter cycle with NO retry cap — a dispatch that can never
// succeed loops forever (open → dispatch fails → dispatching → recover →
// open → …), re-firing the action and re-notifying the principal each cycle
// (live incident 2026-07-15, office-ac-quiet-mode).
//
// The fix caps the resurrection: after MAX_DISPATCH_ATTEMPTS the router
// PATCHes the decision to a terminal `failed` state instead of `open`. For
// ctrl-api (this lane) that means:
//   - PATCH /decisions/:id {state:"failed"} → 200, persists state:"failed"
//     (does NOT reject — `failed` is a valid state now).
//   - PATCH with a bogus state still rejected via ValidationError (the guard
//     is intact). NB: ValidationError maps to HTTP 400 in this codebase
//     (errors.ts), not 422 — the #282 brief's "422" is the generic
//     "rejected-not-persisted" shorthand; the concrete guard is a 400.
//   - GET /decisions/in-flight EXCLUDES a `failed` decision (terminal, drops
//     off the "What Alfred is doing now" strip — so the surfacing audit that
//     Lane II fires on the crossing runs exactly once, never per-cycle).
//   - GET /decisions?state=failed RETURNS the failed decision (the defensive
//     state-vs-status list filter treats `failed` like any other state).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dec-failed-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
fs.mkdirSync(path.join(VAULT, "decision"), { recursive: true });

const { getStateDb } = await import("../src/db/state.js");
const { registerDecisionRoutes } = await import("../src/api/routes/decisions.js");
const { matchRoute } = await import("../src/api/server.js");

registerDecisionRoutes();

// A stuck-dispatching decision on disk, indexed into vault_index, exactly as
// the router would see it before dead-lettering it.
const STUCK_ID = "2026-07-15T00-00-00Z-deadbeef";

function writeDecisionFile(id: string, state: string): void {
  fs.writeFileSync(
    path.join(VAULT, "decision", `${id}.md`),
    [
      "---",
      'type: "decision"',
      'created: "2026-07-15T00:00:00.000Z"',
      'principal: "principal"',
      'source: "needs_attention"',
      'source_record: "needs_attention/office-ac-quiet-mode.md"',
      'intent: "delegate"',
      `state: "${state}"`,
      "---",
      "",
      "# Decision: delegate on needs_attention",
      "",
    ].join("\n") + "\n",
    "utf-8",
  );
}

function indexDecision(id: string, fm: Record<string, unknown>, statusCol: string | null): void {
  getStateDb()
    .prepare(
      `INSERT OR REPLACE INTO vault_index (path, record_type, title, status, frontmatter_json, mtime)
       VALUES (?, 'decision', ?, ?, ?, ?)`,
    )
    .run(`decision/${id}.md`, id, statusCol, JSON.stringify(fm), "2026-07-15T00:00:00.000Z");
}

before(() => {
  getStateDb();
  writeDecisionFile(STUCK_ID, "dispatching");
  indexDecision(
    STUCK_ID,
    {
      type: "decision",
      source: "needs_attention",
      source_record: "needs_attention/office-ac-quiet-mode.md",
      intent: "delegate",
      state: "dispatching",
    },
    "dispatching",
  );
});

async function patchDecision(id: string, body: unknown): Promise<{ status: number; payload: any }> {
  const m = matchRoute("PATCH", `/api/v1/decisions/${id}`);
  assert.ok(m, "PATCH /api/v1/decisions/:id must be registered");
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { url: `/api/v1/decisions/${id}` } as any,
      res,
      params: { id },
      body,
      query: new URLSearchParams(),
    });
  } catch (err: any) {
    // ValidationError/NotFoundError carry a statusCode the real dispatcher
    // maps to a response; surface it here so the test can assert on it.
    status = err?.statusCode ?? err?.status ?? 500;
    payload = { error: err?.message };
  }
  return { status, payload };
}

async function getJson(routePath: string, qs = ""): Promise<any> {
  const m = matchRoute("GET", routePath);
  assert.ok(m, `GET ${routePath} must be registered`);
  let payload: any;
  const res = {
    writeHead() { return res; },
    end(json: string) { payload = JSON.parse(json); },
  } as unknown as ServerResponse;
  await m!.handler({
    req: { url: `${routePath}${qs}` } as any,
    res,
    params: {},
    body: undefined,
    query: new URLSearchParams(qs.replace(/^\?/, "")),
  });
  return payload;
}

describe("#282 — terminal `failed` decision state", () => {
  it("PATCH {state:'failed'} returns 200 and persists state:'failed' (does NOT 422)", async () => {
    const { status, payload } = await patchDecision(STUCK_ID, { state: "failed" });
    assert.equal(status, 200, "dead-letter PATCH must succeed");
    assert.equal(payload.frontmatter.state, "failed", "response echoes the failed state");

    // Persisted to the record frontmatter on disk.
    const raw = fs.readFileSync(path.join(VAULT, "decision", `${STUCK_ID}.md`), "utf-8");
    assert.match(raw, /state:\s*"failed"/, "state:'failed' persisted to the markdown record");
  });

  it("PATCH with a bogus state is still rejected (guard intact)", async () => {
    const { status } = await patchDecision(STUCK_ID, { state: "bogus" });
    // ValidationError → 400 in this codebase (errors.ts). The point of the
    // #282 guard is that an unknown state is REJECTED, not silently persisted.
    assert.equal(status, 400, "an invalid state is still rejected (not persisted)");
    assert.notEqual(status, 200, "invalid state must never succeed");

    // And it must NOT have overwritten the persisted `failed` state.
    const raw = fs.readFileSync(path.join(VAULT, "decision", `${STUCK_ID}.md`), "utf-8");
    assert.match(raw, /state:\s*"failed"/, "bogus PATCH left the record at failed");
    assert.doesNotMatch(raw, /state:\s*"bogus"/, "bogus state was not written");
  });

  it("GET /decisions/in-flight EXCLUDES a failed decision (terminal — drops off the strip)", async () => {
    // The record on disk is now state=failed from the first test.
    const out = await getJson("/api/v1/decisions/in-flight");
    const ids = out.decisions.map((d: any) => d.id);
    assert.ok(!ids.includes(STUCK_ID), "a failed decision must not appear in-flight");
  });

  it("GET /decisions?state=failed RETURNS the failed decision", async () => {
    // Re-index the row to reflect the dead-letter transition (the PATCH handler
    // re-indexes in production; here we assert the list filter surfaces it).
    indexDecision(
      STUCK_ID,
      {
        type: "decision",
        source: "needs_attention",
        source_record: "needs_attention/office-ac-quiet-mode.md",
        intent: "delegate",
        state: "failed",
      },
      "failed",
    );
    const out = await getJson("/api/v1/decisions", "?state=failed");
    const ids = out.decisions.map((d: any) => d.id);
    assert.ok(ids.includes(STUCK_ID), "a failed decision must be listable via state=failed");
  });
});
