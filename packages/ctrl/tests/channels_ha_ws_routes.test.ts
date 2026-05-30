// Tier 4 HA WS routes — `/ha/ws/status` + `/ha/ws/registries` (#115/#158 PR1).
//
// Status route is a thin getter; registries route exercises the
// `wsCall` multiplex against a fake HA WS server.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-ws-routes-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
process.env.HA_WS_AUTOSTART = "false";

// ── fake HA WS server ──────────────────────────────────────────────────

let server: http.Server;
let wss: WebSocketServer;
let serverPort = 0;
const liveSockets: WSWebSocket[] = [];

function setupServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    server = http.createServer();
    wss = new WebSocketServer({ server, path: "/api/websocket" });
    wss.on("connection", (ws) => {
      liveSockets.push(ws);
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok" }));
          return;
        }
        const id = msg.id;
        if (msg.type === "config/area_registry/list") {
          ws.send(
            JSON.stringify({
              id,
              type: "result",
              success: true,
              result: [
                { area_id: "kitchen", name: "Kitchen" },
                { area_id: "living", name: "Living Room" },
              ],
            }),
          );
          return;
        }
        if (msg.type === "config/device_registry/list") {
          ws.send(
            JSON.stringify({
              id,
              type: "result",
              success: true,
              result: [{ id: "dev_1", name: "Hue", area_id: "kitchen" }],
            }),
          );
          return;
        }
        if (msg.type === "config/entity_registry/list") {
          ws.send(
            JSON.stringify({
              id,
              type: "result",
              success: true,
              result: [
                {
                  entity_id: "light.kitchen",
                  name: "Kitchen Light",
                  area_id: "kitchen",
                },
              ],
            }),
          );
          return;
        }
        if (msg.type === "config/scene/list") {
          ws.send(
            JSON.stringify({
              id,
              type: "result",
              success: false,
              error: { code: "not_supported", message: "no scenes on this HA" },
            }),
          );
          return;
        }
        if (msg.type === "config/script/list") {
          ws.send(
            JSON.stringify({
              id,
              type: "result",
              success: true,
              result: [{ entity_id: "script.do_thing", name: "Do Thing" }],
            }),
          );
          return;
        }
        if (msg.type === "subscribe_events") {
          ws.send(JSON.stringify({ id, type: "result", success: true, result: null }));
          return;
        }
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

await setupServer();
process.env.HA_WS_URL_OVERRIDE = `ws://127.0.0.1:${serverPort}/api/websocket`;

const { registerHaWsRoutes } = await import("../src/api/routes/channels_ha_ws.js");
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const { _resetHaWsClientForTests, getHaWsClient } = await import(
  "../src/api/lib/ha_ws_client.js"
);

registerHaWsRoutes();

// Seed ha_connection so the WS client has somewhere to point.
getStateDb()
  .prepare(
    `INSERT INTO ha_connection (id, ha_url, label, vault_item_id, state)
     VALUES (1, ?, ?, ?, 'connected')
     ON CONFLICT(id) DO UPDATE SET state='connected'`,
  )
  .run("http://127.0.0.1:8123", "fake", "vw-test-id");

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.includes("/object/item/")) {
    // vault-cli (`bw serve`) returns single-wrapped `{success,data:<item>}` for
    // GET /object/item/:id — NOT double-wrapped. The HaWsClient.readHaLlat
    // reads `j.data.login.password`. See channels_ha_vault_parse.test.ts for
    // the full bw-serve shape contract. (Fix for #155.)
    return new Response(
      JSON.stringify({
        success: true,
        data: { login: { password: "llat_test", username: null, uris: [] } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return originalFetch(input);
}) as typeof fetch;

interface CallResult {
  status: number;
  payload: any;
}
async function call(method: string, p: string): Promise<CallResult> {
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
  try {
    await m!.handler({
      req: { method, headers: {}, url: p } as any,
      res,
      params: m!.params,
      body: undefined,
      query: new URLSearchParams(),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

describe("/api/v1/channels/ha/ws/* — #115/#158 PR1", () => {
  beforeEach(() => {
    _resetHaWsClientForTests();
  });

  after(async () => {
    _resetHaWsClientForTests();
    await teardownServer();
    globalThis.fetch = originalFetch;
  });

  it("GET /ha/ws/status — returns the status object + subscribed event types", async () => {
    const r = await call("GET", "/api/v1/channels/ha/ws/status");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(typeof r.payload.connected, "boolean");
    assert.equal(typeof r.payload.reconnect_count, "number");
    assert.equal(typeof r.payload.queue_depth, "number");
    assert.deepEqual(
      r.payload.subscribed_event_types,
      [
        "area_registry_updated",
        "device_registry_updated",
        "entity_registry_updated",
        "config_entries_updated",
      ],
      "the 4 Tier 4 event streams must be subscribed",
    );
  });

  it("GET /ha/ws/registries — returns rows by kind, drops nothing on best-effort scene failure", async () => {
    // Pre-warm the client so the route doesn't race auth.
    getHaWsClient().start();
    for (let i = 0; i < 100; i++) {
      if (getHaWsClient().getStatus().connected) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(getHaWsClient().getStatus().connected, "WS client must connect before route runs");

    const r = await call("GET", "/api/v1/channels/ha/ws/registries");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    // counts.scenes is 0 (we made it fail server-side).
    assert.equal(r.payload.counts.areas, 2);
    assert.equal(r.payload.counts.devices, 1);
    assert.equal(r.payload.counts.entities, 1);
    assert.equal(r.payload.counts.scenes, 0);
    assert.equal(r.payload.counts.scripts, 1);
    const rows = r.payload.rows as Array<Record<string, unknown>>;
    const kinds = new Set(rows.map((row) => row.kind));
    assert.ok(kinds.has("area"));
    assert.ok(kinds.has("device"));
    assert.ok(kinds.has("entity"));
    assert.ok(kinds.has("script"));
    // payload_json carries the original record JSON.
    const kitchenArea = rows.find(
      (row) => row.kind === "area" && row.ha_id === "kitchen",
    );
    assert.ok(kitchenArea);
    const parsed = JSON.parse(kitchenArea!.payload_json as string) as Record<string, unknown>;
    assert.equal(parsed.area_id, "kitchen");
    assert.equal(parsed.name, "Kitchen");
  });

  // Regression guard for #155 — if a future agent re-introduces the
  // double-wrap shape in `ha_ws_client.ts:readHaLlat`, the route MUST
  // refuse to lift an LLAT and surface HA_WS_REGISTRY_FAILED. Pairs with
  // the positive test above: positive proves single-wrap works; this
  // proves double-wrap fails. Live-observed failure mode (home, 2026-05-30):
  // `{"error":{"code":"HA_WS_REGISTRY_FAILED","message":"...HaWsClient not
  // authed within 10000ms (last_error=LLAT read failed:
  // vault-cli returned an HA item without a login.password)"}}`.
  it("GET /ha/ws/registries — 502s when vault-cli double-wraps single-object responses (regression guard for #155)", async () => {
    // Swap fetch to return the WRONG (double-wrap) shape that the bug
    // assumed. ha_ws_client.readHaLlat must look at `data.login.password`,
    // not `data.data.login.password`, so this must fail to extract.
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("/object/item/")) {
        return new Response(
          JSON.stringify({
            success: true,
            // Wrong shape — embeds login.password under data.data instead
            // of data. Pre-fix readHaLlat read this and "worked" — but
            // the real bw serve never returns this for single-object GET.
            data: { data: { login: { password: "llat_test", username: null, uris: [] } } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    }) as typeof fetch;
    // Reset so the client re-tries auth with the broken-shape vault-cli.
    _resetHaWsClientForTests();

    const r = await call("GET", "/api/v1/channels/ha/ws/registries");
    assert.equal(r.status, 502, JSON.stringify(r.payload));
    assert.equal(r.payload.error?.code, "HA_WS_REGISTRY_FAILED");

    // Restore the correct-shape mock for any subsequent test ordering.
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("/object/item/")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { login: { password: "llat_test", username: null, uris: [] } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    }) as typeof fetch;
  });
});
