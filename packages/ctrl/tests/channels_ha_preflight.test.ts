// channels_ha — POST /api/v1/channels/ha/turn preflight short-circuit.
//
// What's under test
// -----------------
// The alfred-ha integration's `_preflight` (custom_components/alfred/
// _validators.py) POSTs with text === "__alfred_ha_preflight__" to verify
// host/token at config_flow time. The /turn handler must short-circuit on
// that magic text so the integration's 5s timeout never fires false
// `cannot_connect` while Hermes warms up its cold context.
//
// Coverage
// --------
//   1. valid token + preflight text → 200 in <100ms
//   2. valid token + preflight text → Hermes is NEVER called
//   3. valid token + regular text → still goes through the full path
//      (Hermes IS called)
//   4. missing/bad token + preflight text → 401 (auth runs first)
//
// The short-circuit MUST be:
//   - AFTER channelTokenBearer (so 401 still fires on bad token)
//   - BEFORE checkRateLimit (preflight isn't counted)
//   - BEFORE journalIn (no journal entry for preflight noise)

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-preflight-"));
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

const hermesCalls: { url: string; sessionKey: string; input: string }[] = [];

function makeJsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.endsWith("/v1/responses")) {
    const headers = init?.headers ?? {};
    const sessionKey = headers["X-Hermes-Session-Key"] ?? "";
    const bodyJson = JSON.parse(String(init?.body ?? "{}"));
    hermesCalls.push({ url, sessionKey, input: bodyJson.input ?? "" });
    return makeJsonResponse(
      {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Good morning, Sir." }],
          },
        ],
      },
      200,
    );
  }
  throw new Error(`unexpected fetch in channels_ha preflight test: ${url}`);
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
): Promise<{ status: number; payload: any; elapsedMs: number }> {
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
  const started = Date.now();
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
  const elapsedMs = Date.now() - started;
  return { status, payload, elapsedMs };
}

function preflightBody(over: Partial<Record<string, unknown>> = {}): any {
  return {
    text: "__alfred_ha_preflight__",
    conversationId: "preflight",
    language: "en",
    agentId: "preflight",
    haInstallId: "preflight",
    ...over,
  };
}

function regularBody(over: Partial<Record<string, unknown>> = {}): any {
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
  hermesCalls.length = 0;
  _resetHaRateLimitForTests();
  getStateDb().exec("DELETE FROM channel_tokens");
  getStateDb().exec("DELETE FROM alfred_journal");
}

describe("POST /api/v1/channels/ha/turn — preflight short-circuit", () => {
  beforeEach(() => {
    clearAll();
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 200 in <100ms for the preflight magic text", async () => {
    const tok = mintHaToken();
    const r = await invokeTurn(preflightBody(), tok);
    assert.equal(r.status, 200);
    assert.ok(
      r.elapsedMs < 100,
      `preflight should complete in <100ms, took ${r.elapsedMs}ms`,
    );
    assert.equal(r.payload.response.speech.plain.speech, "preflight ok");
    assert.equal(r.payload.conversation_id, "preflight");
    assert.equal(r.payload.continue_conversation, false);
  });

  it("does NOT call Hermes for the preflight magic text", async () => {
    const tok = mintHaToken();
    await invokeTurn(preflightBody(), tok);
    assert.equal(
      hermesCalls.length,
      0,
      "Hermes must not be invoked for preflight",
    );
  });

  it("does NOT write to alfred_journal for the preflight magic text", async () => {
    const tok = mintHaToken();
    await invokeTurn(preflightBody(), tok);
    const rows = getStateDb()
      .prepare("SELECT COUNT(*) AS n FROM alfred_journal")
      .get() as { n: number };
    assert.equal(rows.n, 0, "preflight must not produce journal rows");
  });

  it("still goes through the full path for regular (non-preflight) text", async () => {
    const tok = mintHaToken();
    const r = await invokeTurn(regularBody(), tok);
    assert.equal(r.status, 200);
    assert.equal(hermesCalls.length, 1, "Hermes must be invoked for real turns");
    assert.equal(hermesCalls[0].sessionKey, "ha-home-install-uuid-1");
    assert.equal(hermesCalls[0].input, "What's on my brief?");
  });

  it("rejects preflight with missing bearer (401)", async () => {
    const r = await invokeTurn(preflightBody(), null);
    assert.equal(r.status, 401);
    assert.equal(hermesCalls.length, 0);
  });

  it("rejects preflight with unknown bearer (401)", async () => {
    const r = await invokeTurn(preflightBody(), "ha_ffffffffffffffff");
    assert.equal(r.status, 401);
    assert.equal(hermesCalls.length, 0);
  });

  it("rejects preflight with a cross-channel token (401)", async () => {
    const tok = mintChannelToken(getStateDb(), {
      channel: "ha-voice",
    }).raw;
    const r = await invokeTurn(preflightBody(), tok);
    assert.equal(r.status, 401);
    assert.equal(hermesCalls.length, 0);
  });
});
