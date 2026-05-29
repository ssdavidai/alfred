// Voice Bridge entry — HTTP server + WebSocket server on :9000.
//
// Caddy proxies wss://voice.alfred.black/voice/<tenantId> to this process.
// (The `voice.alfred.black` subdomain is DNS-only at Cloudflare — orange cloud
// off — because Cloudflare's WAF drops Twilio Media Stream WS upgrades with
// error 31920 on proxied hostnames.)
//
// Authentication: the TwiML <Stream> emitted by SaaS carries a signed HMAC in
// a <Parameter name="sig"> child element. Twilio strips query strings from the
// Stream URL, so we CANNOT verify the sig on WS upgrade — it arrives inside
// the first `start` event on the stream. `VoiceCall` reads + verifies it before
// doing any billable work (tenant lookup, OpenAI Realtime connect).
//
// On-wire flow:
//   1. Client opens WS to /voice/<tenantId>
//   2. We accept the upgrade iff the path shape is valid.
//   3. VoiceCall waits for Twilio `start` event; verifies customParameters.sig;
//      if bad, disposes immediately.
//   4. Valid sig → fetch tenant context + connect OpenAI Realtime + greet.
//
// See packages/saas/app/src/server/twilio/webhooks.ts for the matching
// `<Parameter name="sig">` emission.

import http from "http";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { VoiceCall } from "./voice-call.js";
import { handleTwimlInbound, TWIML_INBOUND_PATH } from "./twiml.js";
import { connectAllMcp } from "./mcp-clients.js";
import {
  computeIdentity,
  startEsphomeServer,
  type EsphomeServerHandle,
  type KnownEsphomeDevice,
} from "./esphome-server.js";
import { announceEsphomeMdns } from "./esphome-mdns.js";
import { EsphomeVoiceSession } from "./esphome-session.js";
import { startWyomingServer, type WyomingServerHandle } from "./wyoming-server.js";
// === Recall PR5: in-meeting voice ===
// One Recall bot = one short OpenAI Realtime turn per wake-word hit.
// ctrl-api drives the wake-word detection on its side and POSTs the
// transcript here. The handler enforces the persona constraint
// (bot speaks AS ALFRED, never as the principal) via the system
// prompt assembled in recall-meeting-context.ts.
import { handleRecallTurnRequest } from "./recall-server.js";
// === end Recall PR5 ===

export function verifySig(tenantId: string, sig: string | null | undefined): boolean {
  if (!sig) return false;
  const expected = crypto
    .createHmac("sha256", config.internalToken)
    .update(tenantId)
    .digest("hex");
  // Constant-time compare; any length mismatch = reject.
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(sig, "hex");
    b = Buffer.from(expected, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Process-local metrics ────────────────────────────────────────────────────
// Kept tiny; no Prom client lib — emit plaintext Prometheus exposition so we
// can scrape from Grafana when it's wired up.
const metrics = {
  callsAccepted: 0,
  callsRejectedBadPath: 0,
  callsRejectedBadSig: 0,
  callsDisposed: 0,
  toolDispatches: 0,
  errors: 0,
};

export function bumpMetric(name: keyof typeof metrics, n = 1): void {
  metrics[name] += n;
}

function renderMetrics(): string {
  return (
    Object.entries(metrics)
      .map(
        ([k, v]) =>
          `# TYPE voice_bridge_${k} counter\nvoice_bridge_${k} ${v}\n`,
      )
      .join("") + "\n"
  );
}

// Boot-time handles captured by the ESPHome + Wyoming initialisers below.
// The HTTP control routes (`/esphome/devices`, `/wyoming/status`) read
// from these. Initially null — surface as `{enabled: false, ...}` to the
// caller until the listeners come up.
let esphomeHandle: EsphomeServerHandle | null = null;
let wyomingHandle: WyomingServerHandle | null = null;

/** Public shape returned by `GET /esphome/devices`. Kept in this file to
 * keep ctrl-api proxying simple — both sides import this type later if
 * needed; for now the wire shape is the contract. */
export interface EsphomeDevicesPayload {
  enabled: boolean;
  /** "0.0.0.0:6053" — informational so the dashboard can render a hint
   * when listener_address has been re-bound. */
  listener_address: string | null;
  devices: KnownEsphomeDevice[];
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(renderMetrics());
    return;
  }
  // ── PR5 control surface ──────────────────────────────────────────────
  // ctrl-api hits these over the internal docker network so the operator
  // dashboard can render which HA installs have paired + whether the
  // Wyoming fallback is hot. Both are GET-only — there is no remote write
  // to the voice-bridge from here. Authentication is the docker network
  // boundary; both ports stay bound to localhost / docker-bridge only.
  if (req.url === "/esphome/devices") {
    const payload: EsphomeDevicesPayload = esphomeHandle
      ? {
          enabled: true,
          listener_address: `${config.esphomeApiBind}:${config.esphomeApiPort}`,
          devices: esphomeHandle.getKnownDevices(),
        }
      : {
          enabled: false,
          listener_address: null,
          devices: [],
        };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }
  if (req.url === "/wyoming/status") {
    const payload = {
      enabled: !!wyomingHandle,
      port: wyomingHandle ? config.wyomingPort : null,
      bind: wyomingHandle ? config.wyomingBind : null,
      last_handshake_at: wyomingHandle?.lastHandshakeAt() ?? null,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }
  // === Recall PR5: in-meeting voice ===
  // /voice/recall-turn — ctrl-api calls here on every wake-word hit
  // inside an active Recall meeting. Bearer is the shared internal
  // token; we run ONE OpenAI Realtime turn (stateless, fresh session
  // per turn) and reply with rendered audio + Alfred's response text.
  //
  // Persona constraint (Sir explicit, 2026-05-29 evening): the system
  // prompt assembled by buildRecallInstructions() / buildMeetingPrefix()
  // forces the model to speak AS ALFRED, never as the principal — this
  // is the SOLE place in the active half of Recall where the bot's
  // voice is set, and the prompt embeds the three-layer enforcement
  // (opening identity + announce-on-join + closing CRITICAL guardrail).
  if (req.url === "/voice/recall-turn" && req.method === "POST") {
    handleRecallTurnRequest(req, res).catch((err) => {
      console.error("[recall-turn] handler error", err);
      bumpMetric("errors");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }
  // === end Recall PR5 ===
  // Twilio "A CALL COMES IN" webhook — returns TwiML pointing at the
  // WSS endpoint below. See twiml.ts for the full handler + the security
  // model (X-Twilio-Signature verification, fail-soft when token unset).
  if (req.url === TWIML_INBOUND_PATH) {
    handleTwimlInbound(req, res).catch((err) => {
      console.error("[twiml] handler error", err);
      bumpMetric("errors");
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/voice\/([^/]+)$/);
    if (!match) {
      bumpMetric("callsRejectedBadPath");
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const tenantId = decodeURIComponent(match[1]);
    // Sig arrives in the Twilio `start` event (customParameters) — NOT in the
    // WS URL query string, since Twilio strips query params from Stream URLs.
    // VoiceCall verifies it before any billable work.
    const initiator =
      url.searchParams.get("initiator") === "alfred" ? "alfred" : "user";
    const intent = url.searchParams.get("intent") ?? undefined;
    bumpMetric("callsAccepted");

    wss.handleUpgrade(req, socket, head, (ws) => {
      const call = new VoiceCall(ws, { tenantId, initiator, intent });
      call.start().catch((err) => {
        console.error("[server] VoiceCall.start failed", err);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      });
    });
  } catch (err) {
    console.error("[server] upgrade error", err);
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
});

httpServer.listen(config.port, () => {
  console.log(`[voice-bridge] listening on :${config.port}`);
});

// Connect to every MCP server at boot. Best-effort: per-server failures are
// logged and voice still works with whatever connected. Awaiting this would
// add 1-3s to startup for no value — calls come tens of seconds later, the
// catalog is populated long before the first session.update.
void connectAllMcp().catch((err) => {
  console.error("[mcp] connectAllMcp threw (continuing):", err);
});

// ── ESPHome Native API listener (issue #112, PR1 skeleton) ──────────────────
// Boots a second TCP listener on :6053 that speaks the ESPHome Native API.
// Opt-in via ESPHOME_API_ENABLED so we don't surprise existing tenants on
// rollout — flip to "1" in docker-compose once the audio path is wired in PR2.
// The Twilio path above is untouched; both listeners share the Node event
// loop but the codecs are unrelated.
if (config.esphomeApiEnabled) {
  const identity = computeIdentity({
    tenantSeed: config.esphomeTenantSeed || undefined,
    friendlyName: config.esphomeFriendlyName,
  });
  const handle = startEsphomeServer({
    port: config.esphomeApiPort,
    bindHost: config.esphomeApiBind,
    identity,
    password: config.haVoiceApiToken || undefined,
    // PR2 wires the ESPHome ↔ OpenAI Realtime bridge. The factory is passed
    // explicitly (not statically imported by esphome-server.ts) so the test
    // suite — which never touches OpenAI — doesn't need OPENAI_API_KEY in
    // env. See esphome-server.ts's import block for the long form.
    voiceSessionFactory: (opts) => new EsphomeVoiceSession(opts),
  });
  esphomeHandle = handle;
  handle.ready
    .then(() =>
      announceEsphomeMdns({
        port: config.esphomeApiPort,
        identity,
      }),
    )
    .catch((err) => {
      console.error("[esphome] startup failed (continuing without HA leg):", err);
    });

  // PR5 — Wyoming Protocol fallback. Same brain factory, different transport
  // shape. Boots iff WYOMING_ENABLED=1; defaults off because most tenants
  // use ESPHome Native and the extra listener is dead weight otherwise.
  if (config.wyomingEnabled) {
    const wyHandle = startWyomingServer({
      port: config.wyomingPort,
      bindHost: config.wyomingBind,
      identity,
      voiceSessionFactory: (opts) => new EsphomeVoiceSession(opts),
    });
    wyomingHandle = wyHandle;
    wyHandle.ready.catch((err) => {
      console.error(
        "[wyoming] startup failed (continuing without Wyoming fallback):",
        err,
      );
      wyomingHandle = null;
    });
  } else {
    console.log("[wyoming] WYOMING_ENABLED!=1 — Wyoming fallback disabled");
  }
} else {
  console.log("[esphome] ESPHOME_API_ENABLED!=1 — HA voice leg disabled");
}

// Surface uncaught failures rather than dying silently.
process.on("uncaughtException", (err) => {
  console.error("[voice-bridge] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[voice-bridge] unhandledRejection", reason);
});
