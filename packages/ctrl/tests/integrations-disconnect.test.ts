// Tests for the DELETE / disconnect-all integration paths fixed in #658
// and the auto-config name fix in #659.
//
// Coverage:
//   - DELETE on a tenant with N>1 Composio connections of mixed toolkits:
//       * the deleted connection's toolkit prefix stays in the allowlist
//         IF another ACTIVE connection of the same toolkit survives.
//       * `composio_execute` always survives a single-id DELETE.
//       * Other toolkits' allow entries are untouched.
//   - DELETE on the LAST connection of a toolkit while OTHER toolkits
//     survive: the deleted toolkit's prefix is stripped, the per-toolkit
//     skill dir is deleted, but `composio_execute` and other toolkits'
//     prefixes remain.
//   - POST /api/v1/integrations/disconnect-all enumerates every owned
//     connection, deletes each at Composio, removes `composio_execute`
//     from the allowlist, and clears every alfred-composio-* skill dir.
//   - POST /api/v1/integrations/:id/auto-config registers the canonical
//     `composio_execute` tool name (NOT the dead `ctrl_composio_execute`).

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
    // The route paginates with cursor, but our mock returns all matching
    // conns in one page (we never set next_cursor).
    const parsed = new URL(u);
    const filterUid = parsed.searchParams.get("user_id");
    // Composio's server-side filter is buggy in production (issue #658), but
    // for these tests we simulate the CORRECT behaviour — the route now
    // always re-filters locally with accountMatchesUserId, so a buggy
    // upstream would not change the test outcomes.
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

  // POST /api/v2/actions?apps=... (skill generation — return empty list so
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
  // Track every prefix path so readdirSync finds nested dirs.
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
    // Recursive remove — clear file at exact path AND any descendants.
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

const integrationsModule = await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

const OPENCLAW_CONFIG_PATH = "/mnt/encrypted/openclaw/openclaw.json";
const OPENCLAW_WORKERS_CONFIG_PATH = "/mnt/encrypted/openclaw-workers/openclaw.json";

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  // Flush any debounced openclaw.json writes before tearing down so the
  // memFs reflects final state during assertions.
  integrationsModule.flushPendingOpenclawWrites();
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

function seedOpenclawConfig(allow: string[]): void {
  const cfg = { gateway: { tools: { allow } } };
  memFs.set(OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
  memFs.set(OPENCLAW_WORKERS_CONFIG_PATH, JSON.stringify(cfg));
}

function readAllow(path: string): string[] {
  const raw = memFs.get(path);
  if (!raw) return [];
  try {
    const cfg = JSON.parse(raw);
    return cfg?.gateway?.tools?.allow ?? [];
  } catch { return []; }
}

function flush(): void {
  integrationsModule.flushPendingOpenclawWrites();
}

// ---------------------------------------------------------------------------
// #658 — DELETE single connection, surviving siblings of same toolkit
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/integrations/:id — sibling-of-same-toolkit survival (#658)", () => {
  it("keeps GMAIL_* prefix + composio_execute when a second Gmail connection survives", async () => {
    seedConn({ id: "ca_gmail_personal", toolkit: "gmail" });
    seedConn({ id: "ca_gmail_work",     toolkit: "gmail" });
    seedConn({ id: "ca_gcal",           toolkit: "googlecalendar" });
    seedOpenclawConfig([
      "composio_execute",
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_EMAIL",
      "GOOGLECALENDAR_EVENTS_LIST",
      "sessions_send",
    ]);
    // Pre-seed the per-toolkit skill dir so we can confirm it survives.
    memFs.set(
      "/mnt/encrypted/openclaw/workspace/skills/alfred-composio-gmail/SKILL.md",
      "x",
    );

    const { status, data } = await req(
      "DELETE",
      "/api/v1/integrations/ca_gmail_personal",
    );
    flush();

    assert.strictEqual(status, 200, `expected 200, got ${status} (${JSON.stringify(data)})`);
    assert.strictEqual(data.toolkit, "gmail");
    assert.deepStrictEqual(data.removed_tools, [], "no toolkit prefix should be stripped — Gmail work survives");
    assert.strictEqual(data.skill_removed, false, "shared skill dir survives");
    assert.strictEqual(data.gateway_restart_triggered, false);
    // Issue #658 regression: this field is gone. The handler no longer
    // claims to manage composio_execute on single-id deletes.
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(data, "composio_execute_removed"),
      false,
      "single-id DELETE must not claim authority over composio_execute",
    );

    const allow = readAllow(OPENCLAW_CONFIG_PATH);
    assert.ok(allow.includes("composio_execute"), "composio_execute MUST survive");
    assert.ok(allow.includes("GMAIL_FETCH_EMAILS"), "GMAIL_* must survive — work account still active");
    assert.ok(allow.includes("GMAIL_SEND_EMAIL"));
    assert.ok(allow.includes("GOOGLECALENDAR_EVENTS_LIST"), "unrelated toolkit untouched");
    assert.ok(
      memFs.has("/mnt/encrypted/openclaw/workspace/skills/alfred-composio-gmail/SKILL.md"),
      "shared per-toolkit skill dir must survive",
    );
  });

  it("strips only the deleted toolkit's prefix when it was the LAST of its toolkit and other toolkits remain", async () => {
    seedConn({ id: "ca_gmail",   toolkit: "gmail" });
    seedConn({ id: "ca_gcal",    toolkit: "googlecalendar" });
    seedConn({ id: "ca_notion",  toolkit: "notion" });
    seedOpenclawConfig([
      "composio_execute",
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_EMAIL",
      "GOOGLECALENDAR_EVENTS_LIST",
      "NOTION_FETCH_DATA",
    ]);
    memFs.set(
      "/mnt/encrypted/openclaw/workspace/skills/alfred-composio-gmail/SKILL.md",
      "x",
    );
    memFs.set(
      "/mnt/encrypted/openclaw-workers/workspace/skills/alfred-composio-gmail/SKILL.md",
      "x",
    );
    memFs.set(
      "/mnt/encrypted/openclaw/workspace/skills/alfred-composio-notion/SKILL.md",
      "y",
    );

    const { status, data } = await req("DELETE", "/api/v1/integrations/ca_gmail");
    flush();

    assert.strictEqual(status, 200);
    assert.strictEqual(data.toolkit, "gmail");
    assert.deepStrictEqual(
      [...data.removed_tools].sort(),
      ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
    );
    assert.strictEqual(data.skill_removed, true);

    const allow = readAllow(OPENCLAW_CONFIG_PATH);
    assert.ok(allow.includes("composio_execute"), "composio_execute MUST survive single-id DELETE");
    assert.ok(!allow.includes("GMAIL_FETCH_EMAILS"));
    assert.ok(!allow.includes("GMAIL_SEND_EMAIL"));
    assert.ok(allow.includes("GOOGLECALENDAR_EVENTS_LIST"), "unrelated toolkit untouched");
    assert.ok(allow.includes("NOTION_FETCH_DATA"), "unrelated toolkit untouched");

    assert.ok(
      !memFs.has("/mnt/encrypted/openclaw/workspace/skills/alfred-composio-gmail/SKILL.md"),
      "deleted toolkit skill dir gone (main)",
    );
    assert.ok(
      !memFs.has("/mnt/encrypted/openclaw-workers/workspace/skills/alfred-composio-gmail/SKILL.md"),
      "deleted toolkit skill dir gone (workers)",
    );
    assert.ok(
      memFs.has("/mnt/encrypted/openclaw/workspace/skills/alfred-composio-notion/SKILL.md"),
      "unrelated toolkit skill dir untouched",
    );
  });

  it("does NOT strip any allow-list entries when deleting the LAST connection of last toolkit (composio_execute + prefix preserved)", async () => {
    // Even when this is the actual last Composio connection on the tenant,
    // the single-id DELETE must NOT take down composio_execute. That global
    // teardown is the job of POST /disconnect-all.
    seedConn({ id: "ca_gmail_only", toolkit: "gmail" });
    seedOpenclawConfig([
      "composio_execute",
      "GMAIL_FETCH_EMAILS",
      "sessions_send",
    ]);
    memFs.set(
      "/mnt/encrypted/openclaw/workspace/skills/alfred-composio-gmail/SKILL.md",
      "x",
    );

    const { status, data } = await req("DELETE", "/api/v1/integrations/ca_gmail_only");
    flush();

    assert.strictEqual(status, 200);
    // The toolkit prefix is stripped (no other gmail conn), but composio_execute lives on.
    assert.deepStrictEqual(data.removed_tools, ["GMAIL_FETCH_EMAILS"]);
    const allow = readAllow(OPENCLAW_CONFIG_PATH);
    assert.ok(
      allow.includes("composio_execute"),
      "composio_execute MUST survive even the last Composio connection's single-id DELETE",
    );
    assert.ok(!allow.includes("GMAIL_FETCH_EMAILS"));
    assert.ok(allow.includes("sessions_send"));
  });
});

// ---------------------------------------------------------------------------
// #658 — POST /disconnect-all
// ---------------------------------------------------------------------------

describe("POST /api/v1/integrations/disconnect-all — explicit global cleanup (#658)", () => {
  it("deletes every connection and clears the entire Composio surface", async () => {
    seedConn({ id: "ca_gmail",  toolkit: "gmail" });
    seedConn({ id: "ca_gcal",   toolkit: "googlecalendar" });
    seedConn({ id: "ca_notion", toolkit: "notion" });
    seedOpenclawConfig([
      "composio_execute",
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_EMAIL",
      "GOOGLECALENDAR_EVENTS_LIST",
      "NOTION_FETCH_DATA",
      "sessions_send",
    ]);
    for (const toolkit of ["gmail", "googlecalendar", "notion"]) {
      memFs.set(
        `/mnt/encrypted/openclaw/workspace/skills/alfred-composio-${toolkit}/SKILL.md`,
        "x",
      );
      memFs.set(
        `/mnt/encrypted/openclaw-workers/workspace/skills/alfred-composio-${toolkit}/SKILL.md`,
        "x",
      );
    }
    // Sentinel: a non-composio skill dir must NOT be touched.
    memFs.set(
      "/mnt/encrypted/openclaw/workspace/skills/alfred-vault-operations/SKILL.md",
      "keep me",
    );

    const { status, data } = await req("POST", "/api/v1/integrations/disconnect-all");
    flush();

    assert.strictEqual(status, 200, `expected 200, got ${status} (${JSON.stringify(data)})`);
    assert.strictEqual(data.disconnected_count, 3);
    assert.deepStrictEqual([...data.disconnected_ids].sort(), ["ca_gcal", "ca_gmail", "ca_notion"]);
    assert.deepStrictEqual([...data.toolkits].sort(), ["gmail", "googlecalendar", "notion"]);
    assert.deepStrictEqual(data.failed_ids, []);
    assert.ok(data.gateway_restart_triggered, "global cleanup mutates allowlist → restart");

    // Composio-side: every conn DELETEd.
    assert.ok(deletedConns.has("ca_gmail"));
    assert.ok(deletedConns.has("ca_gcal"));
    assert.ok(deletedConns.has("ca_notion"));

    // Allowlist: composio_execute + every toolkit prefix gone, sessions_send survives.
    const allow = readAllow(OPENCLAW_CONFIG_PATH);
    assert.ok(!allow.includes("composio_execute"));
    assert.ok(!allow.includes("GMAIL_FETCH_EMAILS"));
    assert.ok(!allow.includes("GMAIL_SEND_EMAIL"));
    assert.ok(!allow.includes("GOOGLECALENDAR_EVENTS_LIST"));
    assert.ok(!allow.includes("NOTION_FETCH_DATA"));
    assert.ok(allow.includes("sessions_send"), "non-composio tools untouched");

    // Same on workers.
    const workersAllow = readAllow(OPENCLAW_WORKERS_CONFIG_PATH);
    assert.ok(!workersAllow.includes("composio_execute"));

    // Skill dirs: every alfred-composio-* gone, vault-operations survives.
    for (const toolkit of ["gmail", "googlecalendar", "notion"]) {
      assert.ok(
        !memFs.has(`/mnt/encrypted/openclaw/workspace/skills/alfred-composio-${toolkit}/SKILL.md`),
        `alfred-composio-${toolkit} should be gone`,
      );
    }
    assert.ok(
      memFs.has("/mnt/encrypted/openclaw/workspace/skills/alfred-vault-operations/SKILL.md"),
      "non-composio skills untouched",
    );
  });

  it("returns disconnected_count: 0 with no errors when there are no connections", async () => {
    seedOpenclawConfig(["sessions_send"]);
    const { status, data } = await req("POST", "/api/v1/integrations/disconnect-all");
    flush();
    assert.strictEqual(status, 200);
    assert.strictEqual(data.disconnected_count, 0);
    assert.deepStrictEqual(data.failed_ids, []);
    // No mutation needed since composio_execute wasn't there to begin with.
    assert.strictEqual(data.gateway_restart_triggered, false);
    assert.ok(readAllow(OPENCLAW_CONFIG_PATH).includes("sessions_send"));
  });
});

// ---------------------------------------------------------------------------
// #659 — auto-config registers the canonical tool name
// ---------------------------------------------------------------------------

describe("POST /api/v1/integrations/:id/auto-config — registers composio_execute (#659)", () => {
  it("adds `composio_execute` (NOT `ctrl_composio_execute`) to gateway.tools.allow", async () => {
    seedConn({ id: "ca_gmail_new", toolkit: "gmail", status: "ACTIVE" });
    seedOpenclawConfig(["sessions_send"]);

    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/ca_gmail_new/auto-config",
    );
    flush();

    assert.strictEqual(status, 200, `expected 200, got ${status} (${JSON.stringify(data)})`);
    assert.strictEqual(data.toolkit, "gmail");
    assert.strictEqual(data.composio_execute_enabled, true);
    assert.strictEqual(data.gateway_restart_triggered, true, "first composio connect → restart");

    const allow = readAllow(OPENCLAW_CONFIG_PATH);
    assert.ok(allow.includes("composio_execute"), "canonical name must be present");
    assert.ok(
      !allow.includes("ctrl_composio_execute"),
      "the dead `ctrl_composio_execute` name MUST NOT be added (#659)",
    );

    // Same on workers.
    const workersAllow = readAllow(OPENCLAW_WORKERS_CONFIG_PATH);
    assert.ok(workersAllow.includes("composio_execute"));
    assert.ok(!workersAllow.includes("ctrl_composio_execute"));
  });

  it("is idempotent — a second auto-config does not duplicate composio_execute", async () => {
    seedConn({ id: "ca_gmail_new", toolkit: "gmail", status: "ACTIVE" });
    seedOpenclawConfig(["composio_execute", "sessions_send"]);

    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/ca_gmail_new/auto-config",
    );
    flush();

    assert.strictEqual(status, 200);
    assert.strictEqual(data.gateway_restart_triggered, false, "already present → no mutation");
    const allow = readAllow(OPENCLAW_CONFIG_PATH);
    const occurrences = allow.filter((t: string) => t === "composio_execute").length;
    assert.strictEqual(occurrences, 1);
  });
});
