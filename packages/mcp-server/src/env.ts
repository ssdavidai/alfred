import { parseTrustProxyHops } from "./trustProxy.js";

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
    TRUST_PROXY_HOPS: parseTrustProxyHops(process.env.TRUST_PROXY_HOPS),
  };
}
