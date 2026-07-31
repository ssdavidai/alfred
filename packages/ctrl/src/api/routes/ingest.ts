// ============================================================================
// ingest.db routes — Store 4 of the four-store architecture.
//
// Raw inbound stream events. A separate SQLite file from state.db so a
// firehose burst never takes the state.db write lock. Hard 7-day TTL,
// consume-then-delete, no archive.
//
// Endpoints (all under /api/v1/ingest):
//   POST  /events            append a raw stream event
//   GET   /events            list (filter: stream, pending, since, limit)
//   GET   /events/pending    oldest-first pending events (EventProcessor feed)
//   GET   /events/dead-letter    the poison queue (#311)
//   POST  /events/:id/processed   mark an event consumed
//   POST  /events/:id/failure     record a consumer failure (may dead-letter)
//   POST  /events/:id/requeue     put a dead-lettered event back on the feed
//   GET   /events/:id        one event
//   POST  /sweep             run the 7d TTL sweep now
//   GET   /sweep             last sweep results
// ============================================================================

import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { getIngestDb, sweepIngestTTL, INGEST_FAILURE_BUDGET } from "../../db/ingest.js";
import { ulid } from "../../db/ulid.js";

function asObj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("JSON object body required");
  }
  return body as Record<string, unknown>;
}

export function registerIngestRoutes(): void {
  const db = getIngestDb;

  // POST /api/v1/ingest/events — append a raw stream event.
  addRoute("POST", "/api/v1/ingest/events", async ({ res, body }) => {
    const b = asObj(body);
    const stream = b.stream;
    if (typeof stream !== "string" || !stream.trim()) {
      throw new ValidationError("stream (non-empty string) is required");
    }
    const payload = b.payload;
    if (payload === undefined || payload === null) {
      throw new ValidationError("payload is required");
    }
    const id = ulid();
    const ts = typeof b.ts === "string" && b.ts ? b.ts : new Date().toISOString();
    const externalId =
      typeof b.external_id === "string" && b.external_id ? b.external_id : null;
    try {
      db().prepare(
        `INSERT INTO stream_event
           (id, ts, stream, channel, external_id, kind, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        ts,
        stream.trim(),
        typeof b.channel === "string" ? b.channel : null,
        externalId,
        typeof b.kind === "string" && b.kind ? b.kind : "message",
        typeof payload === "string" ? payload : JSON.stringify(payload),
      );
    } catch (err) {
      // (stream, external_id) is a unique dedupe key — a re-delivered event
      // is idempotent success, not an error.
      if (String(err).includes("UNIQUE")) {
        const existing = db()
          .prepare(
            "SELECT id FROM stream_event WHERE stream = ? AND external_id = ?",
          )
          .get(stream.trim(), externalId) as { id: string } | undefined;
        sendJson(res, 200, { ok: true, id: existing?.id ?? id, duplicate: true });
        return;
      }
      throw err;
    }
    sendJson(res, 201, { ok: true, id });
  });

  // GET /api/v1/ingest/events — list events.
  addRoute("GET", "/api/v1/ingest/events", async ({ res, query }) => {
    const where: string[] = [];
    const args: unknown[] = [];
    const stream = query.get("stream");
    if (stream) { where.push("stream = ?"); args.push(stream); }
    if (query.get("pending") === "true") where.push("processed_at IS NULL");
    const since = query.get("since");
    if (since) { where.push("ts >= ?"); args.push(since); }
    const limit = Math.max(1, Math.min(500, parseInt(query.get("limit") ?? "100", 10) || 100));
    const rows = db()
      .prepare(
        `SELECT * FROM stream_event ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
          `ORDER BY ts DESC LIMIT ?`,
      )
      .all(...args, limit);
    sendJson(res, 200, { events: rows, count: rows.length });
  });

  // GET /api/v1/ingest/events/pending — oldest-first feed for the consumer.
  // Dead-lettered rows are excluded: leaving them in is what let three poison
  // events cycle ~20 times each and starve the queue (#311). Counts are
  // reported separately so queue health can converge while poison is parked.
  addRoute("GET", "/api/v1/ingest/events/pending", async ({ res, query }) => {
    const limit = Math.max(1, Math.min(500, parseInt(query.get("limit") ?? "100", 10) || 100));
    const rows = db()
      .prepare(
        "SELECT * FROM stream_event WHERE processed_at IS NULL " +
          "AND dead_lettered_at IS NULL ORDER BY ts ASC LIMIT ?",
      )
      .all(limit);
    const counts = db()
      .prepare(
        `SELECT
           SUM(CASE WHEN processed_at IS NULL AND dead_lettered_at IS NULL
                    THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN dead_lettered_at IS NOT NULL THEN 1 ELSE 0 END) AS dead_lettered
         FROM stream_event`,
      )
      .get() as { pending: number | null; dead_lettered: number | null } | undefined;
    sendJson(res, 200, {
      events: rows,
      count: rows.length,
      pending: Number(counts?.pending ?? 0),
      dead_lettered: Number(counts?.dead_lettered ?? 0),
    });
  });

  // GET /api/v1/ingest/events/dead-letter — the operator-visible poison queue.
  // MUST be registered before /events/:id or "dead-letter" is read as an id.
  addRoute("GET", "/api/v1/ingest/events/dead-letter", async ({ res, query }) => {
    const limit = Math.max(1, Math.min(500, parseInt(query.get("limit") ?? "100", 10) || 100));
    const rows = db()
      .prepare(
        `SELECT id, ts, stream, channel, external_id, kind,
                failure_count, last_error,
                dead_lettered_at, dead_letter_reason AS reason
           FROM stream_event
          WHERE dead_lettered_at IS NOT NULL
          ORDER BY dead_lettered_at DESC LIMIT ?`,
      )
      .all(limit);
    sendJson(res, 200, { events: rows, count: rows.length });
  });

  // POST /api/v1/ingest/events/:id/failure — a consumer reports one failure.
  // `non_retryable` (e.g. schema-invalid payload) dead-letters immediately;
  // `retryable` (e.g. an unknown source_type that a later deploy may learn to
  // handle) dead-letters once the fixed budget is exhausted.
  addRoute("POST", "/api/v1/ingest/events/:id/failure", async ({ res, params, body }) => {
    const b = asObj(body);
    const errorText = typeof b.error === "string" ? b.error.slice(0, 1000) : "";
    const nonRetryable = b.error_class === "non_retryable";
    const source = typeof b.source === "string" && b.source ? b.source.slice(0, 120) : "unknown";

    const row = db()
      .prepare("SELECT failure_count, dead_lettered_at FROM stream_event WHERE id = ?")
      .get(params.id) as
      | { failure_count: number | null; dead_lettered_at: string | null }
      | undefined;
    if (!row) throw new NotFoundError(`stream_event ${params.id} not found`);

    // Already terminal — reporting again is idempotent, not an escalation.
    if (row.dead_lettered_at) {
      sendJson(res, 200, {
        ok: true,
        id: params.id,
        failure_count: Number(row.failure_count ?? 0),
        dead_lettered: true,
      });
      return;
    }

    const failureCount = Number(row.failure_count ?? 0) + 1;
    const deadLetter = nonRetryable || failureCount >= INGEST_FAILURE_BUDGET;
    const reason = nonRetryable
      ? `non_retryable (${source}): ${errorText}`.slice(0, 500)
      : `retry_budget_exhausted after ${failureCount} attempts (${source}): ${errorText}`.slice(0, 500);

    db()
      .prepare(
        `UPDATE stream_event
            SET failure_count = ?, last_error = ?,
                dead_lettered_at = ?, dead_letter_reason = ?
          WHERE id = ?`,
      )
      .run(
        failureCount,
        `[${source}] ${errorText}`.slice(0, 1200),
        deadLetter ? new Date().toISOString() : null,
        deadLetter ? reason : null,
        params.id,
      );

    sendJson(res, 200, {
      ok: true,
      id: params.id,
      failure_count: failureCount,
      dead_lettered: deadLetter,
      budget: INGEST_FAILURE_BUDGET,
    });
  });

  // POST /api/v1/ingest/events/:id/requeue — operator puts a parked event back
  // on the feed (e.g. after the deploy that teaches the consumer its shape).
  // Idempotent: requeueing a live or already-requeued event is a 200 no-op.
  addRoute("POST", "/api/v1/ingest/events/:id/requeue", async ({ res, params }) => {
    const row = db()
      .prepare("SELECT dead_lettered_at FROM stream_event WHERE id = ?")
      .get(params.id) as { dead_lettered_at: string | null } | undefined;
    if (!row) throw new NotFoundError(`stream_event ${params.id} not found`);
    const wasDeadLettered = Boolean(row.dead_lettered_at);
    db()
      .prepare(
        `UPDATE stream_event
            SET dead_lettered_at = NULL, dead_letter_reason = NULL, failure_count = 0
          WHERE id = ?`,
      )
      .run(params.id);
    sendJson(res, 200, { ok: true, id: params.id, was_dead_lettered: wasDeadLettered });
  });

  // POST /api/v1/ingest/events/:id/processed — mark an event consumed.
  addRoute("POST", "/api/v1/ingest/events/:id/processed", async ({ res, params, body }) => {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const r = db()
      .prepare(
        "UPDATE stream_event SET processed_at = datetime('now'), processed_by = ? WHERE id = ?",
      )
      .run(typeof b.processed_by === "string" ? b.processed_by : "event_processor", params.id);
    if (r.changes === 0) throw new NotFoundError(`stream_event ${params.id} not found`);
    sendJson(res, 200, { ok: true, id: params.id });
  });

  // GET /api/v1/ingest/events/:id — one event.
  addRoute("GET", "/api/v1/ingest/events/:id", async ({ res, params }) => {
    const row = db().prepare("SELECT * FROM stream_event WHERE id = ?").get(params.id);
    if (!row) throw new NotFoundError(`stream_event ${params.id} not found`);
    sendJson(res, 200, row);
  });

  // POST /api/v1/ingest/sweep — run the 7d TTL sweep on demand.
  addRoute("POST", "/api/v1/ingest/sweep", async ({ res }) => {
    sendJson(res, 200, sweepIngestTTL());
  });

  // GET /api/v1/ingest/sweep — last sweep results.
  addRoute("GET", "/api/v1/ingest/sweep", async ({ res }) => {
    const rows = db()
      .prepare("SELECT * FROM ingest_sweep_log ORDER BY ran_at DESC LIMIT 20")
      .all();
    sendJson(res, 200, { sweeps: rows, count: rows.length });
  });
}
