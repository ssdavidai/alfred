import fs from "node:fs";
import express from "express";
import cors from "cors";
import type { Application, Request, Response, RequestHandler } from "express";
import type { IncomingMessage } from "http";
import { getSessionAndUserFromBearerToken } from "wasp/auth/session";
import {
  CHAT_ROUTE_PREFIX,
  CHAT_ROUTE_PATHS,
  resolveChatCorsOrigin,
  resolveGatewayTokenFromEnv,
} from "./chatProxyCore";
import { tryFastPath } from "./intentRouterCore";

/**
 * Chat proxy — single-VM edition, Hermes runtime.
 *
 * OpenClaw exposed a raw WebSocket at `:18789/` for the dashboard chat
 * widget. Hermes is HTTP/SSE: its API server binds the canonical port
 * `http://hermes:18789` directly on the compose network (the hermes-shim
 * that used to front it was retired in issue #40).
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

// The Hermes `main`-profile API server binds `:18789` directly on the
// compose network and serves the `/v1/*` API. Overridable for local dev.
const HERMES_GATEWAY_URL =
  process.env.HERMES_GATEWAY_URL ?? "http://hermes:18789";

// ctrl-api for the #425 deterministic fast-path (same access pattern as
// filesProxy: CTRL_API_URL + the shared AAS_API_KEY bearer). Simple data
// lookups (decisions/matters/chores/balance) are answered here directly,
// skipping a full ~2s+ LLM turn. Fail-open — any error falls through to Hermes.
const CTRL_API_URL = process.env.CTRL_API_URL ?? "http://ctrl-api:3100";
const CTRL_API_KEY = process.env.AAS_API_KEY ?? "";

async function ctrlGet(path: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`${CTRL_API_URL}${path}`, {
      headers: CTRL_API_KEY ? { Authorization: `Bearer ${CTRL_API_KEY}` } : {},
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`ctrl-api ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Hermes upstream auth. The Hermes API server validates inbound requests
// against the gateway token written by the init container to
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
  // F61 — env fallback aligned with the file token (see chatProxyCore).
  return resolveGatewayTokenFromEnv(process.env);
}

/** CORS middleware for the custom `/api/chat/*` routes (Wasp's router does
 *  not cover setupFn-registered routes). `credentials:false` because the chat
 *  widget authenticates with an Authorization bearer, not cookies. */
function chatCors(): RequestHandler {
  return cors({
    origin: resolveChatCorsOrigin(process.env.WASP_WEB_CLIENT_URL),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Accept"],
    credentials: false,
  });
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
  // F61 — apply CORS to every chat route. These routes live outside Wasp's
  // CORS-bearing router, so without this the browser blocks the cross-origin
  // fetch from the SPA host to the `api.` subdomain.
  //
  // B10 — the `cors` middleware mounted here already answers OPTIONS preflight
  // (it short-circuits OPTIONS with a 204 + the Access-Control-Allow-* headers).
  // The previous explicit `app.options("/api/chat/*", …)` registration threw at
  // boot in the deployed Express/path-to-regexp version ("Missing parameter name
  // … /api/chat/*"): the bare `*` wildcard path is no longer a valid route
  // string, and the throw aborted `registerChatProxy` before any of the four
  // `/api/chat/*` routes registered — they all 404'd and the widget showed
  // "Could not reach the chat service." Mounting `cors` as path-prefix
  // middleware (no wildcard route string) is enough for preflight.
  const cors = chatCors();
  app.use(CHAT_ROUTE_PREFIX, cors);

  // ── Health / config probe ──────────────────────────────────────
  // Lets the chat widget show a clear "not configured" state instead of
  // failing opaquely.
  app.get(CHAT_ROUTE_PATHS[0], async (req: Request, res: Response) => {
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

  app.post(CHAT_ROUTE_PATHS[1], jsonBody, async (req: Request, res: Response) => {
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

      // #425 deterministic fast-path — answer simple lookups from ctrl-api,
      // skip the LLM. Fail-open: a miss/unfamiliar-shape/error returns null.
      const fastTurn = await tryFastPath(input, ctrlGet);
      if (fastTurn) {
        res.status(200).setHeader("Content-Type", "application/json");
        res.send(JSON.stringify(fastTurn));
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
  app.post(CHAT_ROUTE_PATHS[2], jsonBody, async (req: Request, res: Response) => {
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

      // #425 fast-path (streaming path too): the widget renders a completed
      // envelope immediately without opening SSE. Fail-open to a real run.
      const fastRun = await tryFastPath(input, ctrlGet);
      if (fastRun) {
        res.status(200).setHeader("Content-Type", "application/json");
        res.send(JSON.stringify(fastRun));
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
  app.get(CHAT_ROUTE_PATHS[3], async (req: Request, res: Response) => {
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

      // Re-stream the upstream SSE bytes verbatim — the event framing is
      // preserved and the browser renders tokens as they land.
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
