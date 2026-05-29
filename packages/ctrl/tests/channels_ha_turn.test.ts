// channels_ha — POST /api/v1/channels/ha/turn (#111 PR1).
//
// What's under test
// -----------------
// The Home Assistant conversation-agent inbound handler:
//   * channelTokenBearer auth against channel='ha-conversation';
//   * body shape validation;
//   * Hermes /v1/responses round-trip with session key ha-<haInstallId>;
//   * the HA response envelope ({response.speech.plain.speech, conversation_id});
//   * alfred_journal inbound + outbound rows;
//   * the 30/min sliding rate-limit per haInstallId.
//
// PR3+ will extend with tool partitioning; PR4+ with curated catalog; PR5+
// with the voice-context primer. None of those land in PR1, so they are
// NOT covered here.
//
// Coverage:
//   1. Missing bearer → 401.
//   2. Wrong-channel token → 401 (cross-channel impersonation refused).
//   3. Valid token + valid body → 200 + HA envelope.
//   4. journalIn + journalOut rows written (channel='ha-conversation').
//   5. Hermes session key is `ha-<haInstallId>`.
//   6. Hermes upstream failure → 502.
//   7. Hermes timeout → 504.
//   8. 30 turns inside the window → 30 succeed, the 31st is 403 RATE_LIMITED.
//   9. Body validation: missing text, missing haInstallId, etc.

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
process.env.HERMES_GATEWAY_URL = "http://hermes-stub:18789";

const hermesProfilesDir = path.join(tmp, "hermes-profiles");
fs.mkdirSync(path.join(hermesProfilesDir, "main"), { recursive: true });
fs.writeFileSync(
  path.join(hermesProfilesDir, "main", ".env"),
  "API_SERVER_KEY=test-hermes-key\n",
);
process.env.HERMES_CONFIG_DIR = hermesProfilesDir;

// ── fetch mock ─────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

let hermesOk = true;
let hermesText = "Good morning, Sir.";
let hermesStatus = 200;
let hermesShouldThrow = false;
let hermesShouldTimeout = false;
const hermesCalls: {
  url: string;
  sessionKey: string;
  input: string;
}[] = [];

function makeJsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.endsWith("/v1/responses")) {
    if (hermesShouldThrow) throw new Error("fetch failed: ECONNREFUSED");
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
      return makeJsonResponse({ error: { message: "boom" } }, hermesStatus);
    }
    return makeJsonResponse(
      {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: hermesText }],
          },
        ],
      },
      200,
    );
  }
  throw new Error(`unexpected fetch in channels_ha test: ${url}`);
}) as typeof fetch;

// ── module imports (after env + fetch are set) ─────────────────────────────

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerHaChannelRoutes, _resetHaRateLimitForTests } = await import(
  "../src/api/routes/channels_ha.js"
);
const { getStateDb } = await import("../src/db/state.js");
const { mintChannelToken } = await import("../src/db/channelTokens.js");
registerHaChannelRoutes();

async function invokeTurn(
  body: unknown,
  authToken: string | null,
): Promise<{ status: number; payload: any }> {
  const m = matchRoute("POST", "/api/v1/channels/ha/turn");
  assert.ok(m, "POST /api/v1/channels/ha/turn must be registered");
  let status = 0;
  let payload: any;
  const res = {
    setHeader() {},
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as unknown as ServerResponse;
  const headers: Record<string, string> = {};
  if (authToken !== null) headers.authorization = `Bearer ${authToken}`;
  try {
    await m!.handler({
      req: {
        method: "POST",
        url: "/api/v1/channels/ha/turn",
        headers,
        socket: { remoteAddress: "10.0.0.99" },
      } as any,
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

function validBody(over: Partial<Record<string, unknown>> = {}): any {
  return {
    text: "What's on my brief?",
    conversationId: "01HXXXXCONV1",
    language: "en",
    agentId: "conversation.alfred_conversation",
    haInstallId: "home-install-uuid-1",
    ...over,
  };
}

function mintHaToken(): string {
  return mintChannelToken(getStateDb(), {
    channel: "ha-conversation",
    label: "ha:home-install-uuid-1",
    scope: { haInstanceId: "home-install-uuid-1" },
  }).raw;
}

function clearAll(): void {
  hermesOk = true;
  hermesText = "Good morning, Sir.";
  hermesStatus = 200;
  hermesShouldThrow = false;
  hermesShouldTimeout = false;
  hermesCalls.length = 0;
  _resetHaRateLimitForTests();
  getStateDb().exec("DELETE FROM channel_tokens");
  getStateDb().exec("DELETE FROM alfred_journal");
}

describe("POST /api/v1/channels/ha/turn — #111 PR1", () => {
  beforeEach(() => {
    clearAll();
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects a request without a bearer (401)", async () => {
    const r = await invokeTurn(validBody(), null);
    assert.equal(r.status, 401);
  });

  it("rejects an unknown bearer (401)", async () => {
    const r = await invokeTurn(validBody(), "ha_ffffffffffffffff");
    assert.equal(r.status, 401);
  });

  it("rejects a bearer minted for a different channel (cross-channel)", async () => {
    // Mint for ha-voice and try to use on the ha-conversation route.
    const tok = mintChannelToken(getStateDb(), {
      channel: "ha-voice",
    }).raw;
    const r = await invokeTurn(validBody(), tok);
    assert.equal(r.status, 401);
  });

  it("rejects a revoked token", async () => {
    const tok = mintHaToken();
    // Find the row by hashing and revoking. (Simpler: list + revoke via
    // helper.) We use the helper.
    const { hashToken: hash } = await import("../src/db/channelTokens.js");
    const hashed = hash(tok);
    getStateDb()
      .prepare("UPDATE channel_tokens SET revoked_at = ? WHERE token_hash = ?")
      .run(Date.now(), hashed);
    const r = await invokeTurn(validBody(), tok);
    assert.equal(r.status, 401);
  });

  it("returns HA's envelope on success", async () => {
    const tok = mintHaToken();
    hermesText = "Your brief is ready, Sir.";
    const r = await invokeTurn(validBody(), tok);
    assert.equal(r.status, 200);
    assert.equal(
      r.payload.response.speech.plain.speech,
      "Your brief is ready, Sir.",
    );
    assert.equal(r.payload.conversation_id, "01HXXXXCONV1");
    assert.equal(r.payload.hermesSessionId, "ha-home-install-uuid-1");
    assert.ok(typeof r.payload.timing.hermes_ms === "number");
    assert.ok(typeof r.payload.timing.total_ms === "number");
  });

  it("calls Hermes with X-Hermes-Session-Key=ha-<haInstallId>", async () => {
    const tok = mintHaToken();
    await invokeTurn(validBody(), tok);
    assert.equal(hermesCalls.length, 1);
    assert.equal(hermesCalls[0].sessionKey, "ha-home-install-uuid-1");
    assert.equal(hermesCalls[0].input, "What's on my brief?");
  });

  it("writes inbound + outbound alfred_journal rows", async () => {
    const tok = mintHaToken();
    await invokeTurn(validBody(), tok);
    const rows = getStateDb()
      .prepare(
        "SELECT direction, channel, chat_id, message, source_kind FROM alfred_journal ORDER BY ts ASC",
      )
      .all() as {
      direction: string;
      channel: string;
      chat_id: string;
      message: string;
      source_kind: string;
    }[];
    assert.equal(rows.length, 2, "one inbound + one outbound");
    assert.equal(rows[0].direction, "inbound");
    assert.equal(rows[0].channel, "ha-conversation");
    assert.equal(rows[0].chat_id, "ha-home-install-uuid-1");
    assert.equal(rows[0].source_kind, "ha-conversation-turn");
    assert.equal(rows[1].direction, "outbound");
    assert.equal(rows[1].source_kind, "ha-conversation-reply");
  });

  it("returns 502 when Hermes is unreachable", async () => {
    const tok = mintHaToken();
    hermesShouldThrow = true;
    const r = await invokeTurn(validBody(), tok);
    assert.equal(r.status, 502);
    assert.equal(r.payload.error.code, "HERMES_UNREACHABLE");
  });

  it("returns 504 when Hermes times out", async () => {
    const tok = mintHaToken();
    hermesShouldTimeout = true;
    const r = await invokeTurn(validBody(), tok);
    assert.equal(r.status, 504);
    assert.equal(r.payload.error.code, "HERMES_TIMEOUT");
  });

  it("rate-limit: 30 turns OK, 31st returns 403 RATE_LIMITED", async () => {
    const tok = mintHaToken();
    for (let i = 0; i < 30; i++) {
      const r = await invokeTurn(validBody(), tok);
      assert.equal(r.status, 200, `turn ${i + 1} should be 200`);
    }
    const over = await invokeTurn(validBody(), tok);
    assert.equal(over.status, 403);
    assert.equal(over.payload.error.code, "RATE_LIMITED");
  });

  it("validates body: missing text", async () => {
    const tok = mintHaToken();
    const r = await invokeTurn(validBody({ text: "" }), tok);
    assert.equal(r.status, 400);
  });

  it("validates body: missing haInstallId", async () => {
    const tok = mintHaToken();
    const r = await invokeTurn(validBody({ haInstallId: undefined }), tok);
    assert.equal(r.status, 400);
  });

  it("validates body: missing conversationId", async () => {
    const tok = mintHaToken();
    const r = await invokeTurn(validBody({ conversationId: undefined }), tok);
    assert.equal(r.status, 400);
  });
});
