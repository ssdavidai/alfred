// Worker bindings. Each field corresponds to a wrangler.jsonc binding entry
// or a secret declared via `wrangler secret put`. Used for type-safe access
// to the env passed into `fetch(req, env, ctx)` and into Durable Object
// constructors.
//
// v1 ships single-tenant for david. Multi-tenant generalisation lives behind
// the W2 issue (#772) which lifts the per-tenant config into Workers KV.

export interface Env {
  // Durable Object class binding (declared in wrangler.jsonc → durable_objects)
  MCP_OBJECT: DurableObjectNamespace;

  // Bearer token Sir pastes into Claude Desktop's MCP config. Validated in
  // the outer fetch handler before any request reaches the DO.
  MCP_DAVID_BEARER: string;

  // Used to call david's ctrl-api (`/api/v1/sure/*`).
  DAVID_AAS_API_KEY: string;

  // Base URL for the proxy target. Stored as a secret (rather than vars) so
  // deploys to staging/prod can swap it without code changes.
  // e.g. https://alfred-david-mnbqn4jg.alfred.black
  DAVID_CTRL_URL: string;

  // OPTIONAL Cloudflare Access service-token credentials. Only set if the
  // tenant subdomain has an Access policy gating it (currently it doesn't —
  // david's subdomain is bearer-only). When present, both headers are
  // attached to outbound requests so Access doesn't challenge the Worker.
  DAVID_CF_ACCESS_CLIENT_ID?: string;
  DAVID_CF_ACCESS_CLIENT_SECRET?: string;
}
