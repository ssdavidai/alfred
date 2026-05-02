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

  // KV namespace where @cloudflare/workers-oauth-provider stores registered
  // OAuth clients (DCR), grants, and access/refresh tokens. Required because
  // Claude Custom Connectors UI mandates an OAuth 2.1 flow — bearer-only
  // servers are rejected at the connector add step.
  OAUTH_KV: KVNamespace;

  // Pre-shared secret Sir enters ONCE on the /authorize approval page when
  // adding a new Claude Custom Connector. Single-tenant gate so that even
  // though the OAuth /authorize endpoint is public, only Sir (with this
  // value) can complete the grant. Same value Sir keeps in his password
  // manager — rotates rarely.
  MCP_APPROVAL_SECRET: string;

  // 32-byte hex string used by OAuthProvider to encrypt OAuth state stored
  // in OAUTH_KV. Generate via `openssl rand -hex 32`.
  COOKIE_ENCRYPTION_KEY: string;

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
