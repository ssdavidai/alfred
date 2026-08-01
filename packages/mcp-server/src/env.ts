// Per-tenant environment variables read from the container's environment.

export interface Env {
  CTRL_URL: string;
  AAS_API_KEY: string;
  MCP_APPROVAL_SECRET: string;
  DATA_DIR: string;
  PUBLIC_URL: string;
  TENANT_LABEL: string;
  PORT?: string;
  TRUST_PROXY_HOPS: number;
}

export function parseTrustProxyHops(raw: string | undefined, nodeEnv = process.env.NODE_ENV): number {
  if (raw === undefined || raw.trim() === "") {
    if (nodeEnv === "production") throw new Error("TRUST_PROXY_HOPS must be set in production");
    return 0;
  }
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`TRUST_PROXY_HOPS must be a non-negative integer (got ${raw})`);
  }
  const hops = Number(raw.trim());
  if (!Number.isSafeInteger(hops) || hops > 4) {
    throw new Error("TRUST_PROXY_HOPS must be between 0 and 4");
  }
  return hops;
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
    TRUST_PROXY_HOPS: parseTrustProxyHops(process.env.TRUST_PROXY_HOPS, process.env.NODE_ENV),
  };
}
