// Tests for the DELETE / disconnect-all integration paths.
//
// Originally (#658/#659) these covered a Hermes-config tool-enable list that
// ctrl-api hand-edited per-connection. Issue #44 removed that machinery: under
// Hermes, Composio is the single always-on `composio_execute` MCP tool — there
// is no per-action allow-list to mutate and no gateway restart on connect /
// disconnect. What remains real, and is covered here:
//
//   - DELETE on a tenant with N>1 Composio connections of mixed toolkits:
//       * the per-toolkit skill dir survives IF another ACTIVE connection of
//         the same toolkit survives;
//       * it is removed when the deleted connection was the LAST of its
//         toolkit;
//       * other toolkits' skill dirs are untouched.
//   - POST /api/v1/integrations/disconnect-all enumerates every owned
//     connection, deletes each at Composio, and clears every
//     alfred-composio-* skill dir (non-composio skills untouched).
//   - POST /api/v1/integrations/:id/auto-config reports composio_execute as
//     enabled with no gateway restart.
//   - Every response carries `gateway_restart_triggered: false` and
//     `removed_tools: []` — there is no Hermes config to mutate.

import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocked Composio backend
// ---------------------------------------------------------------------------

type FakeConn = {
  id: string;
  toolkit: { slug: string };
  user_id: string;
  member_id?: string;
  status: string;
  appName?: string;
};

const composioConns: Map<string, FakeConn> = new Map();
const deletedConns: Set<string> = new Set();
const composioCalls: Array<{ method: string; url: string; body?: any }> = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  let parsedBody: any;
  if (init?.body) {
    try { parsedBody = JSON.parse(init.body); } catch { /* ignore */ }
  }
  composioCalls.push({ method, url: u, body: parsedBody });

  // GET /api/v3/connected_accounts (list, paginated)
  if (method === "GET" && /\/api\/v3\/connected_accounts(?:\?|$)/.test(u)) {
    const parsed = new URL(u);
    const filterUid = parsed.searchParams.get("user_id");
    const items = [...composioConns.values()].filter(
      (c) => !filterUid || c.user_id === filterUid,
    );
    return new Response(
      JSON.stringify({ items, next_cursor: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  // GET /api/v3/connected_accounts/:id
  const getMatch = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (method === "GET" && getMatch) {
    const id = decodeURIComponent(getMatch[1]);
    if (deletedConns.has(id)) return new Response("Not found", { status: 404 });
    const conn = composioConns.get(id);
    if (!conn) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(conn), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // DELETE /api/v3/connected_accounts/:id
  const delMatch = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (method === "DELETE" && delMatch) {
    const id = decodeURIComponent(delMatch[1]);
    if (!composioConns.has(id) && !deletedConns.has(id)) {
      return new Response("Not found", { status: 404 });
    }
    composioConns.delete(id);
    deletedConns.add(id);
    return new Response(JSON.stringify({ deleted: true }), { status: 200 });
  }

  // GET /api/v2/actions?apps=... (skill generation — return empty list so
  // generateComposioSkill writes a minimal SKILL.md without exploding).
  if (method === "GET" && u.includes("/api/v2/actions")) {
    return new Response(
      JSON.stringify({ items: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ error: "unmocked", url: u, method }),
    { status: 501 },
  );
}) as typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Mocked filesystem
// ---------------------------------------------------------------------------

const memFs: Map<string, string> = new Map();
const memDirs: Set<string> = new Set();

function ensureParentDirs(p: string): void {
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts.slice(0, -1)) {
    cur += `/${part}`;
    memDirs.add(cur);
  }
}

function listChildren(dir: string): string[] {
  const norm = dir.replace(/\/+$/, "");
  const childSet = new Set<string>();
  for (const f of memFs.keys()) {
    if (f.startsWith(`${norm}/`)) {
      const rest = f.slice(norm.length + 1);
      const top = rest.split("/")[0];
      if (top) childSet.add(top);
    }
  }
  for (const d of memDirs) {
    if (d.startsWith(`${norm}/`)) {
      const rest = d.slice(norm.length + 1);
      const top = rest.split("/")[0];
      if (top) childSet.add(top);
    }
  }
  return [...childSet];
}

const fsMock = {
  existsSync: mock.fn((p: string) => memFs.has(p) || memDirs.has(p)),
  readFileSync: mock.fn((p: string) => {
    if (!memFs.has(p)) {
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as any;
      err.code = "ENOENT";
      throw err;
    }
    return memFs.get(p)!;
  }),
  writeFileSync: mock.fn((p: string, data: any) => {
    ensureParentDirs(p);
    memFs.set(p, typeof data === "string" ? data : String(data));
  }),
  mkdirSync: mock.fn((p: string) => {
    ensureParentDirs(p + "/x");
    memDirs.add(p);
  }),
  readdirSync: mock.fn((p: string) => listChildren(p)),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: mock.fn((p: string) => { memFs.delete(p); }),
  renameSync: mock.fn((from: string, to: string) => {
    if (memFs.has(from)) {
      memFs.set(to, memFs.get(from)!);
      memFs.delete(from);
    }
  }),
  appendFileSync: mock.fn(),
  rmSync: mock.fn((p: string) => {
    memFs.delete(p);
    memDirs.delete(p);
    for (const f of [...memFs.keys()]) {
      if (f.startsWith(`${p}/`)) memFs.delete(f);
    }
    for (const d of [...memDirs]) {
      if (d.startsWith(`${p}/`)) memDirs.delete(d);
    }
  }),
  chownSync: mock.fn(),
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
    rmSync: fsMock.rmSync,
    chownSync: fsMock.chownSync,
    openSync: fsMock.openSync,
    readSync: fsMock.readSync,
    closeSync: fsMock.closeSync,
    createReadStream: fsMock.createReadStream,
    Dirent: fsMock.Dirent,
  },
});

// child_process — no Temporal scheduler interactions in these tests; just
// no-op every dockerExec call so the route's await resolves.
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

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

process.env.COMPOSIO_API_KEY = "test-composio-key";
process.env.COMPOSIO_USER_ID = "alfred-test-user";

await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

// Hermes profile workspace skill dirs — HERMES_HOME defaults to /opt/data, so
// profiles live at /opt/data/profiles/<profile>/workspace/skills.
const SKILLS_DIR = "/opt/data/profiles/main/workspace/skills";
const WORKERS_SKILLS_DIR = "/opt/data/profiles/workers/workspace/skills";

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  composioConns.clear();
  deletedConns.clear();
  composioCalls.length = 0;
  memFs.clear();
  memDirs.clear();
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(method: string, pathname: string, body?: unknown): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: pathname,
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

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function seedConn(opts: Partial<FakeConn> & { id: string; toolkit: string }): FakeConn {
  const conn: FakeConn = {
    id: opts.id,
    toolkit: { slug: opts.toolkit },
    user_id: opts.user_id ?? "alfred-test-user",
    member_id: opts.member_id ?? opts.user_id ?? "alfred-test-user",
    status: opts.status ?? "ACTIVE",
  };
  composioConns.set(conn.id, conn);
  return conn;
}

// ---------------------------------------------------------------------------
// DELETE single connection — per-toolkit skill-dir lifecycle
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/integrations/:id — sibling-of-same-toolkit survival", () => {
  it("keeps the shared skill dir when a second Gmail connection survives", async () => {
    seedConn({ id: "ca_gmail_personal", toolkit: "gmail" });
    seedConn({ id: "ca_gmail_work",     toolkit: "gmail" });
    seedConn({ id: "ca_gcal",           toolkit: "googlecalendar" });
    // Pre-seed the per-toolkit skill dir so we can confirm it survives.
    memFs.set(`${SKILLS_DIR}/alfred-composio-gmail/SKILL.md`, "x");

    const { status, data } = await req("DELETE", "/api/v1/integrations/ca_gmail_personal");

    assert.strictEqual(status, 200, `expected 200, got ${status} (${JSON.stringify(data)})`);
    assert.strictEqual(data.toolkit, "gmail");
    // There is no Hermes tool-enable list under Hermes — these are always
    // empty/false. composio_execute lives on the always-on `execute` MCP server.
    assert.deepStrictEqual(data.removed_tools, []);
    assert.strictEqual(data.skill_removed, false, "shared skill dir survives");
    assert.strictEqual(data.gateway_restart_triggered, false);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(data, "composio_execute_removed"),
      false,
      "single-id DELETE must not claim authority over composio_execute",
    );
    assert.ok(
      memFs.has(`${SKILLS_DIR}/alfred-composio-gmail/SKILL.md`),
      "shared per-toolkit skill dir must survive",
    );
  });

  it("removes the skill dir when deleting the LAST connection of a toolkit", async () => {
    seedConn({ id: "ca_gmail",   toolkit: "gmail" });
    seedConn({ id: "ca_gcal",    toolkit: "googlecalendar" });
    seedConn({ id: "ca_notion",  toolkit: "notion" });
    memFs.set(`${SKILLS_DIR}/alfred-composio-gmail/SKILL.md`, "x");
    memFs.set(`${WORKERS_SKILLS_DIR}/alfred-composio-gmail/SKILL.md`, "x");
    memFs.set(`${SKILLS_DIR}/alfred-composio-notion/SKILL.md`, "y");

    const { status, data } = await req("DELETE", "/api/v1/integrations/ca_gmail");

    assert.strictEqual(status, 200);
    assert.strictEqual(data.toolkit, "gmail");
    assert.deepStrictEqual(data.removed_tools, []);
    assert.strictEqual(data.skill_removed, true);
    assert.strictEqual(data.gateway_restart_triggered, false);

    assert.ok(
      !memFs.has(`${SKILLS_DIR}/alfred-composio-gmail/SKILL.md`),
      "deleted toolkit skill dir gone (main)",
    );
    assert.ok(
      !memFs.has(`${WORKERS_SKILLS_DIR}/alfred-composio-gmail/SKILL.md`),
      "deleted toolkit skill dir gone (workers)",
    );
    assert.ok(
      memFs.has(`${SKILLS_DIR}/alfred-composio-notion/SKILL.md`),
      "unrelated toolkit skill dir untouched",
    );
  });

  it("removes the skill dir even when it is the last Composio connection", async () => {
    seedConn({ id: "ca_gmail_only", toolkit: "gmail" });
    memFs.set(`${SKILLS_DIR}/alfred-composio-gmail/SKILL.md`, "x");

    const { status, data } = await req("DELETE", "/api/v1/integrations/ca_gmail_only");

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.removed_tools, []);
    assert.strictEqual(data.gateway_restart_triggered, false);
    assert.strictEqual(data.skill_removed, true);
    assert.ok(!memFs.has(`${SKILLS_DIR}/alfred-composio-gmail/SKILL.md`));
  });
});

// ---------------------------------------------------------------------------
// POST /disconnect-all
// ---------------------------------------------------------------------------

describe("POST /api/v1/integrations/disconnect-all — explicit global cleanup", () => {
  it("deletes every connection and clears every alfred-composio-* skill dir", async () => {
    seedConn({ id: "ca_gmail",  toolkit: "gmail" });
    seedConn({ id: "ca_gcal",   toolkit: "googlecalendar" });
    seedConn({ id: "ca_notion", toolkit: "notion" });
    for (const toolkit of ["gmail", "googlecalendar", "notion"]) {
      memFs.set(`${SKILLS_DIR}/alfred-composio-${toolkit}/SKILL.md`, "x");
      memFs.set(`${WORKERS_SKILLS_DIR}/alfred-composio-${toolkit}/SKILL.md`, "x");
    }
    // Sentinel: a non-composio skill dir must NOT be touched.
    memFs.set(`${SKILLS_DIR}/alfred-vault-operations/SKILL.md`, "keep me");

    const { status, data } = await req("POST", "/api/v1/integrations/disconnect-all");

    assert.strictEqual(status, 200, `expected 200, got ${status} (${JSON.stringify(data)})`);
    assert.strictEqual(data.disconnected_count, 3);
    assert.deepStrictEqual([...data.disconnected_ids].sort(), ["ca_gcal", "ca_gmail", "ca_notion"]);
    assert.deepStrictEqual([...data.toolkits].sort(), ["gmail", "googlecalendar", "notion"]);
    assert.deepStrictEqual(data.failed_ids, []);
    // No Hermes config to mutate — never a gateway restart.
    assert.strictEqual(data.gateway_restart_triggered, false);
    assert.deepStrictEqual(data.removed_tools, []);

    // Composio-side: every conn DELETEd.
    assert.ok(deletedConns.has("ca_gmail"));
    assert.ok(deletedConns.has("ca_gcal"));
    assert.ok(deletedConns.has("ca_notion"));

    // Skill dirs: every alfred-composio-* gone, vault-operations survives.
    for (const toolkit of ["gmail", "googlecalendar", "notion"]) {
      assert.ok(
        !memFs.has(`${SKILLS_DIR}/alfred-composio-${toolkit}/SKILL.md`),
        `alfred-composio-${toolkit} should be gone`,
      );
    }
    assert.ok(
      memFs.has(`${SKILLS_DIR}/alfred-vault-operations/SKILL.md`),
      "non-composio skills untouched",
    );
  });

  it("returns disconnected_count: 0 with no errors when there are no connections", async () => {
    const { status, data } = await req("POST", "/api/v1/integrations/disconnect-all");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.disconnected_count, 0);
    assert.deepStrictEqual(data.failed_ids, []);
    assert.strictEqual(data.gateway_restart_triggered, false);
  });
});

// ---------------------------------------------------------------------------
// auto-config — composio_execute is always enabled, no restart
// ---------------------------------------------------------------------------

describe("POST /api/v1/integrations/:id/auto-config — composio_execute always live", () => {
  it("reports composio_execute_enabled with no gateway restart", async () => {
    seedConn({ id: "ca_gmail_new", toolkit: "gmail", status: "ACTIVE" });

    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/ca_gmail_new/auto-config",
    );

    assert.strictEqual(status, 200, `expected 200, got ${status} (${JSON.stringify(data)})`);
    assert.strictEqual(data.toolkit, "gmail");
    assert.strictEqual(data.composio_execute_enabled, true);
    assert.strictEqual(
      data.gateway_restart_triggered,
      false,
      "composio_execute is on the always-on execute MCP server — no restart",
    );
  });

  it("is idempotent — a second auto-config behaves identically", async () => {
    seedConn({ id: "ca_gmail_new", toolkit: "gmail", status: "ACTIVE" });

    await req("POST", "/api/v1/integrations/ca_gmail_new/auto-config");
    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/ca_gmail_new/auto-config",
    );

    assert.strictEqual(status, 200);
    assert.strictEqual(data.composio_execute_enabled, true);
    assert.strictEqual(data.gateway_restart_triggered, false);
  });
});

// ---------------------------------------------------------------------------
// enable-tool / disable-tool — stable idempotent no-ops
// ---------------------------------------------------------------------------

describe("POST /api/v1/integrations/{enable,disable}-tool — no-op under Hermes", () => {
  it("enable-tool returns enabled with no gateway restart", async () => {
    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/enable-tool",
      { action_slug: "GMAIL_SEND_EMAIL" },
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.status, "enabled");
    assert.strictEqual(data.action_slug, "GMAIL_SEND_EMAIL");
    assert.strictEqual(data.gateway_restart_triggered, false);
  });

  it("disable-tool returns disabled with no gateway restart", async () => {
    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/disable-tool",
      { action_slug: "GMAIL_SEND_EMAIL" },
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.status, "disabled");
    assert.strictEqual(data.gateway_restart_triggered, false);
  });

  it("enable-tool 400s when action_slug is missing", async () => {
    const { status } = await req("POST", "/api/v1/integrations/enable-tool", {});
    assert.strictEqual(status, 400);
  });
});
