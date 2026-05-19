import fs from "node:fs";
import express from "express";
import type { Application, Request, Response } from "express";
import type { IncomingMessage } from "http";
import { getSessionAndUserFromBearerToken } from "wasp/auth/session";

/**
 * Chat proxy — single-VM edition, Hermes runtime.
 *
 * OpenClaw exposed a raw WebSocket at `:18789/` for the dashboard chat
 * widget. Hermes is HTTP/SSE: its API server is reached through the
 * hermes-shim's transparent `/v1/*` passthrough at `http://hermes:18789`.
 * The shim is the only Hermes surface on the compose network (the Hermes
 * API server itself binds 127.0.0.1 inside the container).
 *
 * The browser cannot reach `hermes:18789` directly, so this module mounts
 * three Express routes on the Wasp server — mirroring how `terminalProxy`
 * bridges the browser terminal to ctrl-api. Browser auth is the Wasp
 * session token; the upstream Hermes call uses the gateway bearer token.
 *
 * Chat model (Hermes `/v1` API):
 *   - `POST /api/chat/turn`   → Hermes `POST /v1/responses` (stateful,
 *                               non-streaming; carries `previous_response_id`
 *                               for conversation continuity).
 *   - `POST /api/chat/run`    → Hermes `POST /v1/runs` — starts a run for
 *                               token-streaming; returns `{ runId }`.
 *   - `GET  /api/chat/stream` → Hermes `GET /v1/runs/{id}/events` SSE,
 *                               re-streamed verbatim to the browser.
 *
 * The streaming pair (`/run` + `/stream`) is the primary chat path; the
 * single-shot `/turn` is the fallback when SSE is unavailable.
 */

// The hermes-shim binds the legacy `:18789` port (main profile) on the
// compose network and transparently proxies `/v1/*` to the Hermes API
// server. Overridable for local dev.
const HERMES_GATEWAY_URL =
  process.env.HERMES_GATEWAY_URL ?? "http://hermes:18789";

// Hermes upstream auth. The shim validates inbound requests against the
// legacy gateway token written by the init container to
// `/alfred-data/.gateway-token`. If the web container mounts the
// `alfred_data` volume, that file is the source of truth; otherwise fall
// back to the `HERMES_API_SERVER_KEY` env var (same token value when the
// stack is bootstrapped with a pre-set gateway token).
const GATEWAY_TOKEN_FILE =
  process.env.OPENCLAW_GATEWAY_TOKEN_FILE ?? "/alfred-data/.gateway-token";

function resolveGatewayToken(): string {
  try {
    const fromFile = fs.readFileSync(GATEWAY_TOKEN_FILE, "utf-8").trim();
    if (fromFile) return fromFile;
  } catch {
    /* file not mounted in this container — fall through to env */
  }
  return (
    process.env.HERMES_API_SERVER_KEY ??
    process.env.OPENCLAW_GATEWAY_TOKEN ??
    ""
  );
}

async function getUserIdFromRequest(
  req: IncomingMessage,
): Promise<string | null> {
  const result = await getSessionAndUserFromBearerToken(req as any);
  if (!result) return null;
  return result.user.id;
}

/** Pull the Wasp session token from the Authorization header or `?token=`. */
function bearerOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const q = req.query?.token;
  if (typeof q === "string" && q.length > 0) return q;
  return null;
}

/** Inject `?token=` as an Authorization header so Wasp can read it. */
function withInjectedBearer(req: Request): IncomingMessage {
  const token = bearerOf(req);
  if (token) {
    (req as unknown as IncomingMessage).headers.authorization = `Bearer ${token}`;
  }
  return req as unknown as IncomingMessage;
}

export function registerChatProxy(app: Application): void {
  // ── Health / config probe ──────────────────────────────────────
  // Lets the chat widget show a clear "not configured" state instead of
  // failing opaquely.
  app.get("/api/chat/status", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromRequest(withInjectedBearer(req));
      if (!userId) {
        res
          .status(401)
          .json({ ok: false, error: "not_authenticated" });
        return;
      }
      if (!resolveGatewayToken()) {
        res.json({
          ok: false,
          error: "not_configured",
          message:
            "Hermes gateway token is not available to the web server.",
        });
        return;
      }
      // Probe Hermes liveness through the shim.
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const probe = await fetch(`${HERMES_GATEWAY_URL}/health`, {
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        res.json({ ok: probe.ok, error: probe.ok ? null : "unhealthy" });
      } catch (err: any) {
        res.json({ ok: false, error: "unreachable", message: err.message });
      }
    } catch (err: any) {
      res.status(500).json({ ok: false, error: "internal", message: err.message });
    }
  });

  // ── Turn-by-turn (non-streaming, stateful) ─────────────────────
  // POST /api/chat/turn  { input: string, previousResponseId?: string,
  //                        conversation?: string }
  // → Hermes POST /v1/responses with store:true so the next turn can
  //   carry `previous_response_id` for conversation continuity.
  // Custom Express routes do not inherit Wasp's body parser — attach
  // `express.json()` per route so `req.body` is populated.
  const jsonBody = express.json({ limit: "256kb" });

  app.post("/api/chat/turn", jsonBody, async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromRequest(withInjectedBearer(req));
      if (!userId) {
        res.status(401).json({ error: "not_authenticated" });
        return;
      }
      const token = resolveGatewayToken();
      if (!token) {
        res.status(503).json({ error: "Hermes gateway not configured" });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const input = typeof body.input === "string" ? body.input : "";
      if (!input.trim()) {
        res.status(400).json({ error: "input is required" });
        return;
      }

      // Hermes `/v1/responses` payload. `store:true` makes the response
      // retrievable and chainable via `previous_response_id`.
      const payload: Record<string, unknown> = { input, store: true };
      if (typeof body.previousResponseId === "string" && body.previousResponseId) {
        payload.previous_response_id = body.previousResponseId;
      }
      if (typeof body.conversation === "string" && body.conversation) {
        payload.conversation = body.conversation;
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      const upstream = await fetch(`${HERMES_GATEWAY_URL}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));

      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") ?? "application/json",
      );
      res.send(text);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        res.status(504).json({ error: "Hermes request timed out" });
        return;
      }
      console.error("[chat-proxy] turn error:", err);
      res.status(502).json({ error: "Failed to reach the Hermes runtime" });
    }
  });

  // ── Start a streaming run ──────────────────────────────────────
  // POST /api/chat/run  { input: string, sessionId?: string,
  //                       previousResponseId?: string }
  // → Hermes POST /v1/runs. Returns the created run object (incl. id) so
  //   the browser can then open the SSE stream below.
  app.post("/api/chat/run", jsonBody, async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromRequest(withInjectedBearer(req));
      if (!userId) {
        res.status(401).json({ error: "not_authenticated" });
        return;
      }
      const token = resolveGatewayToken();
      if (!token) {
        res.status(503).json({ error: "Hermes gateway not configured" });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const input = typeof body.input === "string" ? body.input : "";
      if (!input.trim()) {
        res.status(400).json({ error: "input is required" });
        return;
      }

      const payload: Record<string, unknown> = { input };
      // A stable per-browser session keeps the run thread coherent; the
      // dashboard chat uses one session per logged-in user.
      if (typeof body.sessionId === "string" && body.sessionId) {
        payload.session_id = body.sessionId;
      } else {
        payload.session_id = `web-chat-${userId}`;
      }
      if (typeof body.previousResponseId === "string" && body.previousResponseId) {
        payload.previous_response_id = body.previousResponseId;
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      const upstream = await fetch(`${HERMES_GATEWAY_URL}/v1/runs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));

      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") ?? "application/json",
      );
      res.send(text);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        res.status(504).json({ error: "Hermes request timed out" });
        return;
      }
      console.error("[chat-proxy] run error:", err);
      res.status(502).json({ error: "Failed to reach the Hermes runtime" });
    }
  });

  // ── Stream run events (SSE) ────────────────────────────────────
  // GET /api/chat/stream?runId=<id>&token=<wasp-session>
  // → Hermes GET /v1/runs/{id}/events. The upstream Server-Sent-Events
  //   body is re-streamed verbatim to the browser. An EventSource on the
  //   client can't set Authorization headers, so the Wasp session token
  //   is passed as `?token=`.
  app.get("/api/chat/stream", async (req: Request, res: Response) => {
    const userId = await getUserIdFromRequest(withInjectedBearer(req));
    if (!userId) {
      res.status(401).json({ error: "not_authenticated" });
      return;
    }
    const token = resolveGatewayToken();
    if (!token) {
      res.status(503).json({ error: "Hermes gateway not configured" });
      return;
    }
    const runId = typeof req.query.runId === "string" ? req.query.runId : "";
    if (!runId) {
      res.status(400).json({ error: "runId is required" });
      return;
    }

    // SSE response headers for the browser leg.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const upstreamCtrl = new AbortController();
    // If the browser hangs up, abort the upstream fetch.
    req.on("close", () => upstreamCtrl.abort());

    try {
      const upstream = await fetch(
        `${HERMES_GATEWAY_URL}/v1/runs/${encodeURIComponent(runId)}/events`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "text/event-stream",
          },
          signal: upstreamCtrl.signal,
        },
      );

      if (!upstream.ok || !upstream.body) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            message: `Hermes stream unavailable (HTTP ${upstream.status})`,
          })}\n\n`,
        );
        res.end();
        return;
      }

      // Re-stream the upstream SSE bytes verbatim. The hermes-shim may
      // buffer the upstream body before forwarding; either way the event
      // framing is preserved and the browser renders tokens as they land.
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (err: any) {
      if (err?.name === "AbortError") {
        // Browser disconnected — nothing to send.
        res.end();
        return;
      }
      console.error("[chat-proxy] stream error:", err);
      try {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            message: "Failed to reach the Hermes runtime",
          })}\n\n`,
        );
      } catch {
        /* response already closed */
      }
      res.end();
    }
  });
}
