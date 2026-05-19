/**
 * Tests for POST /api/v1/notifications — native Hermes channel delivery.
 *
 * Issue #45 replaced the silent no-op (a hangover from the retired
 * hermes-shim `message` handler, #40) with real delivery via a Hermes
 * `main`-profile cron job: create a one-shot-ish cron job with
 * `deliver=<channel>:<to>`, trigger it for immediate execution, poll the
 * job for its run outcome, then delete it.
 *
 * These tests stub global `fetch` to simulate the Hermes `main` gateway's
 * cron HTTP API:
 *   - POST   /api/jobs            → returns a stable job id
 *   - POST   /api/jobs/{id}/run   → 200
 *   - GET    /api/jobs/{id}       → scripted job states per successive poll
 *   - DELETE /api/jobs/{id}       → 200
 *
 * Covered behaviour:
 *   1. A job that runs ok with no delivery error → delivered:true (200).
 *   2. A job whose run records last_delivery_error → delivered:false (502).
 *   3. A job whose agent run errors → delivered:false (502).
 *   4. A missing message → 400 validation error.
 *   5. channel=webchat → 424 (no Hermes channel adapter to deliver onto).
 */

import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// fs mock — getGatewayToken() reads a token from disk.
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

// Speed up the delivery poll loop for tests.
process.env.HERMES_NOTIFY_POLL_INTERVAL_MS = "20";
process.env.HERMES_NOTIFY_TIMEOUT_MS = "2000";

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
// fetch stub — simulates the Hermes main-gateway cron HTTP API.
// ---------------------------------------------------------------------------

interface CronScenario {
  // Sequential job states returned by successive GET /api/jobs/{id} polls.
  // The last entry repeats forever if the poll runs longer than the list.
  jobStates: Array<{
    last_status?: string | null;
    last_error?: string | null;
    last_delivery_error?: string | null;
  } | null>;
  createFails?: boolean;
}

let scenario: CronScenario = { jobStates: [{ last_status: null }] };
let pollCallIndex = 0;
let createdJobId = "test-job-id";
const calls: { method: string; url: string; body?: any }[] = [];

const originalFetch = globalThis.fetch;

function installFetchStub() {
  (globalThis as any).fetch = async (url: string, opts: any) => {
    const method = (opts?.method ?? "GET").toUpperCase();
    let body: any;
    try { body = opts?.body ? JSON.parse(opts.body) : undefined; } catch { /* ignore */ }
    calls.push({ method, url, body });

    // POST /api/jobs — create a job.
    if (method === "POST" && /\/api\/jobs$/.test(url)) {
      if (scenario.createFails) {
        return new Response("boom", { status: 500 });
      }
      return new Response(
        JSON.stringify({ job: { id: createdJobId } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // POST /api/jobs/{id}/run — trigger immediate execution.
    if (method === "POST" && /\/api\/jobs\/[^/]+\/run$/.test(url)) {
      return new Response(JSON.stringify({ job: { id: createdJobId } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }

    // DELETE /api/jobs/{id} — cleanup.
    if (method === "DELETE" && /\/api\/jobs\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    // GET /api/jobs/{id} — scripted job state.
    if (method === "GET" && /\/api\/jobs\/[^/]+$/.test(url)) {
      const idx = Math.min(pollCallIndex, scenario.jobStates.length - 1);
      pollCallIndex += 1;
      const slot = scenario.jobStates[idx];
      if (slot === null) {
        return new Response(JSON.stringify({ error: "Job not found" }), { status: 404 });
      }
      return new Response(
        JSON.stringify({ job: { id: createdJobId, ...slot } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("not stubbed: " + url, { status: 404 });
  };
}

function restoreFetch() {
  (globalThis as any).fetch = originalFetch;
}

beforeEach(() => {
  installFetchStub();
  pollCallIndex = 0;
  calls.length = 0;
});

after(() => {
  restoreFetch();
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

describe("POST /api/v1/notifications — native Hermes channel delivery", () => {
  it("delivers via a triggered Hermes cron job and returns delivered:true", async () => {
    scenario = {
      jobStates: [
        { last_status: null },                                  // not run yet
        { last_status: "ok", last_delivery_error: null },        // delivered
      ],
    };

    const r = await req("POST", "/api/v1/notifications", {
      message: "Sir, the overnight categorization run finished.",
      channel: "telegram",
      to: "12345",
      urgency: "normal",
    });

    assert.equal(r.status, 200);
    assert.equal(r.data.delivered, true);
    assert.equal(r.data.status, "delivered");
    assert.equal(r.data.channel, "telegram");
    assert.equal(r.data.to, "12345");

    // The job was created with deliver="telegram:12345" and triggered.
    const create = calls.find((c) => c.method === "POST" && /\/api\/jobs$/.test(c.url));
    assert.ok(create, "should POST /api/jobs");
    assert.equal(create!.body.deliver, "telegram:12345");
    assert.ok(
      String(create!.body.prompt).includes("Sir, the overnight categorization run finished."),
      "prompt should carry the verbatim message",
    );
    assert.ok(
      calls.some((c) => c.method === "POST" && /\/api\/jobs\/[^/]+\/run$/.test(c.url)),
      "should trigger the job for immediate execution",
    );
  });

  it("reports a real delivery failure (502) when last_delivery_error is set", async () => {
    scenario = {
      jobStates: [
        { last_status: null },
        { last_status: "ok", last_delivery_error: "telegram: chat not found" },
      ],
    };

    const r = await req("POST", "/api/v1/notifications", {
      message: "test",
      channel: "telegram",
      to: "99999",
    });

    assert.equal(r.status, 502);
    assert.equal(r.data.delivered, false);
    assert.ok(/telegram: chat not found/.test(r.data.error), "error should surface the delivery failure");
  });

  it("reports a real error (502) when the cron agent run fails", async () => {
    scenario = {
      jobStates: [
        { last_status: "error", last_error: "model timeout" },
      ],
    };

    const r = await req("POST", "/api/v1/notifications", {
      message: "test",
      channel: "slack",
      to: "C0123",
    });

    assert.equal(r.status, 502);
    assert.equal(r.data.delivered, false);
    assert.ok(/model timeout/.test(r.data.error));
  });

  it("rejects a missing message with a 400", async () => {
    const r = await req("POST", "/api/v1/notifications", {
      channel: "telegram",
      to: "12345",
    });
    assert.equal(r.status, 400);
  });

  it("rejects channel=webchat with a 424 — not a Hermes-deliverable platform", async () => {
    const r = await req("POST", "/api/v1/notifications", {
      message: "test",
      channel: "webchat",
      to: "someone",
    });
    assert.equal(r.status, 424);
    assert.equal(r.data.status, "error");
    assert.ok(/webchat/.test(r.data.error));
  });

  it("never returns a silent noop — the #40 no-op shape is gone", async () => {
    scenario = {
      jobStates: [{ last_status: "ok", last_delivery_error: null }],
    };
    const r = await req("POST", "/api/v1/notifications", {
      message: "hello",
      channel: "telegram",
      to: "12345",
    });
    assert.notEqual(r.data.noop, true, "response must not carry noop:true");
    assert.equal(r.data.delivered, true);
  });
});
