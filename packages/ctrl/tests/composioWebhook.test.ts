// Composio webhook handler — fix/composio-webhook-handler.
//
// What's under test
// -----------------
// POST /api/v1/composio/webhook — public, HMAC-validated, flips a local
// ComposioConnection row's `status` from INITIATED → ACTIVE by hopping to
// the web-side internal endpoint /webhook/composio/finalize. See
// packages/ctrl/src/api/routes/composioWebhook.ts for the design notes.
//
// We test through matchRoute + a handleError shim — same pattern as
// channels_paperclip.test.ts. The web-side hop is stubbed at the fetch
// boundary so the assertions cover the ctrl-api auth + dispatch surface
// only.
//
// Coverage:
//   1.  unknown event type → 200 no-op (no web call)
//   2.  connected_account.updated with non-ACTIVE status → 200 no-op
//   3.  connected_account.updated + ACTIVE → 200, web-flip called once
//   4.  same event when row is already ACTIVE → 200 idempotent (web noop)
//   5.  unknown connectionId → 200 no-op
//   6.  unparseable body → 200 no-op
//   7.  v3 envelope `{ metadata: { event_type, connected_account_id }, data:
//       { status } }` shape also routed correctly
//   8.  SECRET set + bad standard-webhooks signature → 401
//   9.  SECRET set + missing both signature headers → 401
//  10.  SECRET unset + no signature → 200 + WARN (deploy-friendly fallback)
//  11.  SECRET set + valid x-composio-signature → 200 (alt scheme)
//  12.  web-side flip returns 500 → 502 (transient; Composio will retry)
//
// Privacy: public repo. No real secrets in this file.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

// ── env setup ──────────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "composio-webhook-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "test.alfred.black";
process.env.AAS_API_KEY = "test-aas-api-key";
// Web URL the handler will POST to — stubbed at fetch boundary below.
process.env.WEB_BASE_URL = "http://web-stub:3000";
delete process.env.COMPOSIO_WEBHOOK_SECRET;

// ── fetch mock ─────────────────────────────────────────────────────────────
//
// One upstream to intercept: POST http://web-stub:3000/webhook/composio/finalize.
// Tests assert on this call ledger to verify the ctrl-api → web hop fired
// (or didn't) for each scenario.

const originalFetch = globalThis.fetch;

interface WebCall {
  url: string;
  method: string;
  authorization: string;
  body: any;
}
const webCalls: WebCall[] = [];
let webResponseStatus = 200;
let webResponseBody: any = { ok: true };

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.endsWith("/webhook/composio/finalize") && method === "POST") {
    const headers = init?.headers ?? {};
    const authorization = headers.Authorization ?? headers.authorization ?? "";
    let body: any = null;
    try {
      body = JSON.parse(String(init?.body ?? "null"));
    } catch {
      body = null;
    }
    webCalls.push({ url, method, authorization, body });
    return makeJsonResponse(webResponseBody, webResponseStatus);
  }
  throw new Error(`unexpected fetch in composioWebhook test: ${method} ${url}`);
}) as typeof fetch;

// ── module imports (after env + fetch are set) ─────────────────────────────

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerComposioWebhookRoutes } = await import(
  "../src/api/routes/composioWebhook.js"
);
registerComposioWebhookRoutes();

async function invokeRoute(
  method: string,
  p: string,
  body: unknown,
  headers: Record<string, string> = {},
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
}

// ── signing helpers ────────────────────────────────────────────────────────

const SECRET = "test-composio-secret-do-not-use-in-prod";

/** Sign a body the way Composio's Standard-Webhooks scheme does:
 * `${id}.${ts}.${rawBody}` HMAC-SHA-256, base64. */
function signStandardWebhooks(
  rawBody: Buffer,
  opts: { id?: string; ts?: number; secret?: string } = {},
): { id: string; ts: string; sig: string } {
  const id = opts.id ?? "msg_test_01HK7";
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const secret = opts.secret ?? SECRET;
  const signed = Buffer.concat([
    Buffer.from(`${id}.${ts}.`, "utf-8"),
    rawBody,
  ]);
  const sig = crypto.createHmac("sha256", secret).update(signed).digest("base64");
  return { id, ts, sig: `v1,${sig}` };
}

/** Sign a body the alt-scheme way: x-composio-signature: sha256=<hex>. */
function signXComposio(
  rawBody: Buffer,
  opts: { secret?: string } = {},
): string {
  const secret = opts.secret ?? SECRET;
  const hex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${hex}`;
}

// ── event-shape helpers ────────────────────────────────────────────────────

function buildActiveEvent(connectionId: string): any {
  return {
    type: "connected_account.updated",
    data: {
      id: connectionId,
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      user_id: "user_xyz",
    },
  };
}

function buildV3ActiveEvent(connectionId: string): any {
  return {
    metadata: {
      event_type: "connected_account.updated",
      connected_account_id: connectionId,
    },
    data: { status: "ACTIVE", toolkit: { slug: "gmail" } },
  };
}

function buildBody(payload: any): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf-8");
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("/api/v1/composio/webhook — connected_account.updated → ACTIVE flip", () => {
  beforeEach(() => {
    webCalls.length = 0;
    webResponseStatus = 200;
    webResponseBody = { ok: true };
    delete process.env.COMPOSIO_WEBHOOK_SECRET;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("200 no-op when the event type is not connected_account.* (unsigned fallback)", async () => {
    const body = buildBody({
      type: "trigger.fired",
      data: { id: "ca_xyz", status: "ACTIVE" },
    });
    const r = await invokeRoute(
      "POST",
      "/api/v1/composio/webhook",
      body,
      { "content-type": "application/json" },
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(webCalls.length, 0, "must not hop to web for unrelated events");
  });

  it("200 no-op when status is not ACTIVE (e.g. INITIATED)", async () => {
    const body = buildBody({
      type: "connected_account.updated",
      data: { id: "ca_xyz", status: "INITIATED" },
    });
    const r = await invokeRoute(
      "POST",
      "/api/v1/composio/webhook",
      body,
      { "content-type": "application/json" },
    );
    assert.equal(r.status, 200);
    assert.equal(webCalls.length, 0);
  });

  it("200 + flips row when connected_account.updated + ACTIVE (unsigned fallback)", async () => {
    const body = buildBody(buildActiveEvent("ca_active_001"));
    const r = await invokeRoute(
      "POST",
      "/api/v1/composio/webhook",
      body,
      { "content-type": "application/json" },
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.connection_id, "ca_active_001");
    assert.equal(r.payload.flipped_to, "ACTIVE");
    assert.equal(webCalls.length, 1);
    assert.equal(
      webCalls[0].url,
      "http://web-stub:3000/webhook/composio/finalize",
    );
    assert.equal(webCalls[0].authorization, "Bearer test-aas-api-key");
    assert.equal(webCalls[0].body.connectionId, "ca_active_001");
    assert.equal(webCalls[0].body.status, "ACTIVE");
  });

  it("200 + idempotent when the row is already ACTIVE (web returns noop:true)", async () => {
    // The web side is the source of truth for idempotency; we just need to
    // confirm ctrl-api forwards the call and surfaces a 200.
    webResponseBody = { ok: true, noop: true, status: "ACTIVE" };
    const body = buildBody(buildActiveEvent("ca_already_active"));
    const r = await invokeRoute(
      "POST",
      "/api/v1/composio/webhook",
      body,
      { "content-type": "application/json" },
    );
    assert.equal(r.status, 200);
    assert.equal(webCalls.length, 1);
  });

  it("200 no-op when the connectionId is unknown on web (web returns 200 noop:not found)", async () => {
    // ctrl-api itself doesn't know about row existence — it forwards. The
    // web side returns 200 + noop:"not found" and ctrl-api passes through a
    // 200 to Composio (so they don't retry).
    webResponseStatus = 200;
    webResponseBody = { ok: true, noop: "not found" };
    const body = buildBody(buildActiveEvent("ca_does_not_exist"));
    const r = await invokeRoute(
      "POST",
      "/api/v1/composio/webhook",
      body,
      { "content-type": "application/json" },
    );
    assert.equal(r.status, 200);
    assert.equal(webCalls.length, 1);
  });

  it("200 no-op on unparseable body (don't trigger Composio retries on garbage)", async () => {
    const body = Buffer.from("this is not JSON{{{", "utf-8");
    const r = await invokeRoute(
      "POST",
      "/api/v1/composio/webhook",
      body,
      { "content-type": "application/json" },
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(webCalls.length, 0);
  });

  it("V3 envelope { metadata, data } is also routed", async () => {
    const body = buildBody(buildV3ActiveEvent("ca_v3_envelope"));
    const r = await invokeRoute(
      "POST",
      "/api/v1/composio/webhook",
      body,
      { "content-type": "application/json" },
    );
    assert.equal(r.status, 200);
    assert.equal(webCalls.length, 1);
    assert.equal(webCalls[0].body.connectionId, "ca_v3_envelope");
  });

  describe("HMAC enforcement (COMPOSIO_WEBHOOK_SECRET set)", () => {
    beforeEach(() => {
      process.env.COMPOSIO_WEBHOOK_SECRET = SECRET;
    });

    it("200 when standard-webhooks signature validates", async () => {
      const raw = buildBody(buildActiveEvent("ca_signed_ok"));
      const { id, ts, sig } = signStandardWebhooks(raw);
      const r = await invokeRoute(
        "POST",
        "/api/v1/composio/webhook",
        raw,
        {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": ts,
          "webhook-signature": sig,
        },
      );
      assert.equal(r.status, 200);
      assert.equal(webCalls.length, 1);
      assert.equal(webCalls[0].body.connectionId, "ca_signed_ok");
    });

    it("401 when standard-webhooks signature is wrong", async () => {
      const raw = buildBody(buildActiveEvent("ca_bad_sig"));
      const { id, ts } = signStandardWebhooks(raw, { secret: "wrong-secret" });
      const sig = "v1," + Buffer.from("garbage").toString("base64");
      const r = await invokeRoute(
        "POST",
        "/api/v1/composio/webhook",
        raw,
        {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": ts,
          "webhook-signature": sig,
        },
      );
      assert.equal(r.status, 401);
      assert.equal(r.payload.error.code, "AUTH_FAILED");
      assert.equal(webCalls.length, 0, "no web hop on auth failure");
    });

    it("401 when neither signature header is present and secret IS set", async () => {
      const raw = buildBody(buildActiveEvent("ca_no_sig"));
      const r = await invokeRoute(
        "POST",
        "/api/v1/composio/webhook",
        raw,
        { "content-type": "application/json" },
      );
      assert.equal(r.status, 401);
      assert.equal(r.payload.error.code, "AUTH_FAILED");
    });

    it("200 when alt-scheme x-composio-signature validates", async () => {
      const raw = buildBody(buildActiveEvent("ca_xsig_ok"));
      const xsig = signXComposio(raw);
      const r = await invokeRoute(
        "POST",
        "/api/v1/composio/webhook",
        raw,
        {
          "content-type": "application/json",
          "x-composio-signature": xsig,
        },
      );
      assert.equal(r.status, 200);
      assert.equal(webCalls.length, 1);
    });

    it("401 when alt-scheme x-composio-signature is wrong", async () => {
      const raw = buildBody(buildActiveEvent("ca_xsig_bad"));
      const xsig = signXComposio(raw, { secret: "wrong-secret" });
      const r = await invokeRoute(
        "POST",
        "/api/v1/composio/webhook",
        raw,
        {
          "content-type": "application/json",
          "x-composio-signature": xsig,
        },
      );
      assert.equal(r.status, 401);
      assert.equal(webCalls.length, 0);
    });
  });

  describe("unsigned-fallback (COMPOSIO_WEBHOOK_SECRET unset)", () => {
    it("200 + WARN log when no signature is presented and no secret is configured", async () => {
      // Capture console.warn to assert the fallback fired.
      const warnings: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      };
      try {
        const raw = buildBody(buildActiveEvent("ca_unsigned_ok"));
        const r = await invokeRoute(
          "POST",
          "/api/v1/composio/webhook",
          raw,
          { "content-type": "application/json" },
        );
        assert.equal(r.status, 200);
        assert.equal(webCalls.length, 1);
        assert.ok(
          warnings.some((w) =>
            w.includes("COMPOSIO_WEBHOOK_SECRET is not set"),
          ),
          "expected WARN about missing COMPOSIO_WEBHOOK_SECRET",
        );
      } finally {
        console.warn = orig;
      }
    });
  });

  describe("web-side failure surface", () => {
    it("502 when the web /webhook/composio/finalize endpoint returns 500", async () => {
      webResponseStatus = 500;
      webResponseBody = { error: { code: "INTERNAL_ERROR", message: "boom" } };
      const raw = buildBody(buildActiveEvent("ca_web_500"));
      const r = await invokeRoute(
        "POST",
        "/api/v1/composio/webhook",
        raw,
        { "content-type": "application/json" },
      );
      assert.equal(r.status, 502);
      assert.equal(r.payload.error.code, "WEB_FLIP_FAILED");
      assert.equal(webCalls.length, 1);
    });
  });
});
