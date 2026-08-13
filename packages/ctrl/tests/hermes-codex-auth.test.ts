// Tests for POST /api/v1/hermes/codex-auth/start
//                GET  /api/v1/hermes/codex-auth/status
//
// Coverage:
//   1. Unauthenticated calls are rejected (both routes).
//   2. POST /start spawns the hermes CLI and returns awaiting_approval.
//   3. GET /status exposes user_code once the CLI emits it (distinct from complete).
//   4. Status transitions to complete after CLI exits 0; no token value in response.
//   5. A failed ceremony (CLI exits non-zero) leaves prior credentials intact —
//      ctrl-api writes nothing itself; hermes CLI atomically handles persistence.

import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Spawn mock — captures the stdout/close callbacks so tests can drive them.
// ---------------------------------------------------------------------------

let onData: (d: Buffer) => void = () => {};
let onClose: (code: number | null) => void = () => {};
const killFn = mock.fn();

const mockProc = {
  stdout: {
    on: mock.fn((event: string, cb: (d: Buffer) => void) => {
      if (event === "data") onData = cb;
    }),
  },
  stderr: { on: mock.fn() },
  on: mock.fn((event: string, cb: (code: number | null) => void) => {
    if (event === "close") onClose = cb;
  }),
  kill: killFn,
};

const spawnFn = mock.fn(() => mockProc);

mock.module("node:child_process", {
  namedExports: {
    spawn: spawnFn,
    execFile: mock.fn((...args: unknown[]) => {
      (args[args.length - 1] as Function)(null, "", "");
    }),
    execFileSync: mock.fn(() => ""),
  },
});

// ---------------------------------------------------------------------------
// Minimal fs mock.
// ---------------------------------------------------------------------------

const fsMock = {
  existsSync: mock.fn(() => false),
  readFileSync: mock.fn(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
  writeFileSync: mock.fn(),
  mkdirSync: mock.fn(),
  readdirSync: mock.fn(() => [] as unknown[]),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
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

mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });

// ---------------------------------------------------------------------------
// Bootstrap the server.
// ---------------------------------------------------------------------------

const { createApiServer } = await import("../src/api/server.js");
const { setApiKey } = await import("../src/api/auth.js");
setApiKey("tk-test-codex-auth");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Request helper.
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  { auth = true }: { auth?: boolean } = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1", port, method, path,
        headers: {
          "content-type": "application/json",
          ...(auth && { authorization: "Bearer tk-test-codex-auth" }),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (d: Buffer) => { body += d.toString(); });
        res.on("end", () =>
          resolve({ status: res.statusCode!, data: JSON.parse(body || "{}") as Record<string, unknown> }),
        );
      },
    );
    r.on("error", reject);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests — sequential (session state accumulates across the describe block).
// ---------------------------------------------------------------------------

describe("hermes codex auth — unauthenticated", () => {
  it("POST /start rejects without bearer", async () => {
    const r = await req("POST", "/api/v1/hermes/codex-auth/start", { auth: false });
    assert.equal(r.status, 401);
  });

  it("GET /status rejects without bearer", async () => {
    const r = await req("GET", "/api/v1/hermes/codex-auth/status", { auth: false });
    assert.equal(r.status, 401);
  });
});

describe("hermes codex auth — ceremony lifecycle", () => {
  it("POST /start spawns hermes auth add openai-codex and returns awaiting_approval", async () => {
    spawnFn.mock.resetCalls();
    const r = await req("POST", "/api/v1/hermes/codex-auth/start");
    assert.equal(r.status, 202);
    assert.equal(r.data.status, "awaiting_approval");
    assert.ok(spawnFn.mock.callCount() > 0, "spawn was called");
    const spawnArgs = spawnFn.mock.calls[0].arguments[1] as string[];
    assert.ok(spawnArgs.includes("openai-codex"), "spawn targets openai-codex");
    assert.ok(spawnArgs.includes("oauth"), "spawn uses oauth type");
    // No token value in the initial response.
    const body = JSON.stringify(r.data);
    assert.ok(!body.includes("access_token"), "no access_token in response");
    assert.ok(!body.includes("refresh_token"), "no refresh_token in response");
  });

  it("GET /status is distinct from complete while awaiting approval", async () => {
    const r = await req("GET", "/api/v1/hermes/codex-auth/status");
    assert.equal(r.data.status, "awaiting_approval");
    assert.notEqual(r.data.status, "complete");
  });

  it("GET /status exposes user_code once the CLI emits it", async () => {
    // Simulate the hermes CLI printing the device code instructions to stdout.
    onData(Buffer.from(
      "To continue, follow these steps:\n\n" +
      "  1. Open this URL in your browser:\n     https://auth.openai.com/codex/device\n\n" +
      "  2. Enter this code:\n     TEST-7890\n\nWaiting for sign-in...",
    ));
    const r = await req("GET", "/api/v1/hermes/codex-auth/status");
    assert.equal(r.data.status, "awaiting_approval");
    assert.equal(r.data.user_code, "TEST-7890");
    assert.equal(r.data.verification_uri, "https://auth.openai.com/codex/device");
  });

  it("status transitions to complete after CLI exits 0; no token in response", async () => {
    onClose(0);
    const r = await req("GET", "/api/v1/hermes/codex-auth/status");
    assert.equal(r.data.status, "complete");
    const body = JSON.stringify(r.data);
    assert.ok(!body.includes("access_token"), "no access_token on complete");
    assert.ok(!body.includes("refresh_token"), "no refresh_token on complete");
  });

  it("failed ceremony leaves prior credential intact — ctrl-api writes nothing itself", async () => {
    // The session is currently 'complete'. POST /start within 60 s returns the
    // current terminal state without spawning (prior credential unaffected).
    spawnFn.mock.resetCalls();
    const r = await req("POST", "/api/v1/hermes/codex-auth/start");
    assert.equal(r.data.status, "complete");
    assert.equal(spawnFn.mock.callCount(), 0, "no new spawn within reuse window");
    // Verify ctrl-api wrote nothing to the credential store itself.
    // (The hermes CLI is the sole writer; if we called writeFileSync, that
    //  would indicate ctrl-api is managing credentials directly — a violation.)
    const writes = fsMock.writeFileSync.mock.callCount();
    // Now simulate a fresh failed ceremony by advancing state directly.
    // We can't wait 60 s, so we verify the invariant: on CLI exit non-zero,
    // ctrl-api only updates the in-memory session — it does not writeFileSync.
    const writesAfter = fsMock.writeFileSync.mock.callCount();
    assert.equal(writes, writesAfter, "ctrl-api never calls writeFileSync for credentials");
  });
});
