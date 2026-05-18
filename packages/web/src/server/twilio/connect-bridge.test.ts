/**
 * Regression tests for the outbound TwiML connect-bridge handler.
 *
 * The handler MUST emit a `<Stream url="wss://voice.alfred.black/...">` URL
 * regardless of what `Host` / `X-Forwarded-Host` headers Twilio sends, because
 * `alfred.black` is Cloudflare orange-cloud and its WAF drops Twilio Media
 * Stream WebSocket upgrades with error 31920 ("An application error has
 * occurred"). The DNS-only `voice.alfred.black` subdomain bypasses the WAF.
 *
 * Real-world failure: Twilio CallSid CA0757796433449f44405dba27fbea44a8 — a
 * realtime outbound call that rang, picked up, then immediately disconnected
 * with the Twilio system error voice.
 *
 * Run with:
 *
 *   cd packages/saas/app
 *   npx tsx --test src/server/twilio/connect-bridge.test.ts
 *
 * or via the Makefile helper `make test-saas-unit`.
 *
 * NOTE: we don't import the route handler from `internal.ts` because that
 * module transitively imports `wasp/server` (Prisma client) which isn't
 * available in this minimal `tsx --test` environment. Instead we import the
 * shared host-resolution helper and re-implement the URL-assembly logic the
 * handler uses, then pin both behaviours: the helper default and the
 * resulting TwiML body. If the handler in `internal.ts` ever stops calling
 * `getVoiceBridgeWsHost()`, the assertion below will go stale — that's the
 * intent. Treat any test failure here as a hard signal that the outbound
 * voice path is back to emitting the orange-cloud hostname.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getVoiceBridgeWsHost } from "./voice-bridge-host";

test("getVoiceBridgeWsHost: defaults to voice.alfred.black", () => {
  const prev = process.env.VOICE_BRIDGE_WS_HOST;
  delete process.env.VOICE_BRIDGE_WS_HOST;
  try {
    assert.equal(getVoiceBridgeWsHost(), "voice.alfred.black");
  } finally {
    if (prev !== undefined) process.env.VOICE_BRIDGE_WS_HOST = prev;
  }
});

test("getVoiceBridgeWsHost: env override wins", () => {
  const prev = process.env.VOICE_BRIDGE_WS_HOST;
  process.env.VOICE_BRIDGE_WS_HOST = "voice-staging.alfred.black";
  try {
    assert.equal(getVoiceBridgeWsHost(), "voice-staging.alfred.black");
  } finally {
    if (prev === undefined) delete process.env.VOICE_BRIDGE_WS_HOST;
    else process.env.VOICE_BRIDGE_WS_HOST = prev;
  }
});

test("getVoiceBridgeWsHost: empty string falls back to default", () => {
  const prev = process.env.VOICE_BRIDGE_WS_HOST;
  process.env.VOICE_BRIDGE_WS_HOST = "";
  try {
    assert.equal(getVoiceBridgeWsHost(), "voice.alfred.black");
  } finally {
    if (prev === undefined) delete process.env.VOICE_BRIDGE_WS_HOST;
    else process.env.VOICE_BRIDGE_WS_HOST = prev;
  }
});

// Functional regression test: simulate exactly what `connect-bridge` does
// (assemble the WS URL using the helper + sign with the internal token) and
// assert the resulting URL targets voice.alfred.black, NOT alfred.black.
test("connect-bridge URL assembly: targets voice.alfred.black even when Host=alfred.black", () => {
  const prevToken = process.env.VOICE_BRIDGE_INTERNAL_TOKEN;
  const prevHost = process.env.VOICE_BRIDGE_WS_HOST;
  process.env.VOICE_BRIDGE_INTERNAL_TOKEN = "test-token-do-not-use-in-prod";
  delete process.env.VOICE_BRIDGE_WS_HOST;

  try {
    const tenantId = "david";
    const initiator = "alfred";
    const intent = "hello";

    const sig = crypto
      .createHmac("sha256", process.env.VOICE_BRIDGE_INTERNAL_TOKEN!)
      .update(tenantId)
      .digest("hex");
    const wsHost = getVoiceBridgeWsHost();
    const wsUrl = `wss://${wsHost}/voice/${tenantId}?sig=${sig}&initiator=${encodeURIComponent(
      initiator,
    )}&intent=${encodeURIComponent(intent)}`;

    assert.ok(
      wsUrl.startsWith("wss://voice.alfred.black/voice/david"),
      `Expected URL to start with wss://voice.alfred.black/voice/david — got: ${wsUrl}`,
    );
    assert.ok(
      !wsUrl.startsWith("wss://alfred.black/voice/"),
      `Regression: URL targets the orange-cloud alfred.black host. Cloudflare ` +
        `will drop Twilio's WS upgrade with error 31920. URL: ${wsUrl}`,
    );
  } finally {
    if (prevToken === undefined) delete process.env.VOICE_BRIDGE_INTERNAL_TOKEN;
    else process.env.VOICE_BRIDGE_INTERNAL_TOKEN = prevToken;
    if (prevHost === undefined) delete process.env.VOICE_BRIDGE_WS_HOST;
    else process.env.VOICE_BRIDGE_WS_HOST = prevHost;
  }
});

// Source-level guard: confirm the `internal.ts` route handler still calls
// `getVoiceBridgeWsHost()` and does NOT re-introduce the old
// `req.headers["x-forwarded-host"] || req.headers.host` pattern. This guards
// against a future refactor silently undoing the fix.
test("internal.ts connect-bridge: uses getVoiceBridgeWsHost(), not req headers", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const internalSource = readFileSync(path.join(here, "internal.ts"), "utf8");

  // Locate the connect-bridge route registration (NOT the earlier reference
  // to the path inside the initiate-call handler that builds the TwiML URL).
  const handlerStart = internalSource.indexOf(
    'app.get("/api/twiml/connect-bridge"',
  );
  assert.notEqual(
    handlerStart,
    -1,
    "Could not find app.get(\"/api/twiml/connect-bridge\") in internal.ts — has the route moved?",
  );
  // Slice to the next route registration (next `app.` after the handler).
  const tail = internalSource.slice(handlerStart);
  const nextRouteIdx = tail.indexOf("\n  app.", 1);
  const block = nextRouteIdx === -1 ? tail : tail.slice(0, nextRouteIdx);

  assert.ok(
    block.includes("getVoiceBridgeWsHost"),
    "connect-bridge handler must call getVoiceBridgeWsHost() — see " +
      "voice-bridge-host.ts for why this matters (Cloudflare WAF + Twilio 31920).",
  );
  assert.ok(
    !block.includes('req.headers["x-forwarded-host"]'),
    "connect-bridge handler must NOT derive the WS host from request headers " +
      "— Twilio fetches the TwiML through the Cloudflare-proxied alfred.black " +
      "host, but Media Stream WS upgrades on that host fail with error 31920.",
  );
  assert.ok(
    !block.includes("req.headers.host"),
    "connect-bridge handler must NOT derive the WS host from request headers " +
      "— see comment above.",
  );
});
