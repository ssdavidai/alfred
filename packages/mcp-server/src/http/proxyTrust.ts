import proxyaddr from "proxy-addr";

export interface ProxyTrustEnv {
  NODE_ENV?: string;
  MCP_TRUST_PROXY_HOPS?: string;
  MCP_TRUST_PROXY_IPS?: string;
}

const MAX_TRUSTED_HOPS = 2;

function parseHops(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error("MCP_TRUST_PROXY_HOPS must be a non-negative integer");
  const hops = Number(raw);
  if (!Number.isSafeInteger(hops) || hops > MAX_TRUSTED_HOPS) {
    throw new Error(`MCP_TRUST_PROXY_HOPS must be between 0 and ${MAX_TRUSTED_HOPS}`);
  }
  return hops;
}

export function createProxyTrust(env: ProxyTrustEnv): number | ((ip: string, index: number) => boolean) {
  const production = env.NODE_ENV === "production";
  const hops = parseHops(env.MCP_TRUST_PROXY_HOPS);
  const cidrs = (env.MCP_TRUST_PROXY_IPS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (hops !== undefined && cidrs.length > 0) throw new Error("Set only one of MCP_TRUST_PROXY_HOPS or MCP_TRUST_PROXY_IPS");
  if (hops !== undefined) return hops;
  if (cidrs.length > 0) {
    let trust: (ip: string) => boolean;
    try { trust = proxyaddr.compile(cidrs); } catch { throw new Error("MCP_TRUST_PROXY_IPS contains an invalid CIDR"); }
    return (ip, index) => index <= MAX_TRUSTED_HOPS && trust(ip);
  }
  if (production) throw new Error("Production requires MCP_TRUST_PROXY_HOPS or MCP_TRUST_PROXY_IPS; refusing permissive proxy trust");
  return 0;
}
