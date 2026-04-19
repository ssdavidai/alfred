// Voice Bridge entry — HTTP server + WebSocket server on :9000.
//
// Caddy proxies wss://alfred.black/voice/<tenantId>?sig=<hmac>&initiator=...&intent=...
// to this process. We validate the signed query, then hand the WS off to a
// VoiceCall instance that runs the Twilio MS ↔ OpenAI Realtime bridge.

import http from "http";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { VoiceCall } from "./voice-call.js";

function verifySig(tenantId: string, sig: string | null): boolean {
  if (!sig) return false;
  const expected = crypto
    .createHmac("sha256", config.internalToken)
    .update(tenantId)
    .digest("hex");
  // Constant-time compare
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Process-local metrics ────────────────────────────────────────────────────
// Kept tiny; no Prom client lib — emit plaintext Prometheus exposition so we
// can scrape from Grafana when it's wired up.
const metrics = {
  callsAccepted: 0,
  callsRejected403: 0,
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
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/voice\/([^/]+)$/);
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const tenantId = decodeURIComponent(match[1]);
    const sig = url.searchParams.get("sig");
    if (!verifySig(tenantId, sig)) {
      bumpMetric("callsRejected403");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    bumpMetric("callsAccepted");
    const initiator =
      url.searchParams.get("initiator") === "alfred" ? "alfred" : "user";
    const intent = url.searchParams.get("intent") ?? undefined;

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
