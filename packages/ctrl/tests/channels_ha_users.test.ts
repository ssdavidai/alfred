// Issue #115 PR8 — HA user CRUD + per-user LLAT mint/revoke integration tests.
//
// PR8 adds 8 routes fronting HA's WS auth surface (`config/auth/*` +
// `auth/long_lived_access_token` + `auth/refresh_tokens/*`). All gated
// writes:
//
//   POST /users / PUT /users/:id / DELETE /users/:id
//   POST /users/:id/llat / DELETE /users/:id/llat/:token_id
//
// require `decision_ref`. The `?safe=1` flag on `POST /users/:id/llat`
// STRIPS the raw token from the response — used by the MCP tool layer
// (hass.ts ha__mint_llat sets `?safe=1` so the model never sees the
// token value). Without `?safe=1`, the response includes the token
// ONCE (the operator dashboard's path).
//
// Coverage (12 tests):
//
//   1.  GET /users — returns HA's WS list payload as `{ok, users}`.
//   2.  GET /users/:id — 200 + ledger; 404 when not found.
//   3.  POST /users with decision_ref — writes ha_user_ref + daybook,
//       returns the created HA user.
//   4.  POST /users WITHOUT decision_ref — 400.
//   5.  PUT /users/:id with decision_ref → WS update + refreshed ledger.
//   6.  DELETE /users/:id with decision_ref → WS delete + ha_user_ref
//       row dropped + Vaultwarden item deleted.
//   7.  POST /users/:id/llat without `?safe=1` returns the token value
//       AND writes ha_user_ref.llat_vw_id AND creates a Vaultwarden
//       Login item.
//   8.  POST /users/:id/llat with `?safe=1` STRIPS the token value
//       (this is the LOAD-BEARING masking gate for the MCP path).
//   9.  POST /users/:id/llat WITHOUT decision_ref → 400.
//  10.  POST /users/:id/llat — HA refuses admin mint → 501
//       LLAT_MINT_NOT_SUPPORTED envelope; nothing written to vault.
//  11.  GET /users/:id/llat returns metadata WITHOUT any token / access_token /
//       secret field; strips defensively.
//  12.  DELETE /users/:id/llat/:token_id with decision_ref → WS revoke
//       + Vaultwarden item deleted + ledger.llat_vw_id cleared.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-users-"));
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
process.env.HA_USERS_TIMEOUT_MS = "5000";
process.env.HA_USER_LLAT_TIMEOUT_MS = "5000";
process.env.HA_WS_AUTOSTART = "false";

const VALID_LLAT = "llat_TEST_" + "0".repeat(40);
const HA_URL_HTTP_DEFAULT = "http://homeassistant.local:8123";
const HA_VERSION = "2025.6.1";

// ── fake HA WS server ─────────────────────────────────────────────────

let wsHttp: http.Server;
let wss: WebSocketServer;
let wsPort = 0;
const liveSockets: WSWebSocket[] = [];

interface WsState {
  acceptAuth: boolean;
  users: Array<Record<string, unknown>>;
  /** Tokens keyed by user_id. */
  tokens: Record<string, Array<Record<string, unknown>>>;
  /** When set, auth/long_lived_access_token replies with an error frame
   *  (simulates "admin mint not supported"). */
  mintError: { code: string; message: string } | null;
  /** When set, returns a string token; otherwise object form. */
  mintAsString: boolean;
  /** Logged inbound frames for assertions. */
  log: Array<Record<string, unknown>>;
}
const ws: WsState = {
  acceptAuth: true,
  users: [],
  tokens: {},
  mintError: null,
  mintAsString: false,
  log: [],
};
function resetWsState() {
  ws.acceptAuth = true;
  ws.users = [];
  ws.tokens = {};
  ws.mintError = null;
  ws.mintAsString = false;
  ws.log = [];
}

function setupWsServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    wsHttp = http.createServer();
    wss = new WebSocketServer({ server: wsHttp, path: "/api/websocket" });
    wss.on("connection", (sock) => {
      liveSockets.push(sock);
      sock.send(JSON.stringify({ type: "auth_required", ha_version: "fake" }));
      sock.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        ws.log.push(msg);
        if (msg.type === "auth") {
          sock.send(
            JSON.stringify(
              ws.acceptAuth ? { type: "auth_ok" } : { type: "auth_invalid" },
            ),
          );
          return;
        }
        const id = msg.id as number | undefined;
        switch (msg.type) {
          case "config/auth/list":
            sock.send(
              JSON.stringify({ id, type: "result", success: true, result: ws.users }),
            );
            return;
          case "config/auth/create": {
            const userId = "u_" + Math.random().toString(36).slice(2, 10);
            const user: Record<string, unknown> = {
              id: userId,
              name: msg.name,
              is_active: true,
              system_generated: false,
              group_ids: (msg as Record<string, unknown>).group_ids ?? [
                "system-users",
              ],
            };
            ws.users.push(user);
            sock.send(
              JSON.stringify({
                id,
                type: "result",
                success: true,
                result: { user },
              }),
            );
            return;
          }
          case "config/auth_provider/homeassistant/create":
            sock.send(
              JSON.stringify({ id, type: "result", success: true, result: null }),
            );
            return;
          case "config/auth/update": {
            const uid = (msg as Record<string, unknown>).user_id;
            const idx = ws.users.findIndex((u) => u.id === uid);
            if (idx >= 0) {
              const updates: Record<string, unknown> = {};
              if ((msg as Record<string, unknown>).name !== undefined) {
                updates.name = (msg as Record<string, unknown>).name;
              }
              if ((msg as Record<string, unknown>).is_active !== undefined) {
                updates.is_active = (msg as Record<string, unknown>).is_active;
              }
              if ((msg as Record<string, unknown>).group_ids !== undefined) {
                updates.group_ids = (msg as Record<string, unknown>).group_ids;
              }
              ws.users[idx] = { ...ws.users[idx], ...updates };
            }
            sock.send(
              JSON.stringify({ id, type: "result", success: true, result: null }),
            );
            return;
          }
          case "config/auth/delete": {
            const uid = (msg as Record<string, unknown>).user_id;
            ws.users = ws.users.filter((u) => u.id !== uid);
            delete ws.tokens[String(uid)];
            sock.send(
              JSON.stringify({ id, type: "result", success: true, result: null }),
            );
            return;
          }
          case "auth/long_lived_access_token": {
            if (ws.mintError) {
              sock.send(
                JSON.stringify({
                  id,
                  type: "result",
                  success: false,
                  error: ws.mintError,
                }),
              );
              return;
            }
            const uid = String((msg as Record<string, unknown>).user_id);
            const tokenId = "tok_" + Math.random().toString(36).slice(2, 10);
            const tokenValue =
              "llat_minted_" + Math.random().toString(36).slice(2, 18);
            const meta = {
              id: tokenId,
              client_name: (msg as Record<string, unknown>).client_name,
              created_at: new Date().toISOString(),
            };
            ws.tokens[uid] = [...(ws.tokens[uid] ?? []), meta];
            const result = ws.mintAsString
              ? tokenValue
              : {
                  access_token: tokenValue,
                  token_id: tokenId,
                  expiry: "2036-05-29T00:00:00Z",
                };
            sock.send(
              JSON.stringify({ id, type: "result", success: true, result }),
            );
            return;
          }
          case "auth/refresh_tokens/list": {
            const uid = String((msg as Record<string, unknown>).user_id);
            sock.send(
              JSON.stringify({
                id,
                type: "result",
                success: true,
                result: ws.tokens[uid] ?? [],
              }),
            );
            return;
          }
          case "auth/refresh_tokens/delete": {
            const uid = String((msg as Record<string, unknown>).user_id);
            const tokenId = String(
              (msg as Record<string, unknown>).refresh_token_id,
            );
            ws.tokens[uid] = (ws.tokens[uid] ?? []).filter(
              (t) => t.id !== tokenId,
            );
            sock.send(
              JSON.stringify({ id, type: "result", success: true, result: null }),
            );
            return;
          }
          default:
            return;
        }
      });
    });
    wsHttp.listen(0, "127.0.0.1", () => {
      const addr = wsHttp.address();
      if (addr && typeof addr === "object") wsPort = addr.port;
      resolve();
    });
  });
}

function teardownWsServer(): Promise<void> {
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
      wsHttp?.close(() => resolve());
    });
  });
}

// ── REST mock (HA REST `/api/`, `/api/config`, vault-cli) ──────────────

let mockedInstallationType: string = "Home Assistant Container";
let HA_URL = HA_URL_HTTP_DEFAULT;

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
const haCalls: { url: string; method: string; body: string | undefined }[] = [];

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const bodyRaw = init?.body !== undefined ? String(init.body) : undefined;
  haCalls.push({ url, method, body: bodyRaw });

  if (url === `${HA_URL}/api/` && method === "GET") {
    return makeJsonResponse({ message: "API running." }, 200);
  }
  if (url === `${HA_URL}/api/config` && method === "GET") {
    return makeJsonResponse(
      {
        version: HA_VERSION,
        installation_type: mockedInstallationType,
      },
      200,
    );
  }

  // vault-cli folders.
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
  // vault-cli items.
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
    // SHAPE — vault-cli (`bw serve`) returns single-wrapped
    // `{success, data: <item>}` for GET /object/item/:id. BOTH
    // `channels_ha.ts:readHaLlat` and (post-#155 fix)
    // `api/lib/ha_ws_client.ts:readHaLlat` read `j.data.login.password`.
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
  throw new Error(`unexpected fetch in test_channels_ha_users: ${method} ${url}`);
}) as typeof fetch;

// ── module imports (after env + fetch + ws set up) ───────────────────

await setupWsServer();
HA_URL = `http://127.0.0.1:${wsPort}`;
// HA_WS_URL_OVERRIDE points the WS client at our fake server.
process.env.HA_WS_URL_OVERRIDE = `ws://127.0.0.1:${wsPort}/api/websocket`;

const {
  registerChannelsHaRoutes,
  _resetHaSubscriptionsForTests,
  _resetHaAddonsForTests,
  _resetHaInstallationTypeCache,
  _resetHaUserRefForTests,
} = await import("../src/api/routes/channels_ha.js");
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const { _resetHaWsClientForTests, getHaWsClient } = await import(
  "../src/api/lib/ha_ws_client.js"
);

registerChannelsHaRoutes();

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
  // Seed ha_connection directly + an LLAT vault item so the WS client's
  // pre-auth has a live LLAT to send.
  const llatItemId = "vw-pre-seeded-llat";
  vaultStore.push({
    id: llatItemId,
    name: "LLAT",
    type: 1,
    folderId: null,
    login: {
      username: null,
      password: VALID_LLAT,
      uris: [],
    },
  });
  const db = getStateDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO ha_connection
       (id, ha_url, label, vault_item_id, ha_version, state,
        last_test_at, last_test_ok, last_test_error,
        last_discovery_at, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, 'connected', ?, 1, NULL, NULL, ?, ?)`,
  ).run(HA_URL, "Test", llatItemId, HA_VERSION, now, now, now);
  // Start the singleton WS client; it'll auto-connect to our fake.
  getHaWsClient().start();
  // Wait for auth.
  for (let i = 0; i < 50; i++) {
    if (getHaWsClient().getStatus().connected) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("WS client never authed");
}

// ── tests ──────────────────────────────────────────────────────────────

describe("/api/v1/channels/ha/users — #115 PR8 user CRUD + LLATs", () => {
  before(async () => {
    // first-touch migrations
    getStateDb();
  });

  after(async () => {
    _resetHaWsClientForTests();
    await teardownWsServer();
  });

  beforeEach(() => {
    vaultStore = [];
    vaultFolders = [];
    haCalls.length = 0;
    resetWsState();
    mockedInstallationType = "Home Assistant Container";
    const db = getStateDb();
    try {
      db.prepare("DELETE FROM ha_connection").run();
      db.prepare("DELETE FROM ha_run").run();
      db.prepare("DELETE FROM ha_proposal").run();
      db.prepare("DELETE FROM ha_snapshot").run();
      db.prepare("DELETE FROM ha_event").run();
      db.prepare("DELETE FROM ha_event_subscription").run();
      db.prepare("DELETE FROM ha_user_ref").run();
    } catch {
      // first run before any table exists
    }
    _resetHaSubscriptionsForTests();
    _resetHaAddonsForTests();
    _resetHaInstallationTypeCache();
    _resetHaUserRefForTests();
    // Drop the WS singleton so the next test's connectHa starts fresh.
    _resetHaWsClientForTests();
  });

  // ── 1 ── GET /users returns WS list payload
  it("GET /users returns {ok, users} from config/auth/list", async () => {
    ws.users = [
      { id: "u_owner", name: "Owner", is_active: true, system_generated: true },
      { id: "u_kid", name: "Kid", is_active: true, system_generated: false },
    ];
    await connectHa();
    const r = await call("GET", "/api/v1/channels/ha/users");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.users.length, 2);
    assert.deepEqual(
      r.payload.users.map((u: any) => u.id).sort(),
      ["u_kid", "u_owner"],
    );
    // Ensure NO token field anywhere.
    const blob = JSON.stringify(r.payload);
    assert.equal(blob.includes("access_token"), false);
    assert.equal(blob.includes("\"token\":"), false);
  });

  // ── 2 ── GET /users/:id — 200 + ledger; 404 when missing
  it("GET /users/:id 200 + ledger row; 404 when not on HA", async () => {
    ws.users = [{ id: "u_kid", name: "Kid", is_active: true }];
    await connectHa();
    const ok = await call("GET", "/api/v1/channels/ha/users/u_kid");
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    assert.equal(ok.payload.user.id, "u_kid");
    // No ledger row yet (Alfred didn't provision); response shape allows null.
    assert.equal(ok.payload.ledger, null);

    const miss = await call("GET", "/api/v1/channels/ha/users/u_nope");
    assert.equal(miss.status, 404, JSON.stringify(miss.payload));
  });

  // ── 3 ── POST /users with decision_ref creates ledger + daybook
  it("POST /users with decision_ref writes ha_user_ref + daybook", async () => {
    await connectHa();
    const r = await call("POST", "/api/v1/channels/ha/users", {
      name: "Kid",
      group_ids: ["system-read-only"],
      decision_ref: "decision/2026-05-29-kid.md",
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.ok(r.payload.user?.id);
    assert.equal(r.payload.decision_ref, "decision/2026-05-29-kid.md");
    // ha_user_ref row written.
    const row = getStateDb()
      .prepare("SELECT * FROM ha_user_ref WHERE ha_user_id = ?")
      .get(r.payload.user.id) as any;
    assert.ok(row);
    assert.equal(row.name, "Kid");
    assert.equal(row.decision_ref, "decision/2026-05-29-kid.md");
    assert.equal(row.llat_vw_id, null);
    // Daybook entry written.
    const today = new Date().toISOString().slice(0, 10);
    const daybookPath = path.join(
      process.env.VAULT_PATH!,
      "daybook",
      `${today}.md`,
    );
    assert.ok(fs.existsSync(daybookPath));
    const dayContent = fs.readFileSync(daybookPath, "utf-8");
    assert.match(dayContent, /## HA writes/);
    assert.match(dayContent, /ha__user_create/);
  });

  // ── 4 ── POST /users without decision_ref → 400
  it("POST /users WITHOUT decision_ref returns 400", async () => {
    await connectHa();
    const r = await call("POST", "/api/v1/channels/ha/users", { name: "Kid" });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.payload), /decision_ref/);
  });

  // ── 5 ── PUT /users/:id update + refreshed ledger
  it("PUT /users/:id is_active flip with decision_ref → ledger preserved", async () => {
    ws.users = [{ id: "u_kid", name: "Kid", is_active: true }];
    await connectHa();
    // Seed a ledger row so we can verify the update path preserves it.
    const db = getStateDb();
    db.prepare(
      `INSERT INTO ha_user_ref (ha_user_id, name, decision_ref, llat_vw_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("u_kid", "Kid", "decision/seed", null, new Date().toISOString());

    const r = await call("PUT", "/api/v1/channels/ha/users/u_kid", {
      is_active: false,
      decision_ref: "decision/2026-05-29-deactivate.md",
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.user_id, "u_kid");
    // WS user is_active flipped.
    const wsUser = ws.users.find((u) => u.id === "u_kid")!;
    assert.equal(wsUser.is_active, false);
    // Ledger row still there.
    const row = db
      .prepare("SELECT * FROM ha_user_ref WHERE ha_user_id = ?")
      .get("u_kid") as any;
    assert.ok(row);
    assert.equal(row.name, "Kid");
  });

  // ── 6 ── DELETE /users/:id drops HA user, vault item, ledger
  it("DELETE /users/:id drops HA user + Vaultwarden item + ledger", async () => {
    ws.users = [{ id: "u_kid", name: "Kid", is_active: true }];
    await connectHa();
    // Seed a vault item to simulate "Alfred minted an LLAT here".
    const llatVwId = "vw-kid-llat";
    vaultStore.push({
      id: llatVwId,
      name: "HA — Kid",
      type: 1,
      folderId: null,
      login: { username: "Kid", password: "secret_token", uris: [] },
    });
    getStateDb()
      .prepare(
        `INSERT INTO ha_user_ref (ha_user_id, name, decision_ref, llat_vw_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("u_kid", "Kid", "decision/seed", llatVwId, new Date().toISOString());

    const r = await call(
      "DELETE",
      "/api/v1/channels/ha/users/u_kid?decision_ref=decision/2026-05-29-drop.md",
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.vault_item_deleted, true);
    // HA user gone.
    assert.equal(ws.users.find((u) => u.id === "u_kid"), undefined);
    // Vault item gone.
    assert.equal(vaultStore.find((v) => v.id === llatVwId), undefined);
    // Ledger row gone.
    const row = getStateDb()
      .prepare("SELECT * FROM ha_user_ref WHERE ha_user_id = ?")
      .get("u_kid");
    assert.equal(row, undefined);
  });

  // ── 7 ── POST /users/:id/llat (unsafe) returns token + stores in vault
  it("POST /users/:id/llat (no safe) returns token ONCE + writes vault + ledger", async () => {
    ws.users = [{ id: "u_kid", name: "Kid", is_active: true }];
    await connectHa();
    // Seed ledger so name is known without a WS round-trip.
    getStateDb()
      .prepare(
        `INSERT INTO ha_user_ref (ha_user_id, name, decision_ref, llat_vw_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("u_kid", "Kid", "decision/seed", null, new Date().toISOString());

    const r = await call("POST", "/api/v1/channels/ha/users/u_kid/llat", {
      client_name: "kid-mobile",
      decision_ref: "decision/2026-05-29-mint.md",
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    // Token returned ONCE (operator path).
    assert.ok(typeof r.payload.token === "string");
    assert.match(r.payload.token, /^llat_minted_/);
    assert.ok(typeof r.payload.llat_vw_id === "string");
    assert.ok(typeof r.payload.ha_token_id === "string");
    assert.match(r.payload.warning, /Token value returned ONCE/);
    assert.notEqual(r.payload.redacted, true);
    // Vault item created with the right name + password.
    const item = vaultStore.find((v) => v.name === "HA — Kid");
    assert.ok(item);
    assert.equal(item!.id, r.payload.llat_vw_id);
    assert.equal(item!.login.password, r.payload.token);
    // Ledger row's llat_vw_id updated.
    const row = getStateDb()
      .prepare("SELECT * FROM ha_user_ref WHERE ha_user_id = ?")
      .get("u_kid") as any;
    assert.equal(row.llat_vw_id, r.payload.llat_vw_id);
  });

  // ── 8 ── POST /users/:id/llat?safe=1 STRIPS the token value
  //   THE LOAD-BEARING TEST — the MCP tool layer uses ?safe=1, this is
  //   what stops the raw token from being included in a model-visible
  //   response. Failing this test = a leaked token surface.
  it("POST /users/:id/llat?safe=1 STRIPS token (load-bearing masking gate)", async () => {
    ws.users = [{ id: "u_kid", name: "Kid", is_active: true }];
    await connectHa();
    getStateDb()
      .prepare(
        `INSERT INTO ha_user_ref (ha_user_id, name, decision_ref, llat_vw_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("u_kid", "Kid", "decision/seed", null, new Date().toISOString());

    const r = await call("POST", "/api/v1/channels/ha/users/u_kid/llat?safe=1", {
      client_name: "alfred-mcp",
      decision_ref: "decision/2026-05-29-mint.md",
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.redacted, true);
    // Token field MUST NOT be present.
    assert.equal("token" in r.payload, false);
    assert.equal("warning" in r.payload, false);
    // llat_vw_id IS present so the caller can find the vault item.
    assert.ok(typeof r.payload.llat_vw_id === "string");
    assert.ok(typeof r.payload.ha_token_id === "string");
    // The vault item still exists (the storage side never depends on safe).
    const item = vaultStore.find((v) => v.id === r.payload.llat_vw_id);
    assert.ok(item, "vault item must exist regardless of ?safe");
    assert.match(item!.login.password, /^llat_minted_/);

    // Defence in depth — no field in the whole payload looks like a
    // minted token value.
    const blob = JSON.stringify(r.payload);
    assert.equal(blob.includes("llat_minted_"), false);
  });

  // ── 9 ── POST /users/:id/llat WITHOUT decision_ref → 400
  it("POST /users/:id/llat WITHOUT decision_ref returns 400", async () => {
    ws.users = [{ id: "u_kid", name: "Kid", is_active: true }];
    await connectHa();
    const r = await call("POST", "/api/v1/channels/ha/users/u_kid/llat", {
      client_name: "x",
    });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.payload), /decision_ref/);
  });

  // ── 10 ── HA refuses admin mint → 501 LLAT_MINT_NOT_SUPPORTED
  it("POST /users/:id/llat — HA refuses admin mint → 501 LLAT_MINT_NOT_SUPPORTED", async () => {
    ws.users = [{ id: "u_kid", name: "Kid", is_active: true }];
    ws.mintError = {
      code: "not_supported",
      message: "admin mint not supported on this install",
    };
    await connectHa();
    const r = await call("POST", "/api/v1/channels/ha/users/u_kid/llat", {
      client_name: "kid-mobile",
      decision_ref: "decision/2026-05-29-mint.md",
    });
    assert.equal(r.status, 501, JSON.stringify(r.payload));
    assert.match(
      JSON.stringify(r.payload),
      /LLAT_MINT_NOT_SUPPORTED|not_supported/,
    );
    // No vault item written.
    assert.equal(vaultStore.find((v) => v.name === "HA — Kid"), undefined);
    // Ledger.llat_vw_id stays NULL (no ledger row to begin with).
    const row = getStateDb()
      .prepare("SELECT * FROM ha_user_ref WHERE ha_user_id = ?")
      .get("u_kid");
    assert.equal(row, undefined);
  });

  // ── 11 ── GET /users/:id/llat lists metadata without any token field
  it("GET /users/:id/llat lists metadata WITHOUT any token-shaped field", async () => {
    ws.users = [{ id: "u_kid", name: "Kid", is_active: true }];
    ws.tokens["u_kid"] = [
      {
        id: "tok_a",
        client_name: "kid-mobile",
        access_token: "MUST_BE_STRIPPED_a", // HA shouldn't include this, but defence in depth
        token: "MUST_BE_STRIPPED_b",
        secret: "MUST_BE_STRIPPED_c",
        created_at: "2026-05-29T00:00:00Z",
      },
    ];
    await connectHa();
    const r = await call("GET", "/api/v1/channels/ha/users/u_kid/llat");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.tokens.length, 1);
    const blob = JSON.stringify(r.payload);
    assert.equal(blob.includes("MUST_BE_STRIPPED"), false);
    assert.equal(blob.includes("access_token"), false);
    assert.equal(blob.includes("\"secret\""), false);
    // The metadata fields ARE preserved.
    assert.equal(r.payload.tokens[0].id, "tok_a");
    assert.equal(r.payload.tokens[0].client_name, "kid-mobile");
  });

  // ── 12 ── DELETE /users/:id/llat/:token_id revokes + drops vault
  it("DELETE /users/:id/llat/:token_id revokes HA token + drops Vaultwarden item", async () => {
    ws.users = [{ id: "u_kid", name: "Kid", is_active: true }];
    ws.tokens["u_kid"] = [
      { id: "tok_old", client_name: "kid-mobile", created_at: "2026-05-29Z" },
    ];
    const llatVwId = "vw-kid-llat";
    vaultStore.push({
      id: llatVwId,
      name: "HA — Kid",
      type: 1,
      folderId: null,
      login: { username: "Kid", password: "stale_token", uris: [] },
    });
    getStateDb()
      .prepare(
        `INSERT INTO ha_user_ref (ha_user_id, name, decision_ref, llat_vw_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("u_kid", "Kid", "decision/seed", llatVwId, new Date().toISOString());
    await connectHa();

    const r = await call(
      "DELETE",
      "/api/v1/channels/ha/users/u_kid/llat/tok_old?decision_ref=decision/2026-05-29-revoke.md",
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.vault_item_deleted, true);
    // HA token gone.
    assert.equal(ws.tokens["u_kid"].length, 0);
    // Vault item gone.
    assert.equal(vaultStore.find((v) => v.id === llatVwId), undefined);
    // Ledger.llat_vw_id cleared.
    const row = getStateDb()
      .prepare("SELECT * FROM ha_user_ref WHERE ha_user_id = ?")
      .get("u_kid") as any;
    assert.equal(row.llat_vw_id, null);
    // No raw token in the response.
    const blob = JSON.stringify(r.payload);
    assert.equal(blob.includes("stale_token"), false);
  });
});
