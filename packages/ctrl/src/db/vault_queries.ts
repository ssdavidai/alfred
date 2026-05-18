// vault_queries.ts
//
// STORE-P1-4: typed query helpers around the `vault_index` SQLite
// table (migration 002). Replaces the recursive-walk + per-record
// readFile + YAML parse hot path under /api/v1/vault/list/:type and
// its sibling list endpoints.
//
// Population is owned by `src/api/vault_indexer.ts` (P1-2 backfill on
// boot, P1-3 write-through on mutate). This module is read-only — it
// only ever issues SELECTs against `vault_index`.
//
// Design notes:
//   * Prepared statements are not memoised: `DatabaseSync.prepare` is
//     cheap and the caller is short-lived per request. SQLite handles
//     its own statement cache internally.
//   * `frontmatter` is returned as the raw JSON string. Callers parse
//     only the rows they emit so we don't pay the JSON.parse cost on
//     filtered-out rows (e.g. when `state` doesn't match).
//   * SQLite `INTEGER` columns surface as `bigint` from node:sqlite,
//     hence `mtime_ns: bigint`.

import { DatabaseSync } from "node:sqlite";

export interface VaultIndexRow {
  record_id: string;
  record_type: string;
  path: string;
  mtime_ns: bigint;
  state: string | null;
  parent_matter: string | null;
  frontmatter: string; // raw JSON
  body_first_n: string | null;
}

export interface ListByTypeOptions {
  state?: string;
  limit?: number;
  offset?: number;
  sinceMtimeNs?: bigint;
  sortBy?: "mtime_desc" | "path";
}

export function listByType(
  db: DatabaseSync,
  type: string,
  opts: ListByTypeOptions = {},
): VaultIndexRow[] {
  const where: string[] = ["record_type = ?"];
  const args: Array<string | number | bigint> = [type];

  if (opts.state !== undefined) {
    where.push("state = ?");
    args.push(opts.state);
  }
  if (opts.sinceMtimeNs !== undefined) {
    where.push("mtime_ns >= ?");
    args.push(opts.sinceMtimeNs);
  }

  const orderBy =
    opts.sortBy === "mtime_desc"
      ? "mtime_ns DESC"
      : opts.sortBy === "path"
        ? "path ASC"
        : "path ASC";

  let sql =
    `SELECT record_id, record_type, path, mtime_ns, state, parent_matter, frontmatter, body_first_n ` +
    `FROM vault_index WHERE ${where.join(" AND ")} ORDER BY ${orderBy}`;

  if (opts.limit !== undefined) {
    sql += " LIMIT ?";
    args.push(opts.limit);
    if (opts.offset !== undefined) {
      sql += " OFFSET ?";
      args.push(opts.offset);
    }
  }

  return db.prepare(sql).all(...args) as unknown as VaultIndexRow[];
}

export function getByPath(
  db: DatabaseSync,
  vaultPath: string,
): VaultIndexRow | null {
  const row = db
    .prepare(
      `SELECT record_id, record_type, path, mtime_ns, state, parent_matter, frontmatter, body_first_n
       FROM vault_index WHERE path = ?`,
    )
    .get(vaultPath) as VaultIndexRow | undefined;
  return row ?? null;
}

export function getByRecordId(
  db: DatabaseSync,
  id: string,
): VaultIndexRow | null {
  const row = db
    .prepare(
      `SELECT record_id, record_type, path, mtime_ns, state, parent_matter, frontmatter, body_first_n
       FROM vault_index WHERE record_id = ?`,
    )
    .get(id) as VaultIndexRow | undefined;
  return row ?? null;
}

export function listChildrenOfMatter(
  db: DatabaseSync,
  matterPath: string,
): VaultIndexRow[] {
  return db
    .prepare(
      `SELECT record_id, record_type, path, mtime_ns, state, parent_matter, frontmatter, body_first_n
       FROM vault_index WHERE parent_matter = ? ORDER BY path ASC`,
    )
    .all(matterPath) as unknown as VaultIndexRow[];
}

export function countByType(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT record_type, count(*) AS n FROM vault_index GROUP BY record_type`,
    )
    .all() as Array<{ record_type: string; n: number | bigint }>;
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.record_type] = Number(r.n);
  }
  return out;
}

export function vaultIndexCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM vault_index")
    .get() as { n: number | bigint } | undefined;
  return row ? Number(row.n) : 0;
}

/**
 * Return every row in vault_index. Suitable for whole-vault scans
 * (wikilink title index, graph builders). Even at ~88k rows the
 * result set is comfortably within the JS heap — each row is ~1KB —
 * and this is the SAME shape the legacy walkMd path was already
 * holding in memory pre-rewire.
 *
 * Callers that only need a column subset should issue their own
 * narrower SELECT for memory hygiene.
 */
export function listAll(db: DatabaseSync): VaultIndexRow[] {
  return db
    .prepare(
      `SELECT record_id, record_type, path, mtime_ns, state, parent_matter, frontmatter, body_first_n
       FROM vault_index ORDER BY path ASC`,
    )
    .all() as unknown as VaultIndexRow[];
}
