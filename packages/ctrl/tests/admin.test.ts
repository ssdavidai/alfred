import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let execFileStdout = "{}";
const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as Function;
  cb(null, execFileStdout, "");
});

mock.module("node:child_process", {
  namedExports: {
    execFile: execFileFn,
    spawn: mock.fn(() => ({
      stderr: { on: mock.fn() },
      stdin: { write: mock.fn(), end: mock.fn() },
      on: mock.fn(),
    })),
  },
});

// Configurable readFileSync
let readFileSyncContent = "";
const readFileSyncFn = mock.fn((_path: string) => readFileSyncContent);
const writeFileSyncFn = mock.fn(() => {});
const readdirSyncFn = mock.fn(() => [] as any[]);

const fsMock = {
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
  readdirSync: readdirSyncFn,
  promises: { mkdir: mock.fn(async () => undefined), writeFile: mock.fn(async () => undefined) },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: readFileSyncFn,
    writeFileSync: writeFileSyncFn,
    readdirSync: readdirSyncFn,
  },
});

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
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  body?: unknown
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
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
            }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => { raw += c.toString(); });
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, data: raw }); }
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/health", () => {
  it("returns JSON health status when healthcheck outputs JSON", async () => {
    execFileStdout = JSON.stringify({ status: "ok", services: ["alfred", "openclaw"] });
    const { status, data } = await req("GET", "/api/v1/admin/health");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.status, "ok");
  });

  it("returns raw string when healthcheck outputs non-JSON", async () => {
    execFileStdout = "OK";
    const { status, data } = await req("GET", "/api/v1/admin/health");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.raw, "OK");
  });
});

describe("GET /api/v1/admin/config/env", () => {
  it("returns 200 with parsed env vars", async () => {
    readFileSyncContent = "SOME_VAR=hello\nOPENROUTER_API_KEY=sk-abc\n";
    const { status, data } = await req("GET", "/api/v1/admin/config/env");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.env.SOME_VAR, "hello");
    assert.strictEqual(data.env.OPENROUTER_API_KEY, "sk-abc");
  });

  it("filters out AAS_API_KEY from the response", async () => {
    readFileSyncContent = "AAS_API_KEY=super-secret\nALLOWED_VAR=yes\n";
    const { status, data } = await req("GET", "/api/v1/admin/config/env");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.env.AAS_API_KEY, undefined, "AAS_API_KEY must not be exposed");
    assert.strictEqual(data.env.ALLOWED_VAR, "yes");
  });
});

describe("PATCH /api/v1/admin/config/env", () => {
  it("returns 400 when AAS_API_KEY is in the payload", async () => {
    const { status, data } = await req("PATCH", "/api/v1/admin/config/env", {
      AAS_API_KEY: "new-secret",
    });
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("AAS_API_KEY"));
  });

  it("returns 400 when body is not an object", async () => {
    const { status } = await req("PATCH", "/api/v1/admin/config/env", "string-body");
    assert.strictEqual(status, 400);
  });

  it("writes updated env and returns 200", async () => {
    readFileSyncContent = "EXISTING_VAR=old\n";
    writeFileSyncFn.mock.resetCalls();
    const { status, data } = await req("PATCH", "/api/v1/admin/config/env", {
      EXISTING_VAR: "new",
      NEW_VAR: "added",
    });
    assert.strictEqual(status, 200);
    assert.ok(data.message.includes("updated") || data.message.includes("Environment"));
    assert.strictEqual(writeFileSyncFn.mock.callCount(), 1, "writeFileSync should be called once");
  });
});

describe("GET /api/v1/admin/containers", () => {
  it("returns container list as JSON array", async () => {
    execFileStdout = '{"Name":"alfred","State":"running"}\n{"Name":"openclaw","State":"running"}\n';
    const { status, data } = await req("GET", "/api/v1/admin/containers");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data), "response should be an array");
    assert.strictEqual(data.length, 2);
    assert.strictEqual(data[0].Name, "alfred");
  });
});

describe("POST /api/v1/admin/containers/:service/restart", () => {
  it("restarts a named service and returns 200", async () => {
    execFileStdout = "";
    const { status, data } = await req("POST", "/api/v1/admin/containers/alfred/restart");
    assert.strictEqual(status, 200);
    assert.ok(data.message.includes("alfred"));
  });

  it("returns 400 for an invalid service name", async () => {
    const { status } = await req("POST", "/api/v1/admin/containers/../../../etc/restart");
    // Either 400 (validation) or 404 (no matching route for path with slash)
    assert.ok(status === 400 || status === 404, `expected 400 or 404, got ${status}`);
  });
});

describe("GET /api/v1/admin/debug/headers", () => {
  it("echoes request headers back", async () => {
    const { status, data } = await req("GET", "/api/v1/admin/debug/headers");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.method, "GET");
    assert.ok(typeof data.headers === "object", "headers should be an object");
    assert.ok(typeof data.httpVersion === "string");
  });
});
