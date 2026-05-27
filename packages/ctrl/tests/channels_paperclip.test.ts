// Lane I — /api/v1/channels/paperclip/* (P2 Lane I).
//
// What's under test
// -----------------
// status + heartbeat + test routes for Paperclip's HTTP-adapter inbound
// channel. The wire shape is locked by Paperclip:
//
//   X-Paperclip-Signature: t=<unix-ts>,v1=<hex-hmac>
//   body: { message, agentId, deliver, paperclip: {runId, paperclipAgentId, taskId} }
//
// HMAC is over `<ts>.<JSON-stringified body>` keyed on
// PAPERCLIP_HEARTBEAT_SECRET, compared in constant time.
//
// We test the handler via matchRoute + a handleError shim (same pattern as
// ssh_keys.test.ts), so thrown ApiErrors land as JSON envelopes rather than
// bubbling up into the test runner. Hermes' /v1/responses is mocked at the
// fetch boundary so the heartbeat path is exercised end-to-end without
// reaching out to the network.
//
// Coverage:
//   1. GET /status — unconfigured shape (no env vars).
//   2. GET /status — has_signing_secret toggles on PAPERCLIP_HEARTBEAT_SECRET.
//   3. POST /heartbeat — valid signature (sync) → 200 + result.
//   4. POST /heartbeat — valid signature (async) → 202 + queued.
//   5. POST /heartbeat — missing X-Paperclip-Signature → 401 AUTH_FAILED.
//   6. POST /heartbeat — bad HMAC → 401 AUTH_FAILED, recorded as auth_failed.
//   7. POST /heartbeat — replayed timestamp (>5min skew) → 401 + replay.
//   8. POST /heartbeat — no secret in env → 503 NOT_CONFIGURED.
//   9. POST /heartbeat — malformed body (missing fields) → 400 VALIDATION_ERROR.
//  10. POST /heartbeat — Hermes returns 500 → 502 HERMES_UNREACHABLE.
//  11. POST /heartbeat — valid run is recorded in recent_runs (status=ok).
//  12. POST /test — no secret → 503 NOT_CONFIGURED.
//  13. POST /test — secret + Hermes ok → ok:true + sample_response truncated.
//  14. alfred_journal — heartbeat writes one in + one out row (sync mode).
//
// Privacy: this is a public OSS repo. No real secrets in this file.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-paperclip-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "test.alfred.black";
process.env.AAS_HOST = "127.0.0.1";
process.env.AAS_PORT = "3100";
// Default to NO secret; individual tests set it as needed.
delete process.env.PAPERCLIP_HEARTBEAT_SECRET;
delete process.env.PAPERCLIP_API_KEY;
process.env.HERMES_GATEWAY_URL = "http://hermes-stub:18789";
// channels_paperclip reads its Hermes-main API key from a per-profile
// .env file (matches hermes.ts:387 pattern) — not from HERMES_API_SERVER_KEY
// directly, because the per-profile key is the one Hermes' gateway actually
// validates against. Stub that file location via HERMES_CONFIG_DIR.
const hermesProfilesDir = path.join(tmp, "hermes-profiles");
fs.mkdirSync(path.join(hermesProfilesDir, "main"), { recursive: true });
fs.writeFileSync(
  path.join(hermesProfilesDir, "main", ".env"),
  "API_SERVER_KEY=test-hermes-key\n",
);
process.env.HERMES_CONFIG_DIR = hermesProfilesDir;
// paperclip-init writes the captured "Invite URL: …" to this file. Tests
// drive `setup_state === "needs_admin_signup"` by writing / deleting this
// path. (Production path is /alfred-data/paperclip-ceo-invite.txt; the
// override lives in channels_paperclip.ts under PAPERCLIP_INVITE_FILE.)
const paperclipInviteFile = path.join(tmp, "paperclip-ceo-invite.txt");
process.env.PAPERCLIP_INVITE_FILE = paperclipInviteFile;

// ── fetch mock ─────────────────────────────────────────────────────────────
//
// Two upstreams to intercept:
//   * Hermes /v1/responses — return a canonical responses envelope.
//   * Self-loopback POST to /api/v1/channels/paperclip/heartbeat (the /test
//     path POSTs to itself). Drive it directly through the handler instead of
//     opening a real HTTP socket.

const originalFetch = globalThis.fetch;
const originalHttpRequest = http.request;

let hermesOk = true;
let hermesText = "I have logged the task and will report progress shortly.";
let hermesStatus = 200;
let hermesShouldThrow = false;
let hermesShouldTimeout = false;
const hermesCalls: { url: string; sessionKey: string; input: string }[] = [];

// ── paperclip:3100 mock ──────────────────────────────────────────────────
//
// probeSetupState() calls `http.request({hostname:"paperclip", port:3100,
// path:"/sign-in" | "/api/companies", …})`. In the production stack that
// resolves through Docker DNS; in the test harness `paperclip` does not
// resolve at all (the default test environment routes those probes to
// req.on("error") → status 0 → "unreachable"). To cover the new
// `needs_admin_signup` branch, intercept http.request at the module level
// and return a stub response whose body carries (or doesn't carry) the
// "Instance setup required" sentinel string.
//
// State is set per-test via paperclipHttpStub.set(…) — same posture as the
// hermesOk / hermesShouldThrow flags above.

type PaperclipProbe = {
  status: number;
  body: string;
};

const paperclipHttpStub = {
  // Default: paperclip not reachable (matches the live "no sidecar" case).
  signIn: null as PaperclipProbe | null,
  apiCompanies: null as PaperclipProbe | null,
};

// Minimal stub of an IncomingMessage — enough for the probe's data/end
// handlers and resp.resume() (the route uses both shapes).
function fakeIncomingMessage(p: PaperclipProbe) {
  const handlers: Record<string, ((arg?: any) => void)[]> = {};
  const msg: any = {
    statusCode: p.status,
    on(ev: string, cb: (arg?: any) => void) {
      (handlers[ev] ||= []).push(cb);
      return msg;
    },
    resume() {
      // Drain — fire end immediately for the probe paths that don't read body.
      setImmediate(() => (handlers["end"] || []).forEach((cb) => cb()));
    },
  };
  // Deliver body bytes async to match real http semantics.
  setImmediate(() => {
    if (p.body) {
      (handlers["data"] || []).forEach((cb) =>
        cb(Buffer.from(p.body, "utf-8")),
      );
    }
    (handlers["end"] || []).forEach((cb) => cb());
  });
  return msg;
}

(http as any).request = ((options: any, cb?: (resp: any) => void) => {
  const host = options?.hostname ?? "";
  const path = options?.path ?? "";
  if (host === "paperclip") {
    // Build a minimal ClientRequest-like object that fires either our
    // stubbed response or an "error" if we have no probe configured.
    const reqHandlers: Record<string, ((arg?: any) => void)[]> = {};
    const req: any = {
      on(ev: string, h: (arg?: any) => void) {
        (reqHandlers[ev] ||= []).push(h);
        return req;
      },
      end() {
        let probe: PaperclipProbe | null = null;
        if (path === "/sign-in") probe = paperclipHttpStub.signIn;
        else if (path === "/api/companies")
          probe = paperclipHttpStub.apiCompanies;
        if (probe) {
          setImmediate(() => cb?.(fakeIncomingMessage(probe!)));
        } else {
          setImmediate(() =>
            (reqHandlers["error"] || []).forEach((h) =>
              h(new Error("paperclip not stubbed")),
            ),
          );
        }
        return req;
      },
      destroy() {},
      setTimeout() {},
    };
    return req;
  }
  // Anything else — fall through to the real implementation (the tests
  // don't drive any other http.request calls today).
  return (originalHttpRequest as any)(options, cb);
}) as typeof http.request;

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Forward-declare so the closure picks up the binding after the dynamic
// import populates it below.
let invokeRoute: (
  method: string,
  p: string,
  body?: unknown,
  headers?: Record<string, string>,
  rawBodyBuf?: Buffer,
) => Promise<{ status: number; payload: any }>;

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();

  // Hermes /v1/responses
  if (url.endsWith("/v1/responses")) {
    if (hermesShouldThrow) {
      throw new Error("fetch failed: ECONNREFUSED");
    }
    if (hermesShouldTimeout) {
      const err: any = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    const headers = init?.headers ?? {};
    const sessionKey = headers["X-Hermes-Session-Key"] ?? "";
    const bodyJson = JSON.parse(String(init?.body ?? "{}"));
    hermesCalls.push({ url, sessionKey, input: bodyJson.input ?? "" });
    if (!hermesOk) {
      return makeJsonResponse(
        { error: { message: "boom" } },
        hermesStatus,
      );
    }
    return makeJsonResponse({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: hermesText }],
        },
      ],
    });
  }

  // Self-loop from /test → /heartbeat. Drive directly through the route
  // dispatcher rather than opening a socket on 127.0.0.1:3100.
  if (
    method === "POST" &&
    url.includes("/api/v1/channels/paperclip/heartbeat")
  ) {
    const headersIn = init?.headers ?? {};
    // Pull headers in the same shape req.headers exposes (lowercased keys).
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersIn)) {
      hdrs[k.toLowerCase()] = String(v);
    }
    const raw =
      init?.body instanceof Buffer
        ? init.body
        : Buffer.from(String(init?.body ?? ""));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf-8"));
    } catch {
      parsed = {};
    }
    const result = await invokeRoute(
      "POST",
      "/api/v1/channels/paperclip/heartbeat",
      parsed,
      hdrs,
      raw,
    );
    return makeJsonResponse(result.payload, result.status);
  }

  throw new Error(`unexpected fetch in channels_paperclip test: ${method} ${url}`);
}) as typeof fetch;

// ── module imports (after env + fetch are set) ─────────────────────────────

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerPaperclipChannelRoutes, _resetPaperclipMemoryForTests } =
  await import("../src/api/routes/channels_paperclip.js");
const { getStateDb } = await import("../src/db/state.js");
registerPaperclipChannelRoutes();

invokeRoute = async function (
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
  _rawBodyBuf?: Buffer,
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { method, url: p, headers } as any,
      res,
      params: m!.params,
      body,
      query: new URLSearchParams(),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
};

// ── signing helpers ────────────────────────────────────────────────────────

const SECRET = "test-secret-do-not-use-in-prod";

function signHeartbeat(
  body: unknown,
  opts: { secret?: string; ts?: number } = {},
): { headers: Record<string, string>; raw: Buffer } {
  const secret = opts.secret ?? SECRET;
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const raw = Buffer.from(JSON.stringify(body), "utf-8");
  const signed = Buffer.concat([Buffer.from(`${ts}.`, "utf-8"), raw]);
  const v1 = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  return {
    headers: {
      "content-type": "application/json",
      "x-paperclip-signature": `t=${ts},v1=${v1}`,
    },
    raw,
  };
}

function validHeartbeatBody(over: Partial<any> = {}): any {
  return {
    message: "Work on task task_impl_x using context.",
    agentId: "main",
    deliver: true,
    paperclip: {
      runId: "run_test_001",
      paperclipAgentId: "agent_cto_01",
      taskId: "task_impl_x",
    },
    ...over,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("/api/v1/channels/paperclip/* — Lane I", () => {
  beforeEach(() => {
    _resetPaperclipMemoryForTests();
    hermesOk = true;
    hermesStatus = 200;
    hermesShouldThrow = false;
    hermesShouldTimeout = false;
    hermesText = "I have logged the task and will report progress shortly.";
    hermesCalls.length = 0;
    delete process.env.PAPERCLIP_HEARTBEAT_SECRET;
    delete process.env.PAPERCLIP_API_KEY;
    paperclipHttpStub.signIn = null;
    paperclipHttpStub.apiCompanies = null;
    // Reset the invite file between tests so probes don't leak state.
    try {
      fs.unlinkSync(paperclipInviteFile);
    } catch {
      /* file may not exist */
    }
  });

  after(() => {
    globalThis.fetch = originalFetch;
    (http as any).request = originalHttpRequest;
  });

  describe("GET /status", () => {
    it("returns the empty-state shape when no env vars are set", async () => {
      const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(r.status, 200);
      assert.equal(r.payload.configured, false);
      assert.equal(r.payload.has_signing_secret, false);
      assert.equal(
        r.payload.heartbeat_url,
        "https://test.alfred.black/api/v1/channels/paperclip/heartbeat",
      );
      assert.equal(r.payload.last_heartbeat_at, null);
      assert.deepEqual(r.payload.recent_runs, []);
    });

    it("flips has_signing_secret + configured when env vars are present", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      process.env.PAPERCLIP_API_KEY = "fake-key";
      const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(r.status, 200);
      assert.equal(r.payload.configured, true);
      assert.equal(r.payload.has_signing_secret, true);
    });

    it("setup_state=needs_admin_signup + admin_invite_url when Paperclip shows the instance-setup wall and the invite file is present", async () => {
      // Paperclip's /sign-in body on a fresh sidecar:
      paperclipHttpStub.signIn = {
        status: 200,
        body:
          "<!DOCTYPE html><html><body>" +
          "<h1>Instance setup required</h1>" +
          "<p>Run pnpm paperclipai auth bootstrap-ceo to claim this instance.</p>" +
          "</body></html>",
      };
      // paperclip-init writes the captured invite URL here.
      const invite =
        "https://paperclip.test.alfred.black/admin/setup?token=abc123";
      fs.writeFileSync(paperclipInviteFile, invite + "\n");

      const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(r.status, 200);
      assert.equal(r.payload.setup_state, "needs_admin_signup");
      assert.equal(r.payload.admin_invite_url, invite);
    });

    it("needs_admin_signup with no invite file → setup_state surfaces but admin_invite_url is absent", async () => {
      // paperclip-init might not have completed yet (or compose hasn't been
      // restarted). The card should still show the right state so the UI
      // can show a degraded "still preparing your invite…" message.
      paperclipHttpStub.signIn = {
        status: 200,
        body: "<h1>Instance setup required</h1>",
      };
      // No invite file written.
      const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(r.status, 200);
      assert.equal(r.payload.setup_state, "needs_admin_signup");
      assert.equal(r.payload.admin_invite_url, undefined);
    });

    it("setup_state=needs_api_key when /sign-in is up and NOT showing the instance-setup wall", async () => {
      // Past the admin-signup wall, but PAPERCLIP_API_KEY is still unset.
      paperclipHttpStub.signIn = {
        status: 200,
        body:
          "<!DOCTYPE html><html><body>" +
          "<form><input name='email'/><input name='password' type='password'/>" +
          "<button>Sign in</button></form></body></html>",
      };
      // Even if the invite file is present, we must NOT surface it on
      // needs_api_key — the principal has already signed up; the URL is stale.
      fs.writeFileSync(
        paperclipInviteFile,
        "https://paperclip.test.alfred.black/admin/setup?token=stale\n",
      );

      const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(r.status, 200);
      assert.equal(r.payload.setup_state, "needs_api_key");
      assert.equal(r.payload.admin_invite_url, undefined);
    });

    it("setup_state=configured when PAPERCLIP_API_KEY is set and /api/companies returns 200", async () => {
      process.env.PAPERCLIP_API_KEY = "pck_real_key";
      paperclipHttpStub.apiCompanies = { status: 200, body: "[]" };
      const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(r.status, 200);
      assert.equal(r.payload.setup_state, "configured");
      assert.equal(r.payload.admin_invite_url, undefined);
    });

    it("setup_state=auth_failed when /api/companies rejects the key", async () => {
      process.env.PAPERCLIP_API_KEY = "pck_revoked";
      paperclipHttpStub.apiCompanies = { status: 401, body: "" };
      const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(r.status, 200);
      assert.equal(r.payload.setup_state, "auth_failed");
    });

    it("admin_invite_url is hidden when the invite file holds garbage", async () => {
      paperclipHttpStub.signIn = {
        status: 200,
        body: "Instance setup required",
      };
      // Non-URL content (e.g. a stray banner line snuck through the parser).
      fs.writeFileSync(paperclipInviteFile, "not-actually-a-url\n");

      const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(r.payload.setup_state, "needs_admin_signup");
      assert.equal(r.payload.admin_invite_url, undefined);
    });
  });

  describe("POST /heartbeat", () => {
    it("503 NOT_CONFIGURED when PAPERCLIP_HEARTBEAT_SECRET is unset", async () => {
      const body = validHeartbeatBody();
      const { headers } = signHeartbeat(body);
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      assert.equal(r.status, 503);
      assert.equal(r.payload.error.code, "NOT_CONFIGURED");
    });

    it("401 AUTH_FAILED when X-Paperclip-Signature is missing", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        validHeartbeatBody(),
        { "content-type": "application/json" },
      );
      assert.equal(r.status, 401);
      assert.equal(r.payload.error.code, "AUTH_FAILED");
    });

    it("401 AUTH_FAILED when the HMAC doesn't validate", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      const body = validHeartbeatBody();
      const { headers } = signHeartbeat(body, { secret: "wrong-secret" });
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      assert.equal(r.status, 401);
      assert.equal(r.payload.error.code, "AUTH_FAILED");
      // Auth failures still surface in recent_runs so the operator sees them.
      const status = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(status.payload.recent_runs[0].status, "auth_failed");
    });

    it("401 AUTH_FAILED when the timestamp is outside the replay window", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      const body = validHeartbeatBody();
      const oldTs = Math.floor(Date.now() / 1000) - 10 * 60; // 10min ago
      const { headers } = signHeartbeat(body, { ts: oldTs });
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      assert.equal(r.status, 401);
      assert.equal(r.payload.error.code, "AUTH_FAILED");
      const status = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(status.payload.recent_runs[0].status, "replay");
    });

    it("400 VALIDATION_ERROR when the body is missing required fields", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      const body = { message: "hi" }; // missing agentId/deliver/paperclip
      const { headers } = signHeartbeat(body);
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    });

    it("200 + result when deliver=true and Hermes responds", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      const body = validHeartbeatBody();
      const { headers } = signHeartbeat(body);
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.ok, true);
      assert.equal(
        r.payload.result,
        "I have logged the task and will report progress shortly.",
      );
      assert.equal(r.payload.run_id, "run_test_001");
      assert.equal(hermesCalls.length, 1);
      assert.equal(hermesCalls[0].sessionKey, "paperclip-agent_cto_01");
      assert.equal(hermesCalls[0].input, body.message);
    });

    it("202 + queued when deliver=false (async mode)", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      const body = validHeartbeatBody({ deliver: false });
      const { headers } = signHeartbeat(body);
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      assert.equal(r.status, 202);
      assert.equal(r.payload.ok, true);
      assert.equal(r.payload.queued, true);
      assert.equal(r.payload.run_id, "run_test_001");
    });

    it("502 HERMES_UNREACHABLE when Hermes returns 5xx", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      hermesOk = false;
      hermesStatus = 500;
      const body = validHeartbeatBody();
      const { headers } = signHeartbeat(body);
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      assert.equal(r.status, 502);
      assert.equal(r.payload.error.code, "HERMES_UNREACHABLE");
      const status = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(status.payload.recent_runs[0].status, "hermes_unreachable");
    });

    it("502 HERMES_UNREACHABLE when fetch to Hermes throws", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      hermesShouldThrow = true;
      const body = validHeartbeatBody();
      const { headers } = signHeartbeat(body);
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      assert.equal(r.status, 502);
      assert.equal(r.payload.error.code, "HERMES_UNREACHABLE");
    });

    it("504 HERMES_TIMEOUT when the Hermes call times out", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      hermesShouldTimeout = true;
      const body = validHeartbeatBody();
      const { headers } = signHeartbeat(body);
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      assert.equal(r.status, 504);
      assert.equal(r.payload.error.code, "HERMES_TIMEOUT");
    });

    it("records a successful run + bumps last_heartbeat_at", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      const body = validHeartbeatBody();
      const { headers } = signHeartbeat(body);
      await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      const status = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(status.payload.recent_runs.length, 1);
      const row = status.payload.recent_runs[0];
      assert.equal(row.run_id, "run_test_001");
      assert.equal(row.paperclip_agent_id, "agent_cto_01");
      assert.equal(row.task_id, "task_impl_x");
      assert.equal(row.status, "ok");
      assert.ok(typeof row.duration_ms === "number");
      assert.equal(status.payload.last_heartbeat_at, row.ts);
    });

    it("ring buffer keeps only the most recent 10 runs (newest first)", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      for (let i = 0; i < 12; i++) {
        const body = validHeartbeatBody({
          paperclip: {
            runId: `run_${i}`,
            paperclipAgentId: "agent_cto_01",
            taskId: `task_${i}`,
          },
        });
        const { headers } = signHeartbeat(body);
        await invokeRoute(
          "POST",
          "/api/v1/channels/paperclip/heartbeat",
          body,
          headers,
        );
      }
      const status = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
      assert.equal(status.payload.recent_runs.length, 10);
      // Newest first: run_11 → run_2.
      assert.equal(status.payload.recent_runs[0].run_id, "run_11");
      assert.equal(status.payload.recent_runs[9].run_id, "run_2");
    });

    it("writes one inbound + one outbound row to alfred_journal (sync mode)", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      const body = validHeartbeatBody({
        paperclip: {
          runId: "run_journal_001",
          paperclipAgentId: "agent_cto_07",
          taskId: "task_journal_1",
        },
      });
      const { headers } = signHeartbeat(body);
      await invokeRoute(
        "POST",
        "/api/v1/channels/paperclip/heartbeat",
        body,
        headers,
      );
      const db = getStateDb();
      const rows = db
        .prepare(
          `SELECT channel, chat_id, direction, message, status FROM alfred_journal
             WHERE channel = ? AND chat_id = ? ORDER BY rowid ASC`,
        )
        .all("paperclip", "paperclip-agent_cto_07") as Array<{
        channel: string;
        chat_id: string;
        direction: string;
        message: string;
        status: string;
      }>;
      assert.equal(rows.length, 2, "one inbound + one outbound");
      assert.equal(rows[0].direction, "inbound");
      assert.equal(rows[0].message, body.message);
      assert.equal(rows[0].status, "received");
      assert.equal(rows[1].direction, "outbound");
      assert.equal(rows[1].status, "delivered");
      assert.equal(
        rows[1].message,
        "I have logged the task and will report progress shortly.",
      );
    });
  });

  describe("POST /test", () => {
    it("503 NOT_CONFIGURED when PAPERCLIP_HEARTBEAT_SECRET is unset", async () => {
      const r = await invokeRoute("POST", "/api/v1/channels/paperclip/test");
      assert.equal(r.status, 503);
      assert.equal(r.payload.error.code, "NOT_CONFIGURED");
    });

    it("self-POSTs a signed heartbeat and returns the round-trip result", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      hermesText = "x".repeat(500); // exercise truncation
      const r = await invokeRoute("POST", "/api/v1/channels/paperclip/test");
      assert.equal(r.status, 200);
      assert.equal(r.payload.ok, true);
      assert.equal(r.payload.status, 200);
      assert.ok(typeof r.payload.latency_ms === "number");
      assert.ok(r.payload.sample_response);
      assert.equal(
        r.payload.sample_response.length,
        200,
        "sample_response truncated to 200 chars",
      );
    });

    it("self-test skips alfred_journal writes (X-Paperclip-Test: 1)", async () => {
      process.env.PAPERCLIP_HEARTBEAT_SECRET = SECRET;
      const db = getStateDb();
      const before = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM alfred_journal WHERE channel = ?",
          )
          .get("paperclip") as { n: number }
      ).n;
      await invokeRoute("POST", "/api/v1/channels/paperclip/test");
      const after = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM alfred_journal WHERE channel = ?",
          )
          .get("paperclip") as { n: number }
      ).n;
      assert.equal(after, before, "no journal rows added on self-test");
    });
  });
});
