export function resolveTrustProxy(raw: string | undefined, production = process.env.NODE_ENV === "production"): number {
  const value = raw ?? "1";
  const permissive = ["true", "*", "all", "0.0.0.0/0", "::/0"].includes(value.trim().toLowerCase());
  if (permissive) {
    if (production) throw new Error(`Unsafe TRUST_PROXY_HOPS=${value}; use a bounded integer hop count (0-5)`);
    return 0;
  }
  if (!/^\d+$/.test(value) || Number(value) > 5) {
    throw new Error(`Invalid TRUST_PROXY_HOPS=${value}; use a bounded integer hop count from 0 5`);
  }
  return Number(value);
}
