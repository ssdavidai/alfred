// Proxy surface for per-app MCP scoped bearer tokens — `/api/v1/mcp/tokens/*`.
//
// The mcp-server container OWNS these tokens: it mints/lists/rotates/deletes
// them in its own SQLite and validates them locally on every `POST
// /<app>/mcp` (see packages/mcp-server/src/scopedTokens.ts + index.ts). This
// module is a THIN server-side proxy so the dashboard can drive that surface
// without the browser ever holding the tenant-wide MCP_APPROVAL_SECRET:
//
//     browser → web (Wasp op) → ctrl-api (here) → mcp-server /manage/tokens
//
// It preserves the "web only ever talks to ctrl-api" invariant. Auth: the
// inbound hop is gated by the global authenticate() middleware (AAS_API_KEY),
// like every ctrl-api route; the onward hop to mcp-server presents
// MCP_APPROVAL_SECRET (injected via env_file .env, explicit in compose).
//
// PRIVACY: the raw token is returned by mcp-server EXACTLY ONCE (mint +
// rotate); list responses never carry it. This module relays verbatim, so
// the same posture holds end-to-end.

import type { ServerResponse } from "node:http";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";

const MCP_SERVER_URL = (process.env.MCP_SERVER_URL ?? "http://mcp-server:8787").replace(/\/+$/, "");

/** Forward a management call to mcp-server and relay its status + JSON body. */
async function forward(
  res: ServerResponse,
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const secret = process.env.MCP_APPROVAL_SECRET ?? "";
  if (!secret) {
    sendJson(res, 500, {
      error: {
        code: "MCP_NOT_CONFIGURED",
        message: "MCP_APPROVAL_SECRET is not set on ctrl-api; cannot manage MCP tokens",
      },
    });
    return;
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${MCP_SERVER_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    sendJson(res, 502, {
      error: { code: "MCP_UNREACHABLE", message: `mcp-server unreachable: ${(err as Error).message}` },
    });
    return;
  }
  const text = await upstream.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  sendJson(res, upstream.status, data);
}

export function registerMcpTokensRoutes(): void {
  // GET /api/v1/mcp/tokens[?app=<app>] — list token metadata (never the raw
  // value) + the supported apps + public connector base for the UI.
  addRoute("GET", "/api/v1/mcp/tokens", async ({ res, query }) => {
    const app = query.get("app");
    const qs = app ? `?app=${encodeURIComponent(app)}` : "";
    await forward(res, "GET", `/manage/tokens${qs}`);
  });

  // POST /api/v1/mcp/tokens {app, label} — mint. Raw token returned ONCE.
  addRoute("POST", "/api/v1/mcp/tokens", async ({ res, body }) => {
    const b = (body ?? {}) as { app?: unknown; label?: unknown };
    await forward(res, "POST", "/manage/tokens", {
      app: typeof b.app === "string" ? b.app : "",
      label: typeof b.label === "string" ? b.label : "",
    });
  });

  // POST /api/v1/mcp/tokens/:id/rotate — rotate in place. Raw token ONCE.
  addRoute("POST", "/api/v1/mcp/tokens/:id/rotate", async ({ res, params }) => {
    await forward(res, "POST", `/manage/tokens/${encodeURIComponent(params.id)}/rotate`);
  });

  // DELETE /api/v1/mcp/tokens/:id — delete (hard).
  addRoute("DELETE", "/api/v1/mcp/tokens/:id", async ({ res, params }) => {
    await forward(res, "DELETE", `/manage/tokens/${encodeURIComponent(params.id)}`);
  });
}
