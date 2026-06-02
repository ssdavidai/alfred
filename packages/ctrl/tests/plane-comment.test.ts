import { mock, describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks — must be registered before any import of code that uses them
// ---------------------------------------------------------------------------

const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
const execFileFn = mock.fn((...args: any[]) => {
  const cmd = args[0] as string;
  const cmdArgs = args[1] as string[];
  execFileCalls.push({ cmd, args: cmdArgs });
  const cb = args[args.length - 1] as Function;
  cb(null, '{"run_id":"fake-run-id"}', "");
});

mock.module("node:child_process", {
  namedExports: {
    execFile: execFileFn,
    // execFileSync needed by src/api/routes/system.ts (ssh-keygen, unused here).
    execFileSync: mock.fn(() => ""),
    spawn: mock.fn(() => ({
      stderr: { on: mock.fn() },
      stdin: { write: mock.fn(), end: mock.fn() },
      on: mock.fn(),
    })),
  },
});

// ---------------------------------------------------------------------------
// In-memory fs shim — backs the self-comments ledger used by the route.
// ---------------------------------------------------------------------------

const fsStore = new Map<string, string>();

const readFileSyncFn = mock.fn((p: string) => {
  if (fsStore.has(p)) return fsStore.get(p)!;
  const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${p}'`);
  err.code = "ENOENT";
  throw err;
});
const writeFileSyncFn = mock.fn((p: string, data: string) => {
  fsStore.set(p, data);
});
const existsSyncFn = mock.fn((p: string) => fsStore.has(p));
const renameSyncFn = mock.fn((src: string, dst: string) => {
  if (!fsStore.has(src)) {
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${src}`);
    err.code = "ENOENT";
    throw err;
  }
  fsStore.set(dst, fsStore.get(src)!);
  fsStore.delete(src);
});
const appendFileSyncFn = mock.fn((p: string, data: string) => {
  fsStore.set(p, (fsStore.get(p) ?? "") + data);
});
const mkdirSyncFn = mock.fn();
const readdirSyncFn = mock.fn(() => [] as any[]);
const statSyncFn = mock.fn((p: string) => ({
  size: fsStore.get(p)?.length ?? 0,
  mtimeMs: 0,
  isDirectory: () => false,
  isFile: () => true,
}));
const unlinkSyncFn = mock.fn((p: string) => fsStore.delete(p));
const openSyncFn = mock.fn(() => 0);
const readSyncFn = mock.fn(() => 0);
const closeSyncFn = mock.fn();
const createReadStreamFn = mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() }));
const mkdirFn = mock.fn(async () => undefined);
const writeFileFn = mock.fn(async () => undefined);

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
  Dirent: class Dirent {
    name = "";
    isFile() { return true; }
    isDirectory() { return false; }
  },
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
    Dirent: class Dirent {
      name = "";
      isFile() { return true; }
      isDirectory() { return false; }
    },
  },
});

// ---------------------------------------------------------------------------
// fetch mock — captures outbound Plane API calls and returns a scripted
// response. ``fetchImpl`` is swapped per-test to return 2xx/4xx/5xx/throw.
// ---------------------------------------------------------------------------

interface CapturedFetch {
  url: string;
  init?: RequestInit;
}

const fetchCalls: CapturedFetch[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  new Response(JSON.stringify({ id: "default-comment-id" }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  fetchCalls.push({ url, init });
  return fetchImpl(url, init);
}) as any;

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  fsStore.clear();
  fetchCalls.length = 0;
  execFileCalls.length = 0;
  // Default fetch impl: Plane returns 201 with an id.
  fetchImpl = async () =>
    new Response(JSON.stringify({ id: "plane-comment-uuid-1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  // Default env: configured.
  process.env.PLANE_API_TOKEN = "test-plane-token";
  process.env.PLANE_WORKSPACE_SLUG = "alfred-workspace";
  process.env.PLANE_API_BASE_URL = "http://plane-api:8000";
});

afterEach(() => {
  delete process.env.PLANE_API_TOKEN;
  delete process.env.PLANE_WORKSPACE_SLUG;
  delete process.env.PLANE_API_BASE_URL;
  delete process.env.PLANE_API_URL;
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
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, data: raw });
          }
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

describe("POST /api/v1/plane/comment", () => {
  it("201s on valid payload, calls Plane, and records comment id in the ledger", async () => {
    const { status, data } = await req("POST", "/api/v1/plane/comment", {
      project_id: "proj-123",
      issue_id: "issue-456",
      text: "pong",
    });

    assert.strictEqual(status, 201);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.comment_id, "plane-comment-uuid-1");

    // Plane was called with the expected URL + headers + body
    assert.strictEqual(fetchCalls.length, 1);
    const call = fetchCalls[0];
    assert.strictEqual(
      call.url,
      "http://plane-api:8000/api/v1/workspaces/alfred-workspace/projects/proj-123/issues/issue-456/comments/",
    );
    const headers = call.init?.headers as Record<string, string>;
    assert.strictEqual(headers["x-api-key"], "test-plane-token");
    assert.strictEqual(headers["Content-Type"], "application/json");

    const planeBody = JSON.parse(call.init!.body as string);
    assert.ok(planeBody.comment_html.includes("pong"));
    assert.strictEqual(planeBody.comment_stripped, "pong");

    // Ledger was written with the id
    const ledgerRaw = fsStore.get("/alfred-data/state/plane_self_comments.json");
    assert.ok(ledgerRaw, "ledger file must exist");
    assert.deepStrictEqual(JSON.parse(ledgerRaw!), ["plane-comment-uuid-1"]);
  });

  it("accepts text_html and derives stripped form", async () => {
    const { status } = await req("POST", "/api/v1/plane/comment", {
      project_id: "proj-123",
      issue_id: "issue-456",
      text_html: "<p>hello <b>world</b></p>",
    });

    assert.strictEqual(status, 201);
    const planeBody = JSON.parse(fetchCalls[0].init!.body as string);
    assert.strictEqual(planeBody.comment_html, "<p>hello <b>world</b></p>");
    assert.strictEqual(planeBody.comment_stripped, "hello world");
  });

  it("appends to an existing ledger and caps at 500 entries", async () => {
    // Pre-seed a 499-entry ledger
    const seed = Array.from({ length: 499 }, (_, i) => `old-${i}`);
    fsStore.set(
      "/alfred-data/state/plane_self_comments.json",
      JSON.stringify(seed),
    );

    await req("POST", "/api/v1/plane/comment", {
      project_id: "p", issue_id: "i", text: "x",
    });
    let ledger = JSON.parse(
      fsStore.get("/alfred-data/state/plane_self_comments.json")!,
    );
    assert.strictEqual(ledger.length, 500);
    assert.strictEqual(ledger[499], "plane-comment-uuid-1");

    // One more push — the oldest entry should be evicted (FIFO).
    fetchImpl = async () =>
      new Response(JSON.stringify({ id: "plane-comment-uuid-2" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    await req("POST", "/api/v1/plane/comment", {
      project_id: "p", issue_id: "i", text: "y",
    });
    ledger = JSON.parse(
      fsStore.get("/alfred-data/state/plane_self_comments.json")!,
    );
    assert.strictEqual(ledger.length, 500);
    assert.strictEqual(ledger[0], "old-1"); // "old-0" was evicted
    assert.strictEqual(ledger[499], "plane-comment-uuid-2");
  });

  it("returns 400 when project_id is missing", async () => {
    const { status, data } = await req("POST", "/api/v1/plane/comment", {
      issue_id: "i", text: "x",
    });
    assert.strictEqual(status, 400);
    assert.ok(
      String(data.error?.message ?? "").includes("project_id"),
      `expected project_id error, got ${JSON.stringify(data)}`,
    );
    assert.strictEqual(fetchCalls.length, 0);
  });

  it("returns 400 when issue_id is missing", async () => {
    const { status, data } = await req("POST", "/api/v1/plane/comment", {
      project_id: "p", text: "x",
    });
    assert.strictEqual(status, 400);
    assert.ok(String(data.error?.message ?? "").includes("issue_id"));
  });

  it("returns 400 when both text and text_html are missing", async () => {
    const { status, data } = await req("POST", "/api/v1/plane/comment", {
      project_id: "p", issue_id: "i",
    });
    assert.strictEqual(status, 400);
    assert.ok(String(data.error?.message ?? "").includes("text"));
  });

  it("returns 500 when PLANE_API_TOKEN is unset", async () => {
    delete process.env.PLANE_API_TOKEN;
    const { status, data } = await req("POST", "/api/v1/plane/comment", {
      project_id: "p", issue_id: "i", text: "x",
    });
    assert.strictEqual(status, 500);
    assert.strictEqual(data.error?.code, "NOT_CONFIGURED");
    assert.strictEqual(fetchCalls.length, 0);
  });

  it("returns 500 when PLANE_WORKSPACE_SLUG is unset", async () => {
    delete process.env.PLANE_WORKSPACE_SLUG;
    const { status, data } = await req("POST", "/api/v1/plane/comment", {
      project_id: "p", issue_id: "i", text: "x",
    });
    assert.strictEqual(status, 500);
    assert.strictEqual(data.error?.code, "NOT_CONFIGURED");
    assert.strictEqual(fetchCalls.length, 0);
  });

  it("proxies Plane's 404 status to the caller", async () => {
    fetchImpl = async () =>
      new Response("Issue not found", { status: 404 });
    const { status, data } = await req("POST", "/api/v1/plane/comment", {
      project_id: "p", issue_id: "nonexistent", text: "x",
    });
    assert.strictEqual(status, 404);
    assert.strictEqual(data.error?.code, "PLANE_API_ERROR");
    // Ledger must NOT have been touched on failure.
    assert.strictEqual(
      fsStore.has("/alfred-data/state/plane_self_comments.json"),
      false,
    );
  });

  it("returns 502 when Plane is unreachable", async () => {
    fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { status, data } = await req("POST", "/api/v1/plane/comment", {
      project_id: "p", issue_id: "i", text: "x",
    });
    assert.strictEqual(status, 502);
    assert.strictEqual(data.error?.code, "PLANE_UNREACHABLE");
  });

  it("falls back to PLANE_API_URL when PLANE_API_BASE_URL is unset", async () => {
    delete process.env.PLANE_API_BASE_URL;
    process.env.PLANE_API_URL = "http://other-plane:9000";
    await req("POST", "/api/v1/plane/comment", {
      project_id: "p", issue_id: "i", text: "x",
    });
    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(
      fetchCalls[0].url.startsWith("http://other-plane:9000/"),
      `unexpected url: ${fetchCalls[0].url}`,
    );
  });
});
