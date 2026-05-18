// Tests for POST /api/v1/integrations/:id/reconnect (#635) and the
// reconnect ledger / reaper machinery.
//
// Coverage:
//   - happy path: reconnect issues a NEW connection link, persists ledger,
//     leaves old connection alive (no synchronous DELETE call to Composio).
//   - 404 on unknown connection id (no ledger entry written).
//   - 404 on cross-tenant id (ownership mismatch).
//   - cleanup-not-fake guarantee: the reaper does NOT delete the old
//     connection while the new one is still INITIATED, even with force=1.
//   - cleanup happy path: with force=1 + new connection ACTIVE, the reaper
//     deletes the old one and removes the ledger entry.

import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// In-memory state mocks
// ---------------------------------------------------------------------------

// Mock Composio backend. fetch is intercepted at the global level.
type FakeConn = {
  id: string;
  toolkit: { slug: string };
  user_id: string;
  member_id?: string;
  auth_config: { id: string };
  status: string;
  expires_at?: string | null;
};
const composioConns: Map<string, FakeConn> = new Map();
const deletedConns: Set<string> = new Set();

// Calls Composio actually received (for assertions).
const composioCalls: Array<{ method: string; url: string; body?: any }> = [];

// Fresh-id generator for new connected_accounts created by the reconnect path.
let nextNewIdCounter = 0;
function nextNewId(): string {
  nextNewIdCounter += 1;
  return `ca_new_${nextNewIdCounter}`;
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  let parsedBody: any;
  if (init?.body) {
    try { parsedBody = JSON.parse(init.body); } catch { /* ignore */ }
  }
  composioCalls.push({ method, url: u, body: parsedBody });

  // GET /api/v3/connected_accounts/:id
  const getMatch = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (method === "GET" && getMatch) {
    const id = decodeURIComponent(getMatch[1]);
    if (deletedConns.has(id)) {
      return new Response("Not found", { status: 404 });
    }
    const conn = composioConns.get(id);
    if (!conn) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(conn), { status: 200, headers: { "content-type": "application/json" } });
  }

  // POST /api/v3/connected_accounts (create new)
  if (method === "POST" && u.endsWith("/api/v3/connected_accounts")) {
    const body = parsedBody ?? {};
    const newId = nextNewId();
    const userId = body?.connection?.user_id ?? "alfred-test-user";
    const conn: FakeConn = {
      id: newId,
      // Toolkit slug will be re-attached by the reconnect endpoint via the
      // OLD connection lookup, but we still echo it through for realism by
      // looking up the auth_config_id → toolkit (kept simple here).
      toolkit: { slug: "googlecalendar" },
      user_id: userId,
      member_id: userId,
      auth_config: { id: body?.auth_config?.id ?? "ac_test" },
      status: "INITIATED",
    };
    composioConns.set(newId, conn);
    return new Response(
      JSON.stringify({
        id: newId,
        status: "INITIATED",
        redirect_url: `https://composio.dev/oauth/${newId}`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
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

  // Pass-through for anything not matched (returns 501 so it's loud).
  return new Response(JSON.stringify({ error: "unmocked", url: u, method }), { status: 501 });
}) as typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// In-memory file-system mock — covers the ledger file + skill/streams paths
// ---------------------------------------------------------------------------

const memFs: Map<string, string> = new Map();

const fsMock = {
  existsSync: mock.fn((p: string) => memFs.has(p)),
  readFileSync: mock.fn((p: string) => {
    if (!memFs.has(p)) {
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as any;
      err.code = "ENOENT";
      throw err;
    }
    return memFs.get(p)!;
  }),
  writeFileSync: mock.fn((p: string, data: any) => {
    memFs.set(p, typeof data === "string" ? data : String(data));
  }),
  mkdirSync: mock.fn(() => {}),
  readdirSync: mock.fn(() => [] as any[]),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: mock.fn((p: string) => { memFs.delete(p); }),
  renameSync: mock.fn((from: string, to: string) => {
    if (memFs.has(from)) {
      memFs.set(to, memFs.get(from)!);
      memFs.delete(from);
    }
  }),
  appendFileSync: mock.fn(),
  rmSync: mock.fn(),
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

// child_process mock — never invoked by reconnect, but the routes module imports it.
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

const { createApiServer } = await import("../src/api/server.js");

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
  nextNewIdCounter = 0;
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
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
// Fixtures
// ---------------------------------------------------------------------------

function seedOldConn(opts?: Partial<FakeConn>): FakeConn {
  const conn: FakeConn = {
    id: "ca_old_calendar",
    toolkit: { slug: "googlecalendar" },
    user_id: "alfred-test-user",
    member_id: "alfred-test-user",
    auth_config: { id: "ac_calendar_oauth" },
    status: "EXPIRED",
    expires_at: "2026-04-01T00:00:00Z",
    ...opts,
  };
  composioConns.set(conn.id, conn);
  return conn;
}

function readLedger(): any[] {
  const raw = memFs.get("/alfred-data/.composio-reconnect-ledger.json");
  if (!raw) return [];
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/integrations/:id/reconnect — happy path", () => {
  it("returns a new OAuth link and persists a ledger entry without deleting the old connection", async () => {
    seedOldConn();

    const { status, data } = await req("POST", "/api/v1/integrations/ca_old_calendar/reconnect");

    assert.strictEqual(status, 200, `expected 200, got ${status} (${JSON.stringify(data)})`);
    assert.strictEqual(data.old_connection_id, "ca_old_calendar");
    assert.match(data.new_connection_id, /^ca_new_\d+$/);
    assert.match(data.new_connection_link, /^https:\/\/composio\.dev\/oauth\//);
    assert.strictEqual(data.app, "googlecalendar");
    assert.strictEqual(data.toolkit, "googlecalendar");
    assert.strictEqual(data.expires_at, "2026-04-01T00:00:00Z");
    assert.strictEqual(typeof data.cleanup_after_ms, "number");
    assert.strictEqual(data.grace_window_seconds, 3600);
    assert.match(data.instructions, /1 hour/i);

    // The old connection MUST still be alive — no synchronous DELETE.
    const deleteCalls = composioCalls.filter(
      (c) => c.method === "DELETE" && c.url.includes("ca_old_calendar"),
    );
    assert.strictEqual(deleteCalls.length, 0, "reconnect must NOT delete the old connection synchronously");
    assert.ok(composioConns.has("ca_old_calendar"), "old connection should still be present after reconnect");

    // The ledger should have one entry.
    const ledger = readLedger();
    assert.strictEqual(ledger.length, 1);
    assert.strictEqual(ledger[0].old_connection_id, "ca_old_calendar");
    assert.strictEqual(ledger[0].new_connection_id, data.new_connection_id);
    assert.strictEqual(ledger[0].toolkit, "googlecalendar");
    assert.strictEqual(ledger[0].user_id, "alfred-test-user");
    assert.ok(ledger[0].cleanup_after > Date.now(), "cleanup_after should be in the future");
  });
});

describe("POST /api/v1/integrations/:id/reconnect — 404 cases", () => {
  it("returns 404 for an unknown connection id and writes no ledger entry", async () => {
    const { status, data } = await req("POST", "/api/v1/integrations/ca_does_not_exist/reconnect");
    assert.strictEqual(status, 404);
    assert.match(data.error, /not found/i);
    assert.strictEqual(readLedger().length, 0, "no ledger entry should be written on 404");
  });

  it("returns 404 (not 403) for a cross-tenant connection id (ownership mismatch)", async () => {
    seedOldConn({
      id: "ca_other_tenant",
      user_id: "different-tenant-user",
      member_id: "different-tenant-user",
    });
    const { status } = await req("POST", "/api/v1/integrations/ca_other_tenant/reconnect");
    // Per assertConnectionOwnedByTenant, mismatch → 404 to prevent enumeration.
    assert.strictEqual(status, 404);
    assert.strictEqual(readLedger().length, 0);
  });
});

describe("POST /api/v1/integrations/reconnect-cleanup — cleanup-not-fake guarantee", () => {
  it("does NOT delete the old connection while the new one is still INITIATED, even with force=1", async () => {
    seedOldConn();
    const { data: reconnectData } = await req("POST", "/api/v1/integrations/ca_old_calendar/reconnect");
    const newId = reconnectData.new_connection_id;
    // New connection from the create endpoint is seeded with status: "INITIATED".
    assert.strictEqual(composioConns.get(newId)?.status, "INITIATED");

    const { status, data } = await req("POST", "/api/v1/integrations/reconnect-cleanup?force=1");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.deleted, [], "must not delete while new connection is INITIATED");
    assert.deepStrictEqual(data.kept, ["ca_old_calendar"], "should keep the entry for retry");
    assert.strictEqual(data.ledger_size_remaining, 1, "ledger entry kept for next retry");
    assert.ok(composioConns.has("ca_old_calendar"), "old connection still alive — Sir is no worse off");
  });

  it("deletes the old connection and clears the ledger once the new one is ACTIVE", async () => {
    seedOldConn();
    const { data: reconnectData } = await req("POST", "/api/v1/integrations/ca_old_calendar/reconnect");
    const newId = reconnectData.new_connection_id;

    // Simulate Sir completing the OAuth handshake.
    const newConn = composioConns.get(newId)!;
    newConn.status = "ACTIVE";

    const { status, data } = await req("POST", "/api/v1/integrations/reconnect-cleanup?force=1");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.deleted, ["ca_old_calendar"]);
    assert.deepStrictEqual(data.kept, []);
    assert.strictEqual(data.ledger_size_remaining, 0);
    assert.ok(!composioConns.has("ca_old_calendar"), "old connection should be deleted");
    assert.ok(deletedConns.has("ca_old_calendar"), "DELETE call should have hit Composio");
  });

  it("purges the ledger entry if the new connection itself was already removed", async () => {
    seedOldConn();
    const { data: reconnectData } = await req("POST", "/api/v1/integrations/ca_old_calendar/reconnect");
    const newId = reconnectData.new_connection_id;
    composioConns.delete(newId); // simulate the new connection being lost

    const { status, data } = await req("POST", "/api/v1/integrations/reconnect-cleanup?force=1");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.purged, ["ca_old_calendar"]);
    assert.deepStrictEqual(data.deleted, []);
    assert.strictEqual(data.ledger_size_remaining, 0);
    // Old connection survives — purge means we stopped tracking it, not that we deleted it.
    assert.ok(composioConns.has("ca_old_calendar"), "old connection remains untouched on purge");
  });

  it("respects the grace window — without force=1, fresh entries are deferred", async () => {
    seedOldConn();
    await req("POST", "/api/v1/integrations/ca_old_calendar/reconnect");
    const newId = readLedger()[0].new_connection_id;
    composioConns.get(newId)!.status = "ACTIVE";

    // Default cleanup (no force) — entry just written, cleanup_after is 1h away.
    const { status, data } = await req("POST", "/api/v1/integrations/reconnect-cleanup");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.deleted, [], "fresh entries must not be deleted before grace window elapses");
    assert.strictEqual(data.ledger_size_remaining, 1);
    assert.ok(composioConns.has("ca_old_calendar"));
  });
});
