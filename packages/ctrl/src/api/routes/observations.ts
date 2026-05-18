// observations.ts
//
// STORE-P3-2: HTTP surface for the `observation` and `embedding` tables
// (migration 004).
//
// Endpoints:
//   POST /api/v1/observations              — insert one observation row
//                                              (optionally with an embedding
//                                              vector that gets inserted
//                                              alongside it)
//   GET  /api/v1/observations              — list, optionally filtered by
//                                              instinct_id / signal_id
//   POST /api/v1/observations/vec-search   — kNN search across embeddings
//
// Wire format: bigint `ts` → decimal string (same convention as audit /
// signals). Embedding vectors go on the wire as plain JSON number arrays
// (length 768).

import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError, ConflictError } from "../errors.js";
import { openStateDb } from "../../db/state.js";
import {
  insertObservation,
  getObservation,
  listObservations,
  countObservations,
  insertEmbedding,
  vecSearch,
  EMBEDDING_DIM,
  type ObservationRow,
  type ListObservationsOpts,
} from "../../db/observation_queries.js";

interface ObservationRowOut {
  id: string;
  ts: string;
  signal_id: string | null;
  instinct_id: string;
  confidence: number | null;
  embedding_id: number | null;
}

function rowToWire(row: ObservationRow): ObservationRowOut {
  return {
    id: row.id,
    ts: row.ts.toString(),
    signal_id: row.signal_id,
    instinct_id: row.instinct_id,
    confidence: row.confidence,
    embedding_id: row.embedding_id,
  };
}

interface InsertBody {
  id?: unknown;
  ts?: unknown;
  signal_id?: unknown;
  instinct_id?: unknown;
  confidence?: unknown;
  embedding_id?: unknown;
  // If embedding is supplied, ctrl-api will insert it into the
  // `embedding` vec0 table and store the resulting rowid as
  // observation.embedding_id. Mutually exclusive with embedding_id.
  embedding?: unknown;
  // Required when `embedding` is supplied so the embedding row knows
  // what it describes. Defaults to ("observation:<id>", "observation")
  // when omitted.
  embedding_record_id?: unknown;
  embedding_record_type?: unknown;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new ValidationError(`${name} is required and must be a non-empty string`);
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

function normaliseVec(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${name} must be a number[${EMBEDDING_DIM}]`);
  }
  if (value.length !== EMBEDDING_DIM) {
    throw new ValidationError(
      `${name} must have length ${EMBEDDING_DIM}, got ${value.length}`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ValidationError(`${name}[${i}] must be a finite number`);
    }
  }
  return value as number[];
}

function parseListOpts(query: URLSearchParams): ListObservationsOpts {
  const opts: ListObservationsOpts = {};
  const instinctId = query.get("instinct_id");
  if (instinctId) opts.instinct_id = instinctId;
  const signalId = query.get("signal_id");
  if (signalId) opts.signal_id = signalId;

  const since = query.get("since");
  if (since) {
    if (!/^-?\d+$/.test(since)) {
      throw new ValidationError("since must be an integer (ns)");
    }
    opts.since = BigInt(since);
  }
  const until = query.get("until");
  if (until) {
    if (!/^-?\d+$/.test(until)) {
      throw new ValidationError("until must be an integer (ns)");
    }
    opts.until = BigInt(until);
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

export function registerObservationRoutes(): void {
  // POST /api/v1/observations — insert a row, optionally with its
  // embedding vector in the same call.
  addRoute("POST", "/api/v1/observations", async ({ res, body }) => {
    const b = (body ?? {}) as InsertBody;

    const instinct_id = requireString(b.instinct_id, "instinct_id");
    const signal_id = optionalString(b.signal_id, "signal_id");
    const confidence =
      b.confidence === undefined || b.confidence === null
        ? null
        : (() => {
            if (typeof b.confidence !== "number" || !Number.isFinite(b.confidence)) {
              throw new ValidationError("confidence must be a finite number");
            }
            return b.confidence;
          })();
    const ts = normaliseTs(b.ts, "ts");
    const id =
      b.id === undefined || b.id === null
        ? undefined
        : requireString(b.id, "id");

    if (b.embedding !== undefined && b.embedding_id !== undefined) {
      throw new ValidationError(
        "supply either `embedding` or `embedding_id`, not both",
      );
    }

    const db = openStateDb();
    const effectiveTs = ts ?? BigInt(Date.now()) * 1_000_000n;

    let embedding_id: number | null = null;
    if (b.embedding !== undefined && b.embedding !== null) {
      const vec = normaliseVec(b.embedding, "embedding");
      // Default record_type to 'observation'; record_id falls back to
      // the observation id below once we know it.
      const recordType = optionalString(
        b.embedding_record_type,
        "embedding_record_type",
      ) ?? "observation";
      const recordIdHint = optionalString(
        b.embedding_record_id,
        "embedding_record_id",
      );
      const recordId = recordIdHint ?? `observation:${id ?? "pending"}`;
      embedding_id = insertEmbedding(db, recordId, recordType, vec);
    } else if (b.embedding_id !== undefined && b.embedding_id !== null) {
      if (
        typeof b.embedding_id !== "number" ||
        !Number.isFinite(b.embedding_id) ||
        !Number.isInteger(b.embedding_id)
      ) {
        throw new ValidationError("embedding_id must be an integer rowid");
      }
      embedding_id = b.embedding_id;
    }

    let insertedId: string;
    try {
      insertedId = insertObservation(db, {
        id,
        ts: effectiveTs,
        signal_id,
        instinct_id,
        confidence,
        embedding_id,
      });
    } catch (err) {
      const msg = (err as Error).message || "";
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
        throw new ConflictError(`observation with id ${id} already exists`);
      }
      throw err;
    }
    sendJson(res, 201, {
      id: insertedId,
      ts: effectiveTs.toString(),
      embedding_id,
    });
  });

  // GET /api/v1/observations — paginated list.
  addRoute("GET", "/api/v1/observations", async ({ res, query }) => {
    const opts = parseListOpts(query);
    const db = openStateDb();
    const rows = listObservations(db, opts);
    const count = countObservations(db, opts);
    sendJson(res, 200, {
      results: rows.map(rowToWire),
      count,
    });
  });

  // GET /api/v1/observations/:id — fetch one row.
  addRoute("GET", "/api/v1/observations/:id", async ({ res, params }) => {
    const db = openStateDb();
    const row = getObservation(db, params.id);
    if (!row) throw new NotFoundError(`observation ${params.id} not found`);
    sendJson(res, 200, rowToWire(row));
  });

  // POST /api/v1/observations/vec-search — kNN across the embedding
  // virtual table. Body: { vec: number[768], k?: number }.
  addRoute("POST", "/api/v1/observations/vec-search", async ({ res, body }) => {
    const b = (body ?? {}) as { vec?: unknown; k?: unknown };
    const vec = normaliseVec(b.vec, "vec");
    let k = 10;
    if (b.k !== undefined && b.k !== null) {
      if (typeof b.k !== "number" || !Number.isFinite(b.k) || b.k <= 0) {
        throw new ValidationError("k must be a positive integer");
      }
      k = Math.trunc(b.k);
    }
    const db = openStateDb();
    const hits = vecSearch(db, vec, k);
    sendJson(res, 200, { results: hits });
  });
}
