// pattern_proposals.ts
//
// STORE-P6-1 followup (#478): HTTP surface for the `pattern_proposal`
// table (migration 006).
//
// Endpoints:
//   POST  /api/v1/pattern-proposals       — insert one row
//   GET   /api/v1/pattern-proposals       — paginated list with filters
//   GET   /api/v1/pattern-proposals/:id   — fetch one row
//   PATCH /api/v1/pattern-proposals/:id   — update status + reviewer
//                                            (and optionally promoted
//                                            instinct id)
//
// Wire format: bigint `ts` / `reviewed_at` are serialised as decimal
// strings (same convention as audit / signal). Callers must parse
// with BigInt() if they need to do math.
//
// Writers in alfred-learn (PatternDetection workflow) and the /instincts
// SaaS reader build on these endpoints. This route does not migrate
// existing markdown pattern-proposal records.

import { addRoute } from "../server.js";
import {
  sendJson,
  ValidationError,
  NotFoundError,
  ConflictError,
} from "../errors.js";
import { openStateDb } from "../../db/state.js";
import {
  insertPatternProposal,
  getPatternProposal,
  listPatternProposals,
  countPatternProposals,
  updatePatternProposalStatus,
  type PatternProposalRow,
  type ListPatternProposalsOpts,
} from "../../db/pattern_proposal_queries.js";

interface PatternProposalRowOut {
  id: string;
  ts: string;
  proposed_name: string;
  proposed_body: string;
  cluster_size: number;
  member_observation_ids: string | null;
  status: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  promoted_to_instinct_id: string | null;
  payload: string | null;
}

function rowToWire(row: PatternProposalRow): PatternProposalRowOut {
  return {
    id: row.id,
    ts: row.ts.toString(),
    proposed_name: row.proposed_name,
    proposed_body: row.proposed_body,
    cluster_size: row.cluster_size,
    member_observation_ids: row.member_observation_ids,
    status: row.status,
    reviewed_at:
      row.reviewed_at === null ? null : row.reviewed_at.toString(),
    reviewed_by: row.reviewed_by,
    promoted_to_instinct_id: row.promoted_to_instinct_id,
    payload: row.payload,
  };
}

interface InsertBody {
  id?: unknown;
  ts?: unknown;
  proposed_name?: unknown;
  proposed_body?: unknown;
  cluster_size?: unknown;
  member_observation_ids?: unknown;
  status?: unknown;
  reviewed_at?: unknown;
  reviewed_by?: unknown;
  promoted_to_instinct_id?: unknown;
  payload?: unknown;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new ValidationError(
      `${name} is required and must be a non-empty string`,
    );
  }
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${name} must be a string when provided`);
  }
  return value || null;
}

function normaliseTs(value: unknown, name = "ts"): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      throw new ValidationError(`${name} must be an integer (ns)`);
    }
  }
  throw new ValidationError(`${name} must be an integer or numeric string (ns)`);
}

function normaliseInt(value: unknown, name: string, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  throw new ValidationError(`${name} must be an integer`);
}

// `member_observation_ids` accepts either a stringified JSON array or
// a JS array — normalise to a string for storage. Both shapes show up
// in the wild (TS writers send arrays; Python writers send
// pre-serialised JSON).
function normaliseMemberIds(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      throw new ValidationError(
        "member_observation_ids string must be valid JSON",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      throw new ValidationError(
        "member_observation_ids array is not JSON-serialisable",
      );
    }
  }
  throw new ValidationError(
    "member_observation_ids must be a JSON string or array",
  );
}

function normalisePayload(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      throw new ValidationError("payload string must be valid JSON");
    }
    return value;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      throw new ValidationError("payload object is not JSON-serialisable");
    }
  }
  throw new ValidationError("payload must be a JSON string or object");
}

function parseListOpts(query: URLSearchParams): ListPatternProposalsOpts {
  const opts: ListPatternProposalsOpts = {};
  const status = query.get("status");
  if (status) opts.status = status;

  const since = query.get("since");
  if (since) {
    if (!/^-?\d+$/.test(since)) {
      throw new ValidationError("since must be an integer (ns)");
    }
    opts.since = BigInt(since);
  }

  const limitRaw = query.get("limit");
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ValidationError("limit must be a positive integer");
    }
    opts.limit = n;
  }
  const offsetRaw = query.get("offset");
  if (offsetRaw) {
    const n = parseInt(offsetRaw, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new ValidationError("offset must be a non-negative integer");
    }
    opts.offset = n;
  }
  return opts;
}

export function registerPatternProposalRoutes(): void {
  // POST /api/v1/pattern-proposals — insert a row.
  addRoute("POST", "/api/v1/pattern-proposals", async ({ res, body }) => {
    const b = (body ?? {}) as InsertBody;

    const proposed_name = requireString(b.proposed_name, "proposed_name");
    const proposed_body = requireString(b.proposed_body, "proposed_body");
    const cluster_size = normaliseInt(b.cluster_size, "cluster_size", 0);
    const member_observation_ids = normaliseMemberIds(b.member_observation_ids);
    const status = optionalString(b.status, "status") ?? "pending";
    const reviewed_at = normaliseTs(b.reviewed_at, "reviewed_at");
    const reviewed_by = optionalString(b.reviewed_by, "reviewed_by");
    const promoted_to_instinct_id = optionalString(
      b.promoted_to_instinct_id,
      "promoted_to_instinct_id",
    );
    const payload = normalisePayload(b.payload);
    const ts = normaliseTs(b.ts, "ts");
    const id =
      b.id === undefined || b.id === null
        ? undefined
        : requireString(b.id, "id");

    const db = openStateDb();
    const effectiveTs = ts ?? BigInt(Date.now()) * 1_000_000n;
    let insertedId: string;
    try {
      insertedId = insertPatternProposal(db, {
        id,
        ts: effectiveTs,
        proposed_name,
        proposed_body,
        cluster_size,
        member_observation_ids,
        status,
        reviewed_at: reviewed_at ?? null,
        reviewed_by,
        promoted_to_instinct_id,
        payload,
      });
    } catch (err) {
      const msg = (err as Error).message || "";
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
        throw new ConflictError(
          `pattern_proposal row with id ${id} already exists`,
        );
      }
      throw err;
    }
    sendJson(res, 201, { id: insertedId, ts: effectiveTs.toString() });
  });

  // GET /api/v1/pattern-proposals — paginated list with filters.
  addRoute("GET", "/api/v1/pattern-proposals", async ({ res, query }) => {
    const opts = parseListOpts(query);
    const db = openStateDb();
    const rows = listPatternProposals(db, opts);
    const count = countPatternProposals(db, opts);
    sendJson(res, 200, {
      results: rows.map(rowToWire),
      count,
    });
  });

  // GET /api/v1/pattern-proposals/:id — fetch one row.
  addRoute("GET", "/api/v1/pattern-proposals/:id", async ({ res, params }) => {
    const db = openStateDb();
    const row = getPatternProposal(db, params.id);
    if (!row) {
      throw new NotFoundError(`pattern_proposal ${params.id} not found`);
    }
    sendJson(res, 200, rowToWire(row));
  });

  // PATCH /api/v1/pattern-proposals/:id — update status + reviewer
  // bookkeeping. Body keys:
  //   status: 'pending' | 'approved' | 'rejected'  (required)
  //   reviewed_by: string                          (required)
  //   promoted_to_instinct_id?: string             (optional, only
  //                                                 meaningful when
  //                                                 status='approved')
  // reviewed_at is set server-side.
  addRoute(
    "PATCH",
    "/api/v1/pattern-proposals/:id",
    async ({ res, params, body }) => {
      const b = (body ?? {}) as {
        status?: unknown;
        reviewed_by?: unknown;
        promoted_to_instinct_id?: unknown;
      };
      const status = requireString(b.status, "status");
      const reviewed_by = requireString(b.reviewed_by, "reviewed_by");
      const promoted_to_instinct_id = optionalString(
        b.promoted_to_instinct_id,
        "promoted_to_instinct_id",
      );

      const db = openStateDb();
      const ok = updatePatternProposalStatus(
        db,
        params.id,
        status,
        reviewed_by,
        promoted_to_instinct_id ?? undefined,
      );
      if (!ok) {
        throw new NotFoundError(`pattern_proposal ${params.id} not found`);
      }
      const row = getPatternProposal(db, params.id);
      if (!row) {
        throw new NotFoundError(`pattern_proposal ${params.id} not found`);
      }
      sendJson(res, 200, rowToWire(row));
    },
  );
}
