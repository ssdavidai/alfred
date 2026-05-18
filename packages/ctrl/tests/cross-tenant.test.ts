/**
 * Tests for cross-tenant ask polling behavior.
 *
 * Covers the two recent fixes (#129):
 *   1. Tagless fallback — accept the last assistant text as the final answer
 *      after TURNS_BEFORE_TAGLESS_FALLBACK substantive turns, even if the
 *      peer's Alfred forgot to wrap in <final>...</final> tags.
 *   2. Explicit <final>...</final> wrapper still wins when present.
 *   3. Session-status "completed" / "done" still wins.
 *
 * These tests stub global `fetch` to simulate the openclaw gateway:
 *   - sessions_spawn → returns a stable childSessionKey
 *   - sessions_history → returns a configurable message list per call
 */

import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// fs mock — getGatewayToken() needs to resolve a token from disk
// ---------------------------------------------------------------------------

const fsReadFileSync = mock.fn(() => "fake-gateway-token");
const fsMock = {
  readFileSync: fsReadFileSync,
  writeFileSync: mock.fn(() => {}),
  readdirSync: mock.fn(() => [] as any[]),
  mkdirSync: mock.fn(),
  existsSync: mock.fn(() => true),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => true })),
  unlinkSync: mock.fn(),
  renameSync: mock.fn(),
  appendFileSync: mock.fn(),
  openSync: mock.fn(() => 0),
  readSync: mock.fn(() => 0),
  closeSync: mock.fn(),
  createReadStream: mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() })),
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mock.fn(async () => undefined), writeFile: mock.fn(async () => undefined) },
};
mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: fsMock.readFileSync,
    writeFileSync: fsMock.writeFileSync,
    readdirSync: fsMock.readdirSync,
    mkdirSync: fsMock.mkdirSync,
    existsSync: fsMock.existsSync,
    statSync: fsMock.statSync,
    unlinkSync: fsMock.unlinkSync,
    renameSync: fsMock.renameSync,
    appendFileSync: fsMock.appendFileSync,
    openSync: fsMock.openSync,
    readSync: fsMock.readSync,
    closeSync: fsMock.closeSync,
    createReadStream: fsMock.createReadStream,
    Dirent: fsMock.Dirent,
  },
});

// child_process mock (some other route registration uses it indirectly)
mock.module("node:child_process", {
  namedExports: {
    execFile: mock.fn((..._args: any[]) => {
      const cb = _args[_args.length - 1];
      if (typeof cb === "function") cb(null, "{}", "");
    }),
    spawn: mock.fn(() => ({
      stderr: { on: mock.fn() },
      stdin: { write: mock.fn(), end: mock.fn() },
      on: mock.fn(),
    })),
  },
});

// ---------------------------------------------------------------------------
// Speed up the poll loop for tests
// ---------------------------------------------------------------------------

process.env.CROSS_TENANT_POLL_INTERVAL_MS = "50";

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// fetch stub — controls gateway responses per-call
// ---------------------------------------------------------------------------

interface FakeMsg {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

interface FetchScenario {
  // Sequential message lists returned by successive sessions_history polls.
  // The last entry repeats forever if poll runs longer than the list.
  historyResponses: Array<{ messages: FakeMsg[]; status?: string }>;
}

let scenario: FetchScenario = { historyResponses: [{ messages: [] }] };
let historyCallIndex = 0;

const originalFetch = globalThis.fetch;

function installFetchStub() {
  (globalThis as any).fetch = async (url: string, opts: any) => {
    const bodyStr = typeof opts?.body === "string" ? opts.body : "";
    let parsed: any = {};
    try { parsed = JSON.parse(bodyStr); } catch { /* ignore */ }
    const tool = parsed?.tool;

    if (tool === "sessions_spawn") {
      return new Response(
        JSON.stringify({
          result: { details: { childSessionKey: "test-session-key" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (tool === "sessions_history") {
      const idx = Math.min(historyCallIndex, scenario.historyResponses.length - 1);
      historyCallIndex += 1;
      const slot = scenario.historyResponses[idx];
      return new Response(
        JSON.stringify({
          result: {
            details: {
              messages: slot.messages,
              status: slot.status || "running",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Anything else: 404 to surface accidental traffic
    return new Response("not stubbed: " + url, { status: 404 });
  };
}

function restoreFetch() {
  (globalThis as any).fetch = originalFetch;
}

beforeEach(() => {
  installFetchStub();
  historyCallIndex = 0;
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload)),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let data: any = text;
          try { data = JSON.parse(text); } catch { /* keep as text */ }
          resolve({ status: response.statusCode || 0, data });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/cross-tenant/ask — completion detection", () => {
  it("accepts an explicit <final>...</final> wrapper", async () => {
    scenario = {
      historyResponses: [
        {
          messages: [
            { role: "assistant", content: "<final>The top three matters are A, B, C.</final>" },
          ],
        },
      ],
    };

    const r = await req("POST", "/api/v1/cross-tenant/ask", {
      prompt: "name 3 matters",
      timeoutSeconds: 5,
    });

    assert.equal(r.status, 200);
    assert.equal(r.data.answer, "The top three matters are A, B, C.");
    assert.ok(!r.data.answer.startsWith("[timeout"), "should not be a timeout response");
  });

  it("accepts session-status 'completed' even without <final> tag", async () => {
    scenario = {
      historyResponses: [
        {
          status: "completed",
          messages: [
            { role: "assistant", content: "Plain answer without tags." },
          ],
        },
      ],
    };

    const r = await req("POST", "/api/v1/cross-tenant/ask", {
      prompt: "question",
      timeoutSeconds: 5,
    });

    assert.equal(r.status, 200);
    assert.equal(r.data.answer, "Plain answer without tags.");
  });

  it("falls back to last assistant text after TURNS_BEFORE_TAGLESS_FALLBACK turns (no <final> tag)", async () => {
    // Simulate the realistic shape: 3 short text turns (e.g. "Reading USER.md...",
    // "Reading SOUL.md...", "Reading MEMORY.md...") then a 4th substantive turn
    // with the actual answer — but the agent forgot to wrap in <final> tags.
    scenario = {
      historyResponses: [
        // Poll 1: just the 3 read-acknowledgement turns
        {
          messages: [
            { role: "assistant", content: "Reading USER.md..." },
            { role: "assistant", content: "Reading SOUL.md..." },
            { role: "assistant", content: "Reading MEMORY.md..." },
          ],
        },
        // Poll 2: 4th turn — the real answer, no <final> wrapper
        {
          messages: [
            { role: "assistant", content: "Reading USER.md..." },
            { role: "assistant", content: "Reading SOUL.md..." },
            { role: "assistant", content: "Reading MEMORY.md..." },
            {
              role: "assistant",
              content:
                "Your top three current matters are the strategic pivot of Apex Solutions into an AI agency, the Q3 product launch, and the new hire onboarding plan.",
            },
          ],
        },
      ],
    };

    const r = await req("POST", "/api/v1/cross-tenant/ask", {
      prompt: "name 3 matters",
      timeoutSeconds: 10,
    });

    assert.equal(r.status, 200);
    assert.ok(
      r.data.answer.startsWith("Your top three current matters"),
      `expected real answer, got: ${r.data.answer.slice(0, 200)}`,
    );
    assert.ok(
      !r.data.answer.startsWith("[timeout"),
      "tagless answer must NOT be reported as timeout",
    );
  });

  it("does NOT prematurely accept a single early text turn as the final answer", async () => {
    // Only one short text turn so far — well under the threshold. The poll
    // should keep waiting (and ultimately time out in the test, but that's
    // fine — what we care about is that we don't return after just 1 turn).
    scenario = {
      historyResponses: [
        {
          messages: [
            { role: "assistant", content: "One moment, sir..." },
          ],
        },
      ],
    };

    const r = await req("POST", "/api/v1/cross-tenant/ask", {
      prompt: "question",
      timeoutSeconds: 1,
    });

    assert.equal(r.status, 200);
    // Should hit timeout, NOT return "One moment, sir..." as the final answer
    assert.ok(
      r.data.answer.startsWith("[timeout"),
      `expected timeout marker, got: ${r.data.answer.slice(0, 200)}`,
    );
  });

  it("surfaces billing errors quickly without waiting for full timeout", async () => {
    scenario = {
      historyResponses: [
        {
          messages: [
            {
              role: "assistant",
              content: "Sorry — billing error: insufficient balance on the provider key.",
            },
          ],
        },
      ],
    };

    const r = await req("POST", "/api/v1/cross-tenant/ask", {
      prompt: "anything",
      timeoutSeconds: 5,
    });

    assert.equal(r.status, 200);
    assert.ok(
      r.data.answer.includes("billing error"),
      `expected billing-error answer, got: ${r.data.answer.slice(0, 200)}`,
    );
  });
});

after(() => {
  restoreFetch();
});
