// Per-tenant MCP HTTP server. Runs as a Docker container in the tenant's
// compose stack alongside ctrl-api / sure-web / openclaw. Cloudflare Tunnel
// routes  `<tenant-subdomain>.alfred.black/<app>/mcp/*`  to this service on
// port 8787 (set in compose); the OAuthProvider serves /authorize, /token,
// /register, and /.well-known endpoints alongside.
//
// Express is required because @modelcontextprotocol/sdk's auth router is
// Express-based; the rest of the platform uses node:http but the SDK auth
// surface we depend on is non-negotiable here.

import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID, createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { ZodObject, ZodRawShape } from "zod";

import { loadEnv } from "./env.js";
import { OAuthStorage } from "./oauth/storage.js";
import { SqliteOAuthProvider, issueAuthCode, timingSafeEqual } from "./oauth/provider.js";
import type { MCPProps } from "./oauth/provider.js";
import { type AppId, getToolsForApp, isAppId, SUPPORTED_APPS } from "./tools/registry.js";
import type { CtrlContext } from "./tools/types.js";
import { runTool } from "./tools/types.js";

async function main() {
  const env = loadEnv();
  const issuerUrl = new URL(env.PUBLIC_URL);
  if (issuerUrl.protocol !== "https:" && issuerUrl.hostname !== "localhost" && issuerUrl.hostname !== "127.0.0.1") {
    throw new Error(`PUBLIC_URL must be https:// (got ${env.PUBLIC_URL})`);
  }

  const storage = new OAuthStorage(env.DATA_DIR);
  // Janitor: prune expired rows hourly.
  setInterval(() => storage.pruneExpired(), 60 * 60 * 1000).unref();

  const provider = new SqliteOAuthProvider({ storage, publicUrl: env.PUBLIC_URL });

  const app = express();
  app.set("trust proxy", true); // behind cloudflared

  // CORS — claude.ai's browser-side connector wiring sends a preflight
  // OPTIONS before the real POST /<app>/mcp. Our bearer middleware runs
  // before the route handler, so an unauthenticated OPTIONS gets rejected
  // with 401 and no CORS headers — the browser blocks the actual POST,
  // claude.ai surfaces "Authorization with the MCP server failed", and
  // the user never sees the OAuth approval form.
  //
  // Fix: short-circuit preflight at the top of the middleware stack with
  // permissive CORS. Echo the request's Origin (rather than `*`) because
  // some browsers refuse `*` when credentials are involved, and add
  // long enough max-age to keep the OPTIONS round trips off the hot path.
  // Real auth still happens on the subsequent POST.
  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined;
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, MCP-Protocol-Version, mcp-session-id",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "WWW-Authenticate, mcp-session-id",
    );
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  });

  // Liveness probe
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "alfred-mcp-server",
      tenant: env.TENANT_LABEL,
      apps: [...SUPPORTED_APPS],
    });
  });

  // Per-app oauth-protected-resource metadata. MCP clients (claude.ai's
  // Custom Connectors) follow this chain: POST /<app>/mcp → 401 with
  // WWW-Authenticate header pointing at the per-app metadata URL → fetch
  // metadata → use metadata.resource as the `resource` param in /authorize.
  // Each app advertises a distinct canonical URI (`/<app>/mcp`) so the
  // /authorize handler can extract the app from `params.resource` and bind
  // the token to it. MUST be mounted BEFORE mcpAuthRouter, which serves a
  // separate (now-unused) bare-hostname doc at /.well-known/oauth-protected-resource.
  for (const appId of SUPPORTED_APPS) {
    const resourceUri = new URL(`/${appId}/mcp`, issuerUrl).href;
    app.get(`/.well-known/oauth-protected-resource/${appId}/mcp`, (_req, res) => {
      res.json({
        resource: resourceUri,
        authorization_servers: [issuerUrl.href],
        scopes_supported: [],
        resource_name: `Alfred MCP — ${env.TENANT_LABEL} — ${appId}`,
      });
    });
  }

  // OAuth: /register, /authorize (GET shows form via provider.authorize),
  //        /token, /revoke, /.well-known/{oauth-authorization-server,oauth-protected-resource}
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      scopesSupported: [],
      resourceName: `Alfred MCP — ${env.TENANT_LABEL}`,
    }),
  );

  // POST /approve — submitted by the form on /authorize. Validates the
  // pre-shared approval secret, issues an auth code, and redirects back to
  // Claude with the code (+ state).
  app.post("/approve", express.urlencoded({ extended: false }), async (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const secret = body.secret ?? "";
    if (!timingSafeEqual(secret, env.MCP_APPROVAL_SECRET)) {
      res.status(401).type("text/plain").send("Wrong approval secret. Go back and try again.");
      return;
    }

    const client_id = body.client_id;
    const redirect_uri = body.redirect_uri;
    const code_challenge = body.code_challenge;
    const app_id = body.app;
    const state = body.state;
    const resource = body.resource ?? null;
    const scopes = body.scope ? body.scope.split(/\s+/).filter(Boolean) : [];

    if (!client_id || !redirect_uri || !code_challenge || !app_id) {
      res.status(400).type("text/plain").send("Missing required fields on approval submission");
      return;
    }
    if (!isAppId(app_id)) {
      res.status(400).type("text/plain").send(`Unsupported app: ${app_id}`);
      return;
    }

    const props: MCPProps = {
      appId: app_id,
      tenantLabel: env.TENANT_LABEL,
    };

    const { code } = issueAuthCode(storage, {
      client_id,
      redirect_uri,
      code_challenge,
      scopes,
      resource,
      props,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  });

  // ── MCP route: per-app under /<app>/mcp ───────────────────────────────────
  //
  // McpServer + StreamableHTTPServerTransport are PER-SESSION, not per-app.
  // The earlier "one transport per app at startup" pattern only handled the
  // first client; every subsequent client's `initialize` returned 400
  // ("Server already initialized") because the McpServer had been bound to
  // the first session for the lifetime of the process. claude.ai opens a
  // fresh session every chat, so after the first chat the connector looked
  // permanently broken — every tool call surfaced as "tool failed", which
  // is what Sir reported.
  //
  // Correct shape:
  //   - One Map<sessionId, transport> per app (transports live in memory
  //     keyed by the session id the SDK generates on initialize).
  //   - Each new initialize without a session header creates a fresh
  //     transport + McpServer pair and stores it under the new session id.
  //   - Subsequent requests with mcp-session-id route to the existing
  //     transport.
  //   - When a transport closes, drop the entry.
  // Memory profile: ~25 KB per session, capped naturally by Sir's
  // concurrent-chat count. If we ever need to multi-replica, swap to a
  // shared session store keyed off SQLite or Redis.

  // Programmatic-client shortcut. claude.ai goes through the human-typed
  // /approve form once and rides OAuth bearer tokens after that. Scripts /
  // curl / other MCP clients can skip the OAuth dance entirely by sending
  // `Authorization: Bearer <MCP_APPROVAL_SECRET>`. The check runs BEFORE
  // requireBearerAuth: on a match we synthesize the same `extra` shape an
  // OAuth-authed call would carry (appId + tenantLabel) and short-circuit;
  // on a miss we fall through to the OAuth verifier untouched.
  //
  // Same secret, same scope as the /approve form. The blast radius of
  // leaking MCP_APPROVAL_SECRET is unchanged — it could already mint an
  // OAuth token via /approve. This bypass just removes the round-trip.
  const approvalSecretBypass = (appId: AppId) =>
    (req: Request, _res: Response, next: NextFunction) => {
      const header = req.headers.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        return next();
      }
      const token = header.slice("Bearer ".length).trim();
      if (!token) return next();
      if (!timingSafeEqual(token, env.MCP_APPROVAL_SECRET)) {
        return next(); // wrong token → let requireBearerAuth try OAuth
      }
      // Synthesize the AuthInfo shape requireBearerAuth would have set.
      // `expiresAt` is omitted: the approval-secret bearer doesn't expire
      // (it has no per-token lifetime; rotation = .env edit + restart).
      (req as Request & { auth?: unknown }).auth = {
        token,
        clientId: "approval-secret-bypass",
        scopes: [],
        extra: {
          appId,
          tenantLabel: env.TENANT_LABEL,
        } satisfies MCPProps,
      };
      next();
    };

  for (const appId of SUPPORTED_APPS) {
    // Per-app bearer middleware so the WWW-Authenticate challenge points at
    // the per-app metadata URL — that's what makes claude.ai send the right
    // `resource` param into /authorize. Runs AFTER approvalSecretBypass:
    // if the bypass already populated req.auth, the SDK treats this as a
    // valid token and skips the OAuth verifier.
    const auth = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: new URL(
        `/.well-known/oauth-protected-resource/${appId}/mcp`,
        issuerUrl,
      ).href,
    });

    const tools = getToolsForApp(appId);

    // Build a fresh McpServer + transport pair on demand for a new session.
    // Closing one entry must remove it from the map so memory doesn't leak.
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    const buildTransport = (): StreamableHTTPServerTransport => {
      const mcp = new McpServer({
        name: `alfred-${env.TENANT_LABEL.toLowerCase()}-${appId}`,
        version: "1.0.0",
      });
      for (const tool of tools) {
        const shape = (tool.inputSchema as ZodObject<ZodRawShape>).shape;
        mcp.registerTool(
          tool.name,
          { description: tool.description, inputSchema: shape },
          async (args: unknown, extra: { authInfo?: { extra?: Record<string, unknown> } }) => {
            const props = (extra.authInfo?.extra ?? {}) as Partial<MCPProps>;
            if (props.appId !== appId) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `app mismatch: token bound to "${props.appId}", but called via /${appId}/mcp`,
                  },
                ],
                isError: true,
              };
            }
            const ctx: CtrlContext = {
              ctrlUrl: env.CTRL_URL,
              aasApiKey: env.AAS_API_KEY,
            };
            return runTool(ctx, tool, args);
          },
        );
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, transport);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };
      void mcp.connect(transport);
      return transport;
    };

    const path = `/${appId}/mcp`;
    app.all(path, approvalSecretBypass(appId), auth, express.json(), async (req, res) => {
      try {
        const sessionHeader = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

        let transport: StreamableHTTPServerTransport | undefined;
        if (sessionId) {
          transport = sessions.get(sessionId);
          if (!transport) {
            res.status(404).json({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: `Session not found: ${sessionId} (it expired or never existed; re-initialize)`,
              },
              id: null,
            });
            return;
          }
        } else {
          // No session header → must be an initialize request to spin up a
          // new session. Anything else without a session is a protocol error
          // from a confused client; the SDK will produce a clean error body.
          transport = buildTransport();
        }

        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error(`[${appId}/mcp]`, err);
        if (!res.headersSent) {
          res.status(500).json({ error: "internal_error" });
        }
      }
    });
  }

  // Catch-all 404 for anything else (the cloudflared ingress should route
  // only `/<app>/mcp` + OAuth paths to us; ctrl-api handles everything else
  // on the tenant subdomain).
  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  const port = Number(env.PORT ?? "8787");
  app.listen(port, () => {
    console.log(`alfred-mcp-server listening on :${port}, public URL ${env.PUBLIC_URL}`);
    console.log(`apps: ${[...SUPPORTED_APPS].join(", ")}`);
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

// silence unused-import warning when sha256 not directly referenced in this file
void createHash;
