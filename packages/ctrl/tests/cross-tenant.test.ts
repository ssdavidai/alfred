/**
 * Tests for cross-tenant ask polling behavior.
 *
 * Phase 2: the receiving side calls the Hermes `/v1/runs` API natively (the
 * OpenClaw `sessions_spawn`/`sessions_history` `/tools/invoke` contract was
 * retired). These tests stub global `fetch` to simulate the Hermes runtime:
 *   - POST /v1/runs        → returns a stable run id
 *   - GET  /v1/runs/{id}   → returns a configurable {status, output} per call
 *
 * Covered behaviour:
 *   1. Explicit <final>...</final> wrapper wins as soon as it appears.
 *   2. A terminal run status ("completed") returns the run output verbatim.
 *   3. A run still `running` is never returned early — the poll keeps going.
 *   4. Billing/credit failures surfaced in run output are reported fast.
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
    // execFileSync is imported by src/api/routes/system.ts (ssh-keygen
    // path, unused here) — must be listed or the mock loader 500s the
    // whole module import.
    execFileSync: mock.fn(() => ""),
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

interface FetchScenario {
  // Sequential run states returned by successive GET /v1/runs/{id} polls.
  // The last entry repeats forever if the poll runs longer than the list.
  runStates: Array<{ status?: string; output?: string }>;
}

let scenario: FetchScenario = { runStates: [{ status: "running" }] };
let pollCallIndex = 0;

const originalFetch = globalThis.fetch;

function installFetchStub() {
  (globalThis as any).fetch = async (url: string, opts: any) => {
    const method = (opts?.method ?? "GET").toUpperCase();

    // POST /v1/runs — create a run, return a stable id.
    if (method === "POST" && /\/v1\/runs$/.test(url)) {
      return new Response(
        JSON.stringify({ id: "test-run-id", status: "running" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // GET /v1/runs/{id} — return the next scripted run state.
    if (method === "GET" && /\/v1\/runs\/[^/]+$/.test(url)) {
      const idx = Math.min(pollCallIndex, scenario.runStates.length - 1);
      pollCallIndex += 1;
      const slot = scenario.runStates[idx];
      return new Response(
        JSON.stringify({
          id: "test-run-id",
          status: slot.status ?? "running",
          output: slot.output ?? "",
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
  pollCallIndex = 0;
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
      runStates: [
        { status: "running", output: "<final>The top three matters are A, B, C.</final>" },
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

  it("returns the run output verbatim once the run status is 'completed'", async () => {
    scenario = {
      runStates: [
        { status: "running", output: "" },
        { status: "completed", output: "Plain answer without tags." },
      ],
    };

    const r = await req("POST", "/api/v1/cross-tenant/ask", {
      prompt: "question",
      timeoutSeconds: 5,
    });

    assert.equal(r.status, 200);
    assert.equal(r.data.answer, "Plain answer without tags.");
  });

  it("does NOT return a still-running run's interim output as the final answer", async () => {
    // The run is still `running` and has only emitted an interim line. The
    // poll must keep waiting (and ultimately time out in the test) rather
    // than treating interim output as the final answer.
    scenario = {
      runStates: [
        { status: "running", output: "One moment, sir..." },
      ],
    };

    const r = await req("POST", "/api/v1/cross-tenant/ask", {
      prompt: "question",
      timeoutSeconds: 1,
    });

    assert.equal(r.status, 200);
    // Should hit timeout, NOT return "One moment, sir..." as the final answer.
    assert.ok(
      r.data.answer.startsWith("[timeout"),
      `expected timeout marker, got: ${r.data.answer.slice(0, 200)}`,
    );
  });

  it("surfaces a failed run status with the run output as the error detail", async () => {
    scenario = {
      runStates: [
        { status: "failed", output: "model provider returned 500" },
      ],
    };

    const r = await req("POST", "/api/v1/cross-tenant/ask", {
      prompt: "question",
      timeoutSeconds: 5,
    });

    assert.equal(r.status, 200);
    assert.ok(
      r.data.answer.startsWith("[error: Remote run failed"),
      `expected failed-run error, got: ${r.data.answer.slice(0, 200)}`,
    );
  });

  it("surfaces billing errors quickly without waiting for full timeout", async () => {
    scenario = {
      runStates: [
        {
          status: "running",
          output: "Sorry — billing error: insufficient balance on the provider key.",
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
