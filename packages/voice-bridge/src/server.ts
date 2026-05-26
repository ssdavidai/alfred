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

// Surface uncaught failures rather than dying silently.
process.on("uncaughtException", (err) => {
  console.error("[voice-bridge] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[voice-bridge] unhandledRejection", reason);
});
