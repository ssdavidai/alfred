// Long-lived HA WebSocket client — Tier 4 foundation (#115/#158 PR1).
//
// One durable `wss://` connection per tenant from ctrl-api to the
// principal's HA at the stored `ha_url` + LLAT. Exposes:
//
//   * `wsCall(type, payload, timeoutMs?)` — request/response with per-call
//     id multiplexing, matched against HA's `result` frames.
//   * `wsSubscribe(eventType, callback)` — long-lived event stream; one
//     id-correlated `subscribe_events` per event type, callbacks fired on
//     every matching inbound `event` frame.
//   * `getStatus()` — `{connected, last_message_at, reconnect_count,
//     queue_depth}` for the health check route.
//
// Why this exists
// ---------------
// The Tier 4 verbs (#115 spec §4) cross the REST/WS boundary on every
// registry-mutating surface — area_registry, device_registry,
// entity_registry, config_entries, supervisor, backup, hacs, auth. None of
// those are reachable over HA's REST. Today the per-write surface opens a
// short-lived WS per call (see channels_ha.ts startHaWsSubscriber); that's
// fine for an explicit subscribe but it can't multiplex an
// area_registry/list under a service-call's auth round-trip.
//
// The PR1 spec also points at #149: HaBootstrapWorkflow Phase A's
// area/device/scene/script pull came back 0 because the activity used REST,
// and REST returns 404 for those registries. The new
// `/api/v1/channels/ha/ws/registries` route (channels_ha_ws.ts) calls
// `wsCall("config/area_registry/list")` etc. through this client, which
// closes #149.
//
// Lifecycle
// ---------
//   * Construct → not connected.
//   * `start()` → kick off a connect. If ha_connection isn't `connected`
//     yet, the client polls every 5s waiting for it (no hard crash).
//   * Auto-reconnect on close/error with exponential backoff starting at
//     1s, doubling to a 32s cap, with ±15% jitter. Subscriptions are
//     replayed after every successful auth.
//   * `stop()` → terminates cleanly and stops the reconnect loop.
//
// Test mode
// ---------
// The client honours `HA_WS_URL_OVERRIDE` (full ws://host:port URL string)
// so tests can point at a local fake HA WS server. When the env is
// "skip", the client never opens a socket — useful for the migration +
// helper tests that don't exercise the live connection.
//
// Thread model
// ------------
// Single Node event loop. All state (the id counter, the pending-request
// map, the subscription registry) lives on `this`. No shared mutable
// state across instances; the module-level `getHaWsClient()` accessor
// returns one process-wide singleton.

import { WebSocket } from "ws";
import { getStateDb } from "../../db/state.js";
import { ulid } from "../../db/ulid.js";

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 32_000;
const RECONNECT_JITTER = 0.15;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const POLL_FOR_CONFIG_MS = 5_000;

// The four registry-event streams the Tier 4 surface needs. The PR1 spec
// (§A) calls these out; later PRs (PR2-PR8) can subscribe to more.
export const TIER4_EVENT_STREAMS = [
  "area_registry_updated",
  "device_registry_updated",
  "entity_registry_updated",
  "config_entries_updated",
] as const;

export interface HaWsStatus {
  connected: boolean;
  last_message_at: string | null;
  reconnect_count: number;
  queue_depth: number;
  ha_url: string | null;
  last_error: string | null;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Subscription {
  eventType: string;
  callback: (event: Record<string, unknown>) => void;
  /** HA-side id for the active `subscribe_events` request. Refreshed on
   *  every reconnect. */
  liveId: number | null;
}

/**
 * Pure factory the client uses internally — exported so tests can stub
 * `globalThis.fetch` and still drive the same code path.
 */
export interface HaConnectionLookup {
  ha_url: string;
  state: string;
  vault_item_id: string;
}

function lookupHaConnection(): HaConnectionLookup | null {
  try {
    const row = getStateDb()
      .prepare("SELECT ha_url, state, vault_item_id FROM ha_connection WHERE id = 1")
      .get() as HaConnectionLookup | undefined;
    return row ?? null;
  } catch {
    // Table may not exist on cold boot before migrations.
    return null;
  }
}

function haWsUrlFromHttp(haUrl: string): string {
  // Honour an explicit override (used by tests against a local fake HA).
  if (process.env.HA_WS_URL_OVERRIDE && process.env.HA_WS_URL_OVERRIDE !== "skip") {
    return process.env.HA_WS_URL_OVERRIDE;
  }
  if (haUrl.startsWith("https://")) return `wss://${haUrl.slice("https://".length)}/api/websocket`;
  if (haUrl.startsWith("http://")) return `ws://${haUrl.slice("http://".length)}/api/websocket`;
  return `${haUrl}/api/websocket`;
}

/**
 * Read the LLAT off the Vaultwarden item the ha_connection row points at.
 * Mirrors `channels_ha.ts:readHaLlat` but is duplicated here to keep the
 * lib free of cross-file imports (channels_ha.ts imports this file via
 * channels_ha_ws.ts, the inverse would be a cycle).
 *
 * SHAPE CONTRACT — vault-cli (`bw serve`) returns single-wrapped
 * `{success, data: {id, login, ...}}` for GET /object/item/:id, NOT
 * double-wrapped. The previous double-wrap shape was a copy-paste from
 * the LIST endpoint (which IS `{data:{data:[…]}}`); live-verified wrong
 * 2026-05-29 on home — `ws/registries` 502'd with `LLAT read failed:
 * vault-cli GET <id> returned HTTP 400` (vault locked) but even after
 * unlock the double-wrap path returned undefined and the WS client
 * failed `not authed within 10000ms`. Mirrors the fix in
 * `channels_ha.ts:readHaLlat` (which had the same bug, fixed earlier).
 * Closes #155 — HaBootstrapWorkflow's WS-bridge call to
 * `/api/v1/channels/ha/ws/registries` can now actually authenticate.
 */
async function readHaLlat(vaultItemId: string): Promise<string> {
  const vaultUrl = process.env.VAULT_CLI_URL ?? "http://vault-cli:8087";
  const r = await fetch(`${vaultUrl}/object/item/${vaultItemId}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!r.ok) {
    throw new Error(`vault-cli GET ${vaultItemId} returned HTTP ${r.status}`);
  }
  const j = (await r.json()) as {
    data?: { login?: { password?: string } };
  };
  const pw = j?.data?.login?.password;
  if (typeof pw !== "string" || pw.length === 0) {
    throw new Error("vault-cli returned an HA item without a login.password");
  }
  return pw;
}

export class HaWsClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private subscriptions = new Map<string, Subscription>();
  private authed = false;
  private reconnectCount = 0;
  private lastMessageAt: string | null = null;
  private lastError: string | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private connectingPromise: Promise<void> | null = null;

  /** Start the connection lifecycle. Idempotent. */
  start(): void {
    if (this.stopped) return;
    if (this.ws) return;
    void this.connect();
  }

  /** Stop the client cleanly; close socket and cancel timers. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // best-effort
      }
      this.ws = null;
    }
    // Reject every pending request so callers don't hang.
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error("HaWsClient stopped"));
    }
    this.pending.clear();
  }

  /** Restart — used when ha_connection mutates (reconnect / disconnect). */
  bump(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // best-effort — onClose handler reconnects
      }
      this.ws = null;
    }
    this.authed = false;
    if (!this.stopped) {
      this.scheduleReconnect(0);
    }
  }

  getStatus(): HaWsStatus {
    const conn = lookupHaConnection();
    return {
      connected: this.authed && this.ws?.readyState === WebSocket.OPEN,
      last_message_at: this.lastMessageAt,
      reconnect_count: this.reconnectCount,
      queue_depth: this.pending.size,
      ha_url: conn?.ha_url ?? null,
      last_error: this.lastError,
    };
  }

  /**
   * Request/response over the WS. Mints the next id, sends the message,
   * resolves with `result` on the matching response, rejects on `error` or
   * timeout. The HA WS protocol guarantees one response per id.
   */
  async wsCall(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.authed || this.ws?.readyState !== WebSocket.OPEN) {
      // Try to start; the call will still race the auth so we throw if
      // we can't get to authed within the timeout window.
      await this.waitForAuth(timeoutMs);
    }
    const id = this.nextId++;
    const message = { ...payload, id, type };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HaWsClient wsCall(${type}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.ws!.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Subscribe to an HA event type. Idempotent per event type — the same
   * callback is replaced if subscribed twice. Reconnects re-issue the
   * underlying `subscribe_events` automatically.
   */
  wsSubscribe(
    eventType: string,
    callback: (event: Record<string, unknown>) => void,
  ): void {
    this.subscriptions.set(eventType, {
      eventType,
      callback,
      liveId: null,
    });
    if (this.authed && this.ws?.readyState === WebSocket.OPEN) {
      void this.activateSubscription(this.subscriptions.get(eventType)!);
    }
  }

  /** Remove a subscription by event type. */
  wsUnsubscribe(eventType: string): void {
    const sub = this.subscriptions.get(eventType);
    if (!sub) return;
    if (this.authed && sub.liveId != null && this.ws?.readyState === WebSocket.OPEN) {
      try {
        const id = this.nextId++;
        this.ws.send(
          JSON.stringify({ id, type: "unsubscribe_events", subscription: sub.liveId }),
        );
      } catch {
        // best-effort
      }
    }
    this.subscriptions.delete(eventType);
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (this.connectingPromise) return this.connectingPromise;
    this.connectingPromise = (async () => {
      const conn = lookupHaConnection();
      if (!conn || conn.state !== "connected") {
        // Not configured yet — poll quietly. Don't crash, don't backoff
        // into a long sleep — operators reconnect HA seconds after a
        // first-boot.
        this.scheduleConfigPoll();
        return;
      }
      if (process.env.HA_WS_URL_OVERRIDE === "skip") {
        // Test mode — never open the socket.
        return;
      }
      let llat: string;
      try {
        llat = await readHaLlat(conn.vault_item_id);
      } catch (err) {
        this.lastError = `LLAT read failed: ${err instanceof Error ? err.message : String(err)}`;
        this.scheduleReconnect();
        return;
      }
      const wsUrl = haWsUrlFromHttp(conn.ha_url);
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        this.lastError = `WS construct failed: ${err instanceof Error ? err.message : String(err)}`;
        this.scheduleReconnect();
        return;
      }
      this.ws = ws;
      this.authed = false;
      this.attachHandlers(ws, llat);
    })();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private attachHandlers(ws: WebSocket, llat: string): void {
    ws.on("message", (raw: Buffer | string) => {
      this.lastMessageAt = new Date().toISOString();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleMessage(msg, ws, llat);
    });
    ws.on("close", () => {
      this.authed = false;
      if (this.ws === ws) this.ws = null;
      // Fail pending requests — they cannot resolve once the socket is gone.
      for (const [id, call] of this.pending) {
        clearTimeout(call.timer);
        call.reject(new Error(`HaWsClient connection closed before id=${id} resolved`));
      }
      this.pending.clear();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
    ws.on("error", (err: unknown) => {
      this.lastError = err instanceof Error ? err.message : String(err);
    });
  }

  private handleMessage(
    msg: Record<string, unknown>,
    ws: WebSocket,
    llat: string,
  ): void {
    const type = msg.type;
    if (type === "auth_required") {
      try {
        ws.send(JSON.stringify({ type: "auth", access_token: llat }));
      } catch (err) {
        this.lastError = `auth send failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return;
    }
    if (type === "auth_invalid") {
      this.lastError = "auth_invalid — LLAT rejected by HA";
      try {
        ws.close();
      } catch {
        // best-effort
      }
      return;
    }
    if (type === "auth_ok") {
      this.authed = true;
      this.lastError = null;
      // Reset backoff window once we've cleanly authed.
      this.reconnectCount = 0;
      // Replay every subscription on the now-fresh socket.
      for (const sub of this.subscriptions.values()) {
        sub.liveId = null;
        void this.activateSubscription(sub);
      }
      return;
    }
    if (type === "result") {
      const id = msg.id as number | undefined;
      if (typeof id === "number") {
        const call = this.pending.get(id);
        if (call) {
          clearTimeout(call.timer);
          this.pending.delete(id);
          if (msg.success === false) {
            const err = msg.error as { code?: string; message?: string } | undefined;
            call.reject(
              new Error(
                `HA WS error ${err?.code ?? "unknown"}: ${err?.message ?? "no message"}`,
              ),
            );
          } else {
            call.resolve(msg.result);
          }
        }
      }
      return;
    }
    if (type === "event") {
      const id = msg.id as number | undefined;
      const event = msg.event as Record<string, unknown> | undefined;
      if (typeof id !== "number" || !event) return;
      // Find the subscription that owns this id and route the event.
      for (const sub of this.subscriptions.values()) {
        if (sub.liveId === id) {
          try {
            sub.callback(event);
          } catch (err) {
            console.warn(
              "[ha_ws_client] subscription callback threw:",
              err instanceof Error ? err.message : String(err),
            );
          }
          // Default drain — write into ha_event so the LearningWorkflow can read.
          this.drainEvent(event, sub.eventType);
          return;
        }
      }
    }
  }

  private async activateSubscription(sub: Subscription): Promise<void> {
    if (!this.authed || this.ws?.readyState !== WebSocket.OPEN) return;
    const id = this.nextId++;
    sub.liveId = id;
    try {
      this.ws.send(
        JSON.stringify({ id, type: "subscribe_events", event_type: sub.eventType }),
      );
    } catch (err) {
      this.lastError = `subscribe_events failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Wait until `authed === true` OR the timeout elapses.
   * Pure await loop, no event listeners — keeps the lib free of
   * complicated emit/once gymnastics.
   */
  private async waitForAuth(timeoutMs: number): Promise<void> {
    if (this.authed && this.ws?.readyState === WebSocket.OPEN) return;
    this.start();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.authed && this.ws?.readyState === WebSocket.OPEN) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`HaWsClient not authed within ${timeoutMs}ms (last_error=${this.lastError ?? "none"})`);
  }

  private drainEvent(event: Record<string, unknown>, fallbackType: string): void {
    try {
      const eventType =
        typeof event.event_type === "string" ? (event.event_type as string) : fallbackType;
      const data = event.data as Record<string, unknown> | undefined;
      const entityId =
        data && typeof (data as Record<string, unknown>).entity_id === "string"
          ? ((data as Record<string, unknown>).entity_id as string)
          : null;
      const id = ulid();
      const ts = new Date().toISOString();
      // `ha_event` shipped in 0005_ha_channel.sql with id TEXT PK + signaled
      // INTEGER. We write signaled=0 — the loop guard contract still applies
      // to these registry-update streams the same way it applies to PR4's
      // state_changed drain.
      getStateDb()
        .prepare(
          `INSERT INTO ha_event (id, ts, event_type, entity_id, payload_json, signaled)
           VALUES (?, ?, ?, ?, ?, 0)`,
        )
        .run(id, ts, eventType, entityId, JSON.stringify(event));
    } catch (err) {
      console.warn(
        "[ha_ws_client] drainEvent failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private scheduleReconnect(overrideMs?: number): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.reconnectCount += 1;
    const base = Math.min(
      RECONNECT_INITIAL_MS * 2 ** Math.min(this.reconnectCount - 1, 5),
      RECONNECT_MAX_MS,
    );
    const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
    const delay = overrideMs ?? Math.floor(base * jitter);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private scheduleConfigPoll(): void {
    if (this.stopped) return;
    if (this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.connect();
    }, POLL_FOR_CONFIG_MS);
  }
}

// ── singleton accessor ─────────────────────────────────────────────────

let singleton: HaWsClient | null = null;

/** Get (and lazily start) the process-wide HA WS client. */
export function getHaWsClient(): HaWsClient {
  if (!singleton) {
    singleton = new HaWsClient();
    // Subscribe to the four Tier 4 registry event streams. The callbacks
    // are intentionally no-ops here — the drainEvent path inside the
    // client writes them to ha_event for the LearningWorkflow to read.
    // Later PRs (PR2 etc.) attach side-effect callbacks via the same
    // `wsSubscribe` surface.
    for (const eventType of TIER4_EVENT_STREAMS) {
      singleton.wsSubscribe(eventType, () => {
        // intentional no-op — drainEvent handles the persistence side
      });
    }
    if (process.env.HA_WS_AUTOSTART !== "false") {
      singleton.start();
    }
  }
  return singleton;
}

/** Test-only: reset the singleton so each test starts from a clean state. */
export function _resetHaWsClientForTests(): void {
  if (singleton) {
    singleton.stop();
  }
  singleton = null;
}
