// Live observation count per instinct, derived from the observation/
// vault directory rather than a stored counter on the instinct record.
//
// Trust signal: only count observations that came from a Sir decision
// (source_kind == "decision") and are linked to the instinct via the
// `instinct:` frontmatter field. Signal-sourced observations that
// retroactively matched a pattern are weaker evidence ("would have
// matched" ≠ "Sir consciously decided") and are excluded.
//
// Why derived, not a stored counter:
//   - No race on concurrent writes
//   - No drift between counter and reality
//   - Self-correcting if observations are deleted or moved
//   - One source of truth (the observation files themselves)
//
// Used by:
//   - GET /api/v1/learning/instincts — enriches each instinct's
//     frontmatter with `live_observation_count` for the /instincts UI
//     stage classifier
//   - GET /api/v1/vault/list/instinct — same enrichment, picked up by
//     alfred-learn's signal_actions._instinct_threshold for the
//     discretion-formula gate

import path from "node:path";
import { readRecord, walkMd } from "./routes/vault.js";
import { ttlCache } from "./cache.js";

const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const IGNORE_DIRS = new Set([".git", ".obsidian", "node_modules"]);

// 30s TTL is appropriate: signal_router runs every 2 min so a stale
// count costs at most one cycle; the UI tolerates more. Bust on
// observation writes via invalidateInstinctCounts() (wired into the
// observation invalidator below).
const instinctCountsCache = ttlCache<Map<string, number>>({ ttlMs: 30_000 });

export function invalidateInstinctCounts(): void {
  instinctCountsCache.invalidate();
}

export async function getInstinctCounts(): Promise<Map<string, number>> {
  return instinctCountsCache.get("all", () => {
    const counts = new Map<string, number>();
    const observationDir = path.join(VAULT_PATH, "observation");
    const files = walkMd(observationDir, VAULT_PATH, IGNORE_DIRS);
    for (const relPath of files) {
      const rec = readRecord(relPath);
      if (!rec) continue;
      const fm = rec.fm;
      if (String(fm.type ?? "") !== "observation") continue;
      // Only decision-sourced. Signal-sourced retroactive matches are
      // weak evidence and don't earn trust.
      if (String(fm.source_kind ?? "") !== "decision") continue;
      const instinctRef = String(fm.instinct ?? fm.matched_instinct ?? "").trim();
      if (!instinctRef) continue;
      counts.set(instinctRef, (counts.get(instinctRef) ?? 0) + 1);
    }
    return counts;
  });
}
