// Tests for POST /api/v1/hermes/codex-auth/start
//                GET  /api/v1/hermes/codex-auth/status
//
// Coverage:
//   1. Auth gate rejects unauthenticated callers (both routes).
//   2. POST /start spawns `hermes auth add openai-codex --type oauth`.
//   3. GET /status exposes user_code once the CLI emits it.
//   4. Failed ceremony (CLI exits non-zero) → status=failed + error field;
//      ctrl-api writes nothing to the credential store (hermes CLI is the
//      sole writer, verified to use atomic_replace under an O_EXCL lock).
//   5. POST /start after failure → fresh spawn (reuse window bypassed);
//      CLI exits 0 → status=complete; no token value in response.
//
// Timeout case omitted — adding it would push total to ~363 LOC (13 over
// the 350 cap); the killTimer + early-return guard are on the next slot.

import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Spawn mock — captures stdout/close callbacks so tests can drive the CLI.
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

// fs mock — writeFileSync call count verifies ctrl-api never touches auth.json.
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

const { createApiServer } = await import("../src/api/server.js");
const { setApiKey } = await import("../src/api/auth.js");
const { _setTerminalReuseMs } = await import("../src/api/routes/hermes_codex_auth.js");
setApiKey("tk-test-codex-auth");

let server: http.Server;
before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

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

// Tests are sequential — session state accumulates across the describe block.

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
    assert.ok(spawnArgs.includes("oauth"), "spawn uses --type oauth");
    const body = JSON.stringify(r.data);
    assert.ok(!body.includes("access_token"), "no access_token in initial response");
    assert.ok(!body.includes("refresh_token"), "no refresh_token in initial response");
  });

  it("GET /status is distinct from complete while awaiting approval", async () => {
    const r = await req("GET", "/api/v1/hermes/codex-auth/status");
    assert.equal(r.data.status, "awaiting_approval");
    assert.notEqual(r.data.status, "complete");
  });

  it("GET /status exposes user_code once the CLI emits it", async () => {
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

  it("failed ceremony reports status=failed with error; ctrl-api writes nothing to credential store", async () => {
    const writesBefore = fsMock.writeFileSync.mock.callCount();
    onClose(1); // drive ceremony to non-zero exit
    const r = await req("GET", "/api/v1/hermes/codex-auth/status");
    assert.equal(r.data.status, "failed");
    assert.ok(typeof r.data.error === "string" && r.data.error.length > 0,
      "error field is a non-empty string");
    assert.ok((r.data.error as string).includes("1"), "error references the exit code");
    assert.equal(fsMock.writeFileSync.mock.callCount(), writesBefore,
      "ctrl-api must not call writeFileSync during or after a failed ceremony");
  });

  it("status transitions to complete after reuse-window bypass + CLI exits 0; no token in response", async () => {
    // Collapse the reuse window so POST /start spawns fresh rather than
    // returning the cached 'failed' terminal state.
    _setTerminalReuseMs(0);
    spawnFn.mock.resetCalls();
    const r1 = await req("POST", "/api/v1/hermes/codex-auth/start");
    assert.equal(r1.status, 202, "new ceremony spawned after window bypass");
    assert.equal(r1.data.status, "awaiting_approval");
    assert.equal(spawnFn.mock.callCount(), 1, "exactly one new spawn");
    onClose(0); // drive to success
    const r2 = await req("GET", "/api/v1/hermes/codex-auth/status");
    assert.equal(r2.data.status, "complete");
    const body = JSON.stringify(r2.data);
    assert.ok(!body.includes("access_token"), "no access_token on complete");
    assert.ok(!body.includes("refresh_token"), "no refresh_token on complete");
  });
});
