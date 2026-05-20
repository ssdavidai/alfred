// ============================================================================
// Cross-tier reads — merge hot (state.db) + cold (cold.db) archive rows.
//
// The compactor rolls rows older than the per-table TTL into cold.db. A query
// whose window reaches past that cutoff must read both tiers or it silently
// drops the forensic long tail. This module provides one helper per
// cold-archivable table that:
//
//   * always queries the hot tier,
//   * queries the cold tier ONLY when the query window can reach past the
//     cutoff (`since` is null, or `since` < the table's cold cutoff) — so the
//     common "last 7 days" query never touches cold.db at all,
//   * decompresses only the matched cold rows' bodies,
//   * de-dupes by id (a mid-compaction crash can leave a row in both tiers),
//   * applies the same ts-DESC ordering + limit/offset across the union.
//
// The hot tables keep the canonical row shape; cold rows are reconstituted
// from their compressed `body` blob so callers get identical objects whatever
// tier a row came from.
// ============================================================================

import { getStateDb } from "./state.js";
import { getColdDb, coldDecompress, COLD_TTL_DAYS } from "./cold.js";

function cutoffFor(ttlDays: number): string {
  return new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Whether a query with the given `since` lower bound can match any cold row.
 * Cold rows all have ts < cutoff, so if `since` is at or after the cutoff the
 * cold tier cannot contribute and is skipped entirely.
 */
function coldInScope(table: string, since: string | null): boolean {
  if (!since) return true;
  return since < cutoffFor(COLD_TTL_DAYS[table] ?? 90);
}

export interface AuditQuery {
  action_type?: string | null;
  actor?: string | null;
  source?: string | null;
  target_path?: string | null;
  subject_ref?: string | null;
  mode?: string | null;
  since?: string | null;
  until?: string | null;
  limit: number;
  offset: number;
}

export interface CrossTierResult {
  entries: Array<Record<string, unknown>>;
  total: number;
  hot_total: number;
  cold_total: number;
  tiers: string[]; // which tiers actually contributed
}

/**
 * Audit ledger query across hot + cold tiers. Mirrors the WHERE/ORDER/paging
 * semantics of GET /api/v1/state/audit so the route can delegate to it.
 */
export function queryAuditCrossTier(q: AuditQuery): CrossTierResult {
  const hot = getStateDb();

  // ── shared WHERE builder ──────────────────────────────────────────────────
  const filters: Array<[string, string | null | undefined]> = [
    ["action_type", q.action_type],
    ["actor", q.actor],
    ["source", q.source],
    ["target_path", q.target_path],
    ["subject_ref", q.subject_ref],
    ["mode", q.mode],
  ];
  function buildWhere(): { sql: string; args: unknown[] } {
    const where: string[] = [];
    const args: unknown[] = [];
    for (const [col, val] of filters) {
      if (val) {
        where.push(`${col} = ?`);
        args.push(val);
      }
    }
    if (q.since) {
      where.push("ts >= ?");
      args.push(q.since);
    }
    if (q.until) {
      where.push("ts <= ?");
      args.push(q.until);
    }
    return { sql: where.length ? "WHERE " + where.join(" AND ") : "", args };
  }
  const { sql: whereSql, args: whereArgs } = buildWhere();

  // ── hot tier ──────────────────────────────────────────────────────────────
  const hotTotal = (
    hot.prepare(`SELECT COUNT(*) AS n FROM audit ${whereSql}`).get(...whereArgs) as {
      n: number;
    }
  ).n;

  const tiers: string[] = ["hot"];

  // ── cold tier (only when the window reaches past the cutoff) ──────────────
  let coldTotal = 0;
  let coldRows: Array<Record<string, unknown>> = [];
  if (coldInScope("audit", q.since ?? null)) {
    const cold = getColdDb();
    coldTotal = (
      cold
        .prepare(`SELECT COUNT(*) AS n FROM archive_audit ${whereSql}`)
        .get(...whereArgs) as { n: number }
    ).n;
    if (coldTotal > 0) {
      tiers.push("cold");
      // Pull enough cold rows to satisfy limit+offset after the merge; the
      // archive table keeps the filter columns + ts uncompressed so this query
      // never inflates a body it won't return.
      const coldRaw = cold
        .prepare(
          `SELECT id, ts, codec, body FROM archive_audit ${whereSql} ` +
            `ORDER BY ts DESC LIMIT ?`,
        )
        .all(...whereArgs, q.limit + q.offset) as Array<{
        id: string;
        ts: string;
        codec: string;
        body: Buffer | Uint8Array;
      }>;
      coldRows = coldRaw.map((r) => {
        try {
          return JSON.parse(coldDecompress(r.body, r.codec)) as Record<string, unknown>;
        } catch (err) {
          // A corrupt cold blob must not sink the whole query — surface a
          // minimal stub so the gap is visible in the feed.
          console.error(`[coldRead] audit ${r.id} body inflate failed: ${err}`);
          return { id: r.id, ts: r.ts, _cold_decode_error: true };
        }
      });
    }
  }

  // ── hot rows (paged) ──────────────────────────────────────────────────────
  // When cold contributes we cannot page the hot query in SQL — the global
  // order interleaves tiers. Pull hot rows up to limit+offset, merge, then
  // slice. When cold is empty this degrades to the original single-tier path.
  const hotRows = hot
    .prepare(
      `SELECT * FROM audit ${whereSql} ORDER BY ts DESC LIMIT ?`,
    )
    .all(...whereArgs, q.limit + q.offset) as Array<Record<string, unknown>>;

  // ── merge + de-dupe by id + global ts-DESC order + page ───────────────────
  const seen = new Set<string>();
  const merged: Array<Record<string, unknown>> = [];
  for (const row of [...hotRows, ...coldRows]) {
    const id = String(row.id ?? "");
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.push(row);
  }
  merged.sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")));
  const entries = merged.slice(q.offset, q.offset + q.limit);

  return {
    entries,
    total: hotTotal + coldTotal,
    hot_total: hotTotal,
    cold_total: coldTotal,
    tiers,
  };
}

/** Fetch a single audit row by id, hot tier first then cold. */
export function getAuditCrossTier(id: string): Record<string, unknown> | null {
  const hot = getStateDb();
  const hotRow = hot.prepare("SELECT * FROM audit WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (hotRow) return hotRow;

  const cold = getColdDb();
  const coldRow = cold
    .prepare("SELECT codec, body FROM archive_audit WHERE id = ?")
    .get(id) as { codec: string; body: Buffer | Uint8Array } | undefined;
  if (!coldRow) return null;
  try {
    return JSON.parse(coldDecompress(coldRow.body, coldRow.codec)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    console.error(`[coldRead] audit ${id} body inflate failed: ${err}`);
    return null;
  }
}
