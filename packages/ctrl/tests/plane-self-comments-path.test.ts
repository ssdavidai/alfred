import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Regression for FAILURE-MODES Part 4 (Sure/Plane bug #2):
//
// The Plane self-comments echo-defence ledger must land on the SHARED
// alfred_data volume so alfred-learn's plane_alfred_triggers.py can read
// it. On the merged single-VM stack ctrl-api mounts alfred_data:/alfred-data
// directly — there is no /mnt/encrypted remap. Writing the ledger to the
// stale /mnt/encrypted/alfred/state/... path lands it in ctrl-api's overlay
// FS, never reaches alfred-learn, and the echo-defence silently breaks
// (Alfred re-processes its own Plane comments). The ledger must be written
// to /alfred-data/state/plane_self_comments.json.
// ---------------------------------------------------------------------------

const EXPECTED_LEDGER = "/alfred-data/state/plane_self_comments.json";
const STALE_LEDGER = "/mnt/encrypted/alfred/state/plane_self_comments.json";

const fsStore = new Map<string, string>();
const readFileSyncFn = mock.fn((p: string) => {
  if (fsStore.has(String(p))) return fsStore.get(String(p))!;
  const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
  err.code = "ENOENT";
  throw err;
});
const writeFileSyncFn = mock.fn((p: string, data: string) => {
  fsStore.set(String(p), String(data));
});
const existsSyncFn = mock.fn((p: string) => fsStore.has(String(p)));
const renameSyncFn = mock.fn((src: string, dst: string) => {
  if (!fsStore.has(String(src))) {
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${src}`);
    err.code = "ENOENT";
    throw err;
  }
  fsStore.set(String(dst), fsStore.get(String(src))!);
  fsStore.delete(String(src));
});

const fsMock = {
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
  readdirSync: mock.fn(() => [] as any[]),
  mkdirSync: mock.fn(),
  existsSync: existsSyncFn,
  statSync: mock.fn((p: string) => ({ size: fsStore.get(String(p))?.length ?? 0, mtimeMs: 0, isDirectory: () => false, isFile: () => true })),
  unlinkSync: mock.fn((p: string) => fsStore.delete(String(p))),
  renameSync: renameSyncFn,
  appendFileSync: mock.fn((p: string, d: string) => fsStore.set(String(p), (fsStore.get(String(p)) ?? "") + d)),
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
    readFileSync: readFileSyncFn,
    writeFileSync: writeFileSyncFn,
    readdirSync: fsMock.readdirSync,
    mkdirSync: fsMock.mkdirSync,
    existsSync: existsSyncFn,
    statSync: fsMock.statSync,
    unlinkSync: fsMock.unlinkSync,
    renameSync: renameSyncFn,
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
    execFile: mock.fn((...args: any[]) => {
      const cb = args[args.length - 1] as Function;
      cb(null, '{"id":"x"}', "");
    }),
    // execFileSync needed by src/api/routes/system.ts (ssh-keygen, unused here).
    execFileSync: mock.fn(() => ""),
    spawn: mock.fn(() => ({ stderr: { on: mock.fn() }, stdin: { write: mock.fn(), end: mock.fn() }, on: mock.fn() })),
  },
});

let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  new Response(JSON.stringify({ id: "plane-comment-uuid-1" }), {
    status: 201, headers: { "Content-Type": "application/json" },
  });
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return fetchImpl(url, init);
}) as any;

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  fsStore.clear();
  process.env.PLANE_API_TOKEN = "test-plane-token";
  process.env.PLANE_WORKSPACE_SLUG = "alfred-workspace";
  process.env.PLANE_API_BASE_URL = "http://plane-api:8000";
});

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
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
          ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => { raw += c.toString(); });
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, data: raw }); }
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe("Plane self-comments ledger lands on the shared /alfred-data volume", () => {
  it("writes the ledger to /alfred-data/state, not /mnt/encrypted/alfred", async () => {
    const { status } = await req("POST", "/api/v1/plane/comment", {
      project_id: "p", issue_id: "i", text: "pong",
    });
    assert.strictEqual(status, 201);

    assert.ok(fsStore.has(EXPECTED_LEDGER), `ledger must exist at ${EXPECTED_LEDGER}`);
    assert.deepStrictEqual(JSON.parse(fsStore.get(EXPECTED_LEDGER)!), ["plane-comment-uuid-1"]);
    assert.ok(!fsStore.has(STALE_LEDGER), "ledger must NOT be written to the stale /mnt/encrypted path");
  });
});
