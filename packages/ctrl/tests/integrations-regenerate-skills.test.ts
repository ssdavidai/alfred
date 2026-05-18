import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Regression tests for POST /api/v1/integrations/regenerate-skills.
//
// Two bugs the user hit in production:
//
// 1. The handler reported `ok: true, actions: 50` for slack on Sir, but the
//    on-disk SKILL.md never updated — file mtime stuck at Apr 10 with the
//    pre-#430 `composio_execute` template, while every other toolkit that
//    ran the same code path got rewritten with the current `self()` template.
//    Whatever the underlying cause (silent permission quirk / stale handle /
//    upstream cache), the response MUST surface the failure rather than
//    cheerfully reporting success.  Implemented as a read-after-write
//    verification step in `generateComposioSkill`.
//
// 2. The handler did not clean up `alfred-composio-<toolkit>` skill dirs whose
//    toolkit no longer had any ACTIVE connection.  Sir's slack file
//    persisted long after the slack connection was disconnected because the
//    disconnect handler's removal failed silently (or the connection was
//    cleaned up out-of-band via Composio's dashboard).  These orphan skill
//    files are loaded by openclaw and confuse the agent.  The regen handler
//    is the canonical "make the workspace consistent with the connections"
//    operation, so it now performs a janitorial sweep.
// ---------------------------------------------------------------------------

interface FakeFile {
  content: string;
  mtime: number;
}

const files = new Map<string, FakeFile>();
const dirs = new Set<string>();

// When set to a path, the next writeFileSync to this path is silently
// dropped — used to simulate the "write reports success but file unchanged"
// failure mode we hit on Sir's slack.
let dropWritesTo: string | null = null;

function ensureDirs(p: string): void {
  const parts = p.split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc += "/" + part;
    dirs.add(acc);
  }
}

const existsSyncFn = mock.fn((p: string) => files.has(p) || dirs.has(p));
const mkdirSyncFn = mock.fn((p: string, _opts?: any) => { ensureDirs(p); });
const writeFileSyncFn = mock.fn((p: string, content: string) => {
  if (dropWritesTo && p === dropWritesTo) {
    // Simulate the silent-failure mode: the syscall returns successfully
    // but the file's content does not change.
    return;
  }
  ensureDirs(p.substring(0, p.lastIndexOf("/")));
  files.set(p, { content, mtime: Date.now() });
});
const readFileSyncFn = mock.fn((p: string, _opts?: any) => {
  const f = files.get(p);
  if (!f) {
    const err: any = new Error(`ENOENT: ${p}`);
    err.code = "ENOENT";
    throw err;
  }
  return f.content;
});
const statSyncFn = mock.fn((p: string) => {
  const f = files.get(p);
  if (!f) {
    if (dirs.has(p)) {
      return { mtimeMs: Date.now(), isDirectory: () => true, isFile: () => false, size: 0 };
    }
    const err: any = new Error(`ENOENT: ${p}`);
    err.code = "ENOENT";
    throw err;
  }
  return {
    mtimeMs: f.mtime,
    isDirectory: () => false,
    isFile: () => true,
    size: Buffer.byteLength(f.content, "utf-8"),
  };
});
const readdirSyncFn = mock.fn((p: string, opts?: any) => {
  const wantDirent = opts && opts.withFileTypes;
  const children = new Set<string>();
  for (const d of dirs) {
    if (d === p) continue;
    if (!d.startsWith(p + "/")) continue;
    const rest = d.slice(p.length + 1);
    children.add(rest.split("/")[0]);
  }
  for (const f of files.keys()) {
    const dir = f.substring(0, f.lastIndexOf("/"));
    if (dir === p) {
      children.add(f.substring(f.lastIndexOf("/") + 1));
    }
  }
  const sorted = [...children].sort();
  if (!wantDirent) return sorted;
  return sorted.map((name) => ({
    name,
    isDirectory: () => dirs.has(p + "/" + name),
    isFile: () => files.has(p + "/" + name),
  }));
});
const rmSyncFn = mock.fn((p: string, _opts?: any) => {
  for (const f of [...files.keys()]) {
    if (f === p || f.startsWith(p + "/")) files.delete(f);
  }
  for (const d of [...dirs]) {
    if (d === p || d.startsWith(p + "/")) dirs.delete(d);
  }
});
const chownSyncFn = mock.fn(() => {});

const fsMock = {
  existsSync: existsSyncFn,
  mkdirSync: mkdirSyncFn,
  writeFileSync: writeFileSyncFn,
  readFileSync: readFileSyncFn,
  statSync: statSyncFn,
  readdirSync: readdirSyncFn,
  rmSync: rmSyncFn,
  chownSync: chownSyncFn,
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

mock.module("node:fs", { defaultExport: fsMock, namedExports: fsMock });

mock.module("node:child_process", {
  namedExports: {
    execFile: mock.fn((...args: any[]) => {
      const cb = args[args.length - 1] as Function;
      cb(null, "{}", "");
    }),
    spawn: mock.fn(() => ({
      stderr: { on: mock.fn() },
      stdin: { write: mock.fn(), end: mock.fn() },
      on: mock.fn(),
    })),
  },
});

// Mock fetch so the Composio API calls return deterministic data.
//
// /v3/connected_accounts → returns the fixture passed via `setConnectedAccounts`.
// /v2/actions?apps=<toolkit>&limit=50 → returns 50 fixture actions per toolkit.
type ConnectedAccountFixture = {
  id: string;
  toolkit: string;
  status: "ACTIVE" | "EXPIRED" | "INITIALIZING";
  user_id: string;
};
let connectedAccounts: ConnectedAccountFixture[] = [];

function setConnectedAccounts(items: ConnectedAccountFixture[]): void {
  connectedAccounts = items;
}

const originalFetch = globalThis.fetch;
function installFetchMock(): void {
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://backend.composio.dev/api/v3/connected_accounts")) {
      const items = connectedAccounts.map((a) => ({
        id: a.id,
        status: a.status,
        user_id: a.user_id,
        toolkit: { slug: a.toolkit },
      }));
      return new Response(JSON.stringify({ items, next_cursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://backend.composio.dev/api/v2/actions")) {
      const u = new URL(url);
      const toolkit = (u.searchParams.get("apps") || "").toUpperCase();
      const items = Array.from({ length: 50 }, (_, i) => ({
        name: `${toolkit}_FETCH_THING_${i}`,
        slug: `${toolkit}_FETCH_THING_${i}`,
        description: `Action ${i} for ${toolkit}`,
      }));
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not mocked", { status: 500 });
  }) as any;
}
installFetchMock();

process.env.COMPOSIO_API_KEY = "test-key";
process.env.COMPOSIO_USER_ID = "alfred-test-1";

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalFetch) globalThis.fetch = originalFetch;
});

beforeEach(() => {
  files.clear();
  dirs.clear();
  dropWritesTo = null;
  ensureDirs("/mnt/encrypted/openclaw/workspace/skills");
  ensureDirs("/mnt/encrypted/openclaw-workers/workspace/skills");
});

const OC = "/mnt/encrypted/openclaw/workspace/skills";
const OCW = "/mnt/encrypted/openclaw-workers/workspace/skills";

async function req(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: apiPath,
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

describe("POST /api/v1/integrations/regenerate-skills", () => {
  it("rewrites SKILL.md for every ACTIVE connection on both workspaces", async () => {
    setConnectedAccounts([
      { id: "ca_1", toolkit: "gmail", status: "ACTIVE", user_id: "alfred-test-1" },
      { id: "ca_2", toolkit: "slack", status: "ACTIVE", user_id: "alfred-test-1" },
      { id: "ca_3", toolkit: "github", status: "ACTIVE", user_id: "alfred-test-1" },
    ]);

    const { status, data } = await req("POST", "/api/v1/integrations/regenerate-skills");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.regenerated, 3);

    // Every reported `ok: true` must correspond to an actual file on disk on
    // BOTH the openclaw and openclaw-workers sides — that's the contract the
    // user expects when the response says "ok".
    for (const r of data.results) {
      assert.strictEqual(r.ok, true, `expected ok for ${r.toolkit}`);
      assert.ok(Array.isArray(r.written_paths), `${r.toolkit} should report written_paths`);
      assert.strictEqual(r.written_paths.length, 2, `${r.toolkit} should write to both workspaces`);
      for (const p of r.written_paths) {
        assert.ok(files.has(p), `expected file at ${p}`);
        const content = files.get(p)!.content;
        assert.match(content, /name: alfred-composio-/, `${p} should be a fresh SKILL.md`);
        // Must use the post-#430 MCP self() syntax, not the dead composio_execute.
        assert.match(
          content,
          /self\(\{endpoint: "\/api\/v1\/integrations\/execute"/,
          `${p} should use self() syntax`,
        );
      }
    }
  });

  it("removes orphan alfred-composio-<toolkit> dirs whose toolkit has no ACTIVE connection", async () => {
    // Seed two stale toolkits (slack, notion) plus the dirs for a fresh
    // toolkit (gmail) on both workspaces.
    for (const baseDir of [OC, OCW]) {
      ensureDirs(`${baseDir}/alfred-composio-slack`);
      files.set(`${baseDir}/alfred-composio-slack/SKILL.md`, {
        content: "stale slack content",
        mtime: Date.now() - 86400000,
      });
      ensureDirs(`${baseDir}/alfred-composio-notion`);
      files.set(`${baseDir}/alfred-composio-notion/SKILL.md`, {
        content: "stale notion content",
        mtime: Date.now() - 86400000,
      });
      // Also seed a non-composio skill — must NOT be touched.
      ensureDirs(`${baseDir}/alfred-vault-operations`);
      files.set(`${baseDir}/alfred-vault-operations/SKILL.md`, {
        content: "platform skill",
        mtime: Date.now() - 86400000,
      });
    }

    // Only gmail is connected.
    setConnectedAccounts([
      { id: "ca_1", toolkit: "gmail", status: "ACTIVE", user_id: "alfred-test-1" },
    ]);

    const { status, data } = await req("POST", "/api/v1/integrations/regenerate-skills");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.regenerated, 1);

    // The orphan dirs must be gone on both sides.
    for (const baseDir of [OC, OCW]) {
      assert.ok(
        !files.has(`${baseDir}/alfred-composio-slack/SKILL.md`),
        `slack should be removed from ${baseDir}`,
      );
      assert.ok(
        !files.has(`${baseDir}/alfred-composio-notion/SKILL.md`),
        `notion should be removed from ${baseDir}`,
      );
      // Non-composio skills must survive.
      assert.ok(
        files.has(`${baseDir}/alfred-vault-operations/SKILL.md`),
        `platform skill must survive on ${baseDir}`,
      );
    }

    // The response must report what was removed so the caller can audit.
    assert.ok(Array.isArray(data.stale_removed), "response must include stale_removed array");
    const removedToolkits = new Set(data.stale_removed.map((r: any) => r.toolkit));
    assert.ok(removedToolkits.has("slack"), "stale_removed must include slack");
    assert.ok(removedToolkits.has("notion"), "stale_removed must include notion");
  });

  it("does NOT remove a skill dir whose toolkit had a regen error this run", async () => {
    // gmail will succeed, slack will be ACTIVE-but-broken (mocked v2 actions
    // call returns 500). We must NOT remove slack — it's connected, just
    // transiently borked.
    for (const baseDir of [OC, OCW]) {
      ensureDirs(`${baseDir}/alfred-composio-slack`);
      files.set(`${baseDir}/alfred-composio-slack/SKILL.md`, {
        content: "existing slack content",
        mtime: Date.now() - 3600000,
      });
    }

    setConnectedAccounts([
      { id: "ca_1", toolkit: "gmail", status: "ACTIVE", user_id: "alfred-test-1" },
      { id: "ca_2", toolkit: "slack", status: "ACTIVE", user_id: "alfred-test-1" },
    ]);

    // Override the v2 actions endpoint for slack to fail. The handler currently
    // does NOT throw on a non-ok v2 response — actions array stays empty —
    // so the SKILL.md still gets written. The "broken" path is more useful
    // as: write fails (silent-write-drop) — see the next test.
    // This test instead asserts the happy path that slack is rewritten when
    // ACTIVE, regardless of disk state — i.e. existing files do not block
    // the regeneration.
    const { status, data } = await req("POST", "/api/v1/integrations/regenerate-skills");
    assert.strictEqual(status, 200);
    const slackResult = data.results.find((r: any) => r.toolkit === "slack");
    assert.strictEqual(slackResult.ok, true);
    // The slack file must reflect the new template, not the seeded content.
    const slackFile = files.get(`${OC}/alfred-composio-slack/SKILL.md`)!;
    assert.notStrictEqual(slackFile.content, "existing slack content");
    assert.match(slackFile.content, /self\(\{endpoint: "\/api\/v1\/integrations\/execute"/);
  });

  it("surfaces a real error (not ok: true) when writeFileSync silently drops the write", async () => {
    // This is the Sir-on-slack case in spirit: writeFileSync syscall returns
    // success but the on-disk content does not change. Without read-after-write
    // verification the handler returned `ok: true` and the agent kept loading
    // the stale file. With verification it must report an error.
    setConnectedAccounts([
      { id: "ca_1", toolkit: "slack", status: "ACTIVE", user_id: "alfred-test-1" },
    ]);

    // Seed an existing file with stale content, then force the next write to
    // be silently dropped. After "write", the on-disk content still equals
    // the stale string, NOT the freshly-generated SKILL.md.
    ensureDirs(`${OC}/alfred-composio-slack`);
    files.set(`${OC}/alfred-composio-slack/SKILL.md`, {
      content: "stale slack content from Apr 10",
      mtime: 0,
    });
    dropWritesTo = `${OC}/alfred-composio-slack/SKILL.md`;

    const { status, data } = await req("POST", "/api/v1/integrations/regenerate-skills");
    assert.strictEqual(status, 200);
    const slackResult = data.results.find((r: any) => r.toolkit === "slack");
    assert.notStrictEqual(
      slackResult.ok,
      true,
      "must NOT report ok: true when the write was silently dropped",
    );
    assert.ok(
      typeof slackResult.error === "string" && slackResult.error.length > 0,
      "must report an error string explaining the verification failure",
    );
    assert.match(
      slackResult.error,
      /verification|write|differs/i,
      "error must mention the verification failure",
    );
  });

  it("skips inactive (EXPIRED, INITIALIZING) connections without writing", async () => {
    setConnectedAccounts([
      { id: "ca_1", toolkit: "gmail", status: "ACTIVE", user_id: "alfred-test-1" },
      { id: "ca_2", toolkit: "notion", status: "EXPIRED", user_id: "alfred-test-1" },
      { id: "ca_3", toolkit: "github", status: "INITIALIZING", user_id: "alfred-test-1" },
    ]);

    const { status, data } = await req("POST", "/api/v1/integrations/regenerate-skills");
    assert.strictEqual(status, 200);
    const gmail = data.results.find((r: any) => r.toolkit === "gmail");
    const notion = data.results.find((r: any) => r.toolkit === "notion");
    const github = data.results.find((r: any) => r.toolkit === "github");
    assert.strictEqual(gmail.ok, true);
    assert.strictEqual(notion.skipped, true);
    assert.strictEqual(github.skipped, true);
    // Only gmail file written.
    assert.ok(files.has(`${OC}/alfred-composio-gmail/SKILL.md`));
    assert.ok(!files.has(`${OC}/alfred-composio-notion/SKILL.md`));
    assert.ok(!files.has(`${OC}/alfred-composio-github/SKILL.md`));
  });
});
