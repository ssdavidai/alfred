// Issue #115/#158 PR2 — HA registries CRUD integration tests.
//
// PR2 adds 14 routes fronting HA's four WS-only registries:
//
//   areas    : GET / POST / PUT / DELETE
//   devices  : GET / GET-by-id / PUT
//   entities : GET / GET-by-id / PUT / DELETE
//   labels   : GET / POST / PUT / DELETE
//
// All proxy through the long-lived `HaWsClient` from PR1. None are gated
// by `decision_ref`, none auto-snapshot — per Sir's locked YES defaults
// (2026-05-29) cheap reversible verbs run free.
//
// Coverage (12 tests, round-trip against a mocked HA WS server):
//
//   1.  GET /areas → WS config/area_registry/list, returns areas[]
//   2.  POST /areas → WS config/area_registry/create, body carries fields
//   3.  PUT /areas/:id → WS config/area_registry/update, fields ride
//   4.  DELETE /areas/:id → WS config/area_registry/delete with area_id
//   5.  GET /devices → list; GET /devices/:id → 404 on miss
//   6.  PUT /devices/:id → WS config/device_registry/update,
//       nullable fields (name_by_user / area_id / disabled_by) honoured
//   7.  GET /entities → list; GET /entities/:id → WS
//       config/entity_registry/get; bad dotted form → 400
//   8.  PUT /entities/:id → WS config/entity_registry/update with the
//       fields the spec carved out
//   9.  DELETE /entities/:id → WS config/entity_registry/remove
//   10. labels: GET list + POST create + PUT update + DELETE delete
//   11. HA WS error propagates as 502 HA_WS_ERROR (not a hung request)
//   12. all writes blocked when HA_NOT_CONNECTED → 409
//
// Test plumbing
// -------------
// Mirrors the channels_ha_ws_routes / channels_ha_pr7 tests:
//   - in-process fake HA WS server speaks `auth_required`/`auth_ok` +
//     `result` envelopes
//   - the fetch shim serves the LLAT from the vault-cli stub +
//     answers HA REST /api/ + /api/config so /connect can succeed
//   - HA_WS_URL_OVERRIDE points the client at our fake.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import type { ServerResponse } from "node:http";

// ── env (must be set before module imports) ────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-pr2-"));
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
process.env.HA_REGISTRY_WS_TIMEOUT_MS = "5000";
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
 * Defaults to `{success: true, result: {}}` for unset types.
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
        // subscribe_events — Tier 4 event streams.
        if (msg.type === "subscribe_events") {
          ws.send(JSON.stringify({ id, type: "result", success: true, result: null }));
          return;
        }
        const type = String(msg.type);
        const resp = wsRoutes.get(type) ?? { success: true, result: {} };
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

// ── fetch mock (REST surface — vault-cli + /api/ + /api/config) ─────────

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
  const bodyRaw = init?.body !== undefined ? String(init.body) : undefined;

  // HA /api/ auth gate (used by /connect).
  if (url === `${HA_URL}/api/` && method === "GET") {
    return makeJsonResponse({ message: "API running." }, 200);
  }
  // HA /api/config (used by /connect).
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
    // vault-cli (`bw serve`) returns single-wrapped `{success,data:<item>}`
    // for GET /object/item/:id. Post-#155 fix, ha_ws_client.readHaLlat
    // reads `j.data.login.password` (matching channels_ha.ts:readHaLlat).
    return makeJsonResponse({ success: true, data: item });
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
  throw new Error(`unexpected fetch in channels_ha_registries: ${method} ${url}`);
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

/** Ensure the HA WS client is freshly authed against the fake HA server. */
async function ensureWsAuthed(): Promise<void> {
  const client = getHaWsClient();
  client.start();
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

/** Find the last WS message of a given type in the per-test log. */
function findLastWs(type: string): Record<string, unknown> | undefined {
  for (let i = wsLog.length - 1; i >= 0; i--) {
    if (wsLog[i].type === type) return wsLog[i];
  }
  return undefined;
}

// ── tests ──────────────────────────────────────────────────────────────

describe("/api/v1/channels/ha/{areas,devices,entities,labels} — #115 PR2 registries CRUD", () => {
  before(async () => {
    getStateDb();
  });

  beforeEach(() => {
    vaultStore = [];
    vaultFolders = [];
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

  // ── 1 ── areas: list
  it("GET /areas — proxies config/area_registry/list and returns areas[]", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/area_registry/list", {
      success: true,
      result: [
        { area_id: "kitchen", name: "Kitchen" },
        { area_id: "living", name: "Living Room" },
      ],
    });
    const r = await call("GET", "/api/v1/channels/ha/areas");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.areas.length, 2);
    assert.equal(r.payload.areas[0].area_id, "kitchen");
  });

  // ── 2 ── areas: create
  it("POST /areas — sends config/area_registry/create with the body fields and returns area_id", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/area_registry/create", {
      success: true,
      result: { area_id: "garage", name: "Garage", icon: "mdi:garage" },
    });
    const r = await call("POST", "/api/v1/channels/ha/areas", {
      name: "Garage",
      icon: "mdi:garage",
      labels: ["new"],
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.area_id, "garage");
    const sent = findLastWs("config/area_registry/create");
    assert.ok(sent, "config/area_registry/create must be sent");
    assert.equal(sent!.name, "Garage");
    assert.equal(sent!.icon, "mdi:garage");
    assert.deepEqual(sent!.labels, ["new"]);
  });

  // ── 3 ── areas: update + delete
  it("PUT /areas/:id and DELETE /areas/:id — config/area_registry/{update,delete} with area_id", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/area_registry/update", {
      success: true,
      result: { area_id: "kitchen", name: "Lounge" },
    });
    const rUpd = await call("PUT", "/api/v1/channels/ha/areas/kitchen", {
      name: "Lounge",
      icon: null, // exercise the null-clear path
    });
    assert.equal(rUpd.status, 200, JSON.stringify(rUpd.payload));
    const sentUpd = findLastWs("config/area_registry/update");
    assert.equal(sentUpd!.area_id, "kitchen");
    assert.equal(sentUpd!.name, "Lounge");
    assert.equal(sentUpd!.icon, null);

    wsRoutes.set("config/area_registry/delete", {
      success: true,
      result: null,
    });
    const rDel = await call("DELETE", "/api/v1/channels/ha/areas/kitchen");
    assert.equal(rDel.status, 200, JSON.stringify(rDel.payload));
    assert.equal(rDel.payload.area_id, "kitchen");
    const sentDel = findLastWs("config/area_registry/delete");
    assert.equal(sentDel!.area_id, "kitchen");
  });

  // ── 4 ── devices: list + get-by-id (with 404)
  it("GET /devices and GET /devices/:id — list + filter; 404 on miss", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/device_registry/list", {
      success: true,
      result: [
        { id: "dev_hue_1", name: "Hue Bulb", area_id: "kitchen" },
        { id: "dev_lock_1", name: "Front Door", area_id: "entry" },
      ],
    });
    const rList = await call("GET", "/api/v1/channels/ha/devices");
    assert.equal(rList.status, 200, JSON.stringify(rList.payload));
    assert.equal(rList.payload.devices.length, 2);

    const rOne = await call("GET", "/api/v1/channels/ha/devices/dev_hue_1");
    assert.equal(rOne.status, 200, JSON.stringify(rOne.payload));
    assert.equal(rOne.payload.device.id, "dev_hue_1");

    const rMiss = await call("GET", "/api/v1/channels/ha/devices/nonexistent");
    assert.equal(rMiss.status, 404, JSON.stringify(rMiss.payload));
  });

  // ── 5 ── devices: update (nullable fields)
  it("PUT /devices/:id — sends config/device_registry/update with nullable fields honoured", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/device_registry/update", {
      success: true,
      result: { id: "dev_hue_1", name_by_user: "Bedside Lamp" },
    });
    const r = await call("PUT", "/api/v1/channels/ha/devices/dev_hue_1", {
      name_by_user: "Bedside Lamp",
      area_id: null, // clear the area binding
      labels: ["bedtime"],
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    const sent = findLastWs("config/device_registry/update");
    assert.equal(sent!.device_id, "dev_hue_1");
    assert.equal(sent!.name_by_user, "Bedside Lamp");
    assert.equal(sent!.area_id, null);
    assert.deepEqual(sent!.labels, ["bedtime"]);
  });

  // ── 6 ── entities: list + get-by-id (with 400 on bad dotted form)
  it("GET /entities + GET /entities/:id — list + per-entity get; bad id format → 400", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/entity_registry/list", {
      success: true,
      result: [
        { entity_id: "light.kitchen_main", name: "Kitchen Light" },
        { entity_id: "binary_sensor.front_door", name: "Front Door" },
      ],
    });
    const rList = await call("GET", "/api/v1/channels/ha/entities");
    assert.equal(rList.status, 200, JSON.stringify(rList.payload));
    assert.equal(rList.payload.entities.length, 2);

    wsRoutes.set("config/entity_registry/get", {
      success: true,
      result: {
        entity_id: "light.kitchen_main",
        name: "Kitchen Light",
        area_id: "kitchen",
      },
    });
    const rOne = await call(
      "GET",
      "/api/v1/channels/ha/entities/light.kitchen_main",
    );
    assert.equal(rOne.status, 200, JSON.stringify(rOne.payload));
    assert.equal(rOne.payload.entity.entity_id, "light.kitchen_main");

    const rBad = await call(
      "GET",
      "/api/v1/channels/ha/entities/NoDottedForm",
    );
    assert.equal(rBad.status, 400, JSON.stringify(rBad.payload));
  });

  // ── 7 ── entities: update (multi-field path)
  it("PUT /entities/:id — sends config/entity_registry/update with name/icon/area_id/hidden_by/disabled_by/labels", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/entity_registry/update", {
      success: true,
      result: { entity_id: "light.kitchen_main", name: "Sconce" },
    });
    const r = await call(
      "PUT",
      "/api/v1/channels/ha/entities/light.kitchen_main",
      {
        name: "Sconce",
        icon: "mdi:lightbulb",
        area_id: "kitchen",
        hidden_by: null,
        disabled_by: null,
        labels: ["evening"],
      },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    const sent = findLastWs("config/entity_registry/update");
    assert.equal(sent!.entity_id, "light.kitchen_main");
    assert.equal(sent!.name, "Sconce");
    assert.equal(sent!.icon, "mdi:lightbulb");
    assert.equal(sent!.area_id, "kitchen");
    assert.equal(sent!.hidden_by, null);
    assert.equal(sent!.disabled_by, null);
    assert.deepEqual(sent!.labels, ["evening"]);
  });

  // ── 8 ── entities: delete
  it("DELETE /entities/:id — sends config/entity_registry/remove", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/entity_registry/remove", {
      success: true,
      result: null,
    });
    const r = await call(
      "DELETE",
      "/api/v1/channels/ha/entities/light.unused_one",
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.entity_id, "light.unused_one");
    const sent = findLastWs("config/entity_registry/remove");
    assert.equal(sent!.entity_id, "light.unused_one");
  });

  // ── 9 ── labels: list + create + update + delete
  it("labels: GET /labels + POST + PUT + DELETE round-trip the four WS verbs", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/label_registry/list", {
      success: true,
      result: [{ label_id: "critical", name: "Critical", color: "red" }],
    });
    const rList = await call("GET", "/api/v1/channels/ha/labels");
    assert.equal(rList.status, 200, JSON.stringify(rList.payload));
    assert.equal(rList.payload.labels.length, 1);

    wsRoutes.set("config/label_registry/create", {
      success: true,
      result: { label_id: "bedtime", name: "Bedtime", color: "indigo" },
    });
    const rPost = await call("POST", "/api/v1/channels/ha/labels", {
      name: "Bedtime",
      color: "indigo",
      icon: "mdi:weather-night",
    });
    assert.equal(rPost.status, 200, JSON.stringify(rPost.payload));
    assert.equal(rPost.payload.label_id, "bedtime");
    const sentCreate = findLastWs("config/label_registry/create");
    assert.equal(sentCreate!.name, "Bedtime");
    assert.equal(sentCreate!.color, "indigo");

    wsRoutes.set("config/label_registry/update", {
      success: true,
      result: { label_id: "bedtime", name: "Evening Routine" },
    });
    const rPut = await call("PUT", "/api/v1/channels/ha/labels/bedtime", {
      name: "Evening Routine",
      color: null, // clear
    });
    assert.equal(rPut.status, 200, JSON.stringify(rPut.payload));
    const sentUpdate = findLastWs("config/label_registry/update");
    assert.equal(sentUpdate!.label_id, "bedtime");
    assert.equal(sentUpdate!.name, "Evening Routine");
    assert.equal(sentUpdate!.color, null);

    wsRoutes.set("config/label_registry/delete", {
      success: true,
      result: null,
    });
    const rDel = await call("DELETE", "/api/v1/channels/ha/labels/bedtime");
    assert.equal(rDel.status, 200, JSON.stringify(rDel.payload));
    const sentDelete = findLastWs("config/label_registry/delete");
    assert.equal(sentDelete!.label_id, "bedtime");
  });

  // ── 10 ── HA WS error propagates as 502 HA_WS_ERROR
  it("HA WS error → 502 HA_WS_ERROR with the upstream code/message in the detail", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/area_registry/create", {
      success: false,
      error: { code: "invalid_format", message: "name too long" },
    });
    const r = await call("POST", "/api/v1/channels/ha/areas", {
      name: "x".repeat(8),
    });
    assert.equal(r.status, 502, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "HA_WS_ERROR");
    assert.match(String(r.payload.error.message ?? ""), /invalid_format/);
    assert.match(String(r.payload.error.message ?? ""), /name too long/);
  });

  // ── 11 ── HA not connected → 409
  it("registry writes blocked when HA_NOT_CONNECTED → 409", async () => {
    // No connect call — ha_connection row absent.
    const r = await call("POST", "/api/v1/channels/ha/areas", { name: "X" });
    assert.equal(r.status, 409, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "HA_NOT_CONNECTED");
  });

  // ── 12 ── pinned: no decision_ref required (locked YES default 2026-05-29)
  it("PR2 verbs are NOT decision_ref-gated — empty body 'name' is the only required field for create", async () => {
    await connectHa();
    await ensureWsAuthed();
    wsRoutes.set("config/area_registry/create", {
      success: true,
      result: { area_id: "x", name: "X" },
    });
    // No decision_ref in the body — must NOT 400 with VALIDATION_ERROR
    // re: decision_ref. (The cheap-reversible-default is the entire
    // point of PR2; if a future agent quietly bolts a gate on, this
    // test catches it.)
    const r = await call("POST", "/api/v1/channels/ha/areas", { name: "X" });
    assert.equal(r.status, 200, JSON.stringify(r.payload));

    // Same for delete — no body required at all.
    wsRoutes.set("config/area_registry/delete", {
      success: true,
      result: null,
    });
    const rDel = await call("DELETE", "/api/v1/channels/ha/areas/x");
    assert.equal(rDel.status, 200, JSON.stringify(rDel.payload));

    // PUT with bad body type → 400 (validation), not a gate-related error.
    const rBad = await call("PUT", "/api/v1/channels/ha/areas/x", null);
    assert.equal(rBad.status, 400, JSON.stringify(rBad.payload));
  });
});
