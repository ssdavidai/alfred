// pattern_proposal_queries.ts
//
// STORE-P6-1 followup (#478): typed query helpers for the
// `pattern_proposal` table (migration 006).
//
// Reads/writes derived intelligence records proposed by
// PatternDetectionWorkflow. The principal approves or rejects each
// proposal via /instincts; on approval the proposal is promoted into
// a vault instinct (path stored in `promoted_to_instinct_id`).
//
// Writers (alfred-learn PatternDetection / /instincts mutations) call
// the HTTP route in routes/pattern_proposals.ts — they do not import
// this module directly. This file is the in-process surface used by
// the API layer.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface PatternProposalRow {
  id: string;
  ts: bigint;
  proposed_name: string;
  proposed_body: string;
  cluster_size: number;
  member_observation_ids: string | null; // raw JSON
  status: string;
  reviewed_at: bigint | null;
  reviewed_by: string | null;
  promoted_to_instinct_id: string | null;
  payload: string | null;
}

// `ts` and `reviewed_at` are nanosecond values that exceed
// Number.MAX_SAFE_INTEGER, so every read statement that returns them
// MUST be flipped to bigint mode via setReadBigInts(true). Same lesson
// as STORE-P1-4 / P3-2. Side effect: `cluster_size` also comes back
// as bigint, hence the Number(...) coercion in toRow.
interface PatternProposalRowRaw {
  id: string;
  ts: bigint;
  proposed_name: string;
  proposed_body: string;
  cluster_size: number | bigint;
  member_observation_ids: string | null;
  status: string;
  reviewed_at: bigint | null;
  reviewed_by: string | null;
  promoted_to_instinct_id: string | null;
  payload: string | null;
}

function toRow(raw: PatternProposalRowRaw): PatternProposalRow {
  return {
    id: raw.id,
    ts: typeof raw.ts === "bigint" ? raw.ts : BigInt(raw.ts),
    proposed_name: raw.proposed_name,
    proposed_body: raw.proposed_body,
    cluster_size: Number(raw.cluster_size),
    member_observation_ids: raw.member_observation_ids,
    status: raw.status,
    reviewed_at:
      raw.reviewed_at === null
        ? null
        : typeof raw.reviewed_at === "bigint"
          ? raw.reviewed_at
          : BigInt(raw.reviewed_at),
    reviewed_by: raw.reviewed_by,
    promoted_to_instinct_id: raw.promoted_to_instinct_id,
    payload: raw.payload,
  };
}

const SELECT_COLS =
  "id, ts, proposed_name, proposed_body, cluster_size, " +
  "member_observation_ids, status, reviewed_at, reviewed_by, " +
  "promoted_to_instinct_id, payload";

export function insertPatternProposal(
  db: DatabaseSync,
  row: Partial<PatternProposalRow>,
): string {
  if (!row.proposed_name) {
    throw new Error("proposed_name is required");
  }
  if (!row.proposed_body) {
    throw new Error("proposed_body is required");
  }
  const id = row.id ?? crypto.randomUUID();
  const ts = row.ts ?? BigInt(Date.now()) * 1_000_000n;
  const status = row.status ?? "pending";
  const cluster_size = row.cluster_size ?? 0;
  const stmt = db.prepare(
    `INSERT INTO pattern_proposal
       (id, ts, proposed_name, proposed_body, cluster_size,
        member_observation_ids, status, reviewed_at, reviewed_by,
        promoted_to_instinct_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    id,
    ts,
    row.proposed_name,
    row.proposed_body,
    cluster_size,
    row.member_observation_ids ?? null,
    status,
    row.reviewed_at ?? null,
    row.reviewed_by ?? null,
    row.promoted_to_instinct_id ?? null,
    row.payload ?? null,
  );
  return id;
}

export function getPatternProposal(
  db: DatabaseSync,
  id: string,
): PatternProposalRow | null {
  const stmt = db.prepare(
    `SELECT ${SELECT_COLS} FROM pattern_proposal WHERE id = ?`,
  );
  stmt.setReadBigInts(true);
  const raw = stmt.get(id) as PatternProposalRowRaw | undefined;
  return raw ? toRow(raw) : null;
}

export interface ListPatternProposalsOpts {
  status?: string;
  since?: bigint;
  limit?: number;
  offset?: number;
}

export function listPatternProposals(
  db: DatabaseSync,
  opts: ListPatternProposalsOpts = {},
): PatternProposalRow[] {
  const wheres: string[] = [];
  const params: (string | bigint)[] = [];

  if (opts.status !== undefined) {
    wheres.push("status = ?");
    params.push(opts.status);
  }
  if (opts.since !== undefined) {
    wheres.push("ts >= ?");
    params.push(opts.since);
  }

  const limit = Math.min(Math.max(1, opts.limit ?? 50), 1000);
  const offset = Math.max(0, opts.offset ?? 0);

  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql =
    `SELECT ${SELECT_COLS} FROM pattern_proposal ${whereSql} ` +
    `ORDER BY ts DESC LIMIT ? OFFSET ?`;

  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  const rows = stmt.all(...params, limit, offset) as PatternProposalRowRaw[];
  return rows.map(toRow);
}

export function countPatternProposals(
  db: DatabaseSync,
  opts: ListPatternProposalsOpts = {},
): number {
  const wheres: string[] = [];
  const params: (string | bigint)[] = [];

  if (opts.status !== undefined) {
    wheres.push("status = ?");
    params.push(opts.status);
  }
  if (opts.since !== undefined) {
    wheres.push("ts >= ?");
    params.push(opts.since);
  }

  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql = `SELECT count(*) AS n FROM pattern_proposal ${whereSql}`;
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row ? Number(row.n) : 0;
}

// Update status (approve / reject / pending → other) + reviewer
// bookkeeping. Sets reviewed_at server-side. promoted_to_instinct_id
// is optional and only meaningful when status='approved'.
// Returns true iff a row was updated.
export function updatePatternProposalStatus(
  db: DatabaseSync,
  id: string,
  status: string,
  reviewed_by: string,
  promoted_to_instinct_id?: string,
): boolean {
  const reviewed_at = BigInt(Date.now()) * 1_000_000n;
  const stmt = db.prepare(
    `UPDATE pattern_proposal
        SET status = ?,
            reviewed_at = ?,
            reviewed_by = ?,
            promoted_to_instinct_id = COALESCE(?, promoted_to_instinct_id)
      WHERE id = ?`,
  );
  const result = stmt.run(
    status,
    reviewed_at,
    reviewed_by,
    promoted_to_instinct_id ?? null,
    id,
  );
  return Number(result.changes) > 0;
}
