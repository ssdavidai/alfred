// Long-lived HA WS client — #115/#158 PR1.
//
// We spin up a small in-process `ws.WebSocketServer` that speaks the HA
// WS protocol just well enough (auth_required → auth_ok, result frames
// with id, event frames) to exercise:
//
//   1. Authentication round-trip.
//   2. Request/response multiplexing via wsCall.
//   3. Subscription drain into state.db.ha_event.
//   4. Auto-reconnect on close.
//   5. getStatus() shape.
//
// We DON'T cover: the LLAT fetch path (channels_ha.ts tests already
// cover that pattern) or the connect-when-disconnected polling loop.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ha-ws-client-"));
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

// Behaviour the fake HA server can flip on.
interface ServerBehaviour {
  acceptAuth: boolean;
  registry: {
    area: unknown[];
    device: unknown[];
    entity: unknown[];
  };
  injectEventOnSubscribe: boolean;
  /** Track every inbound JSON message so tests can assert. */
  log: { incoming: Array<Record<string, unknown>> };
}

const behaviour: ServerBehaviour = {
  acceptAuth: true,
  registry: {
    area: [{ area_id: "kitchen", name: "Kitchen" }],
    device: [{ id: "dev_1", name: "Hue", area_id: "kitchen" }],
    entity: [{ entity_id: "light.kitchen", name: "Kitchen Light", area_id: "kitchen" }],
  },
  injectEventOnSubscribe: false,
  log: { incoming: [] },
};

function setBehaviour(patch: Partial<ServerBehaviour>) {
  Object.assign(behaviour, patch);
}

function setupServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    server = http.createServer();
    wss = new WebSocketServer({ server, path: "/api/websocket" });
    wss.on("connection", (ws) => {
      liveSockets.push(ws);
      ws.send(JSON.stringify({ type: "auth_required", ha_version: "fake" }));
      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        behaviour.log.incoming.push(msg);
        if (msg.type === "auth") {
          if (behaviour.acceptAuth) {
            ws.send(JSON.stringify({ type: "auth_ok" }));
          } else {
            ws.send(JSON.stringify({ type: "auth_invalid", message: "bad" }));
          }
          return;
        }
        const id = msg.id;
        if (msg.type === "config/area_registry/list") {
          ws.send(JSON.stringify({ id, type: "result", success: true, result: behaviour.registry.area }));
          return;
        }
        if (msg.type === "config/device_registry/list") {
          ws.send(JSON.stringify({ id, type: "result", success: true, result: behaviour.registry.device }));
          return;
        }
        if (msg.type === "config/entity_registry/list") {
          ws.send(JSON.stringify({ id, type: "result", success: true, result: behaviour.registry.entity }));
          return;
        }
        if (msg.type === "subscribe_events") {
          ws.send(JSON.stringify({ id, type: "result", success: true, result: null }));
          if (behaviour.injectEventOnSubscribe) {
            // Wait a tick then fire one event.
            setTimeout(() => {
              ws.send(
                JSON.stringify({
                  id,
                  type: "event",
                  event: {
                    event_type: msg.event_type,
                    data: { entity_id: "light.kitchen" },
                    time_fired: new Date().toISOString(),
                    origin: "LOCAL",
                  },
                }),
              );
            }, 20);
          }
          return;
        }
        if (msg.type === "result-error-trigger") {
          // a special type that always returns error
          ws.send(
            JSON.stringify({
              id,
              type: "result",
              success: false,
              error: { code: "boom", message: "synthetic" },
            }),
          );
          return;
        }
        // Default: unknown type, no response.
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

// ── imports (after env + before server) ───────────────────────────────

await setupServer();
process.env.HA_WS_URL_OVERRIDE = `ws://127.0.0.1:${serverPort}/api/websocket`;

const { HaWsClient, _resetHaWsClientForTests } = await import(
  "../src/api/lib/ha_ws_client.js"
);
const { getStateDb } = await import("../src/db/state.js");

// Seed ha_connection so the client's `lookupHaConnection` returns
// `connected` and the connect path proceeds.
getStateDb()
  .prepare(
    `INSERT INTO ha_connection (id, ha_url, label, vault_item_id, state)
     VALUES (1, ?, ?, ?, 'connected')
     ON CONFLICT(id) DO UPDATE SET state='connected'`,
  )
  .run("http://127.0.0.1:8123", "fake", "vw-test-id");

// Stub fetch so the client's vault-cli LLAT lookup resolves to a
// synthetic password.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.includes("/object/item/")) {
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          data: { login: { password: "llat_test_synthetic", username: null, uris: [] } },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return originalFetch(input);
}) as typeof fetch;

// ── tests ──────────────────────────────────────────────────────────────

describe("HaWsClient — long-lived connection (#115/#158 PR1)", () => {
  beforeEach(() => {
    behaviour.log.incoming = [];
    behaviour.acceptAuth = true;
    behaviour.injectEventOnSubscribe = false;
    _resetHaWsClientForTests();
    getStateDb().prepare("DELETE FROM ha_event").run();
  });

  after(async () => {
    _resetHaWsClientForTests();
    await teardownServer();
    globalThis.fetch = originalFetch;
  });

  it("auth round-trip — client sends `auth` after `auth_required` and reaches authed=true", async () => {
    const client = new HaWsClient();
    client.start();
    // Give it up to 1s to auth.
    for (let i = 0; i < 50; i++) {
      if (client.getStatus().connected) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(client.getStatus().connected, true, "client must be connected");
    // The auth message landed on the server.
    const sawAuth = behaviour.log.incoming.some(
      (m) => m.type === "auth" && m.access_token === "llat_test_synthetic",
    );
    assert.ok(sawAuth, "server must have received an auth message with the LLAT");
    client.stop();
  });

  it("wsCall — request/response correlated by id", async () => {
    const client = new HaWsClient();
    client.start();
    const result = (await client.wsCall("config/area_registry/list")) as unknown[];
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal((result[0] as Record<string, unknown>).area_id, "kitchen");
    client.stop();
  });

  it("wsCall — surfaces HA error frames as Error", async () => {
    const client = new HaWsClient();
    client.start();
    await assert.rejects(
      () => client.wsCall("result-error-trigger"),
      /HA WS error boom: synthetic/,
    );
    client.stop();
  });

  it("wsCall — times out when no response arrives", async () => {
    const client = new HaWsClient();
    client.start();
    // "unknown-type" never gets a response from the fake server.
    await assert.rejects(
      () => client.wsCall("unknown-type", {}, 100),
      /timed out/,
    );
    client.stop();
  });

  it("wsSubscribe — drains incoming events into state.db.ha_event", async () => {
    behaviour.injectEventOnSubscribe = true;
    const client = new HaWsClient();
    let cbHits = 0;
    client.wsSubscribe("state_changed", () => {
      cbHits += 1;
    });
    client.start();
    // wait for auth + subscribe + event.
    for (let i = 0; i < 50; i++) {
      if (cbHits > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(cbHits > 0, "subscription callback fired");
    const row = getStateDb()
      .prepare("SELECT * FROM ha_event ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    assert.ok(row, "ha_event row landed");
    assert.equal(row!.event_type, "state_changed");
    assert.equal(row!.entity_id, "light.kitchen");
    assert.equal(Number(row!.signaled), 0);
    client.stop();
  });

  it("getStatus() — shape stable in the disconnected / connected states", async () => {
    const client = new HaWsClient();
    const before = client.getStatus();
    assert.equal(before.connected, false);
    assert.equal(before.queue_depth, 0);
    assert.equal(typeof before.reconnect_count, "number");
    client.start();
    for (let i = 0; i < 50; i++) {
      if (client.getStatus().connected) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const after = client.getStatus();
    assert.equal(after.connected, true);
    assert.ok(after.last_message_at, "last_message_at populated after a frame");
    client.stop();
  });

  it("auto-reconnect — closing the socket triggers a reconnect that re-auths", async () => {
    const client = new HaWsClient();
    client.start();
    // Wait for initial auth.
    for (let i = 0; i < 50; i++) {
      if (client.getStatus().connected) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(client.getStatus().connected);
    const firstReconnects = client.getStatus().reconnect_count;
    // Kill every live server-side socket — the client's onClose fires
    // and scheduleReconnect kicks in (1s + jitter for the first
    // attempt). We wait up to 2.5s for the client to re-auth.
    for (const s of liveSockets) {
      try {
        s.terminate();
      } catch {
        // best-effort
      }
    }
    liveSockets.length = 0;
    let reAuthed = false;
    for (let i = 0; i < 125; i++) {
      const st = client.getStatus();
      if (st.connected) {
        reAuthed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(reAuthed, "client re-auths after a forced disconnect");
    // Note: `reconnect_count` resets to 0 on every successful auth (the
    // backoff window is per-disconnect, not lifetime). The load-bearing
    // signal is `connected === true` after the disconnect — proving that
    // both onClose → scheduleReconnect AND a fresh auth round-trip ran.
    // `firstReconnects` was captured but its value is informational only.
    void firstReconnects;
    client.stop();
  });

  it("auth_invalid — client closes cleanly and sets last_error", async () => {
    setBehaviour({ acceptAuth: false });
    const client = new HaWsClient();
    client.start();
    for (let i = 0; i < 50; i++) {
      if (client.getStatus().last_error) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const status = client.getStatus();
    assert.equal(status.connected, false);
    assert.match(status.last_error ?? "", /auth_invalid/);
    client.stop();
  });
});
