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

/**
 * B1: count rows that satisfy the same WHERE in BOTH the hot table and the
 * cold archive. `total = hotTotal + coldTotal` double-counts every such
 * straddling row (a mid-compaction crash writes cold then crashes before the
 * hot delete). The entries[] are de-duped by id but the total was not.
 *
 * The straddle set is bounded by one compaction batch, so pulling the matching
 * cold ids and probing hot existence is cheap. Capped defensively.
 */
function crossTierOverlap(
  hot: import("node:sqlite").DatabaseSync,
  cold: import("node:sqlite").DatabaseSync,
  hotTable: string,
  archiveTable: string,
  whereSql: string,
  whereArgs: unknown[],
): number {
  const CAP = 5000;
  const coldIds = (
    cold
      .prepare(`SELECT id FROM ${archiveTable} ${whereSql} LIMIT ?`)
      .all(...whereArgs, CAP) as Array<{ id: string }>
  ).map((r) => r.id);
  if (coldIds.length === 0) return 0;
  let overlap = 0;
  const probe = hot.prepare(`SELECT 1 FROM ${hotTable} WHERE id = ? LIMIT 1`);
  for (const id of coldIds) {
    if (probe.get(id)) overlap++;
  }
  return overlap;
}

export interface AuditQuery {
  action_type?: string | null;
  actor?: string | null;
  source?: string | null;
  target_path?: string | null;
  /** #120 Lane V — prefix-match on target_path (LIKE 'value%'). When set,
   * `target_path` is ignored. Tightens the channels/<kind>/* slice query the
   * /profiles/:slug/channels page wants. */
  target_path_prefix?: string | null;
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
    // #120 Lane V — target_path prefix match. Ignored when target_path is also
    // set (exact-match wins).
    if (q.target_path_prefix && !q.target_path) {
      where.push("target_path LIKE ?");
      args.push(`${q.target_path_prefix}%`);
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
  let overlap = 0;
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
      overlap = crossTierOverlap(hot, cold, "audit", "archive_audit", whereSql, whereArgs);
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
    // B1: subtract the hot∩cold straddle so a mid-compaction duplicate row is
    // counted once, matching the de-duped entries[].
    total: hotTotal + coldTotal - overlap,
    hot_total: hotTotal,
    cold_total: coldTotal,
    tiers,
  };
}

/** Fetch a single audit row by id, hot tier first then cold. */
export function getAuditCrossTier(id: string): Record<string, unknown> | null {
  return getCrossTier("audit", id);
}

// ============================================================================
// Generic cross-tier reads for the other four cold-archivable tables
// (signal / observation / routing_decision / link).
//
// B4: src/api/routes/state.ts list + GET-by-id for these tables queried hot
// state.db ONLY, so once the compactor rolled a row into cold.db and deleted
// it from hot, the row was unreachable from every API. These helpers mirror
// the audit cross-tier pattern (hot ∪ cold archive_<table>, dedup by id,
// global ts-DESC order + page) for each of those four tables.
//
// Each table's cold archive keeps a fixed set of plain filter columns
// uncompressed (mirroring the compactor's TablePlan.extra) so a cold query
// filters / orders WITHOUT inflating a body. The hot tier uses the same
// column names, so one WHERE builder serves both tiers.
// ============================================================================

interface CrossTierTableConfig {
  hot: string; // hot table name in state.db
  archive: string; // archive_* table name in cold.db
  // Filter columns the LIST route exposes — `col` lives in both tiers.
  filterCols: string[];
}

const CROSS_TIER_TABLES: Record<string, CrossTierTableConfig> = {
  signal: { hot: "signal", archive: "archive_signal", filterCols: ["status", "kind", "matter_ref", "source"] },
  observation: { hot: "observation", archive: "archive_observation", filterCols: ["kind", "subject", "status"] },
  routing_decision: {
    hot: "routing_decision",
    archive: "archive_routing_decision",
    filterCols: ["tier", "signal_id", "outcome", "chosen_path"],
  },
  link: { hot: "link", archive: "archive_link", filterCols: ["src_ref", "dst_ref", "rel"] },
};

export interface GenericQuery {
  // Equality filters keyed by hot/archive column name (only known filter cols
  // are applied; anything else is ignored).
  filters: Record<string, string | null | undefined>;
  since?: string | null;
  until?: string | null;
  // Optional OR-of-equality predicate: matches when ANY listed column equals
  // `value`. Used by the link route's `ref` param ("all edges touching X").
  anyOf?: { cols: string[]; value: string } | null;
  // Optional negated-equality predicate: matches rows whose `col` is NOT
  // `value` (NULLs treated as not-equal so they're included). Used by the
  // observations route's `status=unprocessed` semantic filter — "unprocessed"
  // is NOT a stored status value (rows are written `status='open'` and only
  // become `'processed'` once ReflectionWorkflow consumes them), so an equality
  // match on it returns nothing. This expresses the real intent: "everything
  // reflection hasn't processed yet."
  not?: { col: string; value: string } | null;
  // Equality filters applied ONLY to the hot tier. Columns listed here must
  // exist in state.db's hot table but need NOT be bare columns in the cold
  // archive (which stores the full row in a compressed body blob). When any
  // value is non-empty, the cold tier is skipped entirely — it cannot filter
  // by these columns without decompressing every body row.
  // Used by: GET /state/observations?instinct=<slug> (instinct_ref column).
  hotOnlyFilters?: Record<string, string | null | undefined> | null;
  limit: number;
  offset: number;
}

/**
 * List query for one of the four non-audit cold-archivable tables, merged
 * across the hot tier (state.db) and the cold archive (cold.db). Mirrors
 * queryAuditCrossTier: hot always queried, cold queried only when the window
 * can reach past the cutoff, union de-duped by id, global ts-DESC + page.
 */
export function queryCrossTier(table: string, q: GenericQuery): CrossTierResult {
  const cfg = CROSS_TIER_TABLES[table];
  if (!cfg) throw new Error(`queryCrossTier: unknown table ${table}`);
  const hot = getStateDb();

  // ── WHERE builder ─────────────────────────────────────────────────────────
  // `includeHotOnly=true` appends hotOnlyFilters — columns that exist in the
  // hot state.db table but NOT as bare columns in the cold archive. When false
  // (the cold-tier path) those columns are omitted so the query stays valid.
  function buildWhere(includeHotOnly = false): { sql: string; args: unknown[] } {
    const where: string[] = [];
    const args: unknown[] = [];
    for (const col of cfg.filterCols) {
      const val = q.filters[col];
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
    if (q.anyOf && q.anyOf.value) {
      // Restrict to columns this table actually archives, so the predicate is
      // valid against BOTH tiers.
      const cols = q.anyOf.cols.filter((c) => cfg.filterCols.includes(c));
      if (cols.length) {
        where.push("(" + cols.map((c) => `${c} = ?`).join(" OR ") + ")");
        for (const _ of cols) args.push(q.anyOf.value);
      }
    }
    if (q.not && cfg.filterCols.includes(q.not.col)) {
      // COALESCE so NULL statuses are treated as "not equal" (included),
      // matching SQLite's three-valued-logic where `col != ?` would drop NULLs.
      where.push(`COALESCE(${q.not.col}, '') != ?`);
      args.push(q.not.value);
    }
    if (includeHotOnly && q.hotOnlyFilters) {
      for (const [col, val] of Object.entries(q.hotOnlyFilters)) {
        if (val) { where.push(`${col} = ?`); args.push(val); }
      }
    }
    return { sql: where.length ? "WHERE " + where.join(" AND ") : "", args };
  }
  // Cold WHERE: shared columns only — hot-only columns may not exist in archive.
  const { sql: coldWhereSql, args: coldWhereArgs } = buildWhere();
  // Hot WHERE: same as cold plus any hot-only filter columns.
  const { sql: hotWhereSql, args: hotWhereArgs } = buildWhere(true);
  // Skip cold entirely when a hot-only filter is active — the archive table
  // stores those columns only inside the compressed body blob, so equality
  // filtering without full decompression would silently return wrong results.
  const skipCold = Object.values(q.hotOnlyFilters ?? {}).some((v) => !!v);

  // ── hot tier ──────────────────────────────────────────────────────────────
  const hotTotal = (
    hot.prepare(`SELECT COUNT(*) AS n FROM ${cfg.hot} ${hotWhereSql}`).get(...hotWhereArgs) as {
      n: number;
    }
  ).n;

  const tiers: string[] = ["hot"];

  // ── cold tier (only when the window reaches past the cutoff) ──────────────
  let coldTotal = 0;
  let overlap = 0;
  let coldRows: Array<Record<string, unknown>> = [];
  if (!skipCold && coldInScope(table, q.since ?? null)) {
    const cold = getColdDb();
    coldTotal = (
      cold
        .prepare(`SELECT COUNT(*) AS n FROM ${cfg.archive} ${coldWhereSql}`)
        .get(...coldWhereArgs) as { n: number }
    ).n;
    if (coldTotal > 0) {
      tiers.push("cold");
      overlap = crossTierOverlap(hot, cold, cfg.hot, cfg.archive, coldWhereSql, coldWhereArgs);
      const coldRaw = cold
        .prepare(
          `SELECT id, ts, codec, body FROM ${cfg.archive} ${coldWhereSql} ` +
            `ORDER BY ts DESC LIMIT ?`,
        )
        .all(...coldWhereArgs, q.limit + q.offset) as Array<{
        id: string;
        ts: string;
        codec: string;
        body: Buffer | Uint8Array;
      }>;
      coldRows = coldRaw.map((r) => {
        try {
          return JSON.parse(coldDecompress(r.body, r.codec)) as Record<string, unknown>;
        } catch (err) {
          console.error(`[coldRead] ${table} ${r.id} body inflate failed: ${err}`);
          return { id: r.id, ts: r.ts, _cold_decode_error: true };
        }
      });
    }
  }

  // ── hot rows (paged) ──────────────────────────────────────────────────────
  const hotRows = hot
    .prepare(`SELECT * FROM ${cfg.hot} ${hotWhereSql} ORDER BY ts DESC LIMIT ?`)
    .all(...hotWhereArgs, q.limit + q.offset) as Array<Record<string, unknown>>;

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
    // B1: subtract the hot∩cold straddle so a mid-compaction duplicate counts
    // once, matching the de-duped entries[].
    total: hotTotal + coldTotal - overlap,
    hot_total: hotTotal,
    cold_total: coldTotal,
    tiers,
  };
}

/** Fetch a single row by id from one of the four tables, hot first then cold. */
export function getCrossTier(table: string, id: string): Record<string, unknown> | null {
  const cfg = table === "audit"
    ? { hot: "audit", archive: "archive_audit" }
    : CROSS_TIER_TABLES[table];
  if (!cfg) throw new Error(`getCrossTier: unknown table ${table}`);
  const hot = getStateDb();
  const hotRow = hot.prepare(`SELECT * FROM ${cfg.hot} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (hotRow) return hotRow;

  const cold = getColdDb();
  const coldRow = cold
    .prepare(`SELECT codec, body FROM ${cfg.archive} WHERE id = ?`)
    .get(id) as { codec: string; body: Buffer | Uint8Array } | undefined;
  if (!coldRow) return null;
  try {
    return JSON.parse(coldDecompress(coldRow.body, coldRow.codec)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    console.error(`[coldRead] ${table} ${id} body inflate failed: ${err}`);
    return null;
  }
}
