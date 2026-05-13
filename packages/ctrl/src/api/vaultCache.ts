// Shared TTL caches for ctrl-api read endpoints that re-walk the vault
// on every request. The walk-and-parse-each-md pattern is O(N) over
// thousands of records; coalescing the Desk's ~12-parallel-query
// fan-out into a single walk is the entire reason this module exists.
//
// Three caches:
//
//   * `vaultListCache` — keyed by `<type>:<previewLen>` for
//     `/api/v1/vault/list/:type`.
//   * `vaultWalkCache` — keyed by `approvals|steward:<query>` for
//     endpoints that walk the entire vault and filter (approvals,
//     steward/recent-actions).
//   * `attentionCache` — keyed by `<include>:<limit>` for
//     `/api/v1/admin/needs-attention`.
//
// All three are busted by `invalidateAllVaultCaches()` which is called
// from every write path in ctrl-api (POST/PATCH/DELETE on a vault
// record). External writes (alfred-learn workers writing through the
// PATCH endpoints) get the same invalidation for free because every
// write lands here.

import { ttlCache } from "./cache.js";
import { invalidateInstinctCounts } from "./instinctCounts.js";

export const vaultListCache = ttlCache<{
  results: any[];
  count: number;
}>({ ttlMs: 3_000 });

export const vaultWalkCache = ttlCache<any>({ ttlMs: 3_000 });

export const attentionCache = ttlCache<{
  records: any[];
  count: number;
}>({ ttlMs: 2_000 });

export function invalidateAllVaultCaches(): void {
  vaultListCache.invalidate();
  vaultWalkCache.invalidate();
  attentionCache.invalidate();
  invalidateInstinctCounts();
}

// Type-aware invalidation. A write to `task/<id>.md` should only bust
// caches keyed by `task:*`, not by `signal:*` or `matter:*`. Background
// writers (alfred-learn task writebacks every few seconds) used to nuke
// every cache on every write, which meant /list/signal etc. were always
// cold and the synchronous walk re-ran on every Desk fetch — pinning
// ctrl-api's event loop at 100% CPU and 502'ing the preview proxy.
//
// `vaultListCache` is keyed `<type>:<previewLen>` so the prefix match
// is exact. `attentionCache` is only populated by `needs_attention`
// reads, so we only bust it when needs_attention writes happen.
// `vaultWalkCache` is for cross-type endpoints (steward feed, approvals
// pending); we still bust the whole thing because re-narrowing isn't
// worth the complexity at the call sites today.
export function invalidateVaultCachesForType(type: string): void {
  if (!type) {
    invalidateAllVaultCaches();
    return;
  }
  vaultListCache.invalidatePrefix(`${type}:`);
  vaultWalkCache.invalidate();
  if (type === "needs_attention") {
    attentionCache.invalidate();
  }
}
