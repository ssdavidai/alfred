// Per-tenant environment variables read from the container's environment.
// Set via the tenant compose `.env` (the provisioner writes them at ship
// time; existing tenants get them via a one-off ops command). All values
// scoped to THIS tenant — the container is single-tenant by deployment.

export interface Env {
  /** ctrl-api base URL inside the compose network. Always http://ctrl-api:3100 in prod. */
  CTRL_URL: string;
  /** Bearer for the in-tenant ctrl-api. */
  AAS_API_KEY: string;
  /** Pre-shared secret Sir enters once on /authorize when adding the connector. */
  MCP_APPROVAL_SECRET: string;
  /** Where SQLite lives. Bind-mounted from /mnt/encrypted/mcp-server in compose. */
  DATA_DIR: string;
  /** Public URL the tenant subdomain serves (used as OAuth issuer). */
  PUBLIC_URL: string;
  /** Display label shown on the approval page. e.g. "Sir". */
  TENANT_LABEL: string;
  /** HTTP listen port. Default 8787. */
  PORT?: string;
  NODE_ENV?: string;
  MCP_TRUST_PROXY_HOPS?: string;
  MCP_TRUST_PROXY_IPS?: string;
}

export function loadEnv(): Env {
  const required = (name: keyof Env) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env: ${name}`);
    return v;
  };
  return {
    CTRL_URL: required("CTRL_URL"),
    AAS_API_KEY: required("AAS_API_KEY"),
    MCP_APPROVAL_SECRET: required("MCP_APPROVAL_SECRET"),
    DATA_DIR: process.env.DATA_DIR ?? "/data",
    PUBLIC_URL: required("PUBLIC_URL"),
    TENANT_LABEL: required("TENANT_LABEL"),
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    MCP_TRUST_PROXY_HOPS: process.env.MCP_TRUST_PROXY_HOPS,
    MCP_TRUST_PROXY_IPS: process.env.MCP_TRUST_PROXY_IPS,
  };
}
