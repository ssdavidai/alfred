// Worker entry. Wraps the SureMCP McpAgent in Cloudflare's OAuthProvider so
// the Worker exposes the OAuth 2.1 + DCR endpoints that Claude's Custom
// Connectors UI requires. Bearer-only mode (the prior implementation) was
// rejected by Anthropic's UI: it doesn't expose a "static bearer" field.
//
// Flow when Sir adds the connector at https://mcp.alfred.black/mcp:
//
//   1. Sir pastes the URL in claude.ai → Settings → Connectors → Add custom.
//   2. Claude fetches /.well-known/oauth-authorization-server (auto-served
//      by OAuthProvider) and discovers /authorize, /token, /register.
//   3. Claude registers itself as a client via Dynamic Client Registration
//      (RFC 7591) on /register — no manual client_id/secret needed.
//   4. Claude opens /authorize?client_id=...&redirect_uri=... in Sir's
//      browser. Our defaultHandler renders a tiny approval page; Sir pastes
//      his MCP_APPROVAL_SECRET, clicks Approve.
//   5. We call OAuthProvider.completeAuthorization(...) with userId="david"
//      + Sir's bearer carried as `props` so the McpAgent can attach it on
//      every outbound ctrl-api call.
//   6. Claude exchanges the code at /token for an access token.
//   7. Claude calls /mcp with `Authorization: Bearer <access_token>`. The
//      OAuthProvider validates it, extracts `props`, and forwards to
//      SureMCP.serve("/mcp"). The DO uses props.aasApiKey on backend calls.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { ZodObject, ZodRawShape } from "zod";

import type { Env } from "./env.js";
import { ALL_TOOLS } from "./tools/sure.js";
import { runTool } from "./tools/types.js";
import type { CtrlContext } from "./tools/types.js";

// Per-grant props carried alongside the access token. The OAuthProvider
// stores `props` opaquely in KV bound to the access token; on every
// authenticated /mcp call it surfaces them on `this.props` inside the DO.
// Single-tenant for david — multi-tenant routing replaces this with a
// tenant_id lookup in W2 (#772).
//
// Must extend Record<string, unknown> because McpAgent<Env, State, Props>
// constrains Props to that shape (so the DO can store it in its
// per-session SQLite blob).
export interface MCPProps extends Record<string, unknown> {
  userId: "david";
  aasApiKey: string;
  ctrlUrl: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

export class SureMCP extends McpAgent<Env, unknown, MCPProps> {
  server = new McpServer({
    name: "alfred-sure",
    version: "1.0.0",
  });

  async init(): Promise<void> {
    for (const tool of ALL_TOOLS) {
      const shape = (tool.inputSchema as ZodObject<ZodRawShape>).shape;
      this.server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: shape,
        },
        async (args: unknown) => {
          // `this.props` is populated by the OAuthProvider from the access
          // token's stored grant. McpAgent types it as possibly-undefined
          // (since DO state can race with the OAuth handshake); the
          // not-null assertion is safe because OAuthProvider only routes
          // here AFTER a successful token exchange that wrote props.
          const props = this.props!;
          const ctx: CtrlContext = {
            ctrlUrl: props.ctrlUrl,
            aasApiKey: props.aasApiKey,
            cfAccessClientId: props.cfAccessClientId,
            cfAccessClientSecret: props.cfAccessClientSecret,
          };
          return runTool(ctx, tool, args);
        },
      );
    }
  }
}

// ─── default handler: /authorize approval UI + /health probe ────────────────

const APPROVE_PAGE_HTML = (error?: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Approve Alfred MCP connector</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 28rem;
           margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #6b7280; }
    label { display: block; margin: 1rem 0 0.25rem; font-weight: 500; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 0.5rem;
                            font-size: 1rem; border: 1px solid #d1d5db; border-radius: 6px; }
    button { margin-top: 1rem; padding: 0.6rem 1rem; background: #111827; color: white;
             border: 0; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    .err { color: #b91c1c; margin-top: 0.75rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Approve Alfred MCP connector</h1>
  <p>Grants Claude access to Sir's Sure data via <code>mcp.alfred.black</code>. Claude exchanges this approval for an OAuth access token; nothing else has to be pasted into Claude.</p>
  <form method="POST" action="">
    <label for="secret">Approval secret</label>
    <input type="password" id="secret" name="secret" autocomplete="off" required autofocus />
    <button type="submit">Approve</button>
    ${error ? `<div class="err">${error}</div>` : ""}
  </form>
</body>
</html>`;

// Constant-time string comparison so the approval secret can't be brute-
// forced via timing measurements. Both strings are short and bounded.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

const HEALTH_BODY = JSON.stringify({
  ok: true,
  service: "alfred-mcp-worker",
  tenant: "david",
  app: "sure",
  oauth: true,
});

const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Liveness probe — unauthenticated, no sensitive data.
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(HEALTH_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // OAuth /authorize: GET shows the approval form, POST validates the
    // pre-shared secret and completes the grant.
    if (url.pathname === "/authorize") {
      // OAuthProvider exposes its helpers on env at runtime (typed as `any`
      // because the library doesn't ship a TS type for the augmented env).
      const oauth = (env as unknown as {
        OAUTH_PROVIDER: {
          parseAuthRequest: (req: Request) => Promise<unknown>;
          completeAuthorization: (opts: {
            request: unknown;
            userId: string;
            metadata: Record<string, unknown>;
            scope: string[];
            props: MCPProps;
          }) => Promise<{ redirectTo: string }>;
        };
      }).OAUTH_PROVIDER;

      let authReq: unknown;
      try {
        authReq = await oauth.parseAuthRequest(request);
      } catch (err) {
        return new Response(
          `Bad authorization request: ${err instanceof Error ? err.message : String(err)}`,
          { status: 400, headers: { "content-type": "text/plain" } },
        );
      }

      if (request.method === "GET") {
        return new Response(APPROVE_PAGE_HTML(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const secret = String(form.get("secret") ?? "");
        if (!env.MCP_APPROVAL_SECRET || env.MCP_APPROVAL_SECRET.length < 16) {
          return new Response(
            "MCP_APPROVAL_SECRET not configured on the worker",
            { status: 503, headers: { "content-type": "text/plain" } },
          );
        }
        if (!timingSafeEqual(secret, env.MCP_APPROVAL_SECRET)) {
          return new Response(
            APPROVE_PAGE_HTML("Wrong approval secret. Try again."),
            { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }

        const props: MCPProps = {
          userId: "david",
          aasApiKey: env.DAVID_AAS_API_KEY,
          ctrlUrl: env.DAVID_CTRL_URL,
          cfAccessClientId: env.DAVID_CF_ACCESS_CLIENT_ID,
          cfAccessClientSecret: env.DAVID_CF_ACCESS_CLIENT_SECRET,
        };

        const { redirectTo } = await oauth.completeAuthorization({
          request: authReq,
          userId: "david",
          metadata: { label: "Alfred (david)" },
          // Empty scopes — we don't fragment access by scope in v1; every
          // approved client gets the full Sure tool catalogue.
          scope: [],
          props,
        });
        return Response.redirect(redirectTo, 302);
      }

      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ─── exported Worker ────────────────────────────────────────────────────────

// OAuthProvider's TypeScript types are loose around the `apiHandler` /
// `defaultHandler` shapes — both expect a Worker-entry-style object with a
// `fetch(req, env, ctx)` method. We cast to satisfy TS; runtime behaviour
// is the contract that matters.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oauthProvider = new OAuthProvider({
  apiRoute: ["/mcp"],
  apiHandler: SureMCP.serve("/mcp") as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default oauthProvider;
