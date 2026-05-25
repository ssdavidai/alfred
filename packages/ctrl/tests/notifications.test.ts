/**
 * Tests for POST /api/v1/notifications — the legacy entry point.
 *
 * HISTORY (2026-05-25 hard switch — docs/design/one-alfred.md).
 * The route was originally the direct cron-job delivery path with a
 * deterministic byte-echo prompt. The new architecture moves the actual
 * delivery + journalling into POST /api/v1/alfred-deliver; /notifications
 * is now a thin forwarder that preserves the legacy body + response shape
 * so `notify_principal` MCP callers keep working unchanged.
 *
 * What we test here is the forwarder behaviour only:
 *   1. Missing message → 400.
 *   2. A successful forward maps alfred-deliver's response to the
 *      legacy { status:"delivered", delivered:true, channel, to, jobId }
 *      shape (jobId = journal_id).
 *   3. A failed forward (alfred-deliver returned non-ok) surfaces the
 *      error and returns delivered:false.
 *
 * The deep coverage of channel resolution, journal-pending writes,
 * Hermes webhook composition, delivery success/failure handling, etc.
 * lives at the live /api/v1/alfred-deliver path. This test file is
 * intentionally thin — it only proves the forwarder bridges shape
 * correctly.
 */
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// fs mock — getGatewayToken() reads from disk at module import. The new
// forwarder doesn't need the token, but downstream helpers still do.
const fsReadFileSync = mock.fn((p: any) => {
  if (typeof p === "string" && p.endsWith(".gateway-token")) {
    return "stub-gateway-token-for-tests";
  }
  if (typeof p === "string" && p.endsWith("sessions.json")) {
    return "{}";
  }
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
});
const fsExistsSync = mock.fn(() => true);
// streams.ts mkdir's its data dir at import time — stub it so transitively
// importing server.js (and therefore streams.ts) doesn't ENOENT in tests.
const fsMkdirSync = mock.fn(() => undefined);
const fsWriteFileSync = mock.fn(() => undefined);
const fsAppendFileSync = mock.fn(() => undefined);
const fsStatSync = mock.fn(() => ({ size: 0 }));
const fsBundle = {
  readFileSync: fsReadFileSync,
  existsSync: fsExistsSync,
  mkdirSync: fsMkdirSync,
  writeFileSync: fsWriteFileSync,
  appendFileSync: fsAppendFileSync,
  statSync: fsStatSync,
};
mock.module("node:fs", {
  defaultExport: fsBundle,
  namedExports: fsBundle,
});

// fetch mock — intercept the self-call to /api/v1/alfred-deliver.
type FetchReply = { ok: boolean; status: number; body: Record<string, unknown> };
let nextReply: FetchReply = {
  ok: true,
  status: 200,
  body: {
    ok: true,
    journal_id: "01STUBJOURNAL",
    channel: "telegram",
    chat_id: "432094090",
    delivered_bytes: "Sir, here's your reminder.",
  },
};
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = ((url: any, init?: RequestInit) => {
  const u = String(url);
  fetchCalls.push({ url: u, init });
  if (!u.includes("/api/v1/alfred-deliver")) {
    throw new Error(`unexpected fetch in /notifications test: ${u}`);
  }
  return Promise.resolve(
    new Response(JSON.stringify(nextReply.body), {
      status: nextReply.status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}) as typeof fetch;

process.env.AAS_API_KEY = "stub-aas-key";
process.env.AAS_PORT = "3100";

const { registerNotificationRoutes } = await import(
  "../src/api/routes/notifications.js"
);
const { matchRoute } = await import("../src/api/server.js");

registerNotificationRoutes();

async function callNotify(
  body: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const match = matchRoute("POST", "/api/v1/notifications");
  assert.ok(match, "POST /api/v1/notifications must be registered");
  let status = 0;
  let payload: Record<string, unknown> = {};
  const res: any = {
    statusCode: 0,
    setHeader() {},
    writeHead(s: number) {
      status = s;
    },
    end(b: string) {
      try {
        payload = JSON.parse(b);
      } catch {
        payload = { raw: b };
      }
    },
  };
  try {
    await match!.handler({
      req: { method: "POST", headers: {} } as any,
      res,
      params: {},
      body,
      query: new URLSearchParams(),
    });
  } catch (e: any) {
    // The route's ValidationError + NotFoundError + the like normally bubble
    // up to server.ts's handleError which translates them to HTTP statuses;
    // we replicate that translation here for the tests since we don't go
    // through the full server.
    if (e?.statusCode) {
      status = e.statusCode;
      try {
        payload = { error: { code: e.code, message: e.message } };
      } catch {
        /* leave payload */
      }
    } else {
      throw e;
    }
  }
  return { status: status || res.statusCode, payload };
}

describe("POST /api/v1/notifications (forwarder)", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    nextReply = {
      ok: true,
      status: 200,
      body: {
        ok: true,
        journal_id: "01STUBJOURNAL",
        channel: "telegram",
        chat_id: "432094090",
        delivered_bytes: "Sir, here's your reminder.",
      },
    };
  });

  it("returns 400 when message is missing", async () => {
    const r = await callNotify({});
    assert.equal(r.status, 400);
  });

  it("returns 400 when message is empty", async () => {
    const r = await callNotify({ message: "   " });
    assert.equal(r.status, 400);
  });

  it("forwards to alfred-deliver and maps the response to the legacy shape", async () => {
    const r = await callNotify({
      message: "ping me",
      channel: "telegram",
      to: "432094090",
      urgency: "normal",
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.delivered, true);
    assert.equal(r.payload.status, "delivered");
    assert.equal(r.payload.channel, "telegram");
    assert.equal(r.payload.to, "432094090");
    // jobId is the journal_id under the new path — same role (stable handle).
    assert.equal(r.payload.jobId, "01STUBJOURNAL");
    // Confirms the forward actually fired.
    assert.equal(fetchCalls.length, 1);
    const sent = JSON.parse(fetchCalls[0].init!.body as string);
    assert.equal(sent.message, "ping me");
    assert.equal(sent.channel, "telegram");
    assert.equal(sent.to, "432094090");
  });

  it("propagates downstream errors as delivered:false with the original status", async () => {
    nextReply = {
      ok: false,
      status: 502,
      body: {
        ok: false,
        journal_id: "01PENDINGFAIL",
        error: "hermes webhook returned 503",
      },
    };
    const r = await callNotify({ message: "ping", channel: "telegram", to: "x" });
    assert.equal(r.status, 502);
    assert.equal(r.payload.delivered, false);
    assert.equal(r.payload.status, "error");
    assert.equal(r.payload.error, "hermes webhook returned 503");
    assert.equal(r.payload.jobId, "01PENDINGFAIL");
  });
});

after(() => {
  globalThis.fetch = originalFetch;
});
