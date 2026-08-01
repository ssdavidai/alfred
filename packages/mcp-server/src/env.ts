export interface Env {
  CTRL_URL: string;
  AAS_API_KEY: string;
  MCP_APPROVAL_SECRET: string;
  DATA_DIR: string;
  PUBLIC_URL: string;
  TENANT_LABEL: string;
  PORT?: string;
  TRUST_PROXY_HOPS?: string;
}

function validatedTrustProxyHops(raw: string | undefined): string {
  const value = raw ?? "1";
  const production = process.env.NODE_ENV === "production";
  const permissive = ["true", "*", "all", "0.0.0.0/0", "::/0"].includes(value.trim().toLowerCase());
  if (permissive) {
    if (production) throw new Error(`Unsafe TRUST_PROXY_HOPS=${value}; production requires a bounded integer hop count (0-5)`);
    return "0";
  }
  if (!/^\d+$/.test(value) || Number(value) > 5) {
    throw new Error(`Invalid TRUST_PROXY_HOPS=${value}; use a bounded integer hop count from 0 to 5`);
  }
  return value;
}

export function loadEnv(): Env {
  const required = (name: keyof Env) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env: ${name}`);
    return value;
  };
  return {
    CTRL_URL: required("CTRL_URL"),
    AAS_API_KEY: required("AAS_API_KEY"),
    MCP_APPROVAL_SECRET: required("MCP_APPROVAL_SECRET"),
    DATA_DIR: process.env.DATA_DIR ?? "/data",
    PUBLIC_URL: required("PUBLIC_URL"),
    TENANT_LABEL: required("TENANT_LABEL"),
    PORT: process.env.PORT,
    TRUST_PROXY_HOPS: validatedTrustProxyHops(process.env.TRUST_PROXY_HOPS),
  };
}
