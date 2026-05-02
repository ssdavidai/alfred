// Worker entry. Routes streamable-HTTP MCP requests to the SureMCP Durable
// Object after bearer-token auth. Anything that isn't /mcp/* returns 404.
//
// v1 single-tenant for david. Multi-tenant routing (#772) will swap the
// hardcoded bearer for a KV lookup keyed on (bearer → tenant_id) and
// resolve per-tenant ctrl-api credentials per-request.

import { checkBearer } from "./auth.js";
import type { Env } from "./env.js";
import { SureMCP } from "./mcp/server.js";

export { SureMCP };

const HEALTH_BODY = JSON.stringify({
  ok: true,
  service: "alfred-mcp-worker",
  tenant: "david",
  app: "sure",
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Cheap, unauthenticated liveness probe. Doesn't reveal anything
    // sensitive — useful for Cloudflare's "is the Worker reachable" check
    // and for the operator's first sanity test after a deploy.
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(HEALTH_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // Auth boundary: validate bearer in the outer fetch so unauthorised
      // requests never reach the Durable Object.
      const rejection = checkBearer(request, env);
      if (rejection) return rejection;

      // Streamable HTTP transport (single-endpoint, 2025 standard).
      // McpAgent's serve() returns an object with a fetch() bound to /mcp.
      return SureMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
