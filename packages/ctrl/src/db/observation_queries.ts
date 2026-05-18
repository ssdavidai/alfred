// observation_queries.ts
//
// STORE-P3-2: typed query helpers for the `observation` and
// `embedding` tables (migration 004).
//
// The `embedding` table is a sqlite-vec vec0 virtual table; access
// goes through this module's insertEmbedding / vecSearch helpers so
// the SQL stays in one place. We use the sqlite-vec function
// `vec_distance_cosine` available in v0.1.6 (the .so pinned in P3-1).
//
// Writers in alfred-learn (P3-3) and readers in the SaaS dashboard
// (P3-6) build on these endpoints via routes/observations.ts.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface ObservationRow {
  id: string;
  ts: bigint;
  signal_id: string | null;
  instinct_id: string;
  confidence: number | null;
  embedding_id: number | null;
}

// `ts` is a nanosecond value that exceeds Number.MAX_SAFE_INTEGER, so
// the read statement must be flipped to bigint mode via
// setReadBigInts(true). Same lesson as STORE-P1-4 hotfix.
interface ObservationRowRaw {
  id: string;
  ts: bigint;
  signal_id: string | null;
  instinct_id: string;
  confidence: number | null;
  embedding_id: number | bigint | null;
}

function toRow(raw: ObservationRowRaw): ObservationRow {
  return {
    id: raw.id,
    ts: typeof raw.ts === "bigint" ? raw.ts : BigInt(raw.ts),
    signal_id: raw.signal_id,
    instinct_id: raw.instinct_id,
    confidence: raw.confidence,
    embedding_id:
      raw.embedding_id === null ? null : Number(raw.embedding_id),
  };
}

const SELECT_COLS =
  "id, ts, signal_id, instinct_id, confidence, embedding_id";

export function insertObservation(
  db: DatabaseSync,
  row: Omit<ObservationRow, "id" | "ts"> & { id?: string; ts?: bigint },
): string {
  const id = row.id ?? crypto.randomUUID();
  const ts = row.ts ?? BigInt(Date.now()) * 1_000_000n;
  const stmt = db.prepare(
    `INSERT INTO observation
       (id, ts, signal_id, instinct_id, confidence, embedding_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    id,
    ts,
    row.signal_id,
    row.instinct_id,
    row.confidence,
    row.embedding_id,
  );
  return id;
}

export function getObservation(
  db: DatabaseSync,
  id: string,
): ObservationRow | null {
  const stmt = db.prepare(
    `SELECT ${SELECT_COLS} FROM observation WHERE id = ?`,
  );
  stmt.setReadBigInts(true);
  const raw = stmt.get(id) as ObservationRowRaw | undefined;
  return raw ? toRow(raw) : null;
}

export interface ListObservationsOpts {
  instinct_id?: string;
  signal_id?: string;
  since?: bigint;
  until?: bigint;
  limit?: number;
  offset?: number;
}

export function listObservations(
  db: DatabaseSync,
  opts: ListObservationsOpts = {},
): ObservationRow[] {
  const wheres: string[] = [];
  const params: (string | bigint)[] = [];

  if (opts.instinct_id !== undefined) {
    wheres.push("instinct_id = ?");
    params.push(opts.instinct_id);
  }
  if (opts.signal_id !== undefined) {
    wheres.push("signal_id = ?");
    params.push(opts.signal_id);
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
    `SELECT ${SELECT_COLS} FROM observation ${whereSql} ` +
    `ORDER BY ts DESC LIMIT ? OFFSET ?`;

  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  const rows = stmt.all(...params, limit, offset) as ObservationRowRaw[];
  return rows.map(toRow);
}

export function countObservations(
  db: DatabaseSync,
  opts: ListObservationsOpts = {},
): number {
  const wheres: string[] = [];
  const params: (string | bigint)[] = [];

  if (opts.instinct_id !== undefined) {
    wheres.push("instinct_id = ?");
    params.push(opts.instinct_id);
  }
  if (opts.signal_id !== undefined) {
    wheres.push("signal_id = ?");
    params.push(opts.signal_id);
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
  const sql = `SELECT count(*) AS n FROM observation ${whereSql}`;
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row ? Number(row.n) : 0;
}

// ───────────────────────────────────────────────────────────────────────
// embedding (sqlite-vec vec0 virtual table)
// ───────────────────────────────────────────────────────────────────────

export const EMBEDDING_DIM = 768;

function vecToBlob(vec: number[]): Buffer {
  // sqlite-vec stores FLOAT[N] as a tightly-packed little-endian
  // Float32 blob. node:sqlite accepts a Buffer for BLOB params, which
  // is the cleanest path here. (sqlite-vec also accepts a JSON-array
  // string, but the binary form is faster and avoids the JSON parser.)
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `embedding vector must be a number[${EMBEDDING_DIM}], got length ${
        Array.isArray(vec) ? vec.length : typeof vec
      }`,
    );
  }
  const buf = Buffer.alloc(EMBEDDING_DIM * 4);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const v = vec[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`embedding[${i}] must be a finite number`);
    }
    buf.writeFloatLE(v, i * 4);
  }
  return buf;
}

// Insert a row into the embedding vec0 virtual table. Returns the
// auto-assigned rowid, which observation.embedding_id should
// reference. record_id / record_type let us reverse-look-up the
// source row that this embedding describes.
export function insertEmbedding(
  db: DatabaseSync,
  record_id: string,
  record_type: string,
  vec: number[],
): number {
  const blob = vecToBlob(vec);
  // vec0 virtual tables don't support last_insert_rowid() the way
  // ordinary tables do, so use the RETURNING clause (supported in
  // SQLite ≥ 3.35 and in sqlite-vec).
  const stmt = db.prepare(
    `INSERT INTO embedding (record_id, record_type, vec)
     VALUES (?, ?, ?) RETURNING rowid`,
  );
  stmt.setReadBigInts(true);
  const row = stmt.get(record_id, record_type, blob) as
    | { rowid: bigint | number }
    | undefined;
  if (!row) throw new Error("insertEmbedding: no rowid returned");
  return Number(row.rowid);
}

export interface VecSearchHit {
  rowid: number;
  record_id: string | null;
  record_type: string | null;
  distance: number;
}

// k-nearest-neighbours over the embedding table. Uses sqlite-vec's
// MATCH operator (the canonical kNN syntax from the vec0 docs); see
// https://github.com/asg017/sqlite-vec for the query shape. `vec` is
// the query vector; k defaults to 10. Result rows are ordered by
// ascending distance (closest first).
export function vecSearch(
  db: DatabaseSync,
  vec: number[],
  k = 10,
): VecSearchHit[] {
  const blob = vecToBlob(vec);
  const limit = Math.min(Math.max(1, k), 1000);
  const stmt = db.prepare(
    `SELECT rowid, record_id, record_type, distance
       FROM embedding
      WHERE vec MATCH ?
        AND k = ?
      ORDER BY distance ASC`,
  );
  stmt.setReadBigInts(true);
  const rows = stmt.all(blob, limit) as {
    rowid: bigint | number;
    record_id: string | null;
    record_type: string | null;
    distance: number;
  }[];
  return rows.map((r) => ({
    rowid: Number(r.rowid),
    record_id: r.record_id,
    record_type: r.record_type,
    distance: r.distance,
  }));
}
