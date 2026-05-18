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
import { readColdAudit } from "../../db/cold_reader.js";

// STORE-P5-2: hot-tier retention boundary. Rows older than this live
// ONLY in the Parquet archive at /vault/_archive (see
// packages/learn/src/activities/archive.py for the writer). Computed
// on every request so it tracks wall-clock without restart. Mirrors
// the env knob used by the writer so the two sides agree.
function coldBoundaryNs(): bigint {
  const days = parseInt(process.env.AUDIT_HOT_TTL_DAYS ?? "90", 10);
  const safeDays = Number.isFinite(days) && days > 0 ? days : 90;
  return (
    BigInt(Date.now()) * 1_000_000n -
    BigInt(safeDays * 86_400 * 1000) * 1_000_000n
  );
}

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
  //
  // STORE-P5-2: tier-spanning read. If the caller's `since` predates the
  // hot-tier boundary, also query the cold Parquet archive via DuckDB
  // and merge with the hot SQLite result. The HTTP contract stays
  // identical; an `X-Audit-Tiers` header reports which tiers were
  // consulted ("hot" | "cold" | "both").
  addRoute("GET", "/api/v1/audit", async ({ res, query }) => {
    const opts = parseListOpts(query);
    const db = openStateDb();

    const boundary = coldBoundaryNs();
    const needsCold = opts.since !== undefined && opts.since < boundary;
    // Pure-cold: the requested window ends BEFORE the hot boundary,
    // so there's nothing in the hot table that matches — skip the hot
    // SQL entirely. Saves a scan on a backlogged tenant.
    const pureCold =
      opts.until !== undefined && opts.until < boundary;

    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    // Both tiers ORDER BY ts DESC. Cold rows older than hot rows by
    // definition, so the merge is a simple [cold-after-hot] concat.
    // We oversample (offset + limit) from each tier so the post-merge
    // slice has enough rows even when offset > 0.
    const fetchCap = offset + limit;
    const hotOpts: ListAuditOpts = { ...opts, limit: fetchCap, offset: 0 };
    const hotRows: AuditRow[] = pureCold ? [] : listAudit(db, hotOpts);

    let coldRows: AuditRow[] = [];
    if (needsCold) {
      try {
        coldRows = await readColdAudit({
          since: opts.since,
          until: opts.until,
          actor: opts.actor,
          action_type: opts.action_type,
          target_type: opts.target_type,
          target_id: opts.target_id,
          limit: fetchCap,
        });
      } catch (err) {
        // readColdAudit catches its own errors and returns [], so this
        // should be unreachable — log and continue with just hot.
        console.error(
          `audit: cold-tier read failed: ${(err as Error).message}`,
        );
      }
    }

    // Merge + sort DESC + paginate. Both tiers are already sorted DESC,
    // but a simple full re-sort is O(n log n) on n ~= 2 * fetchCap which
    // stays small (default fetchCap is 50).
    const merged = [...hotRows, ...coldRows].sort((a, b) => {
      if (a.ts === b.ts) return 0;
      return a.ts > b.ts ? -1 : 1;
    });
    const page = merged.slice(offset, offset + limit);

    // Count is best-effort tier-aware:
    //   * hot-only:   exact SQL count
    //   * pure-cold:  cold rows we actually fetched (capped at fetchCap)
    //   * both:       hot SQL count + cold rows we actually fetched
    // The hot count is exact; the cold count is the materialised batch
    // size. Callers wanting an exact total over a >90d window can re-
    // query without limit (bounded by the duckdb scan timeout).
    let total: number;
    if (!needsCold) {
      total = countAudit(db, opts);
    } else if (pureCold) {
      total = coldRows.length;
    } else {
      total = countAudit(db, opts) + coldRows.length;
    }

    const tiers = pureCold
      ? "cold"
      : needsCold
        ? "both"
        : "hot";
    res.setHeader("X-Audit-Tiers", tiers);
    sendJson(res, 200, {
      results: page.map(rowToWire),
      count: total,
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
