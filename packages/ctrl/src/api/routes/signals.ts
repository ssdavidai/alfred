// signals.ts
//
// STORE-P3-2: HTTP surface for the `signal` table (migration 004).
//
// Endpoints:
//   POST  /api/v1/signals         — insert one signal row
//   GET   /api/v1/signals         — paginated list with filters
//   GET   /api/v1/signals/:id     — fetch one row
//   PATCH /api/v1/signals/:id     — update mutable fields (mostly
//                                    processed_at and classified_noise)
//
// Wire format: bigint `ts` / `processed_at` are serialised as decimal
// strings (same convention as audit). Callers must parse with BigInt()
// if they need to do math.
//
// Writers in alfred-learn (P3-3) and the SaaS read-side (P3-6) build on
// these endpoints. This route does not migrate existing markdown signal
// records — that's P3-4.

import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError, ConflictError } from "../errors.js";
import { openStateDb } from "../../db/state.js";
import {
  insertSignal,
  getSignal,
  listSignals,
  countSignals,
  updateSignal,
  type SignalRow,
  type ListSignalsOpts,
} from "../../db/signal_queries.js";

interface SignalRowOut {
  id: string;
  ts: string;
  source_type: string;
  source_event: string | null;
  target_matter: string | null;
  target_kind: string | null;
  actor: string | null;
  decision_required: number;
  display_headline: string | null;
  display_body: string | null;
  body: string;
  processed_at: string | null;
  classified_noise: number;
  // Round 2.7: forensic JSON payload (effect, action_proposal,
  // confidences, raw_quote, reasoning, target_*). Returned as a parsed
  // object so callers don't have to JSON.parse again; null when the
  // row predates migration 007 or no payload was supplied.
  payload: Record<string, unknown> | null;
}

function rowToWire(row: SignalRow): SignalRowOut {
  let parsedPayload: Record<string, unknown> | null = null;
  if (row.payload !== null && row.payload !== "") {
    try {
      const v = JSON.parse(row.payload);
      // We only emit objects; arrays / scalars should never appear here
      // (the route validates), but defend against legacy / hand-edited
      // rows by collapsing anything non-object to null.
      if (v && typeof v === "object" && !Array.isArray(v)) {
        parsedPayload = v as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON in storage — surface as null rather than
      // crashing the whole list response.
      parsedPayload = null;
    }
  }
  return {
    id: row.id,
    ts: row.ts.toString(),
    source_type: row.source_type,
    source_event: row.source_event,
    target_matter: row.target_matter,
    target_kind: row.target_kind,
    actor: row.actor,
    decision_required: row.decision_required,
    display_headline: row.display_headline,
    display_body: row.display_body,
    body: row.body,
    processed_at: row.processed_at === null ? null : row.processed_at.toString(),
    classified_noise: row.classified_noise,
    payload: parsedPayload,
  };
}

interface InsertBody {
  id?: unknown;
  ts?: unknown;
  source_type?: unknown;
  source_event?: unknown;
  target_matter?: unknown;
  target_kind?: unknown;
  actor?: unknown;
  decision_required?: unknown;
  display_headline?: unknown;
  display_body?: unknown;
  body?: unknown;
  processed_at?: unknown;
  classified_noise?: unknown;
  payload?: unknown;
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

function normaliseBoolInt(value: unknown, name: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value ? 1 : 0;
  throw new ValidationError(`${name} must be a boolean or 0/1`);
}

// Mirrors the audit route's normalisePayload: accept either a parsed
// object or a pre-stringified JSON string. We always store as text so
// SQLite stays JSON1-free; rowToWire JSON.parse()s on read. Returning
// `null` is explicit (caller passed null) → clear the column.
function normalisePayload(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    if (value === "") return null;
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ValidationError("payload must be a JSON object");
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError("payload string must be valid JSON");
    }
    return value;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      throw new ValidationError("payload object is not JSON-serialisable");
    }
  }
  throw new ValidationError("payload must be a JSON object or stringified JSON");
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

function parseListOpts(query: URLSearchParams): ListSignalsOpts {
  const opts: ListSignalsOpts = {};
  const targetMatter = query.get("target_matter");
  if (targetMatter) opts.target_matter = targetMatter;
  const sourceType = query.get("source_type");
  if (sourceType) opts.source_type = sourceType;

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
  const processed = query.get("processed");
  if (processed === "pending" || processed === "done") {
    opts.processed = processed;
  } else if (processed !== null) {
    throw new ValidationError("processed must be 'pending' or 'done'");
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

export function registerSignalRoutes(): void {
  // POST /api/v1/signals — insert a row.
  addRoute("POST", "/api/v1/signals", async ({ res, body }) => {
    const b = (body ?? {}) as InsertBody;

    const source_type = requireString(b.source_type, "source_type");
    const body_text = requireString(b.body, "body");
    const source_event = optionalString(b.source_event, "source_event");
    const target_matter = optionalString(b.target_matter, "target_matter");
    const target_kind = optionalString(b.target_kind, "target_kind");
    const actor = optionalString(b.actor, "actor");
    const decision_required = normaliseBoolInt(b.decision_required, "decision_required");
    const display_headline = optionalString(b.display_headline, "display_headline");
    const display_body = optionalString(b.display_body, "display_body");
    const classified_noise = normaliseBoolInt(b.classified_noise, "classified_noise");
    const processed_at = normaliseTs(b.processed_at, "processed_at");
    const ts = normaliseTs(b.ts, "ts");
    const payloadRaw = normalisePayload(b.payload);
    // normalisePayload returns `undefined` when the caller omitted the
    // field; for INSERT we collapse that to `null` so the column has a
    // value-or-null write rather than being skipped.
    const payload = payloadRaw === undefined ? null : payloadRaw;
    const id =
      b.id === undefined || b.id === null
        ? undefined
        : requireString(b.id, "id");

    const db = openStateDb();
    const effectiveTs = ts ?? BigInt(Date.now()) * 1_000_000n;
    let insertedId: string;
    try {
      insertedId = insertSignal(db, {
        id,
        ts: effectiveTs,
        source_type,
        source_event,
        target_matter,
        target_kind,
        actor,
        decision_required,
        display_headline,
        display_body,
        body: body_text,
        processed_at: processed_at ?? null,
        classified_noise,
        payload,
      });
    } catch (err) {
      const msg = (err as Error).message || "";
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
        throw new ConflictError(`signal row with id ${id} already exists`);
      }
      throw err;
    }
    sendJson(res, 201, { id: insertedId, ts: effectiveTs.toString() });
  });

  // GET /api/v1/signals — paginated list with filters.
  addRoute("GET", "/api/v1/signals", async ({ res, query }) => {
    const opts = parseListOpts(query);
    const db = openStateDb();
    const rows = listSignals(db, opts);
    const count = countSignals(db, opts);
    sendJson(res, 200, {
      results: rows.map(rowToWire),
      count,
    });
  });

  // GET /api/v1/signals/:id — fetch one row.
  addRoute("GET", "/api/v1/signals/:id", async ({ res, params }) => {
    const db = openStateDb();
    const row = getSignal(db, params.id);
    if (!row) throw new NotFoundError(`signal ${params.id} not found`);
    sendJson(res, 200, rowToWire(row));
  });

  // PATCH /api/v1/signals/:id — update mutable fields. Body keys:
  //   processed_at?: number | string | null    (ns; null clears)
  //   classified_noise?: boolean | 0 | 1
  addRoute("PATCH", "/api/v1/signals/:id", async ({ res, params, body }) => {
    const b = (body ?? {}) as {
      processed_at?: unknown;
      classified_noise?: unknown;
      payload?: unknown;
    };
    const update: Parameters<typeof updateSignal>[2] = {};
    if (b.processed_at !== undefined) {
      if (b.processed_at === null) {
        update.processed_at = null;
      } else {
        const ts = normaliseTs(b.processed_at, "processed_at");
        update.processed_at = ts ?? null;
      }
    }
    if (b.classified_noise !== undefined) {
      update.classified_noise = normaliseBoolInt(b.classified_noise, "classified_noise");
    }
    if (b.payload !== undefined) {
      // normalisePayload returns `undefined` only when the field was
      // omitted entirely; PATCH only enters this branch when the caller
      // supplied it explicitly, so we get back string | null.
      update.payload = normalisePayload(b.payload) ?? null;
    }
    if (Object.keys(update).length === 0) {
      throw new ValidationError("no updatable fields supplied");
    }

    const db = openStateDb();
    const ok = updateSignal(db, params.id, update);
    if (!ok) {
      // Either the row didn't exist or no fields were set; we filtered
      // the latter above, so this is a 404.
      const existing = getSignal(db, params.id);
      if (!existing) throw new NotFoundError(`signal ${params.id} not found`);
      // Defensive — updateSignal returning false for an existing row is
      // unexpected, but surface it rather than silently sending 200.
      throw new ValidationError("update produced no changes");
    }
    const row = getSignal(db, params.id);
    if (!row) throw new NotFoundError(`signal ${params.id} not found`);
    sendJson(res, 200, rowToWire(row));
  });
}
