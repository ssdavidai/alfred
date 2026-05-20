// ============================================================================
// state.db CRUD/query routes — Store 2 of the four-store architecture.
//
// These endpoints are the write/read surface for the machine's working
// memory: signals, observations, routing decisions, the audit ledger, the
// link graph, and the sqlite-vec embedding store. ctrl-api is the SOLE writer
// to state.db — alfred-learn and the vault daemon reach it only through here.
//
// Endpoints (all under /api/v1/state):
//   POST   /signals                  create a signal
//   GET    /signals                  list (filter: status, kind, matter, since, limit)
//   GET    /signals/:id              one signal
//   PATCH  /signals/:id              partial update (status, salience, payload)
//   POST   /observations             create an observation
//   GET    /observations             list (filter: kind, subject, status, since, limit)
//   GET    /observations/:id         one observation
//   PATCH  /observations/:id         partial update
//   POST   /routing-decisions        create a routing decision
//   GET    /routing-decisions        list (filter: tier, signal_id, outcome, since, limit)
//   GET    /routing-decisions/:id    one routing decision
//   PATCH  /routing-decisions/:id    partial update (outcome, payload)
//   POST   /audit                    append an audit row
//   GET    /audit                    list (filter: action_type, actor, source, target, since)
//   GET    /audit/:id                one audit row
//   POST   /links                    create a graph edge
//   GET    /links                    list (filter: src, dst, rel, limit)
//   DELETE /links/:id                delete an edge
//   POST   /embeddings               upsert a vector
//   POST   /embeddings/search        k-NN search (caller supplies the vector)
//   POST   /embeddings/search-text   semantic search by TEXT — ctrl-api embeds
//                                    the query via Ollama, then runs k-NN.
//                                    Backs the vault semantic-search MCP tool.
//   DELETE /embeddings               delete vectors by ref
// ============================================================================

import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { getStateDb, vecAvailable, EMBEDDING_DIM } from "../../db/state.js";
import { ulid } from "../../db/ulid.js";
import { queryAuditCrossTier, getAuditCrossTier } from "../../db/coldRead.js";
import { runCompaction } from "../../db/compactor.js";
import { COLD_TTL_DAYS, COLD_CODEC, getColdDb } from "../../db/cold.js";

function nowIso(): string {
  return new Date().toISOString();
}

// ----------------------------------------------------------------------------
// Query-text embedding — used by POST /embeddings/search-text.
//
// The `embedding` vec0 table stores 768-d nomic-embed-text vectors written by
// the alfred-learn surveyor. To search by natural-language text the query
// must be embedded with the SAME model, so ctrl-api calls the shared Ollama
// sidecar (the surveyor uses the same service — see config.yaml.tpl).
// ----------------------------------------------------------------------------
const OLLAMA_URL = (process.env.OLLAMA_BASE_URL ?? "http://ollama:11434").replace(/\/$/, "");
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";

async function embedQuery(text: string): Promise<number[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error(`Ollama embeddings ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = (await resp.json()) as { embedding?: unknown };
  const vec = data.embedding;
  if (!Array.isArray(vec) || !vec.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("Ollama returned no usable embedding vector");
  }
  return vec as number[];
}

function asObj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("JSON object body required");
  }
  return body as Record<string, unknown>;
}

function reqStr(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new ValidationError(`${key} (non-empty string) is required`);
  }
  return v.trim();
}

function optStr(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function optNum(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function optJson(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function clampLimit(q: URLSearchParams, def = 100, max = 500): number {
  return Math.max(1, Math.min(max, parseInt(q.get("limit") ?? String(def), 10) || def));
}

export function registerStateRoutes(): void {
  // state.db is opened lazily on first request — NOT at registration time —
  // so route registration stays side-effect-free (tests register routes
  // without a real DB / under a mocked fs). `db` is a getter, not a handle.
  const db = getStateDb;

  // ─────────────────────────────────────────────────────────────
  // signal
  // ─────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/state/signals", async ({ res, body }) => {
    const b = asObj(body);
    const id = ulid();
    const ts = optStr(b, "ts") ?? nowIso();
    db().prepare(
      `INSERT INTO signal
         (id, ts, kind, source, stream_event_id, entity_ref, matter_ref,
          headline, body, salience, status, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      ts,
      reqStr(b, "kind"),
      reqStr(b, "source"),
      optStr(b, "stream_event_id"),
      optStr(b, "entity_ref"),
      optStr(b, "matter_ref"),
      reqStr(b, "headline"),
      optStr(b, "body"),
      optNum(b, "salience") ?? 0.5,
      // C2: absent status defaults to 'unrouted' — SignalRouterWorkflow only
      // routes status='unrouted', so an 'open' default was never surfaced.
      optStr(b, "status") ?? "unrouted",
      optJson(b, "payload"),
    );
    sendJson(res, 201, { ok: true, id });
  });

  addRoute("GET", "/api/v1/state/signals", async ({ res, query }) => {
    const where: string[] = [];
    const args: unknown[] = [];
    for (const [col, key] of [
      ["status", "status"],
      ["kind", "kind"],
      ["matter_ref", "matter"],
      ["source", "source"],
    ] as const) {
      const v = query.get(key);
      if (v) {
        where.push(`${col} = ?`);
        args.push(v);
      }
    }
    const since = query.get("since");
    if (since) {
      where.push("ts >= ?");
      args.push(since);
    }
    const limit = clampLimit(query);
    const sql =
      `SELECT * FROM signal ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
      `ORDER BY ts DESC LIMIT ?`;
    const rows = db().prepare(sql).all(...args, limit);
    sendJson(res, 200, { signals: rows, count: rows.length });
  });

  addRoute("GET", "/api/v1/state/signals/:id", async ({ res, params }) => {
    const row = db().prepare("SELECT * FROM signal WHERE id = ?").get(params.id);
    if (!row) throw new NotFoundError(`signal ${params.id} not found`);
    sendJson(res, 200, row);
  });

  addRoute("PATCH", "/api/v1/state/signals/:id", async ({ res, params, body }) => {
    const b = asObj(body);
    const existing = db().prepare("SELECT id FROM signal WHERE id = ?").get(params.id);
    if (!existing) throw new NotFoundError(`signal ${params.id} not found`);
    const sets: string[] = [];
    const args: unknown[] = [];
    if ("status" in b) { sets.push("status = ?"); args.push(reqStr(b, "status")); }
    if ("salience" in b) { sets.push("salience = ?"); args.push(optNum(b, "salience") ?? 0.5); }
    if ("headline" in b) { sets.push("headline = ?"); args.push(reqStr(b, "headline")); }
    if ("body" in b) { sets.push("body = ?"); args.push(optStr(b, "body")); }
    if ("payload" in b) { sets.push("payload_json = ?"); args.push(optJson(b, "payload")); }
    if (!sets.length) throw new ValidationError("no updatable fields supplied");
    sets.push("updated_at = datetime('now')");
    db().prepare(`UPDATE signal SET ${sets.join(", ")} WHERE id = ?`).run(...args, params.id);
    sendJson(res, 200, { ok: true, id: params.id });
  });

  // ─────────────────────────────────────────────────────────────
  // observation
  // ─────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/state/observations", async ({ res, body }) => {
    const b = asObj(body);
    const id = ulid();
    db().prepare(
      `INSERT INTO observation
         (id, ts, subject, kind, decision_ref, instinct_ref, summary, detail,
          confidence, status, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      optStr(b, "ts") ?? nowIso(),
      reqStr(b, "subject"),
      reqStr(b, "kind"),
      optStr(b, "decision_ref"),
      optStr(b, "instinct_ref"),
      reqStr(b, "summary"),
      optStr(b, "detail"),
      optNum(b, "confidence") ?? 0.5,
      optStr(b, "status") ?? "open",
      optJson(b, "payload"),
    );
    sendJson(res, 201, { ok: true, id });
  });

  addRoute("GET", "/api/v1/state/observations", async ({ res, query }) => {
    const where: string[] = [];
    const args: unknown[] = [];
    for (const [col, key] of [
      ["kind", "kind"],
      ["subject", "subject"],
      ["status", "status"],
    ] as const) {
      const v = query.get(key);
      if (v) { where.push(`${col} = ?`); args.push(v); }
    }
    const since = query.get("since");
    if (since) { where.push("ts >= ?"); args.push(since); }
    const limit = clampLimit(query);
    const rows = db()
      .prepare(
        `SELECT * FROM observation ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
          `ORDER BY ts DESC LIMIT ?`,
      )
      .all(...args, limit);
    sendJson(res, 200, { observations: rows, count: rows.length });
  });

  addRoute("GET", "/api/v1/state/observations/:id", async ({ res, params }) => {
    const row = db().prepare("SELECT * FROM observation WHERE id = ?").get(params.id);
    if (!row) throw new NotFoundError(`observation ${params.id} not found`);
    sendJson(res, 200, row);
  });

  addRoute("PATCH", "/api/v1/state/observations/:id", async ({ res, params, body }) => {
    const b = asObj(body);
    if (!db().prepare("SELECT id FROM observation WHERE id = ?").get(params.id)) {
      throw new NotFoundError(`observation ${params.id} not found`);
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if ("status" in b) { sets.push("status = ?"); args.push(reqStr(b, "status")); }
    if ("confidence" in b) { sets.push("confidence = ?"); args.push(optNum(b, "confidence") ?? 0.5); }
    if ("summary" in b) { sets.push("summary = ?"); args.push(reqStr(b, "summary")); }
    if ("detail" in b) { sets.push("detail = ?"); args.push(optStr(b, "detail")); }
    if ("payload" in b) { sets.push("payload_json = ?"); args.push(optJson(b, "payload")); }
    if (!sets.length) throw new ValidationError("no updatable fields supplied");
    sets.push("updated_at = datetime('now')");
    db().prepare(`UPDATE observation SET ${sets.join(", ")} WHERE id = ?`).run(...args, params.id);
    sendJson(res, 200, { ok: true, id: params.id });
  });

  // ─────────────────────────────────────────────────────────────
  // routing_decision
  // ─────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/state/routing-decisions", async ({ res, body }) => {
    const b = asObj(body);
    const id = ulid();
    db().prepare(
      `INSERT INTO routing_decision
         (id, ts, signal_id, tier, chosen_path, agent, instinct_ref,
          discretion, reason, outcome, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      optStr(b, "ts") ?? nowIso(),
      optStr(b, "signal_id"),
      reqStr(b, "tier"),
      reqStr(b, "chosen_path"),
      optStr(b, "agent"),
      optStr(b, "instinct_ref"),
      optNum(b, "discretion"),
      optStr(b, "reason"),
      optStr(b, "outcome") ?? "pending",
      optJson(b, "payload"),
    );
    sendJson(res, 201, { ok: true, id });
  });

  addRoute("GET", "/api/v1/state/routing-decisions", async ({ res, query }) => {
    const where: string[] = [];
    const args: unknown[] = [];
    for (const [col, key] of [
      ["tier", "tier"],
      ["signal_id", "signal_id"],
      ["outcome", "outcome"],
      ["chosen_path", "chosen_path"],
    ] as const) {
      const v = query.get(key);
      if (v) { where.push(`${col} = ?`); args.push(v); }
    }
    const since = query.get("since");
    if (since) { where.push("ts >= ?"); args.push(since); }
    const limit = clampLimit(query);
    const rows = db()
      .prepare(
        `SELECT * FROM routing_decision ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
          `ORDER BY ts DESC LIMIT ?`,
      )
      .all(...args, limit);
    sendJson(res, 200, { routing_decisions: rows, count: rows.length });
  });

  addRoute("GET", "/api/v1/state/routing-decisions/:id", async ({ res, params }) => {
    const row = db().prepare("SELECT * FROM routing_decision WHERE id = ?").get(params.id);
    if (!row) throw new NotFoundError(`routing_decision ${params.id} not found`);
    sendJson(res, 200, row);
  });

  addRoute("PATCH", "/api/v1/state/routing-decisions/:id", async ({ res, params, body }) => {
    const b = asObj(body);
    if (!db().prepare("SELECT id FROM routing_decision WHERE id = ?").get(params.id)) {
      throw new NotFoundError(`routing_decision ${params.id} not found`);
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if ("outcome" in b) { sets.push("outcome = ?"); args.push(reqStr(b, "outcome")); }
    if ("reason" in b) { sets.push("reason = ?"); args.push(optStr(b, "reason")); }
    if ("payload" in b) { sets.push("payload_json = ?"); args.push(optJson(b, "payload")); }
    if (!sets.length) throw new ValidationError("no updatable fields supplied");
    sets.push("updated_at = datetime('now')");
    db().prepare(`UPDATE routing_decision SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args, params.id);
    sendJson(res, 200, { ok: true, id: params.id });
  });

  // ─────────────────────────────────────────────────────────────
  // audit
  // ─────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/state/audit", async ({ res, body }) => {
    const b = asObj(body);
    // strict:true — the audit row is the primary write here, so a failed
    // insert must 5xx (not return a false 201). See appendAudit.
    const id = appendAudit(
      {
        ts: optStr(b, "ts") ?? nowIso(),
        action_type: reqStr(b, "action_type"),
        actor: reqStr(b, "actor"),
        source: optStr(b, "source"),
        target_path: optStr(b, "target_path"),
        target_kind: optStr(b, "target_kind"),
        subject_ref: optStr(b, "subject_ref"),
        summary: reqStr(b, "summary"),
        changes: b.changes ?? null,
        mode: optStr(b, "mode") ?? "live",
        confidence: optNum(b, "confidence"),
        undo: b.undo ?? null,
        payload: b.payload ?? null,
      },
      { strict: true },
    );
    sendJson(res, 201, { ok: true, id });
  });

  // GET /audit — cross-tier (hot state.db + cold archive). The forensic long
  // tail lives in cold.db once the compactor rolls rows past their TTL; this
  // query merges both tiers when the window (`since`) reaches past the cutoff,
  // and stays hot-only for the common recent-window case (PLAN.md Part I,
  // Store 3). `tiers` in the response shows which tiers actually contributed.
  addRoute("GET", "/api/v1/state/audit", async ({ res, query }) => {
    const limit = clampLimit(query);
    const offset = Math.max(0, parseInt(query.get("offset") ?? "0", 10) || 0);
    const result = queryAuditCrossTier({
      action_type: query.get("action_type"),
      actor: query.get("actor"),
      source: query.get("source"),
      target_path: query.get("target"),
      subject_ref: query.get("subject"),
      mode: query.get("mode"),
      since: query.get("since"),
      until: query.get("until"),
      limit,
      offset,
    });
    sendJson(res, 200, {
      entries: result.entries,
      total: result.total,
      limit,
      offset,
      tiers: result.tiers,
      hot_total: result.hot_total,
      cold_total: result.cold_total,
    });
  });

  // GET /audit/:id — hot tier first, then the cold archive.
  addRoute("GET", "/api/v1/state/audit/:id", async ({ res, params }) => {
    const row = getAuditCrossTier(params.id);
    if (!row) throw new NotFoundError(`audit ${params.id} not found`);
    sendJson(res, 200, row);
  });

  // ─────────────────────────────────────────────────────────────
  // Store 3 — cold archive ops.
  //
  //   POST /api/v1/state/cold/compact   run the TTL compactor now (the
  //                                     boot-scheduled daily job calls the
  //                                     same runCompaction()).
  //   GET  /api/v1/state/cold/status    archive row counts + last compactions.
  // ─────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/state/cold/compact", async ({ res }) => {
    const result = runCompaction();
    sendJson(res, 200, { ok: true, ...result });
  });

  addRoute("GET", "/api/v1/state/cold/status", async ({ res }) => {
    const cold = getColdDb();
    const archiveTables = [
      "archive_signal",
      "archive_observation",
      "archive_routing_decision",
      "archive_audit",
      "archive_link",
    ];
    const counts: Record<string, number> = {};
    for (const t of archiveTables) {
      counts[t] = (
        cold.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }
      ).n;
    }
    const recent = cold
      .prepare(
        `SELECT ran_at, table_name, cutoff_ts, rows_moved, bytes_cold,
                duration_ms, ok, note
           FROM cold_compact_log ORDER BY ran_at DESC LIMIT 25`,
      )
      .all();
    sendJson(res, 200, {
      codec: COLD_CODEC,
      ttl_days: COLD_TTL_DAYS,
      archive_counts: counts,
      recent_compactions: recent,
    });
  });

  // ─────────────────────────────────────────────────────────────
  // link — the cross-record graph edge
  // ─────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/state/links", async ({ res, body }) => {
    const b = asObj(body);
    const id = ulid();
    try {
      db().prepare(
        `INSERT INTO link (id, ts, src_ref, dst_ref, rel, weight, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        optStr(b, "ts") ?? nowIso(),
        reqStr(b, "src_ref"),
        reqStr(b, "dst_ref"),
        reqStr(b, "rel"),
        optNum(b, "weight") ?? 1.0,
        optJson(b, "payload"),
      );
    } catch (err) {
      // Unique (src,dst,rel) — treat a duplicate edge as idempotent success.
      if (String(err).includes("UNIQUE")) {
        const existing = db()
          .prepare("SELECT id FROM link WHERE src_ref = ? AND dst_ref = ? AND rel = ?")
          .get(reqStr(b, "src_ref"), reqStr(b, "dst_ref"), reqStr(b, "rel")) as
          | { id: string }
          | undefined;
        sendJson(res, 200, { ok: true, id: existing?.id ?? id, duplicate: true });
        return;
      }
      throw err;
    }
    sendJson(res, 201, { ok: true, id });
  });

  addRoute("GET", "/api/v1/state/links", async ({ res, query }) => {
    const where: string[] = [];
    const args: unknown[] = [];
    const src = query.get("src");
    const dst = query.get("dst");
    const rel = query.get("rel");
    if (src) { where.push("src_ref = ?"); args.push(src); }
    if (dst) { where.push("dst_ref = ?"); args.push(dst); }
    if (rel) { where.push("rel = ?"); args.push(rel); }
    // `ref` matches either endpoint — for "all edges touching X" graph queries.
    const ref = query.get("ref");
    if (ref) { where.push("(src_ref = ? OR dst_ref = ?)"); args.push(ref, ref); }
    const limit = clampLimit(query);
    const rows = db()
      .prepare(
        `SELECT * FROM link ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
          `ORDER BY ts DESC LIMIT ?`,
      )
      .all(...args, limit);
    sendJson(res, 200, { links: rows, count: rows.length });
  });

  addRoute("DELETE", "/api/v1/state/links/:id", async ({ res, params }) => {
    const r = db().prepare("DELETE FROM link WHERE id = ?").run(params.id);
    if (r.changes === 0) throw new NotFoundError(`link ${params.id} not found`);
    sendJson(res, 200, { ok: true, id: params.id });
  });

  // ─────────────────────────────────────────────────────────────
  // embedding — sqlite-vec vector store
  // ─────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/state/embeddings", async ({ res, body }) => {
    if (!vecAvailable()) {
      sendJson(res, 503, {
        error: { code: "VEC_UNAVAILABLE", message: "sqlite-vec extension not loaded" },
      });
      return;
    }
    const b = asObj(body);
    const ref = reqStr(b, "ref");
    const refKind = optStr(b, "ref_kind") ?? "vault";
    const vector = b.embedding;
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM) {
      throw new ValidationError(`embedding must be a float array of length ${EMBEDDING_DIM}`);
    }
    const chunkIndex = optNum(b, "chunk_index") ?? 0;
    // Re-embed: drop any prior vector for this (ref, chunk).
    const prior = db()
      .prepare("SELECT rowid FROM embedding_meta WHERE ref = ? AND chunk_index = ?")
      .get(ref, chunkIndex) as { rowid: number } | undefined;
    if (prior) {
      db().prepare("DELETE FROM embedding WHERE rowid = ?").run(prior.rowid);
      db().prepare("DELETE FROM embedding_meta WHERE rowid = ?").run(prior.rowid);
    }
    const metaResult = db()
      .prepare(
        `INSERT INTO embedding_meta (ref, ref_kind, ts, model, chunk_index, text_preview)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ref,
        refKind,
        optStr(b, "ts") ?? nowIso(),
        optStr(b, "model") ?? "nomic-embed-text",
        chunkIndex,
        optStr(b, "text_preview"),
      );
    const rowid = Number(metaResult.lastInsertRowid);
    db().prepare("INSERT INTO embedding (rowid, embedding) VALUES (?, ?)").run(
      rowid,
      JSON.stringify(vector),
    );
    sendJson(res, 201, { ok: true, rowid, ref });
  });

  addRoute("POST", "/api/v1/state/embeddings/search", async ({ res, body }) => {
    if (!vecAvailable()) {
      sendJson(res, 503, {
        error: { code: "VEC_UNAVAILABLE", message: "sqlite-vec extension not loaded" },
      });
      return;
    }
    const b = asObj(body);
    const vector = b.embedding;
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM) {
      throw new ValidationError(`embedding must be a float array of length ${EMBEDDING_DIM}`);
    }
    const k = Math.max(1, Math.min(50, optNum(b, "k") ?? 10));
    const refKind = optStr(b, "ref_kind");
    // vec0 k-NN: order by distance, join the meta table for human columns.
    const rows = db()
      .prepare(
        `SELECT m.rowid, m.ref, m.ref_kind, m.ts, m.model, m.chunk_index,
                m.text_preview, e.distance
           FROM embedding e
           JOIN embedding_meta m ON m.rowid = e.rowid
          WHERE e.embedding MATCH ? AND k = ?
          ${refKind ? "AND m.ref_kind = ?" : ""}
          ORDER BY e.distance`,
      )
      .all(...(refKind ? [JSON.stringify(vector), k, refKind] : [JSON.stringify(vector), k]));
    sendJson(res, 200, { results: rows, count: rows.length });
  });

  // POST /api/v1/state/embeddings/search-text — semantic search by TEXT.
  //
  // ctrl-api embeds the query string via the Ollama sidecar (same model the
  // surveyor used to write the vectors), then runs the vec0 k-NN. This is the
  // endpoint the vault semantic-search MCP tool calls — it lets Alfred search
  // the vault by meaning without having to compute an embedding itself.
  addRoute("POST", "/api/v1/state/embeddings/search-text", async ({ res, body }) => {
    if (!vecAvailable()) {
      sendJson(res, 503, {
        error: { code: "VEC_UNAVAILABLE", message: "sqlite-vec extension not loaded" },
      });
      return;
    }
    const b = asObj(body);
    const q = reqStr(b, "query");
    const k = Math.max(1, Math.min(50, optNum(b, "k") ?? 10));
    const refKind = optStr(b, "ref_kind");

    let vector: number[];
    try {
      vector = await embedQuery(q);
    } catch (err) {
      sendJson(res, 502, {
        error: {
          code: "EMBED_FAILED",
          message: `query embedding failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return;
    }
    if (vector.length !== EMBEDDING_DIM) {
      sendJson(res, 502, {
        error: {
          code: "EMBED_DIM_MISMATCH",
          message: `embedding model returned ${vector.length} dims, expected ${EMBEDDING_DIM}`,
        },
      });
      return;
    }

    const rows = db()
      .prepare(
        `SELECT m.rowid, m.ref, m.ref_kind, m.ts, m.model, m.chunk_index,
                m.text_preview, e.distance
           FROM embedding e
           JOIN embedding_meta m ON m.rowid = e.rowid
          WHERE e.embedding MATCH ? AND k = ?
          ${refKind ? "AND m.ref_kind = ?" : ""}
          ORDER BY e.distance`,
      )
      .all(...(refKind ? [JSON.stringify(vector), k, refKind] : [JSON.stringify(vector), k]));
    sendJson(res, 200, { query: q, results: rows, count: rows.length });
  });

  addRoute("DELETE", "/api/v1/state/embeddings", async ({ res, query }) => {
    if (!vecAvailable()) {
      sendJson(res, 503, {
        error: { code: "VEC_UNAVAILABLE", message: "sqlite-vec extension not loaded" },
      });
      return;
    }
    const ref = query.get("ref");
    if (!ref) throw new ValidationError("ref query param is required");
    const metas = db()
      .prepare("SELECT rowid FROM embedding_meta WHERE ref = ?")
      .all(ref) as Array<{ rowid: number }>;
    for (const m of metas) {
      db().prepare("DELETE FROM embedding WHERE rowid = ?").run(m.rowid);
    }
    db().prepare("DELETE FROM embedding_meta WHERE ref = ?").run(ref);
    sendJson(res, 200, { ok: true, ref, deleted: metas.length });
  });
}

// ----------------------------------------------------------------------------
// appendAudit — shared helper.
//
// Exported so the markdown-writing routes (decisions, state-changes,
// needs-attention) can mirror every action they take into the `audit` table.
// That makes the audit ledger the single source of truth the /decisions,
// /state-changes, /attention list routes can be re-backed onto.
// ----------------------------------------------------------------------------
export interface AuditInput {
  ts?: string;
  action_type: string;
  actor: string;
  source?: string | null;
  target_path?: string | null;
  target_kind?: string | null;
  subject_ref?: string | null;
  summary: string;
  changes?: unknown;
  mode?: string;
  confidence?: number | null;
  undo?: unknown;
  payload?: unknown;
}

/**
 * Append an audit row.
 *
 * Default (no opts) is **best-effort**: an insert failure is logged and
 * swallowed, returning the would-be id, so a vault write is never broken by a
 * failed audit mirror (decisions.ts / attention.ts / stateChanges.ts).
 *
 * `{ strict: true }` is for callers where the audit row IS the primary write
 * (the POST /api/v1/state/audit route): a failed insert RETHROWS so the request
 * surfaces a 5xx instead of a false 201 {ok,id}.
 */
export function appendAudit(
  input: AuditInput,
  opts?: { strict?: boolean },
): string {
  const id = ulid();
  const toJson = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch {
      return null;
    }
  };
  try {
    getStateDb()
      .prepare(
        `INSERT INTO audit
           (id, ts, action_type, actor, source, target_path, target_kind,
            subject_ref, summary, changes_json, mode, confidence, undo_json,
            payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.ts ?? new Date().toISOString(),
        input.action_type,
        input.actor,
        input.source ?? null,
        input.target_path ?? null,
        input.target_kind ?? null,
        input.subject_ref ?? null,
        input.summary,
        toJson(input.changes),
        input.mode ?? "live",
        input.confidence ?? null,
        toJson(input.undo),
        toJson(input.payload),
      );
  } catch (err) {
    // Logged so the gap is always visible.
    console.error(`[audit] appendAudit failed: ${err}`);
    // Strict callers (the primary-write POST /audit route) must NOT report a
    // false success — rethrow so the request 5xx's. Best-effort callers (vault
    // write mirrors) swallow and return the id.
    if (opts?.strict) throw err;
  }
  return id;
}
