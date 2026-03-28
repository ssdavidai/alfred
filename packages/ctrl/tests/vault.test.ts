import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks — must be registered before any import of code that uses them
// ---------------------------------------------------------------------------

// Configurable execFile behavior (docker exec calls from vault write routes)
let execFileStdout = '{"ok":true}';
const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as Function;
  cb(null, execFileStdout, "");
});

mock.module("node:child_process", {
  namedExports: {
    execFile: execFileFn,
    spawn: mock.fn(() => ({ stderr: { on: mock.fn() }, stdin: { write: mock.fn(), end: mock.fn() }, on: mock.fn() })),
  },
});

// Configurable fs behavior
const mkdirFn = mock.fn(async () => undefined);
const writeFileFn = mock.fn(async () => undefined);
const readFileSyncFn = mock.fn((_path: string) => "");
const writeFileSyncFn = mock.fn(() => {});
const readdirSyncFn = mock.fn(() => [] as any[]);

const mkdirSyncFn = mock.fn();
const existsSyncFn = mock.fn(() => false);
const statSyncFn = mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false }));
const unlinkSyncFn = mock.fn();
const renameSyncFn = mock.fn();
const appendFileSyncFn = mock.fn();
const openSyncFn = mock.fn(() => 0);
const readSyncFn = mock.fn(() => 0);
const closeSyncFn = mock.fn();
const createReadStreamFn = mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() }));

const fsMock = {
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
  readdirSync: readdirSyncFn,
  mkdirSync: mkdirSyncFn,
  existsSync: existsSyncFn,
  statSync: statSyncFn,
  unlinkSync: unlinkSyncFn,
  renameSync: renameSyncFn,
  appendFileSync: appendFileSyncFn,
  openSync: openSyncFn,
  readSync: readSyncFn,
  closeSync: closeSyncFn,
  createReadStream: createReadStreamFn,
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mkdirFn, writeFile: writeFileFn },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: readFileSyncFn,
    writeFileSync: writeFileSyncFn,
    readdirSync: readdirSyncFn,
    mkdirSync: mkdirSyncFn,
    existsSync: existsSyncFn,
    statSync: statSyncFn,
    unlinkSync: unlinkSyncFn,
    renameSync: renameSyncFn,
    appendFileSync: appendFileSyncFn,
    openSync: openSyncFn,
    readSync: readSyncFn,
    closeSync: closeSyncFn,
    createReadStream: createReadStreamFn,
    Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  },
});

// ---------------------------------------------------------------------------
// Server setup — dynamic import after mocks are in place
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
  body?: unknown,
  headers: Record<string, string> = {}
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
          ...headers,
        },
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

describe("GET /api/v1/vault/schema", () => {
  it("returns known_types and status_by_type", async () => {
    const { status, data } = await req("GET", "/api/v1/vault/schema");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.known_types), "known_types should be an array");
    assert.ok(data.known_types.includes("note"), "should include 'note'");
    assert.ok(data.known_types.includes("task"), "should include 'task'");
    assert.ok(typeof data.status_by_type === "object", "status_by_type should be an object");
  });
});

describe("GET /api/v1/vault/list/:type", () => {
  it("returns 200 with empty results for a valid type", async () => {
    readdirSyncFn.mock.mockImplementation(() => []);
    const { status, data } = await req("GET", "/api/v1/vault/list/note");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.results));
    assert.strictEqual(data.count, 0);
  });

  it("returns 400 for an unknown type", async () => {
    const { status, data } = await req("GET", "/api/v1/vault/list/foobar_unknown");
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("Unknown vault type"));
  });
});

describe("POST /api/v1/vault/records", () => {
  it("returns 400 when type is missing", async () => {
    const { status, data } = await req("POST", "/api/v1/vault/records", { name: "Test" });
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("type and name are required"));
  });

  it("returns 400 when name is missing", async () => {
    const { status, data } = await req("POST", "/api/v1/vault/records", { type: "note" });
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("type and name are required"));
  });

  it("writes file and returns 201 when content is provided", async () => {
    mkdirFn.mock.resetCalls();
    writeFileFn.mock.resetCalls();
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "note",
      name: "my-note",
      content: "---\ntype: note\n---\nHello",
    });
    assert.strictEqual(status, 201);
    assert.ok(typeof data.path === "string", "should return a path");
    assert.strictEqual(mkdirFn.mock.callCount(), 1, "mkdir should be called once");
    assert.strictEqual(writeFileFn.mock.callCount(), 1, "writeFile should be called once");
  });
});

describe("GET /api/v1/vault/records/* (path traversal)", () => {
  it("returns 400 for a path traversal attempt", async () => {
    const { status, data } = await req("GET", "/api/v1/vault/records/..%2Fetc%2Fpasswd");
    assert.strictEqual(status, 400);
    assert.ok(
      data.error.message.includes("traversal") || data.error.message.includes("Absolute"),
      `expected traversal error, got: ${data.error.message}`
    );
  });
});

describe("PATCH /api/v1/vault/records/*", () => {
  it("calls dockerExec and returns 200", async () => {
    execFileStdout = '{"updated":true}';
    execFileFn.mock.resetCalls();
    const { status, data } = await req(
      "PATCH",
      "/api/v1/vault/records/note/test-record.md",
      { set: { status: "active" } }
    );
    assert.strictEqual(status, 200);
    assert.ok(execFileFn.mock.callCount() >= 1, "execFile should be called");
    assert.deepStrictEqual(data, { updated: true });
  });
});

describe("DELETE /api/v1/vault/records/*", () => {
  it("calls dockerExec and returns 200", async () => {
    execFileStdout = '{"deleted":true}';
    execFileFn.mock.resetCalls();
    const { status, data } = await req("DELETE", "/api/v1/vault/records/note/test-record.md");
    assert.strictEqual(status, 200);
    assert.ok(execFileFn.mock.callCount() >= 1, "execFile should be called");
    assert.deepStrictEqual(data, { deleted: true });
  });
});
