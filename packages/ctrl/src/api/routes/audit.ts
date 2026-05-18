// audit.ts
//
// STORE-P2-1: HTTP surface for the unified `audit` table (migration 003).
//
// Endpoints:
//   POST   /api/v1/audit               — insert one audit row
//   GET    /api/v1/audit               — paginated list with filters
//   GET    /api/v1/audit/:id           — fetch one row
//   POST   /api/v1/audit/:id/reverse   — chain a reverse row + mark original
//
// Writers in alfred-learn (P2-2) and the SaaS read-side (P2-4) build on
// these endpoints. This route does not migrate existing markdown audit
// records — that's P2-3.

import { addRoute } from "../server.js";
import {
  sendJson,
  ValidationError,
  NotFoundError,
  ConflictError,
} from "../errors.js";
import { openStateDb } from "../../db/state.js";
import {
  insertAudit,
  getAudit,
  listAudit,
  countAudit,
  reverseAudit,
  type AuditRow,
  type ListAuditOpts,
} from "../../db/audit_queries.js";

// Audit rows carry a bigint `ts` (unix ns) that exceeds Number.MAX_SAFE_INTEGER
// on a few-decade horizon, so we serialise it as a string on the wire to keep
// JSON precision honest. Callers must parse it back with BigInt() if they
// need to do math.
interface AuditRowOut {
  id: string;
  ts: string;
  actor: string;
  action_type: string;
  target_type: string;
  target_id: string;
  decision_origin: string | null;
  reasoning: string | null;
  payload: string;
  reversible: number;
  reversed_by: string | null;
}

function rowToWire(row: AuditRow): AuditRowOut {
  return {
    id: row.id,
    ts: row.ts.toString(),
    actor: row.actor,
    action_type: row.action_type,
    target_type: row.target_type,
    target_id: row.target_id,
    decision_origin: row.decision_origin,
    reasoning: row.reasoning,
    payload: row.payload,
    reversible: row.reversible,
    reversed_by: row.reversed_by,
  };
}

interface InsertBody {
  id?: unknown;
  ts?: unknown;
  actor?: unknown;
  action_type?: unknown;
  target_type?: unknown;
  target_id?: unknown;
  decision_origin?: unknown;
  reasoning?: unknown;
  payload?: unknown;
  reversible?: unknown;
  reversed_by?: unknown;
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

// `payload` accepts either a stringified JSON or a plain object — both
// shapes show up in the wild (writers in TypeScript send objects; writers
// in Python send pre-serialised JSON). We normalise to a string for
// storage and validate that it is parseable JSON.
function normalisePayload(value: unknown): string {
  if (value === undefined || value === null) {
    throw new ValidationError("payload is required");
  }
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

function normaliseReversible(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value ? 1 : 0;
  throw new ValidationError("reversible must be a boolean or 0/1");
}

function normaliseTs(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      throw new ValidationError("ts must be an integer (ns)");
    }
  }
  throw new ValidationError("ts must be an integer or numeric string (ns)");
}

function parseListOpts(query: URLSearchParams): ListAuditOpts {
  const opts: ListAuditOpts = {};
  const actor = query.get("actor");
  if (actor) opts.actor = actor;
  const actionType = query.get("action_type");
  if (actionType) opts.action_type = actionType;
  const targetType = query.get("target_type");
  if (targetType) opts.target_type = targetType;
  const targetId = query.get("target_id");
  if (targetId) opts.target_id = targetId;

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

export function registerAuditRoutes(): void {
  // POST /api/v1/audit — insert a row.
  addRoute("POST", "/api/v1/audit", async ({ res, body }) => {
    const b = (body ?? {}) as InsertBody;

    const actor = requireString(b.actor, "actor");
    const action_type = requireString(b.action_type, "action_type");
    const target_type = requireString(b.target_type, "target_type");
    const target_id = requireString(b.target_id, "target_id");
    const decision_origin = optionalString(b.decision_origin, "decision_origin");
    const reasoning = optionalString(b.reasoning, "reasoning");
    const payload = normalisePayload(b.payload);
    const reversible = normaliseReversible(b.reversible);
    const reversed_by = optionalString(b.reversed_by, "reversed_by");
    const ts = normaliseTs(b.ts);
    const id =
      b.id === undefined || b.id === null
        ? undefined
        : requireString(b.id, "id");

    const db = openStateDb();
    const effectiveTs = ts ?? BigInt(Date.now()) * 1_000_000n;
    let insertedId: string;
    try {
      insertedId = insertAudit(db, {
        id,
        ts: effectiveTs,
        actor,
        action_type,
        target_type,
        target_id,
        decision_origin,
        reasoning,
        payload,
        reversible,
        reversed_by,
      });
    } catch (err) {
      const msg = (err as Error).message || "";
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
        throw new ConflictError(`audit row with id ${id} already exists`);
      }
      throw err;
    }
    sendJson(res, 201, { id: insertedId, ts: effectiveTs.toString() });
  });

  // GET /api/v1/audit — paginated list with filters.
  addRoute("GET", "/api/v1/audit", async ({ res, query }) => {
    const opts = parseListOpts(query);
    const db = openStateDb();
    const rows = listAudit(db, opts);
    const count = countAudit(db, opts);
    sendJson(res, 200, {
      results: rows.map(rowToWire),
      count,
    });
  });

  // GET /api/v1/audit/:id — fetch one row.
  addRoute("GET", "/api/v1/audit/:id", async ({ res, params }) => {
    const db = openStateDb();
    const row = getAudit(db, params.id);
    if (!row) throw new NotFoundError(`audit ${params.id} not found`);
    sendJson(res, 200, rowToWire(row));
  });

  // POST /api/v1/audit/:id/reverse — write a new "reverse" row, then
  // chain the original's `reversed_by` to the new id. The two writes
  // are wrapped in a transaction so a crash between leaves no dangling
  // pointer.
  addRoute("POST", "/api/v1/audit/:id/reverse", async ({ res, params, body }) => {
    const b = (body ?? {}) as { reason?: unknown };
    const reason = requireString(b.reason, "reason");
    const originalId = params.id;

    const db = openStateDb();
    const original = getAudit(db, originalId);
    if (!original) throw new NotFoundError(`audit ${originalId} not found`);
    if (original.reversible !== 1) {
      throw new ValidationError(`audit ${originalId} is not reversible`);
    }
    if (original.reversed_by) {
      throw new ValidationError(
        `audit ${originalId} has already been reversed by ${original.reversed_by}`,
      );
    }

    const reversePayload = JSON.stringify({
      original_id: originalId,
      original_action_type: original.action_type,
      reason,
    });
    const reverseTs = BigInt(Date.now()) * 1_000_000n;

    let newRow: AuditRow | null = null;
    db.exec("BEGIN");
    try {
      // Re-check inside the transaction to guard against concurrent
      // reversers — reverseAudit only flips the row if it is still
      // reversible AND reversed_by IS NULL.
      const newId = insertAudit(db, {
        ts: reverseTs,
        actor: original.actor,
        action_type: "reverse",
        target_type: original.target_type,
        target_id: original.target_id,
        decision_origin: original.decision_origin,
        reasoning: reason,
        payload: reversePayload,
        reversible: 0,
        reversed_by: null,
      });
      const ok = reverseAudit(db, originalId, newId);
      if (!ok) {
        throw new ConflictError(
          `audit ${originalId} was reversed concurrently`,
        );
      }
      newRow = getAudit(db, newId);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    }

    if (!newRow) {
      // Defensive — getAudit immediately after insertAudit should
      // always succeed.
      throw new Error("reverse row vanished after insert");
    }
    sendJson(res, 201, rowToWire(newRow));
  });
}
