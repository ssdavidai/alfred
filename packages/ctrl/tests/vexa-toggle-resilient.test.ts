// F29 — Vexa auto-join toggle must return 2xx, not 500, and toggle both
// VEXA-gated schedules. debug/0522/vexa-meetingbot-findings.md: the toggle
// 500'd writing ${COMPOSE_DIR}/.env to an unmounted path (ENOENT outside any
// try/catch). With F40 the path is reachable; the route must also create a
// missing .env, toggle al-meeting-capture AND al-transcript-intake, and treat
// an absent schedule handle as a benign no-op rather than a 5xx.
//
// COMPOSE_DIR is read at module import (helpers.ts), so it's set first. The
// temporal shell-out fails in the sandbox (bogus compose path) — exactly the
// "schedule handle absent" condition under test.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vexa-toggle-"));
process.env.COMPOSE_DIR = tmp; // a dir with NO .env yet — toggle must create it
// Redirect the data/vault/state paths that server.ts's transitive imports touch
// at module load (streams.ts mkdirs ALFRED_DATA_DIR/streams).
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
const ENV_PATH = path.join(tmp, ".env");

const { matchRoute } = await import("../src/api/server.js");
const { registerVexaRoutes, _internal } = await import("../src/api/routes/vexa.js");
registerVexaRoutes();

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(c: number) { status = c; return res; },
    end(j?: string) { payload = j ? JSON.parse(j) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: p } as any, res, params: m!.params, body, query: new URLSearchParams() });
  return { status, payload };
}

const POST = "/api/v1/admin/vexa/auto-join";

describe("vexa auto-join toggle — resilient to absent schedules (F29)", () => {
  it("creates a missing .env and returns 200 on enable", async () => {
    assert.ok(!fs.existsSync(ENV_PATH), "precondition: .env must not exist yet");
    const { status, payload } = await call("POST", POST, { enabled: true });
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    assert.equal(payload.enabled, true);
    assert.match(fs.readFileSync(ENV_PATH, "utf-8"), /VEXA_ENABLED=true/);
    // existing response shape preserved
    for (const k of ["enabled", "schedule_paused", "warning"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(payload, k), `missing field ${k}`);
    }
  });

  it("returns 200 on disable even when no schedule handle exists", async () => {
    const { status, payload } = await call("POST", POST, { enabled: false });
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    assert.equal(payload.enabled, false);
    assert.match(fs.readFileSync(ENV_PATH, "utf-8"), /VEXA_ENABLED=false/);
  });

  it("rejects a bad body with a 400 ValidationError", async () => {
    await assert.rejects(
      () => call("POST", POST, { enabled: "yes" }),
      (e: any) => e && e.statusCode === 400,
    );
  });

  it("toggles BOTH vexa schedules and classifies NOT_FOUND as benign", () => {
    assert.deepEqual([..._internal.SCHEDULE_IDS], ["al-meeting-capture", "al-transcript-intake"]);
    assert.equal(_internal.isScheduleNotFound("temporal CLI exit 1: workflow not found"), true);
    assert.equal(_internal.isScheduleNotFound("schedule does not exist"), true);
    assert.equal(_internal.isScheduleNotFound("connection refused"), false);
  });
});
