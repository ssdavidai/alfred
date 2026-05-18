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
//   POST  /events/:id/processed   mark an event consumed
//   GET   /events/:id        one event
//   POST  /sweep             run the 7d TTL sweep now
//   GET   /sweep             last sweep results
// ============================================================================

import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { getIngestDb, sweepIngestTTL } from "../../db/ingest.js";
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
  addRoute("GET", "/api/v1/ingest/events/pending", async ({ res, query }) => {
    const limit = Math.max(1, Math.min(500, parseInt(query.get("limit") ?? "100", 10) || 100));
    const rows = db()
      .prepare(
        "SELECT * FROM stream_event WHERE processed_at IS NULL ORDER BY ts ASC LIMIT ?",
      )
      .all(limit);
    sendJson(res, 200, { events: rows, count: rows.length });
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
