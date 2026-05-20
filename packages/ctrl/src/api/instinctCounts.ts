// Live observation count per instinct, sourced from the state.db `observation`
// table (Store 2) — the machine's working memory — NOT the vault.
//
// Trust signal: only count observations that came from a Sir decision
// (state.db `kind = 'decision'`) and are linked to an instinct via
// `instinct_ref`. Signal-sourced retroactive matches are weak evidence and
// don't earn trust, so they're excluded.
//
// Before the storage cutover this walked vault/observation/*.md, but the
// decision-observation writer posts to state.db, so the vault directory was
// empty and the count was frozen at 0 — which pinned the discretion gate at
// 0.95 (get_discretion_threshold(0)) and froze progressive autonomy at
// "Asking" forever (FAILURE-MODES bug #1). Querying state.db is the fix.
//
// Consumers (key the returned Map by the instinct's vault path = instinct_ref):
//   - GET /api/v1/learning/instincts — enriches each instinct's frontmatter
//     with `live_observation_count` for the /instincts UI.
//   - GET /api/v1/vault/list/instinct — same enrichment, read by
//     alfred-learn's signal_actions._instinct_threshold for the discretion gate.
import { getStateDb } from "../db/state.js";
import { ttlCache } from "./cache.js";

// 30s TTL: signal_router runs every 2 min so a stale count costs at most one
// cycle; the UI tolerates more. Bust via invalidateInstinctCounts() on writes.
const instinctCountsCache = ttlCache<Map<string, number>>({ ttlMs: 30_000 });

export function invalidateInstinctCounts(): void {
  instinctCountsCache.invalidate();
}

export async function getInstinctCounts(): Promise<Map<string, number>> {
  return instinctCountsCache.get("all", () => {
    const counts = new Map<string, number>();
    const rows = getStateDb()
      .prepare(
        `SELECT instinct_ref AS ref, COUNT(*) AS n
           FROM observation
          WHERE kind = 'decision'
            AND instinct_ref IS NOT NULL AND instinct_ref != ''
          GROUP BY instinct_ref`,
      )
      .all() as { ref: string; n: number }[];
    for (const r of rows) counts.set(r.ref, r.n);
    return counts;
  });
}
