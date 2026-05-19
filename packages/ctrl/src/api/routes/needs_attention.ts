// needs_attention.ts
//
// STORE-P6-1 followup (#478): HTTP surface for the `needs_attention`
// table (migration 006).
//
// Endpoints:
//   POST  /api/v1/needs-attention       — insert one row
//   GET   /api/v1/needs-attention       — paginated list with filters
//   GET   /api/v1/needs-attention/:id   — fetch one row
//   PATCH /api/v1/needs-attention/:id   — update status + resolver
//                                          (and optional resolution
//                                          verb/target JSON)
//
// Wire format: bigint `ts` / `resolved_at` are serialised as decimal
// strings (same convention as audit / signal). Callers must parse
// with BigInt() if they need to do math.
//
// Writers in alfred-learn (observer activities) and the Desk swipe
// mutation path build on these endpoints. This route does not
// migrate existing markdown needs-attention records.

import { addRoute } from "../server.js";
import {
  sendJson,
  ValidationError,
  NotFoundError,
  ConflictError,
} from "../errors.js";
import { openStateDb } from "../../db/state.js";
import {
  insertNeedsAttention,
  getNeedsAttention,
  listNeedsAttention,
  countNeedsAttention,
  updateNeedsAttentionStatus,
  type NeedsAttentionRow,
  type ListNeedsAttentionOpts,
} from "../../db/needs_attention_queries.js";

interface NeedsAttentionRowOut {
  id: string;
  ts: string;
  source_signal_id: string | null;
  target_matter: string | null;
  target_kind: string | null;
  headline: string;
  body: string;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  payload: string | null;
}

function rowToWire(row: NeedsAttentionRow): NeedsAttentionRowOut {
  return {
    id: row.id,
    ts: row.ts.toString(),
    source_signal_id: row.source_signal_id,
    target_matter: row.target_matter,
    target_kind: row.target_kind,
    headline: row.headline,
    body: row.body,
    status: row.status,
    resolved_at:
      row.resolved_at === null ? null : row.resolved_at.toString(),
    resolved_by: row.resolved_by,
    resolution: row.resolution,
    payload: row.payload,
  };
}

interface InsertBody {
  id?: unknown;
  ts?: unknown;
  source_signal_id?: unknown;
  target_matter?: unknown;
  target_kind?: unknown;
  headline?: unknown;
  body?: unknown;
  status?: unknown;
  resolved_at?: unknown;
  resolved_by?: unknown;
  resolution?: unknown;
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

// `resolution` and `payload` accept either a stringified JSON or a
// plain object — TS writers send objects, Python writers send
// pre-serialised JSON. Normalise to a string for storage.
function normaliseJsonOrNull(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      throw new ValidationError(`${name} string must be valid JSON`);
    }
    return value;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      throw new ValidationError(`${name} object is not JSON-serialisable`);
    }
  }
  throw new ValidationError(`${name} must be a JSON string or object`);
}

function parseListOpts(query: URLSearchParams): ListNeedsAttentionOpts {
  const opts: ListNeedsAttentionOpts = {};
  const status = query.get("status");
  if (status) opts.status = status;
  const targetMatter = query.get("target_matter");
  if (targetMatter) opts.target_matter = targetMatter;

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

export function registerNeedsAttentionRoutes(): void {
  // POST /api/v1/needs-attention — insert a row.
  addRoute("POST", "/api/v1/needs-attention", async ({ res, body }) => {
    const b = (body ?? {}) as InsertBody;

    const headline = requireString(b.headline, "headline");
    const body_text = requireString(b.body, "body");
    const source_signal_id = optionalString(
      b.source_signal_id,
      "source_signal_id",
    );
    const target_matter = optionalString(b.target_matter, "target_matter");
    const target_kind = optionalString(b.target_kind, "target_kind");
    const status = optionalString(b.status, "status") ?? "pending";
    const resolved_at = normaliseTs(b.resolved_at, "resolved_at");
    const resolved_by = optionalString(b.resolved_by, "resolved_by");
    const resolution = normaliseJsonOrNull(b.resolution, "resolution");
    const payload = normaliseJsonOrNull(b.payload, "payload");
    const ts = normaliseTs(b.ts, "ts");
    const id =
      b.id === undefined || b.id === null
        ? undefined
        : requireString(b.id, "id");

    const db = openStateDb();
    const effectiveTs = ts ?? BigInt(Date.now()) * 1_000_000n;
    let insertedId: string;
    try {
      insertedId = insertNeedsAttention(db, {
        id,
        ts: effectiveTs,
        source_signal_id,
        target_matter,
        target_kind,
        headline,
        body: body_text,
        status,
        resolved_at: resolved_at ?? null,
        resolved_by,
        resolution,
        payload,
      });
    } catch (err) {
      const msg = (err as Error).message || "";
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
        throw new ConflictError(
          `needs_attention row with id ${id} already exists`,
        );
      }
      throw err;
    }
    sendJson(res, 201, { id: insertedId, ts: effectiveTs.toString() });
  });

  // GET /api/v1/needs-attention — paginated list with filters.
  addRoute("GET", "/api/v1/needs-attention", async ({ res, query }) => {
    const opts = parseListOpts(query);
    const db = openStateDb();
    const rows = listNeedsAttention(db, opts);
    const count = countNeedsAttention(db, opts);
    sendJson(res, 200, {
      results: rows.map(rowToWire),
      count,
    });
  });

  // GET /api/v1/needs-attention/:id — fetch one row.
  addRoute("GET", "/api/v1/needs-attention/:id", async ({ res, params }) => {
    const db = openStateDb();
    const row = getNeedsAttention(db, params.id);
    if (!row) {
      throw new NotFoundError(`needs_attention ${params.id} not found`);
    }
    sendJson(res, 200, rowToWire(row));
  });

  // PATCH /api/v1/needs-attention/:id — update status + resolver
  // bookkeeping. Body keys:
  //   status: 'pending' | 'done' | 'skipped' | 'dispatched'   (required)
  //   resolved_by: string                                     (required)
  //   resolution?: object | string                            (optional)
  // resolved_at is set server-side.
  addRoute(
    "PATCH",
    "/api/v1/needs-attention/:id",
    async ({ res, params, body }) => {
      const b = (body ?? {}) as {
        status?: unknown;
        resolved_by?: unknown;
        resolution?: unknown;
      };
      const status = requireString(b.status, "status");
      const resolved_by = requireString(b.resolved_by, "resolved_by");
      const resolution = normaliseJsonOrNull(b.resolution, "resolution");

      const db = openStateDb();
      const ok = updateNeedsAttentionStatus(
        db,
        params.id,
        status,
        resolved_by,
        resolution ?? undefined,
      );
      if (!ok) {
        throw new NotFoundError(`needs_attention ${params.id} not found`);
      }
      const row = getNeedsAttention(db, params.id);
      if (!row) {
        throw new NotFoundError(`needs_attention ${params.id} not found`);
      }
      sendJson(res, 200, rowToWire(row));
    },
  );
}
