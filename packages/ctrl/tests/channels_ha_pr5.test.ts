// Lane I — /api/v1/channels/ha/* HA bootstrap surface (#110 PR5).
//
// PR5 adds the three operator-only routes the alfred-learn
// HaBootstrapWorkflow drives:
//
//   * GET  /api/v1/channels/ha/llat                — fetch the raw LLAT
//                                                   (operator-only; 403 to
//                                                   voice-bridge / channel
//                                                   token bearers)
//   * POST /api/v1/channels/ha/registry/bulk       — batch upsert + tombstone
//                                                   vanished rows in one
//                                                   transaction
//   * POST /api/v1/channels/ha/registry/refresh    — start a one-shot
//                                                   HaBootstrapWorkflow run
//
// Coverage (10 tests):
//   1. bulk-upsert inserts new rows
//   2. bulk-upsert updates existing rows (bumps last_seen_at)
//   3. bulk-upsert tombstones rows NOT in input (vanished_at set)
//   4. bulk-upsert is idempotent (same input twice = same row count)
//   5. vanished_at is set ONCE — re-running with same vanished set doesn't re-stamp
//   6. LLAT route requires operator bearer (master AAS_API_KEY) — 401 without
//   7. LLAT route returns the raw LLAT on the master-key path
//   8. LLAT route rejects voice-bridge bearer with 403 (NOT 401)
//   9. LLAT route 404s when HA isn't connected
//  10. refresh route returns 202 + workflow_id

import { describe, it, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-pr5-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
process.env.HA_VAULTWARDEN_FOLDER = "Home Assistant";
process.env.HA_LLAT_ITEM = "LLAT";
process.env.HA_PROBE_TIMEOUT_MS = "5000";

// Synthetic placeholder — never resembles a real HA LLAT.
const VALID_LLAT = "llat_TEST_" + "0".repeat(40);
const HA_URL = "http://homeassistant.local:8123";
const HA_VERSION = "2026.5.0";

// ── fetch mock (vault-cli + HA probe; reused from PR1/PR4 patterns) ────

interface VaultItem {
  id: string;
  name: string;
  type: 1;
  folderId: string | null;
  login: { username: string | null; password: string; uris: unknown[] };
}
interface VaultFolder {
  id: string;
  name: string;
}
let vaultStore: VaultItem[] = [];
let vaultFolders: VaultFolder[] = [];

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();

  // HA probes
  if (url === `${HA_URL}/api/` && method === "GET") {
    return makeJsonResponse({ message: "API running." }, 200);
  }
  if (url === `${HA_URL}/api/config` && method === "GET") {
    return makeJsonResponse({ version: HA_VERSION }, 200);
  }

  // vault-cli folders
  if (url.endsWith("/list/object/folders") && method === "GET") {
    return makeJsonResponse({ success: true, data: { data: vaultFolders } });
  }
  if (url.endsWith("/object/folder") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const f: VaultFolder = {
      id: "fld-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6),
      name: body.name,
    };
    vaultFolders.push(f);
    return makeJsonResponse({ success: true, data: { data: f } });
  }
  // vault-cli items
  if (url.includes("/list/object/items")) {
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
    const search = params.get("search") ?? "";
    const filtered = search
      ? vaultStore.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
      : vaultStore.slice();
    return makeJsonResponse({ success: true, data: { data: filtered } });
  }
  const objMatch = url.match(/\/object\/item\/([^/?]+)/);
  if (objMatch && method === "GET") {
    const id = objMatch[1];
    const item = vaultStore.find((i) => i.id === id);
    if (!item) return makeJsonResponse({ success: false, message: "not found" }, 404);
    return makeJsonResponse({ success: true, data: { data: item } });
  }
  if (url.endsWith("/object/item") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const id =
      "id-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
    const item: VaultItem = {
      id,
      name: body.name,
      type: 1,
      folderId: body.folderId ?? null,
      login: {
        username: body.login?.username ?? null,
        password: body.login?.password ?? "",
        uris: body.login?.uris ?? [],
      },
    };
    vaultStore.push(item);
    return makeJsonResponse({ success: true, data: { data: item } });
  }
  if (objMatch && method === "PUT") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    const body = JSON.parse(String(init?.body ?? "{}"));
    vaultStore[idx] = {
      ...vaultStore[idx],
      name: body.name ?? vaultStore[idx].name,
      folderId: body.folderId ?? vaultStore[idx].folderId,
      login: { ...vaultStore[idx].login, ...(body.login ?? {}) },
    };
    return makeJsonResponse({ success: true, data: { data: vaultStore[idx] } });
  }
  if (objMatch && method === "DELETE") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true });
  }
  throw new Error(`unexpected fetch in channels_ha_pr5: ${method} ${url}`);
}) as typeof fetch;

// ── Stub out dockerExec — the refresh route calls into the temporal CLI.
//
// We mock node:child_process so the helpers.dockerExec call resolves to
// a captured no-op instead of a real spawn. The rest of helpers.ts is
// preserved unmodified, so other tests can still import from this file.

let dockerExecCalls: string[][] = [];
let dockerExecShouldFail = false;

// helpers.ts's dockerExec calls execFile under the hood; intercept that.
mock.module("node:child_process", {
  namedExports: {
    execFile: (file: string, args: string[], opts: any, cb: any) => {
      // execFile signature can be (file, args, callback) OR
      // (file, args, opts, callback) — normalise.
      const callback = typeof opts === "function" ? opts : cb;
      // First arg in our docker-exec path is "docker"; the rest is the
      // command itself. We only care about the temporal arguments —
      // strip the docker wrapper to make assertions cleaner.
      if (file === "docker" && Array.isArray(args)) {
        // args looks like: ["exec", "-T", "<service>", ...command]
        const dashTIdx = args.indexOf("-T");
        const cmd = dashTIdx >= 0 ? args.slice(dashTIdx + 2) : args.slice(1);
        dockerExecCalls.push([...cmd]);
      }
      if (dockerExecShouldFail) {
        callback(new Error("temporal unreachable"), "", "boom");
        return;
      }
      callback(null, JSON.stringify({ started: true }), "");
    },
    execFileSync: () => "",
    spawn: () => ({
      stderr: { on: () => {} },
      stdin: { write: () => {}, end: () => {} },
      on: () => {},
    }),
    spawnSync: () => ({ stdout: "", stderr: "", status: 0 }),
    exec: () => undefined,
  },
});

const {
  registerChannelsHaRoutes,
  _resetHaSubscriptionsForTests,
  _resetHaRegistryForTests,
} = await import("../src/api/routes/channels_ha.js");
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const {
  setApiKey,
  setVoiceBridgeKey,
  _resetAuthForTests,
} = await import("../src/api/auth.js");

registerChannelsHaRoutes();

interface CallResult {
  status: number;
  payload: any;
}
async function call(
  method: string,
  p: string,
  body?: unknown,
  bearer?: string,
): Promise<CallResult> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as unknown as ServerResponse;
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  try {
    await m!.handler({
      req: { method, headers, url: p } as any,
      res,
      params: m!.params,
      body,
      query: new URLSearchParams(),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

async function connectHa(): Promise<void> {
  const r = await call("POST", "/api/v1/channels/ha/connect", {
    ha_url: HA_URL,
    llat: VALID_LLAT,
    label: "Test",
  });
  assert.equal(r.status, 200, JSON.stringify(r.payload));
}

const MASTER_KEY = "test-master-" + "a".repeat(40);
const VOICE_KEY = "test-voice-" + "b".repeat(40);
const CHANNEL_KEY = "pcp_" + "c".repeat(48);

// ── tests ──────────────────────────────────────────────────────────────

describe("/api/v1/channels/ha/* — #110 PR5 registry bootstrap", () => {
  beforeEach(() => {
    vaultStore = [];
    vaultFolders = [];
    dockerExecCalls = [];
    dockerExecShouldFail = false;
    const db = getStateDb();
    try {
      db.prepare("DELETE FROM ha_connection").run();
    } catch {
      /* table missing on very first run */
    }
    _resetHaRegistryForTests();
    _resetHaSubscriptionsForTests();
    _resetAuthForTests();
  });

  // ── 1 ── insert via bulk upsert
  it("bulk upsert inserts new rows", async () => {
    const rows = [
      {
        kind: "entity",
        ha_id: "light.kitchen",
        domain: "light",
        area_id: "kitchen",
        friendly_name: "Kitchen Light",
        state: "on",
        payload_json: '{"entity_id":"light.kitchen"}',
      },
      {
        kind: "area",
        ha_id: "kitchen",
        friendly_name: "Kitchen",
        payload_json: '{"area_id":"kitchen","name":"Kitchen"}',
      },
    ];
    const r = await call("POST", "/api/v1/channels/ha/registry/bulk", { rows });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.inserted, 2);
    assert.equal(r.payload.updated, 0);
    assert.equal(r.payload.tombstoned, 0);
    assert.equal(r.payload.total_after, 2);

    const persisted = getStateDb()
      .prepare("SELECT kind, ha_id, friendly_name FROM ha_registry ORDER BY ha_id")
      .all() as Array<{ kind: string; ha_id: string; friendly_name: string }>;
    assert.equal(persisted.length, 2);
    const kitchen = persisted.find((p) => p.ha_id === "light.kitchen")!;
    assert.equal(kitchen.kind, "entity");
    assert.equal(kitchen.friendly_name, "Kitchen Light");
  });

  // ── 2 ── update bumps last_seen_at, friendly_name updates
  it("bulk upsert updates existing rows (bumps last_seen_at, friendly_name change persists)", async () => {
    // First insert
    await call("POST", "/api/v1/channels/ha/registry/bulk", {
      rows: [
        {
          kind: "entity",
          ha_id: "light.kitchen",
          domain: "light",
          friendly_name: "Old Name",
          state: "off",
          payload_json: '{"old":true}',
        },
      ],
    });
    const before = getStateDb()
      .prepare("SELECT last_seen_at, friendly_name FROM ha_registry WHERE ha_id = ?")
      .get("light.kitchen") as { last_seen_at: string; friendly_name: string };
    // Wait a millisecond so the timestamp can move.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Second insert — bumps + updates name.
    const r = await call("POST", "/api/v1/channels/ha/registry/bulk", {
      rows: [
        {
          kind: "entity",
          ha_id: "light.kitchen",
          domain: "light",
          friendly_name: "New Name",
          state: "on",
          payload_json: '{"new":true}',
        },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.inserted, 0);
    assert.equal(r.payload.updated, 1);
    assert.equal(r.payload.tombstoned, 0);

    const after = getStateDb()
      .prepare("SELECT last_seen_at, friendly_name, state FROM ha_registry WHERE ha_id = ?")
      .get("light.kitchen") as { last_seen_at: string; friendly_name: string; state: string };
    assert.equal(after.friendly_name, "New Name");
    assert.equal(after.state, "on");
    assert.notEqual(after.last_seen_at, before.last_seen_at);
  });

  // ── 3 ── tombstones rows not in input
  it("bulk upsert tombstones rows that vanished from input (vanished_at set)", async () => {
    // Seed three rows.
    await call("POST", "/api/v1/channels/ha/registry/bulk", {
      rows: [
        { kind: "entity", ha_id: "light.a", payload_json: "{}" },
        { kind: "entity", ha_id: "light.b", payload_json: "{}" },
        { kind: "entity", ha_id: "light.c", payload_json: "{}" },
      ],
    });
    // Second pull only has light.a — b + c should be tombstoned.
    const r = await call("POST", "/api/v1/channels/ha/registry/bulk", {
      rows: [{ kind: "entity", ha_id: "light.a", payload_json: "{}" }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.tombstoned, 2);

    const all = getStateDb()
      .prepare(
        "SELECT ha_id, vanished_at FROM ha_registry ORDER BY ha_id",
      )
      .all() as Array<{ ha_id: string; vanished_at: string | null }>;
    assert.equal(all.length, 3);
    const aRow = all.find((x) => x.ha_id === "light.a")!;
    const bRow = all.find((x) => x.ha_id === "light.b")!;
    const cRow = all.find((x) => x.ha_id === "light.c")!;
    assert.equal(aRow.vanished_at, null);
    assert.ok(bRow.vanished_at, "light.b must carry a vanished_at timestamp");
    assert.ok(cRow.vanished_at, "light.c must carry a vanished_at timestamp");
  });

  // ── 4 ── idempotent
  it("bulk upsert is idempotent — second identical call leaves row count unchanged", async () => {
    const rows = [
      { kind: "entity", ha_id: "light.a", payload_json: "{}" },
      { kind: "entity", ha_id: "light.b", payload_json: "{}" },
    ];
    const r1 = await call("POST", "/api/v1/channels/ha/registry/bulk", { rows });
    const r2 = await call("POST", "/api/v1/channels/ha/registry/bulk", { rows });
    assert.equal(r1.payload.total_after, 2);
    assert.equal(r2.payload.total_after, 2);
    // Second run is pure update — no inserts, no tombstones.
    assert.equal(r2.payload.inserted, 0);
    assert.equal(r2.payload.updated, 2);
    assert.equal(r2.payload.tombstoned, 0);
  });

  // ── 5 ── vanished_at stamped ONCE
  it("vanished_at is set ONCE — re-running with same vanished set doesn't re-stamp", async () => {
    // Seed two rows.
    await call("POST", "/api/v1/channels/ha/registry/bulk", {
      rows: [
        { kind: "entity", ha_id: "light.kept", payload_json: "{}" },
        { kind: "entity", ha_id: "light.gone", payload_json: "{}" },
      ],
    });
    // First "lost light.gone" pull.
    await call("POST", "/api/v1/channels/ha/registry/bulk", {
      rows: [{ kind: "entity", ha_id: "light.kept", payload_json: "{}" }],
    });
    const firstTombstone = getStateDb()
      .prepare("SELECT vanished_at FROM ha_registry WHERE ha_id = ?")
      .get("light.gone") as { vanished_at: string };
    assert.ok(firstTombstone.vanished_at);

    // Wait + run AGAIN with same input — vanished_at must NOT change.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const r = await call("POST", "/api/v1/channels/ha/registry/bulk", {
      rows: [{ kind: "entity", ha_id: "light.kept", payload_json: "{}" }],
    });
    assert.equal(r.status, 200);
    // Tombstoned count is 0 — already tombstoned rows don't re-stamp.
    assert.equal(r.payload.tombstoned, 0);
    const secondTombstone = getStateDb()
      .prepare("SELECT vanished_at FROM ha_registry WHERE ha_id = ?")
      .get("light.gone") as { vanished_at: string };
    assert.equal(secondTombstone.vanished_at, firstTombstone.vanished_at);
  });

  // ── 6 ── LLAT operator-only — 401 without bearer (when key configured)
  it("LLAT route requires operator bearer (401 with no Authorization header)", async () => {
    setApiKey(MASTER_KEY);
    await connectHa(); // populate the vault item

    const r = await call("GET", "/api/v1/channels/ha/llat");
    assert.equal(r.status, 401, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "UNAUTHORIZED");
    // The LLAT must not appear in the error envelope.
    assert.ok(!JSON.stringify(r.payload).includes(VALID_LLAT));
  });

  // ── 7 ── LLAT route returns LLAT on master-key path
  it("LLAT route returns the raw LLAT on the master-key (operator) bearer", async () => {
    setApiKey(MASTER_KEY);
    await connectHa();
    const r = await call("GET", "/api/v1/channels/ha/llat", undefined, MASTER_KEY);
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.llat, VALID_LLAT);
  });

  // ── 8 ── LLAT route rejects voice-bridge bearer with 403 (not 401)
  it("LLAT route rejects voice-bridge bearer with 403 (operator-only)", async () => {
    setApiKey(MASTER_KEY);
    setVoiceBridgeKey(VOICE_KEY);
    await connectHa();
    const r = await call("GET", "/api/v1/channels/ha/llat", undefined, VOICE_KEY);
    assert.equal(r.status, 403, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "FORBIDDEN");
    // No LLAT leak.
    assert.ok(!JSON.stringify(r.payload).includes(VALID_LLAT));
  });

  // ── 8b ── unknown channel-token bearer also 403
  it("LLAT route rejects channel-token bearer with 403", async () => {
    setApiKey(MASTER_KEY);
    await connectHa();
    const r = await call("GET", "/api/v1/channels/ha/llat", undefined, CHANNEL_KEY);
    assert.equal(r.status, 403, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "FORBIDDEN");
  });

  // ── 9 ── LLAT 404 when HA isn't connected
  it("LLAT route 404s when HA is not connected", async () => {
    setApiKey(MASTER_KEY);
    const r = await call("GET", "/api/v1/channels/ha/llat", undefined, MASTER_KEY);
    assert.equal(r.status, 404, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "NOT_FOUND");
  });

  // ── 10 ── refresh route returns 202 + workflow_id
  it("refresh route returns 202 + workflow_id, calls temporal CLI", async () => {
    await connectHa();
    const r = await call("POST", "/api/v1/channels/ha/registry/refresh");
    assert.equal(r.status, 202, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.ok(
      typeof r.payload.workflow_id === "string" &&
        r.payload.workflow_id.startsWith("ha-bootstrap-"),
      "workflow_id must be present and prefixed",
    );
    assert.equal(r.payload.eta, "30s");
    // The dockerExec mock recorded the temporal CLI invocation.
    const dockerCall = dockerExecCalls.find((c) =>
      c.includes("HaBootstrapWorkflow"),
    );
    assert.ok(dockerCall, "temporal CLI must be invoked with HaBootstrapWorkflow");
    assert.ok(
      dockerCall.includes("alfred-learn"),
      "task-queue must be alfred-learn",
    );
  });

  // ── 10b ── refresh 409 when HA isn't connected
  it("refresh route 409s when HA is not connected", async () => {
    const r = await call("POST", "/api/v1/channels/ha/registry/refresh");
    assert.equal(r.status, 409, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "CONFLICT");
  });
});
