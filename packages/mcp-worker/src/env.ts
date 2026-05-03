// Worker bindings. Each field corresponds to a wrangler.jsonc binding entry
// or a secret declared via `wrangler secret put`. Used for type-safe access
// to the env passed into `fetch(req, env, ctx)` and into Durable Object
// constructors.
//
// Multi-tenant by design: per-tenant config lives in MCP_TENANTS KV, not in
// worker secrets, so new tenants ship without redeploying the worker. The
// provisioner writes a tenant row at /authorize time (#772 W2).

export interface Env {
  // Durable Object class binding (declared in wrangler.jsonc → durable_objects)
  MCP_OBJECT: DurableObjectNamespace;

  // OAuthProvider runtime state (registered clients, grants, access tokens).
  OAUTH_KV: KVNamespace;

  // Per-tenant config: ctrl URL, AAS API key, approval secret, label, etc.
  // Keyed on tenant_id. Written by the provisioner; read by the OAuth
  // /authorize handler when binding props to the access token.
  MCP_TENANTS: KVNamespace;

  // 32-byte hex string used by OAuthProvider to encrypt OAuth state stored
  // in OAUTH_KV. Generate via `openssl rand -hex 32`.
  COOKIE_ENCRYPTION_KEY: string;
}
