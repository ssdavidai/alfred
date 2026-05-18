// signal_queries.ts
//
// STORE-P3-2: typed query helpers for the `signal` table (migration 004).
//
// Reads/writes the unified signal stream that replaces the markdown
// /vault/signal/*.md records. See STORAGE-ARCHITECTURE.md §5 for
// the schema and the canonical source_type / target_kind / actor
// vocabulary.
//
// Writers (alfred-learn EventProcessor, omi/vexa ingestors, the
// composio gateway) call the HTTP route in routes/signals.ts —
// they do not import this module directly. This file is the
// in-process surface used by the API layer.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SignalRow {
  id: string;
  ts: bigint;
  source_type: string;
  source_event: string | null;
  target_matter: string | null;
  target_kind: string | null;
  actor: string | null;
  decision_required: number;
  display_headline: string | null;
  display_body: string | null;
  body: string;
  processed_at: bigint | null;
  classified_noise: number;
}

// `ts` and `processed_at` are nanosecond values that exceed
// Number.MAX_SAFE_INTEGER on a few-decade horizon, so every read
// statement that returns them MUST be flipped to bigint mode via
// setReadBigInts(true). Without that flag, node:sqlite throws
// `RangeError: Value is too large to be represented as a JavaScript
// number` when materialising the row. Same lesson as STORE-P1-4. Side
// effect: integer flag columns (decision_required, classified_noise)
// also come back as bigint, hence the Number(...) coercion in toRow.
interface SignalRowRaw {
  id: string;
  ts: bigint;
  source_type: string;
  source_event: string | null;
  target_matter: string | null;
  target_kind: string | null;
  actor: string | null;
  decision_required: number | bigint;
  display_headline: string | null;
  display_body: string | null;
  body: string;
  processed_at: bigint | null;
  classified_noise: number | bigint;
}

function toRow(raw: SignalRowRaw): SignalRow {
  return {
    id: raw.id,
    ts: typeof raw.ts === "bigint" ? raw.ts : BigInt(raw.ts),
    source_type: raw.source_type,
    source_event: raw.source_event,
    target_matter: raw.target_matter,
    target_kind: raw.target_kind,
    actor: raw.actor,
    decision_required: Number(raw.decision_required),
    display_headline: raw.display_headline,
    display_body: raw.display_body,
    body: raw.body,
    processed_at:
      raw.processed_at === null
        ? null
        : typeof raw.processed_at === "bigint"
          ? raw.processed_at
          : BigInt(raw.processed_at),
    classified_noise: Number(raw.classified_noise),
  };
}

const SELECT_COLS =
  "id, ts, source_type, source_event, target_matter, target_kind, " +
  "actor, decision_required, display_headline, display_body, body, " +
  "processed_at, classified_noise";

export function insertSignal(
  db: DatabaseSync,
  row: Omit<SignalRow, "id" | "ts"> & { id?: string; ts?: bigint },
): string {
  const id = row.id ?? crypto.randomUUID();
  const ts = row.ts ?? BigInt(Date.now()) * 1_000_000n;
  const stmt = db.prepare(
    `INSERT INTO signal
       (id, ts, source_type, source_event, target_matter, target_kind,
        actor, decision_required, display_headline, display_body, body,
        processed_at, classified_noise)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    id,
    ts,
    row.source_type,
    row.source_event,
    row.target_matter,
    row.target_kind,
    row.actor,
    row.decision_required,
    row.display_headline,
    row.display_body,
    row.body,
    row.processed_at,
    row.classified_noise,
  );
  return id;
}

export function getSignal(db: DatabaseSync, id: string): SignalRow | null {
  const stmt = db.prepare(`SELECT ${SELECT_COLS} FROM signal WHERE id = ?`);
  stmt.setReadBigInts(true);
  const raw = stmt.get(id) as SignalRowRaw | undefined;
  return raw ? toRow(raw) : null;
}

export interface ListSignalsOpts {
  target_matter?: string;
  source_type?: string;
  since?: bigint;
  until?: bigint;
  // 'pending' = processed_at IS NULL, 'done' = processed_at IS NOT NULL,
  // undefined = no filter on processed_at.
  processed?: "pending" | "done";
  limit?: number;
  offset?: number;
}

export function listSignals(
  db: DatabaseSync,
  opts: ListSignalsOpts = {},
): SignalRow[] {
  const wheres: string[] = [];
  const params: (string | bigint)[] = [];

  if (opts.target_matter !== undefined) {
    wheres.push("target_matter = ?");
    params.push(opts.target_matter);
  }
  if (opts.source_type !== undefined) {
    wheres.push("source_type = ?");
    params.push(opts.source_type);
  }
  if (opts.since !== undefined) {
    wheres.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    wheres.push("ts <= ?");
    params.push(opts.until);
  }
  if (opts.processed === "pending") {
    wheres.push("processed_at IS NULL");
  } else if (opts.processed === "done") {
    wheres.push("processed_at IS NOT NULL");
  }

  const limit = Math.min(Math.max(1, opts.limit ?? 50), 1000);
  const offset = Math.max(0, opts.offset ?? 0);

  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql =
    `SELECT ${SELECT_COLS} FROM signal ${whereSql} ` +
    `ORDER BY ts DESC LIMIT ? OFFSET ?`;

  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  const rows = stmt.all(...params, limit, offset) as SignalRowRaw[];
  return rows.map(toRow);
}

export function countSignals(
  db: DatabaseSync,
  opts: ListSignalsOpts = {},
): number {
  const wheres: string[] = [];
  const params: (string | bigint)[] = [];

  if (opts.target_matter !== undefined) {
    wheres.push("target_matter = ?");
    params.push(opts.target_matter);
  }
  if (opts.source_type !== undefined) {
    wheres.push("source_type = ?");
    params.push(opts.source_type);
  }
  if (opts.since !== undefined) {
    wheres.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    wheres.push("ts <= ?");
    params.push(opts.until);
  }
  if (opts.processed === "pending") {
    wheres.push("processed_at IS NULL");
  } else if (opts.processed === "done") {
    wheres.push("processed_at IS NOT NULL");
  }

  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql = `SELECT count(*) AS n FROM signal ${whereSql}`;
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row ? Number(row.n) : 0;
}

// Mark a signal as processed by setting processed_at. Idempotent at the
// SQL level — repeated calls just overwrite the same timestamp.
// Returns true if a row was updated, false if the id does not exist.
export function markProcessed(
  db: DatabaseSync,
  id: string,
  ts: bigint,
): boolean {
  const stmt = db.prepare(
    `UPDATE signal SET processed_at = ? WHERE id = ?`,
  );
  const result = stmt.run(ts, id);
  return Number(result.changes) > 0;
}

// Update mutable signal fields. Used by PATCH /api/v1/signals/:id.
// Currently mostly for processed_at + classified_noise; expand as
// future writers need it. Returns true iff a row was updated.
export interface UpdateSignalOpts {
  processed_at?: bigint | null;
  classified_noise?: number;
}

export function updateSignal(
  db: DatabaseSync,
  id: string,
  opts: UpdateSignalOpts,
): boolean {
  const sets: string[] = [];
  const params: (string | bigint | number | null)[] = [];
  if (opts.processed_at !== undefined) {
    sets.push("processed_at = ?");
    params.push(opts.processed_at);
  }
  if (opts.classified_noise !== undefined) {
    sets.push("classified_noise = ?");
    params.push(opts.classified_noise);
  }
  if (!sets.length) return false;
  params.push(id);
  const stmt = db.prepare(
    `UPDATE signal SET ${sets.join(", ")} WHERE id = ?`,
  );
  const result = stmt.run(...params);
  return Number(result.changes) > 0;
}
