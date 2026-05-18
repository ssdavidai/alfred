// audit_queries.ts
//
// STORE-P2-1: typed query helpers for the `audit` table (migration 003).
//
// Reads/writes the unified audit log that replaces the six markdown
// audit-record types previously filed under /vault/event/. See
// STORAGE-ARCHITECTURE.md §5 for the schema and the canonical actor /
// action_type / target_type vocabulary.
//
// Writers (alfred-learn workflows) call insertAudit via the HTTP route
// in routes/audit.ts — they do not import this module directly. This
// file is the in-process surface used by the API layer.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AuditRow {
  id: string;
  ts: bigint;
  actor: string;
  action_type: string;
  target_type: string;
  target_id: string;
  decision_origin: string | null;
  reasoning: string | null;
  payload: string; // JSON
  reversible: number;
  reversed_by: string | null;
}

// `ts` is a nanosecond value that exceeds Number.MAX_SAFE_INTEGER, so
// every read statement that returns it MUST be flipped to bigint mode
// via setReadBigInts(true). Without that flag, node:sqlite throws
// `RangeError: Value is too large to be represented as a JavaScript
// number` when materialising the row. Side effect: `reversible` also
// comes back as bigint, hence the Number(...) coercion in toRow.
interface AuditRowRaw {
  id: string;
  ts: bigint;
  actor: string;
  action_type: string;
  target_type: string;
  target_id: string;
  decision_origin: string | null;
  reasoning: string | null;
  payload: string;
  reversible: number | bigint;
  reversed_by: string | null;
}

function toRow(raw: AuditRowRaw): AuditRow {
  return {
    id: raw.id,
    ts: typeof raw.ts === "bigint" ? raw.ts : BigInt(raw.ts),
    actor: raw.actor,
    action_type: raw.action_type,
    target_type: raw.target_type,
    target_id: raw.target_id,
    decision_origin: raw.decision_origin,
    reasoning: raw.reasoning,
    payload: raw.payload,
    reversible: Number(raw.reversible),
    reversed_by: raw.reversed_by,
  };
}

// Columns we read back from the `audit` table. Defined once so the
// SELECT list stays in lockstep across getAudit / listAudit.
const SELECT_COLS =
  "id, ts, actor, action_type, target_type, target_id, " +
  "decision_origin, reasoning, payload, reversible, reversed_by";

export function insertAudit(
  db: DatabaseSync,
  row: Omit<AuditRow, "id" | "ts"> & { id?: string; ts?: bigint },
): string {
  const id = row.id ?? crypto.randomUUID();
  const ts = row.ts ?? BigInt(Date.now()) * 1_000_000n;
  const stmt = db.prepare(
    `INSERT INTO audit
       (id, ts, actor, action_type, target_type, target_id,
        decision_origin, reasoning, payload, reversible, reversed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    id,
    ts,
    row.actor,
    row.action_type,
    row.target_type,
    row.target_id,
    row.decision_origin,
    row.reasoning,
    row.payload,
    row.reversible,
    row.reversed_by,
  );
  return id;
}

export function getAudit(db: DatabaseSync, id: string): AuditRow | null {
  const stmt = db.prepare(`SELECT ${SELECT_COLS} FROM audit WHERE id = ?`);
  stmt.setReadBigInts(true);
  const raw = stmt.get(id) as AuditRowRaw | undefined;
  return raw ? toRow(raw) : null;
}

export interface ListAuditOpts {
  actor?: string;
  action_type?: string;
  target_type?: string;
  target_id?: string;
  since?: bigint;
  until?: bigint;
  limit?: number;
  offset?: number;
}

export function listAudit(
  db: DatabaseSync,
  opts: ListAuditOpts = {},
): AuditRow[] {
  const wheres: string[] = [];
  const params: (string | bigint)[] = [];

  if (opts.actor !== undefined) {
    wheres.push("actor = ?");
    params.push(opts.actor);
  }
  if (opts.action_type !== undefined) {
    wheres.push("action_type = ?");
    params.push(opts.action_type);
  }
  if (opts.target_type !== undefined) {
    wheres.push("target_type = ?");
    params.push(opts.target_type);
  }
  if (opts.target_id !== undefined) {
    wheres.push("target_id = ?");
    params.push(opts.target_id);
  }
  if (opts.since !== undefined) {
    wheres.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    wheres.push("ts <= ?");
    params.push(opts.until);
  }

  const limit = Math.min(Math.max(1, opts.limit ?? 50), 1000);
  const offset = Math.max(0, opts.offset ?? 0);

  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql =
    `SELECT ${SELECT_COLS} FROM audit ${whereSql} ` +
    `ORDER BY ts DESC LIMIT ? OFFSET ?`;

  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  const rows = stmt.all(...params, limit, offset) as AuditRowRaw[];
  return rows.map(toRow);
}

// Count rows matching the same filter shape as listAudit, for paginated
// responses. Re-uses the WHERE clause builder logic to keep the two
// queries in lockstep.
export function countAudit(db: DatabaseSync, opts: ListAuditOpts = {}): number {
  const wheres: string[] = [];
  const params: (string | bigint)[] = [];

  if (opts.actor !== undefined) {
    wheres.push("actor = ?");
    params.push(opts.actor);
  }
  if (opts.action_type !== undefined) {
    wheres.push("action_type = ?");
    params.push(opts.action_type);
  }
  if (opts.target_type !== undefined) {
    wheres.push("target_type = ?");
    params.push(opts.target_type);
  }
  if (opts.target_id !== undefined) {
    wheres.push("target_id = ?");
    params.push(opts.target_id);
  }
  if (opts.since !== undefined) {
    wheres.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    wheres.push("ts <= ?");
    params.push(opts.until);
  }

  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql = `SELECT count(*) AS n FROM audit ${whereSql}`;
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row ? Number(row.n) : 0;
}

// reverseAudit: mark `id` as reversed by `reversed_by`. Returns false if
// the original row does not exist, is not reversible, or has already
// been reversed.
export function reverseAudit(
  db: DatabaseSync,
  id: string,
  reversed_by: string,
): boolean {
  const stmt = db.prepare(
    `UPDATE audit
        SET reversed_by = ?
      WHERE id = ?
        AND reversible = 1
        AND reversed_by IS NULL`,
  );
  const result = stmt.run(reversed_by, id);
  return Number(result.changes) > 0;
}
