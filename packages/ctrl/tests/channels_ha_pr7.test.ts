// Issue #115 PR7 — HA core lifecycle + backup CRUD integration tests.
//
// PR7 adds 11 routes fronting:
//   - REST `/api/services/homeassistant/{check_config,restart,reload_all}`
//   - REST `/api/config` (version)
//   - WS `supervisor/api {endpoint: '/core/update'}`
//   - WS `backup/{info,details,generate,delete,restore}`
//   - WS `backup/strategy/{info,update}`
//
// Plus a ledger surface `/backups/ledger` reading our own
// `ha_backup_ref` rows.
//
// Coverage (12 tests):
//   1.  GET /version returns ha_version + installation_type from /api/config.
//   2.  POST /core/check_config — no gate, POSTs to /api/services/homeassistant/check_config.
//   3.  POST /core/reload_yaml — no gate, POSTs to .../reload_all.
//   4.  POST /core/restart — auto-snapshots + records daybook + responds with backup_ref_id.
//   5.  POST /core/restart without decision_ref → 400.
//   6.  POST /core/update — gated, snapshot, WS supervisor/api carries /core/update endpoint
//       (and version pin when supplied).
//   7.  GET /backups — WS backup/info, returns data.
//   8.  POST /backups (create) — no gate, records ha_backup_ref with triggered_by='user'.
//   9.  DELETE /backups/:id — gated, daybook entry written.
//   10. POST /backups/:id/restore — gated, NO new snapshot row (restoring IS the recovery action).
//   11. GET /backups/strategy + PUT /backups/strategy (gated).
//   12. GET /backups/ledger — reads ha_backup_ref, indexed by triggered_by.
//
// Test plumbing
// -------------
// Mirrors the addons test (fetch-mock for REST) + the ha_ws_client test
// (in-process WebSocketServer for the WS verbs). The two surfaces don't
// interfere — REST goes through `fetch`, WS through the long-lived
// `HaWsClient` singleton.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import type { ServerResponse } from "node:http";

// ── env (must be set before module imports) ────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-pr7-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
process.env.HA_VAULTWARDEN_FOLDER = "Home Assistant";
process.env.HA_LLAT_ITEM = "LLAT";
process.env.HA_PROBE_TIMEOUT_MS = "5000";
process.env.HA_WRITE_TIMEOUT_MS = "5000";
process.env.HA_CORE_REST_TIMEOUT_MS = "5000";
process.env.HA_BACKUP_WS_TIMEOUT_MS = "5000";
process.env.HA_CORE_UPDATE_WS_TIMEOUT_MS = "5000";
process.env.HA_WS_AUTOSTART = "false";

const VALID_LLAT = "llat_TEST_" + "0".repeat(40);
const HA_URL = "http://homeassistant.local:8123";
const HA_VERSION = "2025.6.1";

// ── fake HA WS server ──────────────────────────────────────────────────

let server: http.Server;
let wss: WebSocketServer;
let serverPort = 0;
const liveSockets: WSWebSocket[] = [];

interface WsRouteResp {
  success?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * Map of WS message-type → response. Tests mutate this between cases.
 * Default 'success: true, result: {}' for unset types.
 */
let wsRoutes: Map<string, WsRouteResp> = new Map();
const wsLog: Array<Record<string, unknown>> = [];

function setupServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    server = http.createServer();
    wss = new WebSocketServer({ server, path: "/api/websocket" });
    wss.on("connection", (ws) => {
      liveSockets.push(ws);
      ws.send(JSON.stringify({ type: "auth_required", ha_version: HA_VERSION }));
      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        wsLog.push(msg);
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok" }));
          return;
        }
        const id = msg.id;
        // subscribe_events — Tier 4 event streams the client subscribes to.
        if (msg.type === "subscribe_events") {
          ws.send(JSON.stringify({ id, type: "result", success: true, result: null }));
          return;
        }
        const type = String(msg.type);
        const resp = wsRoutes.get(type) ?? {
          success: true,
          result: {},
        };
        ws.send(
          JSON.stringify({
            id,
            type: "result",
            success: resp.success ?? true,
            ...(resp.result !== undefined ? { result: resp.result } : {}),
            ...(resp.error !== undefined ? { error: resp.error } : {}),
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") serverPort = addr.port;
      resolve();
    });
  });
}

function teardownServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    for (const s of liveSockets) {
      try {
        s.terminate();
      } catch {
        // best-effort
      }
    }
    liveSockets.length = 0;
    wss?.close(() => {
      server?.close(() => resolve());
    });
  });
}

// ── fetch mock (REST surface — homeassistant.* + /api/config + vault-cli) ──

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

interface RestResp {
  status?: number;
  body?: unknown;
}
let restRoutes: Map<string, RestResp> = new Map();
const restCalls: { url: string; method: string; body: string | undefined }[] = [];

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
  const bodyRaw = init?.body !== undefined ? String(init.body) : undefined;
  restCalls.push({ url, method, body: bodyRaw });

  // HA /api/ auth gate.
  if (url === `${HA_URL}/api/` && method === "GET") {
    return makeJsonResponse({ message: "API running." }, 200);
  }
  // HA /api/config — used by /connect AND by PR7's /version route.
  if (url === `${HA_URL}/api/config` && method === "GET") {
    return makeJsonResponse(
      {
        version: HA_VERSION,
        installation_type: "Home Assistant OS",
        location_name: "Home",
      },
      200,
    );
  }
  // homeassistant.* services.
  const haServiceMatch = url.match(
    /^http:\/\/homeassistant\.local:8123(\/api\/services\/homeassistant\/[a-z_]+)$/,
  );
  if (haServiceMatch && method === "POST") {
    const key = `POST ${haServiceMatch[1]}`;
    const r = restRoutes.get(key);
    if (r === undefined) {
      return makeJsonResponse([], 200);
    }
    return makeJsonResponse(r.body ?? [], r.status ?? 200);
  }

  // vault-cli folders + items.
  if (url.endsWith("/list/object/folders") && method === "GET") {
    return makeJsonResponse({ success: true, data: { data: vaultFolders } });
  }
  if (url.endsWith("/object/folder") && method === "POST") {
    const b = JSON.parse(bodyRaw ?? "{}");
    const f: VaultFolder = {
      id: "fld-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6),
      name: b.name,
    };
    vaultFolders.push(f);
    return makeJsonResponse({ success: true, data: f });
  }
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
    // Two callers read this endpoint with different envelope expectations:
    //  - channels_ha.ts:readHaLlat (post-23917969 fix) reads single-wrapped
    //    `data.login.password`
    //  - ha_ws_client.ts:readHaLlat (PR1 of #115) reads double-wrapped
    //    `data.data.login.password`
    // We satisfy both by returning a payload with both shapes — the
    // outer `data` is the item itself (single-wrapped) AND it embeds
    // `data: {login: {password}}` (double-wrapped) for the WS client.
    return makeJsonResponse({
      success: true,
      data: {
        ...item,
        data: { login: { password: item.login.password } },
      },
    });
  }
  if (url.endsWith("/object/item") && method === "POST") {
    const b = JSON.parse(bodyRaw ?? "{}");
    const id = "id-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
    const item: VaultItem = {
      id,
      name: b.name,
      type: 1,
      folderId: b.folderId ?? null,
      login: {
        username: b.login?.username ?? null,
        password: b.login?.password ?? "",
        uris: b.login?.uris ?? [],
      },
    };
    vaultStore.push(item);
    return makeJsonResponse({ success: true, data: item });
  }
  if (objMatch && method === "PUT") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    const b = JSON.parse(bodyRaw ?? "{}");
    vaultStore[idx] = {
      ...vaultStore[idx],
      name: b.name ?? vaultStore[idx].name,
      folderId: b.folderId ?? vaultStore[idx].folderId,
      login: { ...vaultStore[idx].login, ...(b.login ?? {}) },
    };
    return makeJsonResponse({ success: true, data: vaultStore[idx] });
  }
  if (objMatch && method === "DELETE") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true });
  }
  throw new Error(`unexpected fetch in test_channels_ha_pr7: ${method} ${url}`);
}) as typeof fetch;

// ── server up + module imports ─────────────────────────────────────────

await setupServer();
process.env.HA_WS_URL_OVERRIDE = `ws://127.0.0.1:${serverPort}/api/websocket`;

const {
  registerChannelsHaRoutes,
  _resetHaSubscriptionsForTests,
  _resetHaAddonsForTests,
  _resetHaInstallationTypeCache,
} = await import("../src/api/routes/channels_ha.js");
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const { _resetHaWsClientForTests, getHaWsClient } = await import(
  "../src/api/lib/ha_ws_client.js"
);

registerChannelsHaRoutes();

// ── helpers ────────────────────────────────────────────────────────────

interface CallResult {
  status: number;
  payload: any;
}

async function call(
  method: string,
  p: string,
  body?: unknown,
): Promise<CallResult> {
  const qIdx = p.indexOf("?");
  const pathname = qIdx >= 0 ? p.slice(0, qIdx) : p;
  const query = new URLSearchParams(qIdx >= 0 ? p.slice(qIdx + 1) : "");
  const m = matchRoute(method, pathname);
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
  try {
    await m!.handler({
      req: { method, headers: {}, url: p } as any,
      res,
      params: m!.params,
      body,
      query,
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

/** Ensure the HA WS client is freshly authed against the fake HA server.
 *  Called at the top of every test that exercises a WS verb. */
async function ensureWsAuthed(): Promise<void> {
  const client = getHaWsClient();
  client.start();
  // Drive a probe call so we know the client is past auth_ok.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const tick = () => {
      const s = client.getStatus();
      if (s.connected) return resolve();
      if (Date.now() > deadline) {
        return reject(
          new Error(
            `WS never reached connected state (last_error=${s.last_error ?? "none"})`,
          ),
        );
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

// ── tests ──────────────────────────────────────────────────────────────

describe("/api/v1/channels/ha/* — #115 PR7 core + backups", () => {
  before(async () => {
    // First-time DB init.
    getStateDb();
  });

  beforeEach(() => {
    vaultStore = [];
    vaultFolders = [];
    restCalls.length = 0;
    restRoutes = new Map();
    wsLog.length = 0;
    wsRoutes = new Map();
    const db = getStateDb();
    try {
      db.prepare("DELETE FROM ha_connection").run();
      db.prepare("DELETE FROM ha_run").run();
      db.prepare("DELETE FROM ha_proposal").run();
      db.prepare("DELETE FROM ha_snapshot").run();
      db.prepare("DELETE FROM ha_event").run();
      db.prepare("DELETE FROM ha_event_subscription").run();
      db.prepare("DELETE FROM ha_backup_ref").run();
    } catch {
      // first run before tables exist
    }
    _resetHaSubscriptionsForTests();
    _resetHaAddonsForTests();
    _resetHaInstallationTypeCache();
    _resetHaWsClientForTests();
  });

  after(async () => {
    _resetHaWsClientForTests();
    await teardownServer();
    globalThis.fetch = originalFetch;
  });

  // ── 1 ── version
  it("GET /version returns ha_version + installation_type from /api/config", async () => {
    await connectHa();
    const r = await call("GET", "/api/v1/channels/ha/version");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ha_version, HA_VERSION);
    assert.equal(r.payload.installation_type, "Home Assistant OS");
    assert.equal(r.payload.location_name, "Home");
    assert.ok(r.payload.data);
  });

  // ── 2 ── check_config (no gate)
  it("POST /core/check_config posts to /api/services/homeassistant/check_config", async () => {
    await connectHa();
    restRoutes.set("POST /api/services/homeassistant/check_config", {
      body: [],
    });
    const r = await call("POST", "/api/v1/channels/ha/core/check_config");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    // Confirm we hit the right upstream path.
    const hit = restCalls.find((c) =>
      c.url.endsWith("/api/services/homeassistant/check_config") &&
      c.method === "POST",
    );
    assert.ok(hit, "check_config must POST to homeassistant.check_config service");
  });

  // ── 3 ── reload_yaml (no gate)
  it("POST /core/reload_yaml posts to /api/services/homeassistant/reload_all", async () => {
    await connectHa();
    restRoutes.set("POST /api/services/homeassistant/reload_all", { body: [] });
    const r = await call("POST", "/api/v1/channels/ha/core/reload_yaml");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    const hit = restCalls.find((c) =>
      c.url.endsWith("/api/services/homeassistant/reload_all") &&
      c.method === "POST",
    );
    assert.ok(hit, "reload_yaml must POST to homeassistant.reload_all service");
  });

  // ── 4 ── restart (gated + auto-snapshot)
  it("POST /core/restart auto-snapshots BEFORE the restart + records ha_backup_ref + daybook", async () => {
    await connectHa();
    await ensureWsAuthed();
    // backup/generate returns a slug — drives triggerBackupBeforeAction.
    wsRoutes.set("backup/generate", { success: true, result: { slug: "bk_abc123" } });
    restRoutes.set("POST /api/services/homeassistant/restart", { body: [] });

    const decision_ref = "decision/2026-05-29-restart.md";
    const r = await call(
      "POST",
      "/api/v1/channels/ha/core/restart",
      { decision_ref },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.decision_ref, decision_ref);
    assert.equal(r.payload.ha_backup_id, "bk_abc123");
    assert.ok(typeof r.payload.backup_ref_id === "string");
    assert.match(r.payload.backup_name, /^alfred-pre-ha__core_restart-\d{8}T\d{6}$/);

    // ha_backup_ref row landed.
    const refs = getStateDb()
      .prepare("SELECT * FROM ha_backup_ref")
      .all() as any[];
    assert.equal(refs.length, 1);
    assert.equal(refs[0].triggered_by, "ha__core_restart");
    assert.equal(refs[0].decision_ref, decision_ref);
    assert.equal(refs[0].ha_backup_id, "bk_abc123");

    // Daybook entry landed under HA writes.
    const day = new Date().toISOString().slice(0, 10);
    const dayPath = path.join(process.env.VAULT_PATH!, "daybook", `${day}.md`);
    const body = fs.readFileSync(dayPath, "utf-8");
    assert.match(body, /action: ha__core_restart/);
    assert.match(body, /## HA writes/);
  });

  // ── 5 ── restart without decision_ref → 400
  it("POST /core/restart without decision_ref → 400 VALIDATION_ERROR", async () => {
    await connectHa();
    const r = await call("POST", "/api/v1/channels/ha/core/restart", {});
    assert.equal(r.status, 400, JSON.stringify(r.payload));
    assert.equal(r.payload.error?.code, "VALIDATION_ERROR");
  });

  // ── 6 ── update (gated + snapshot, WS supervisor/api carries the endpoint)
  it("POST /core/update — WS supervisor/api endpoint=/core/update + version pin", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("backup/generate", { success: true, result: { slug: "bk_upd123" } });
    wsRoutes.set("supervisor/api", { success: true, result: { ok: true } });

    const r = await call("POST", "/api/v1/channels/ha/core/update", {
      version: "2025.7.0",
      decision_ref: "decision/2026-05-29-update.md",
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.target_version, "2025.7.0");
    assert.equal(r.payload.ha_backup_id, "bk_upd123");

    // supervisor/api was called with the right payload.
    const supervisorCall = wsLog.find((m) => m.type === "supervisor/api");
    assert.ok(supervisorCall, "supervisor/api WS call must have been issued");
    assert.equal(supervisorCall!.endpoint, "/core/update");
    assert.equal(supervisorCall!.method, "post");
    assert.deepEqual(supervisorCall!.data, { version: "2025.7.0" });
  });

  // ── 7 ── list backups (WS backup/info)
  it("GET /backups returns WS backup/info data", async () => {
    await connectHa();
    await ensureWsAuthed();
    const fakeBackups = {
      backups: [
        { slug: "bk_one", name: "Auto 2026-05-29", date: "2026-05-29T03:00:00Z" },
        { slug: "bk_two", name: "Manual", date: "2026-05-28T19:00:00Z" },
      ],
    };
    wsRoutes.set("backup/info", { success: true, result: fakeBackups });

    const r = await call("GET", "/api/v1/channels/ha/backups");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.deepEqual(r.payload.data, fakeBackups);
    // Confirm the WS call fired.
    const wsCall = wsLog.find((m) => m.type === "backup/info");
    assert.ok(wsCall, "backup/info WS call must have been issued");
  });

  // ── 8 ── create backup (no gate, ha_backup_ref row triggered_by='user')
  it("POST /backups creates a backup + records ha_backup_ref with triggered_by='user'", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("backup/generate", { success: true, result: { slug: "bk_user_made" } });

    const r = await call("POST", "/api/v1/channels/ha/backups", {
      name: "alfred-pre-zwave",
      include_database: false,
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ha_backup_id, "bk_user_made");
    assert.ok(typeof r.payload.backup_ref_id === "string");

    // ledger has one user-triggered row.
    const refs = getStateDb()
      .prepare("SELECT * FROM ha_backup_ref")
      .all() as any[];
    assert.equal(refs.length, 1);
    assert.equal(refs[0].triggered_by, "user");
    assert.equal(refs[0].decision_ref, null);
    assert.equal(refs[0].ha_backup_id, "bk_user_made");

    // Confirm payload was forwarded (name + include_database).
    const wsCall = wsLog.find((m) => m.type === "backup/generate");
    assert.ok(wsCall);
    assert.equal(wsCall!.name, "alfred-pre-zwave");
    assert.equal(wsCall!.include_database, false);
  });

  // ── 9 ── delete backup (gated, daybook entry)
  it("DELETE /backups/:id requires decision_ref + writes daybook entry", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("backup/delete", { success: true, result: { ok: true } });

    // missing decision_ref → 400.
    const bad = await call(
      "DELETE",
      "/api/v1/channels/ha/backups/bk_abc",
      {},
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.payload.error?.code, "VALIDATION_ERROR");

    // happy path.
    const decision_ref = "decision/2026-05-29-prune.md";
    const ok = await call(
      "DELETE",
      "/api/v1/channels/ha/backups/bk_abc",
      { decision_ref },
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    assert.equal(ok.payload.backup_id, "bk_abc");
    assert.equal(ok.payload.decision_ref, decision_ref);

    // Daybook entry.
    const day = new Date().toISOString().slice(0, 10);
    const dayPath = path.join(process.env.VAULT_PATH!, "daybook", `${day}.md`);
    const body = fs.readFileSync(dayPath, "utf-8");
    assert.match(body, /action: ha__delete_backup/);
    assert.match(body, new RegExp(`decision_ref: ${decision_ref.replace(/[/.]/g, "\\$&")}`));

    // WS call had the right backup_id.
    const wsCall = wsLog.find((m) => m.type === "backup/delete");
    assert.ok(wsCall);
    assert.equal(wsCall!.backup_id, "bk_abc");
  });

  // ── 10 ── restore backup (gated, NO new snapshot)
  it("POST /backups/:id/restore — gated, NO ha_backup_ref row added (restoring IS recovery)", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("backup/restore", { success: true, result: { ok: true } });

    // missing decision_ref → 400.
    const bad = await call(
      "POST",
      "/api/v1/channels/ha/backups/bk_abc/restore",
      {},
    );
    assert.equal(bad.status, 400);

    // happy path.
    const decision_ref = "decision/2026-05-29-restore.md";
    const r = await call(
      "POST",
      "/api/v1/channels/ha/backups/bk_abc/restore",
      { decision_ref, password: "secret" },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));

    // No ha_backup_ref row added by the restore.
    const refs = getStateDb()
      .prepare("SELECT * FROM ha_backup_ref")
      .all() as any[];
    assert.equal(refs.length, 0);

    // WS payload carried backup_id + password.
    const wsCall = wsLog.find((m) => m.type === "backup/restore");
    assert.ok(wsCall);
    assert.equal(wsCall!.backup_id, "bk_abc");
    assert.equal(wsCall!.password, "secret");
  });

  // ── 11 ── strategy GET + PUT (gated)
  it("GET /backups/strategy + PUT /backups/strategy (gated)", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("backup/strategy/info", {
      success: true,
      result: { days: 7, time: "03:00:00" },
    });
    wsRoutes.set("backup/strategy/update", { success: true, result: { ok: true } });

    // GET — no gate.
    const get = await call("GET", "/api/v1/channels/ha/backups/strategy");
    assert.equal(get.status, 200);
    assert.equal(get.payload.data.days, 7);

    // PUT without decision_ref → 400.
    const bad = await call(
      "PUT",
      "/api/v1/channels/ha/backups/strategy",
      { strategy: { days: 14 } },
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.payload.error?.code, "VALIDATION_ERROR");

    // PUT without strategy → 400.
    const bad2 = await call(
      "PUT",
      "/api/v1/channels/ha/backups/strategy",
      { decision_ref: "decision/2026-05-29-strat.md" },
    );
    assert.equal(bad2.status, 400);

    // happy path.
    const ok = await call(
      "PUT",
      "/api/v1/channels/ha/backups/strategy",
      {
        decision_ref: "decision/2026-05-29-strat.md",
        strategy: { days: 14, time: "04:00:00" },
      },
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    // WS call carried the strategy body.
    const wsCall = wsLog.find((m) => m.type === "backup/strategy/update");
    assert.ok(wsCall);
    assert.equal(wsCall!.days, 14);
    assert.equal(wsCall!.time, "04:00:00");
  });

  // ── 12 ── ledger surface reads ha_backup_ref, indexed by triggered_by
  it("GET /backups/ledger reads ha_backup_ref, properly indexed by triggered_by", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("backup/generate", { success: true, result: { slug: "bk_X" } });

    // Seed: one auto-snapshot via /core/restart, one user-initiated via
    // /backups create, one direct ha_backup_ref row (simulating
    // strategy:auto from HA's own scheduler that the PR1 drain would
    // populate on later PRs).
    restRoutes.set("POST /api/services/homeassistant/restart", { body: [] });
    await call(
      "POST",
      "/api/v1/channels/ha/core/restart",
      { decision_ref: "decision/2026-05-29-restart.md" },
    );
    // Reset backup/generate slug for the user-initiated create so we get a
    // different ha_backup_id.
    wsRoutes.set("backup/generate", { success: true, result: { slug: "bk_user_Y" } });
    await call("POST", "/api/v1/channels/ha/backups", { name: "Manual" });
    // Direct insert: strategy:auto row.
    getStateDb()
      .prepare(
        `INSERT INTO ha_backup_ref (id, ha_backup_id, triggered_by, decision_ref, ts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "01J_STRATEGY_TEST_ROW_____",
        "bk_strategy_Z",
        "strategy:auto",
        null,
        new Date().toISOString(),
      );

    const r = await call("GET", "/api/v1/channels/ha/backups/ledger");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.count, 3);
    const byKind: Record<string, number> = {};
    for (const ref of r.payload.refs) {
      byKind[ref.triggered_by] = (byKind[ref.triggered_by] ?? 0) + 1;
    }
    assert.equal(byKind["ha__core_restart"], 1, "auto-snapshot row present");
    assert.equal(byKind["user"], 1, "user-initiated backup row present");
    assert.equal(byKind["strategy:auto"], 1, "strategy:auto row present");

    // ?days=N narrows the window. Insert an old row, confirm it gets
    // filtered.
    getStateDb()
      .prepare(
        `INSERT INTO ha_backup_ref (id, ha_backup_id, triggered_by, decision_ref, ts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "01J_OLD_TEST_ROW_________",
        "bk_old_X",
        "user",
        null,
        // 60 days ago.
        new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(),
      );

    const narrow = await call(
      "GET",
      "/api/v1/channels/ha/backups/ledger?days=7",
    );
    assert.equal(narrow.payload.count, 3, "60d-old row filtered out");
    const wide = await call(
      "GET",
      "/api/v1/channels/ha/backups/ledger?days=120",
    );
    assert.equal(wide.payload.count, 4, "60d-old row included with 120d window");
  });
});
