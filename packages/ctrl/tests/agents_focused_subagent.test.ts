// POST /api/v1/agents/focused-subagent — the backing for the
// delegate_to_focused_agent MCP tool (Phase B).
//
// What's under test:
//   * Validation: task + domain required, both non-empty.
//   * Workers .env discovery: writes a fake .env into a temp HERMES_CONFIG_DIR
//     before importing the route module, then asserts the route reads
//     API_SERVER_KEY from there and pipes it through to fetch.
//   * Session-key shape: `focus-<sanitised-domain>-<8-hex-chars>`.
//   * Skill directive lands in the system message: `LOAD skill
//     alfred-<domain>-skill.md OR alfred-composio-<domain>-skill.md`.
//   * Hermes :18790/v1/responses is the actual target URL.
//   * Plain-text reply extraction from the Hermes-style envelope.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-focused-"));
const hermesConfigDir = path.join(tmp, "hermes-state", "profiles");
fs.mkdirSync(path.join(hermesConfigDir, "workers"), { recursive: true });
fs.writeFileSync(
  path.join(hermesConfigDir, "workers", ".env"),
  "API_SERVER_KEY=test-workers-key-43chars-xxxxxxxxxxxxxxx\nOTHER=ignored\n",
);

process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
process.env.HERMES_HOME = path.join(tmp, "hermes-state");
process.env.HERMES_CONFIG_DIR = hermesConfigDir;
process.env.HERMES_WORKERS_GATEWAY_URL = "http://hermes-test:18790";

const realFetch = globalThis.fetch;
let lastFetchCall: { url: string; init: any } | null = null;
let nextFetchResponse: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify({
    output: [
      {
        content: [{ text: "The subagent ran the task and replied verbatim." }],
      },
    ],
  }),
};

globalThis.fetch = (async (url: any, init?: any) => {
  lastFetchCall = { url: String(url), init };
  return new Response(nextFetchResponse.body, {
    status: nextFetchResponse.status,
    headers: { "content-type": "application/json" },
  });
}) as typeof globalThis.fetch;

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const {
  registerAgentRoutes,
  _resetHermesRestartDebounceForTests,
} = await import("../src/api/routes/agents.js");
const { getStateDb } = await import("../src/db/state.js");

registerAgentRoutes();
getStateDb(); // run migrations

after(() => {
  _resetHermesRestartDebounceForTests();
  globalThis.fetch = realFetch;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface InvokeOpts { body?: unknown; }

async function invokeRoute(
  method: string,
  p: string,
  opts: InvokeOpts = {},
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    setHeader() {},
    writeHead(c: number) { status = c; return res; },
    end(j?: string) { payload = j ? JSON.parse(j) : undefined; },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { method, url: p, headers: {}, socket: { remoteAddress: "10.0.0.42" } } as any,
      res,
      params: m!.params,
      body: opts.body,
      query: new URLSearchParams(""),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

describe("POST /api/v1/agents/focused-subagent — validation", () => {
  it("rejects missing task", async () => {
    const r = await invokeRoute("POST", "/api/v1/agents/focused-subagent", {
      body: { domain: "sure" },
    });
    assert.equal(r.status, 400);
    assert.ok(String(r.payload.error?.message ?? "").includes("task"));
  });

  it("rejects empty task", async () => {
    const r = await invokeRoute("POST", "/api/v1/agents/focused-subagent", {
      body: { task: "   ", domain: "sure" },
    });
    assert.equal(r.status, 400);
  });

  it("rejects missing domain", async () => {
    const r = await invokeRoute("POST", "/api/v1/agents/focused-subagent", {
      body: { task: "List my checking balance" },
    });
    assert.equal(r.status, 400);
    assert.ok(String(r.payload.error?.message ?? "").includes("domain"));
  });
});

describe("POST /api/v1/agents/focused-subagent — happy path", () => {
  it("posts to Hermes workers :18790 with bearer + session-key header", async () => {
    lastFetchCall = null;
    const r = await invokeRoute("POST", "/api/v1/agents/focused-subagent", {
      body: { task: "What's my checking balance?", domain: "sure" },
    });
    assert.equal(r.status, 200);
    assert.ok(lastFetchCall, "fetch must have been called");
    assert.equal(
      lastFetchCall!.url,
      "http://hermes-test:18790/v1/responses",
      "URL must be workers /v1/responses",
    );
    const headers = lastFetchCall!.init.headers as Record<string, string>;
    assert.equal(
      headers["Authorization"],
      "Bearer test-workers-key-43chars-xxxxxxxxxxxxxxx",
      "Bearer must be the workers .env API_SERVER_KEY",
    );
    assert.ok(
      typeof headers["X-Hermes-Session-Key"] === "string",
      "X-Hermes-Session-Key header must be present",
    );
  });

  it("session key has shape `focus-<domain-slug>-<8-hex>`", async () => {
    lastFetchCall = null;
    await invokeRoute("POST", "/api/v1/agents/focused-subagent", {
      body: { task: "List events tomorrow", domain: "googlecalendar" },
    });
    const headers = lastFetchCall!.init.headers as Record<string, string>;
    const key = headers["X-Hermes-Session-Key"];
    // 8 hex chars (crypto.randomBytes(4).toString('hex')) at the tail; the
    // middle slug is the sanitised domain.
    assert.match(key, /^focus-googlecalendar-[a-f0-9]{8}$/);
  });

  it("sanitises hostile domain characters in the session key", async () => {
    lastFetchCall = null;
    await invokeRoute("POST", "/api/v1/agents/focused-subagent", {
      body: { task: "task", domain: "../etc/passwd" },
    });
    const headers = lastFetchCall!.init.headers as Record<string, string>;
    const key = headers["X-Hermes-Session-Key"];
    // Slashes + dots collapsed to underscores; no path traversal in the key.
    assert.doesNotMatch(key, /[./]/);
    assert.match(key, /^focus-_+etc_passwd-[a-f0-9]{8}$/);
  });

  it("body carries the LOAD skill directive for the domain", async () => {
    lastFetchCall = null;
    await invokeRoute("POST", "/api/v1/agents/focused-subagent", {
      body: { task: "any task", domain: "paperclip" },
    });
    const body = JSON.parse(lastFetchCall!.init.body);
    const sys = body.input.find((m: any) => m.role === "system");
    assert.ok(
      String(sys.content).includes(
        "LOAD skill alfred-paperclip-skill.md OR alfred-composio-paperclip-skill.md",
      ),
      "skill directive must mention both per-MCP-server and composio toolkit skill paths",
    );
  });

  it("user content includes task + context when context supplied", async () => {
    lastFetchCall = null;
    await invokeRoute("POST", "/api/v1/agents/focused-subagent", {
      body: {
        task: "Pull tomorrow's events",
        domain: "googlecalendar",
        context: "Sir's primary calendar id is abc-123.",
      },
    });
    const body = JSON.parse(lastFetchCall!.init.body);
    const usr = body.input.find((m: any) => m.role === "user");
    assert.ok(usr.content.includes("Pull tomorrow's events"));
    assert.ok(usr.content.includes("Sir's primary calendar id is abc-123."));
  });

  it("extracts plain-text reply from Hermes envelope", async () => {
    nextFetchResponse = {
      status: 200,
      body: JSON.stringify({
        output: [{ content: [{ text: "Your balance is $4,231." }] }],
      }),
    };
    const r = await invokeRoute("POST", "/api/v1/agents/focused-subagent", {
      body: { task: "balance?", domain: "sure" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.reply, "Your balance is $4,231.");
    assert.equal(r.payload.domain, "sure");
    assert.match(r.payload.session_key, /^focus-sure-[a-f0-9]{8}$/);
  });

  it("surfaces 502 when the workers gateway returns non-2xx", async () => {
    nextFetchResponse = { status: 500, body: "internal explosion" };
    const r = await invokeRoute("POST", "/api/v1/agents/focused-subagent", {
      body: { task: "task", domain: "sure" },
    });
    assert.equal(r.status, 500);
    assert.equal(r.payload.ok, false);
    assert.equal(r.payload.error, "HERMES_WORKERS_ERROR");
    // Reset for the next test (mutable shared state).
    nextFetchResponse = {
      status: 200,
      body: JSON.stringify({ output: [{ content: [{ text: "ok" }] }] }),
    };
  });
});
