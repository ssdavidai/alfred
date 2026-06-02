import { mock, describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks — must register before the route module is imported.
// ---------------------------------------------------------------------------

const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as Function;
  cb(null, '{"ok":true}', "");
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

// fs shim — the route module uses fs only for the persistent dedupe LRU
// (webhook path) which is not exercised here, so a stub suffices.
const fsStore = new Map<string, string>();
const readFileSyncFn = mock.fn((p: string) => {
  if (fsStore.has(p)) return fsStore.get(p)!;
  const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
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
// fetch mock — captures Plane API calls.
// ---------------------------------------------------------------------------

interface CapturedFetch {
  url: string;
  init?: RequestInit;
}

const fetchCalls: CapturedFetch[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  fsStore.clear();
  fetchCalls.length = 0;
  fetchImpl = async () =>
    new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  process.env.PLANE_API_TOKEN = "test-plane-token";
  process.env.PLANE_WORKSPACE_SLUG = "alfred-workspace";
  process.env.PLANE_API_BASE_URL = "http://plane-api:8000";
  delete process.env.PLANE_ALFRED_USER_ID;
});

afterEach(() => {
  delete process.env.PLANE_API_TOKEN;
  delete process.env.PLANE_WORKSPACE_SLUG;
  delete process.env.PLANE_API_BASE_URL;
  delete process.env.PLANE_API_URL;
  delete process.env.PLANE_ALFRED_USER_ID;
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

// ===========================================================================
// GET /api/v1/plane/issues/:project_id/:issue_id
// ===========================================================================

describe("GET /api/v1/plane/issues/:project_id/:issue_id", () => {
  it("200s with the pruned issue shape on success", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          id: "issue-uuid",
          name: "Set up Plane sync",
          description_html: "<p>do the thing</p>",
          description_stripped: "do the thing",
          state: { id: "state-uuid", name: "todo", group: "unstarted" },
          priority: "medium",
          labels: [{ id: "lbl-1", name: "bug" }],
          assignees: [{ id: "u-1", display_name: "Sir", email: "sir@x.com" }],
          target_date: "2026-04-30",
          external_id: "alfred:task/foo",
          external_source: "alfred",
          created_at: "2026-04-25T10:00:00Z",
          updated_at: "2026-04-25T11:00:00Z",
          // Noise we expect to drop:
          workspace_detail: { name: "alfred", slug: "alfred-workspace" },
          project_detail: { name: "Galerius" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const { status, data } = await req(
      "GET",
      "/api/v1/plane/issues/proj-123/issue-uuid",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.id, "issue-uuid");
    assert.strictEqual(data.name, "Set up Plane sync");
    assert.strictEqual(data.priority, "medium");
    assert.strictEqual(data.state.group, "unstarted");
    assert.deepStrictEqual(data.labels, [{ id: "lbl-1", name: "bug" }]);
    assert.deepStrictEqual(data.assignees, [
      { id: "u-1", display_name: "Sir", email: "sir@x.com" },
    ]);
    assert.strictEqual(data.target_date, "2026-04-30");
    assert.strictEqual(data.external_id, "alfred:task/foo");
    // Noisy fields must NOT leak through.
    assert.ok(!("workspace_detail" in data));
    assert.ok(!("project_detail" in data));

    // Plane was called with the right URL + auth header + GET.
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(
      fetchCalls[0].url,
      "http://plane-api:8000/api/v1/workspaces/alfred-workspace/projects/proj-123/issues/issue-uuid/",
    );
    assert.strictEqual(fetchCalls[0].init?.method, "GET");
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assert.strictEqual(headers["x-api-key"], "test-plane-token");
  });

  it("proxies a 404 from Plane to the caller", async () => {
    fetchImpl = async () =>
      new Response("Not Found", { status: 404 });
    const { status, data } = await req(
      "GET",
      "/api/v1/plane/issues/proj-123/missing",
    );
    assert.strictEqual(status, 404);
    assert.strictEqual(data.error?.code, "PLANE_API_ERROR");
  });

  it("502s when Plane is unreachable", async () => {
    fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { status, data } = await req(
      "GET",
      "/api/v1/plane/issues/proj-123/issue-uuid",
    );
    assert.strictEqual(status, 502);
    assert.strictEqual(data.error?.code, "PLANE_UNREACHABLE");
  });

  it("500s with NOT_CONFIGURED when Plane env vars are missing", async () => {
    delete process.env.PLANE_API_TOKEN;
    const { status, data } = await req(
      "GET",
      "/api/v1/plane/issues/proj-123/issue-uuid",
    );
    assert.strictEqual(status, 500);
    assert.strictEqual(data.error?.code, "NOT_CONFIGURED");
    // Plane must NOT have been hit when config is incomplete.
    assert.strictEqual(fetchCalls.length, 0);
  });

  it("falls back to PLANE_API_URL when PLANE_API_BASE_URL is unset", async () => {
    delete process.env.PLANE_API_BASE_URL;
    process.env.PLANE_API_URL = "http://other-plane:9000";
    fetchImpl = async () =>
      new Response(JSON.stringify({ id: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await req("GET", "/api/v1/plane/issues/p/i");
    assert.ok(
      fetchCalls[0].url.startsWith("http://other-plane:9000/"),
      `unexpected url ${fetchCalls[0].url}`,
    );
  });
});

// ===========================================================================
// GET /api/v1/plane/issues/:project_id/:issue_id/comments
// ===========================================================================

describe("GET /api/v1/plane/issues/:project_id/:issue_id/comments", () => {
  it("200s with comments sorted oldest → newest and is_alfred set", async () => {
    process.env.PLANE_ALFRED_USER_ID = "alfred-user-1";
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          // Plane returns newest first by default.
          results: [
            {
              id: "c-3",
              comment_stripped: "second reply",
              comment_html: "<p>second reply</p>",
              actor: "alfred-user-1",
              actor_detail: { display_name: "Alfred", email: "alfred@x" },
              created_at: "2026-04-25T12:00:00Z",
            },
            {
              id: "c-2",
              comment_stripped: "@alfred please look at this",
              comment_html: "<p>@alfred please look at this</p>",
              actor: "sir-user-1",
              actor_detail: { display_name: "Sir", email: "sir@x" },
              created_at: "2026-04-25T11:30:00Z",
            },
            {
              id: "c-1",
              comment_stripped: "first thoughts",
              comment_html: "<p>first thoughts</p>",
              actor: "sir-user-1",
              actor_detail: { display_name: "Sir", email: "sir@x" },
              created_at: "2026-04-25T11:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const { status, data } = await req(
      "GET",
      "/api/v1/plane/issues/proj-123/issue-uuid/comments",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total, 3);
    assert.strictEqual(data.comments.length, 3);
    // Oldest first
    assert.strictEqual(data.comments[0].id, "c-1");
    assert.strictEqual(data.comments[1].id, "c-2");
    assert.strictEqual(data.comments[2].id, "c-3");
    // is_alfred toggles only on the alfred-authored comment
    assert.strictEqual(data.comments[0].is_alfred, false);
    assert.strictEqual(data.comments[1].is_alfred, false);
    assert.strictEqual(data.comments[2].is_alfred, true);
    // Actor shape collapsed
    assert.strictEqual(data.comments[0].actor.id, "sir-user-1");
    assert.strictEqual(data.comments[0].actor.display_name, "Sir");
    assert.strictEqual(data.comments[2].actor.email, "alfred@x");

    assert.strictEqual(
      fetchCalls[0].url,
      "http://plane-api:8000/api/v1/workspaces/alfred-workspace/projects/proj-123/issues/issue-uuid/comments/",
    );
  });

  it("handles a bare-list response (no results wrapper)", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify([
          {
            id: "c-1",
            comment_stripped: "hi",
            comment_html: "<p>hi</p>",
            actor: "u-1",
            created_at: "2026-04-25T10:00:00Z",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const { status, data } = await req(
      "GET",
      "/api/v1/plane/issues/p/i/comments",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total, 1);
    assert.strictEqual(data.comments[0].id, "c-1");
    assert.strictEqual(data.comments[0].is_alfred, false);
  });

  it("does NOT mark anyone as alfred when PLANE_ALFRED_USER_ID is unset", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: "c-1",
              comment_stripped: "hi",
              comment_html: "<p>hi</p>",
              actor: "alfred-user-1",
              created_at: "2026-04-25T10:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const { status, data } = await req(
      "GET",
      "/api/v1/plane/issues/p/i/comments",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.comments[0].is_alfred, false);
  });

  it("proxies a 403 from Plane to the caller", async () => {
    fetchImpl = async () => new Response("Forbidden", { status: 403 });
    const { status, data } = await req(
      "GET",
      "/api/v1/plane/issues/p/i/comments",
    );
    assert.strictEqual(status, 403);
    assert.strictEqual(data.error?.code, "PLANE_API_ERROR");
  });
});
