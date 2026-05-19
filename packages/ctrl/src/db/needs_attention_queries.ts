// needs_attention_queries.ts
//
// STORE-P6-1 followup (#478): typed query helpers for the
// `needs_attention` table (migration 006).
//
// Reads/writes Desk cards — the state machine the Desk swipe UI
// mutates (done / skipped / dispatched). One row per card, created
// by alfred-learn observers and resolved by the principal (or auto-
// dispatched).
//
// Writers (alfred-learn + Desk mutations) call the HTTP route in
// routes/needs_attention.ts — they do not import this module
// directly. This file is the in-process surface used by the API
// layer.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface NeedsAttentionRow {
  id: string;
  ts: bigint;
  source_signal_id: string | null;
  target_matter: string | null;
  target_kind: string | null;
  headline: string;
  body: string;
  status: string;
  resolved_at: bigint | null;
  resolved_by: string | null;
  resolution: string | null;
  payload: string | null;
}

// `ts` and `resolved_at` are nanosecond values that exceed
// Number.MAX_SAFE_INTEGER, so every read statement that returns them
// MUST be flipped to bigint mode via setReadBigInts(true). Same
// lesson as STORE-P1-4 / P3-2.
interface NeedsAttentionRowRaw {
  id: string;
  ts: bigint;
  source_signal_id: string | null;
  target_matter: string | null;
  target_kind: string | null;
  headline: string;
  body: string;
  status: string;
  resolved_at: bigint | null;
  resolved_by: string | null;
  resolution: string | null;
  payload: string | null;
}

function toRow(raw: NeedsAttentionRowRaw): NeedsAttentionRow {
  return {
    id: raw.id,
    ts: typeof raw.ts === "bigint" ? raw.ts : BigInt(raw.ts),
    source_signal_id: raw.source_signal_id,
    target_matter: raw.target_matter,
    target_kind: raw.target_kind,
    headline: raw.headline,
    body: raw.body,
    status: raw.status,
    resolved_at:
      raw.resolved_at === null
        ? null
        : typeof raw.resolved_at === "bigint"
          ? raw.resolved_at
          : BigInt(raw.resolved_at),
    resolved_by: raw.resolved_by,
    resolution: raw.resolution,
    payload: raw.payload,
  };
}

const SELECT_COLS =
  "id, ts, source_signal_id, target_matter, target_kind, " +
  "headline, body, status, resolved_at, resolved_by, " +
  "resolution, payload";

export function insertNeedsAttention(
  db: DatabaseSync,
  row: Partial<NeedsAttentionRow>,
): string {
  if (!row.headline) {
    throw new Error("headline is required");
  }
  if (!row.body) {
    throw new Error("body is required");
  }
  const id = row.id ?? crypto.randomUUID();
  const ts = row.ts ?? BigInt(Date.now()) * 1_000_000n;
  const status = row.status ?? "pending";
  const stmt = db.prepare(
    `INSERT INTO needs_attention
       (id, ts, source_signal_id, target_matter, target_kind,
        headline, body, status, resolved_at, resolved_by,
        resolution, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    id,
    ts,
    row.source_signal_id ?? null,
    row.target_matter ?? null,
    row.target_kind ?? null,
    row.headline,
    row.body,
    status,
    row.resolved_at ?? null,
    row.resolved_by ?? null,
    row.resolution ?? null,
    row.payload ?? null,
  );
  return id;
}

export function getNeedsAttention(
  db: DatabaseSync,
  id: string,
): NeedsAttentionRow | null {
  const stmt = db.prepare(
    `SELECT ${SELECT_COLS} FROM needs_attention WHERE id = ?`,
  );
  stmt.setReadBigInts(true);
  const raw = stmt.get(id) as NeedsAttentionRowRaw | undefined;
  return raw ? toRow(raw) : null;
}

export interface ListNeedsAttentionOpts {
  status?: string;
  target_matter?: string;
  since?: bigint;
  limit?: number;
  offset?: number;
}

export function listNeedsAttention(
  db: DatabaseSync,
  opts: ListNeedsAttentionOpts = {},
): NeedsAttentionRow[] {
  const wheres: string[] = [];
  const params: (string | bigint)[] = [];

  if (opts.status !== undefined) {
    wheres.push("status = ?");
    params.push(opts.status);
  }
  if (opts.target_matter !== undefined) {
    wheres.push("target_matter = ?");
    params.push(opts.target_matter);
  }
  if (opts.since !== undefined) {
    wheres.push("ts >= ?");
    params.push(opts.since);
  }

  const limit = Math.min(Math.max(1, opts.limit ?? 50), 1000);
  const offset = Math.max(0, opts.offset ?? 0);

  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql =
    `SELECT ${SELECT_COLS} FROM needs_attention ${whereSql} ` +
    `ORDER BY ts DESC LIMIT ? OFFSET ?`;

  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  const rows = stmt.all(...params, limit, offset) as NeedsAttentionRowRaw[];
  return rows.map(toRow);
}

export function countNeedsAttention(
  db: DatabaseSync,
  opts: ListNeedsAttentionOpts = {},
): number {
  const wheres: string[] = [];
  const params: (string | bigint)[] = [];

  if (opts.status !== undefined) {
    wheres.push("status = ?");
    params.push(opts.status);
  }
  if (opts.target_matter !== undefined) {
    wheres.push("target_matter = ?");
    params.push(opts.target_matter);
  }
  if (opts.since !== undefined) {
    wheres.push("ts >= ?");
    params.push(opts.since);
  }

  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql = `SELECT count(*) AS n FROM needs_attention ${whereSql}`;
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row ? Number(row.n) : 0;
}

// Update status (done / skipped / dispatched / pending) + resolver
// bookkeeping. Sets resolved_at server-side. resolution is optional
// (JSON describing verb + target). Returns true iff a row was
// updated.
export function updateNeedsAttentionStatus(
  db: DatabaseSync,
  id: string,
  status: string,
  resolved_by: string,
  resolution?: string,
): boolean {
  const resolved_at = BigInt(Date.now()) * 1_000_000n;
  const stmt = db.prepare(
    `UPDATE needs_attention
        SET status = ?,
            resolved_at = ?,
            resolved_by = ?,
            resolution = COALESCE(?, resolution)
      WHERE id = ?`,
  );
  const result = stmt.run(
    status,
    resolved_at,
    resolved_by,
    resolution ?? null,
    id,
  );
  return Number(result.changes) > 0;
}
