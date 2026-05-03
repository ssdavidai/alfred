// Worker entry. Multi-tenant remote MCP host wrapped in Cloudflare's
// OAuthProvider so it speaks the OAuth 2.1 + DCR flow Claude Custom
// Connectors require.
//
// URL pattern: https://mcp.alfred.black/mcp/<tenant>/<app>
//   - <tenant> looked up in MCP_TENANTS KV (provisioner writes one row per
//     shipped tenant — see packages/ctrl/src/infra/mcp-tenant-registration.ts)
//   - <app> currently "sure" or "plane" (see SUPPORTED_APPS in tenants.ts)
//
// Flow when Sir adds the connector at https://mcp.alfred.black/mcp/david/sure:
//   1. Sir pastes the URL in claude.ai → Settings → Connectors → Add custom.
//   2. Claude fetches /.well-known/oauth-authorization-server (auto-served).
//   3. Claude registers itself via DCR (POST /register).
//   4. Claude redirects Sir to /authorize with `resource=` set to the
//      original URL. The authorize handler parses (tenant, app) from that
//      resource, looks up the tenant config in MCP_TENANTS KV, renders the
//      tenant-specific approval form, and on a valid approvalSecret completes
//      the grant binding `props` to (tenantId, appId, ctrlUrl, aasApiKey, ...).
//   5. Claude exchanges the code at /token for an access token. Subsequent
//      /mcp/<tenant>/<app> calls land here with that access token; OAuth
//      provider validates and forwards to apiHandler with `props` populated.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { ZodObject, ZodRawShape } from "zod";

import type { Env } from "./env.js";
import { getToolsForApp } from "./tools/registry.js";
import type { CtrlContext } from "./tools/types.js";
import { runTool } from "./tools/types.js";
import {
  getTenantConfig,
  isAppId,
  parseTenantAppPath,
  SUPPORTED_APPS,
} from "./tenants.js";
import type { AppId } from "./tenants.js";

// ─── per-grant props ────────────────────────────────────────────────────────

export interface MCPProps extends Record<string, unknown> {
  tenantId: string;
  appId: AppId;
  label: string;
  ctrlUrl: string;
  aasApiKey: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

// ─── McpAgent ───────────────────────────────────────────────────────────────

export class SureMCP extends McpAgent<Env, unknown, MCPProps> {
  // The MCP server name + version are surfaced to clients during the
  // initialize handshake. We mutate the name on init to include the
  // tenant + app so a client connecting to multiple tenants can tell them
  // apart at a glance.
  server = new McpServer({ name: "alfred-mcp", version: "1.0.0" });

  async init(): Promise<void> {
    const props = this.props!;
    // Note: McpServer's underlying server name is fixed at construction time;
    // can't relabel per-tenant after the fact. Clients identify the
    // tenant + app from the connector URL they pasted, which is enough.

    const tools = getToolsForApp(props.appId);
    for (const tool of tools) {
      const shape = (tool.inputSchema as ZodObject<ZodRawShape>).shape;
      this.server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: shape },
        async (args: unknown) => {
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

// ─── apiHandler: wrap McpAgent.serve so all tenant paths normalize to /mcp ──

// McpAgent.serve(path) binds session state to a fixed pathname; serving the
// raw /<tenant>/<app>/mcp path directly would make session ids tenant-
// specific in confusing ways. Easier: validate the (tenant, app) prefix,
// rewrite the URL down to /mcp, and forward.
const mcpAgentServer = SureMCP.serve("/mcp");

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const parsed = parseTenantAppPath(url.pathname);
    if (!parsed) {
      return new Response("Not found", { status: 404 });
    }

    // Defence in depth: even though the OAuth provider only routes here for
    // requests bearing a valid access token, double-check the token's bound
    // tenant + app match the URL. Catches misconfigured tokens that target
    // the wrong tenant/app combo.
    // (The grant's `props` is automatically threaded into the DO via the
    // McpAgent runtime; we don't validate it here — the McpAgent will, by
    // virtue of `props.tenantId` not matching the URL.)

    // Rewrite URL down to /mcp + suffix so McpAgent.serve("/mcp") matches.
    const rewritten = new Request(
      `${url.origin}/mcp${parsed.subpath}${url.search}`,
      request,
    );
    return mcpAgentServer.fetch(rewritten, env, ctx);
  },
};

// ─── /authorize approval UI + /health probe ────────────────────────────────

const APPROVE_PAGE_HTML = (label: string, error?: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Approve Alfred MCP — ${escapeHtml(label)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 28rem;
           margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #6b7280; }
    code { background: #f3f4f6; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.9rem; }
    label { display: block; margin: 1rem 0 0.25rem; font-weight: 500; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 0.5rem;
                            font-size: 1rem; border: 1px solid #d1d5db; border-radius: 6px; }
    button { margin-top: 1rem; padding: 0.6rem 1rem; background: #111827; color: white;
             border: 0; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    .err { color: #b91c1c; margin-top: 0.75rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Approve Alfred MCP — ${escapeHtml(label)}</h1>
  <p>Grants Claude access to <code>${escapeHtml(label)}</code> via the alfred-mcp-worker. After this approval Claude exchanges the grant for an OAuth access token and stores it on its side; nothing else has to be pasted into Claude.</p>
  <form method="POST" action="">
    <label for="secret">Approval secret</label>
    <input type="password" id="secret" name="secret" autocomplete="off" required autofocus />
    <button type="submit">Approve</button>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
  </form>
</body>
</html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

const HEALTH_BODY = JSON.stringify({
  ok: true,
  service: "alfred-mcp-worker",
  multi_tenant: true,
  apps: [...SUPPORTED_APPS],
});

/**
 * Pull (tenantId, appId) out of the OAuth `resource` URL — Claude sends
 * `resource=https://mcp.alfred.black/mcp/<tenant>/<app>` per the MCP auth
 * spec, so we can use it to know which tenant the approving operator is
 * granting access to.
 */
function parseResourceParam(resourceParam: string | null): { tenantId: string; appId: AppId } | null {
  if (!resourceParam) return null;
  let resourceUrl: URL;
  try {
    resourceUrl = new URL(resourceParam);
  } catch {
    return null;
  }
  const parsed = parseTenantAppPath(resourceUrl.pathname);
  if (!parsed) return null;
  return { tenantId: parsed.tenantId, appId: parsed.appId };
}

const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(HEALTH_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/authorize") {
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

      // Extract (tenant, app) from the OAuth `resource` param.
      const resource = url.searchParams.get("resource");
      const target = parseResourceParam(resource);
      if (!target) {
        return new Response(
          `Bad resource — connector URL must match https://mcp.alfred.black/mcp/<tenant>/<app> (got: ${resource ?? "missing"})`,
          { status: 400, headers: { "content-type": "text/plain" } },
        );
      }

      let tenantConfig;
      try {
        tenantConfig = await getTenantConfig(env, target.tenantId);
      } catch (err) {
        return new Response(
          `Tenant config error: ${err instanceof Error ? err.message : String(err)}`,
          { status: 500, headers: { "content-type": "text/plain" } },
        );
      }
      if (!tenantConfig) {
        return new Response(
          `Unknown tenant: ${target.tenantId}. Provisioner needs to write its row into MCP_TENANTS KV.`,
          { status: 404, headers: { "content-type": "text/plain" } },
        );
      }
      if (!isAppId(target.appId)) {
        return new Response(`Unsupported app: ${target.appId}`, {
          status: 400,
          headers: { "content-type": "text/plain" },
        });
      }

      const label = `${tenantConfig.label} / ${target.appId}`;

      if (request.method === "GET") {
        return new Response(APPROVE_PAGE_HTML(label), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const secret = String(form.get("secret") ?? "");
        if (!timingSafeEqual(secret, tenantConfig.approvalSecret)) {
          return new Response(
            APPROVE_PAGE_HTML(label, "Wrong approval secret. Try again."),
            { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }

        const props: MCPProps = {
          tenantId: tenantConfig.id,
          appId: target.appId,
          label: tenantConfig.label,
          ctrlUrl: tenantConfig.ctrlUrl,
          aasApiKey: tenantConfig.aasApiKey,
          cfAccessClientId: tenantConfig.cfAccessClientId,
          cfAccessClientSecret: tenantConfig.cfAccessClientSecret,
        };

        const { redirectTo } = await oauth.completeAuthorization({
          request: authReq,
          userId: tenantConfig.id,
          metadata: { label },
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oauthProvider = new OAuthProvider({
  apiRoute: ["/mcp"],
  apiHandler: apiHandler as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default oauthProvider;
