export const MAX_TRUST_PROXY_HOPS = 5;

export function parseTrustProxyHops(raw: string | undefined, nodeEnv = process.env.NODE_ENV): number {
  if (raw === undefined || raw.trim() === "") {
    if (nodeEnv === "production") throw new Error("TRUST_PROXY_HOPS must be set in production");
    return 0;
  }
  const value = raw.trim();
  if (!/^\d+$/.test(value)) throw new Error(`TRUST_PROXY_HOPS must be a non-negative integer (got ${raw})`);
  const hops = Number(value);
  if (!Number.isSafeInteger(hops) || hops > MAX_TRUST_PROXY_HOPS) throw new Error(`TRUST_PROXY_HOPS must be between 0 and ${MAX_TRUST_PROXY_HOPS}`);
  return hops;
}

export function resolveTrustProxy(raw: string | undefined, production = process.env.NODE_ENV === "production"): number {
  if (raw === undefined || raw.trim() === "") return production ? parseTrustProxyHops(raw, "production") : 1;
  return parseTrustProxyHops(raw, production ? "production" : "development");
}
