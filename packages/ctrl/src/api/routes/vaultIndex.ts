// ============================================================================
// vault_index query routes — the SQL-backed read index over Store 1.
//
// These let the dashboard and MCP tools list/filter vault records without a
// markdown directory walk. ctrl-api keeps vault_index exact by updating it on
// every vault write (see src/db/vaultIndex.ts), plus a boot-time reconciler.
//
// Endpoints (all under /api/v1/vault-index):
//   GET   /                  list (filter: type, status, since, limit, offset)
//   GET   /:path*            one record's index row
//   POST  /reconcile         force a full reconcile walk
// ============================================================================

import { addRoute } from "../server.js";
import { sendJson, NotFoundError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { reconcileVaultIndex } from "../../db/vaultIndex.js";

export function registerVaultIndexRoutes(): void {
  const db = getStateDb;

  // GET /api/v1/vault-index — list canonical vault records from the index.
  addRoute("GET", "/api/v1/vault-index", async ({ res, query }) => {
    const where: string[] = [];
    const args: unknown[] = [];
    const type = query.get("type");
    if (type) { where.push("record_type = ?"); args.push(type); }
    const status = query.get("status");
    if (status) { where.push("status = ?"); args.push(status); }
    const since = query.get("since");
    if (since) { where.push("mtime >= ?"); args.push(since); }
    const limit = Math.max(1, Math.min(1000, parseInt(query.get("limit") ?? "200", 10) || 200));
    const offset = Math.max(0, parseInt(query.get("offset") ?? "0", 10) || 0);
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = (
      db().prepare(`SELECT COUNT(*) AS n FROM vault_index ${whereSql}`).get(...args) as {
        n: number;
      }
    ).n;
    const rows = db()
      .prepare(
        `SELECT path, record_type, title, status, as_of, body_preview,
                size_bytes, mtime, indexed_at
           FROM vault_index ${whereSql}
          ORDER BY mtime DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
    sendJson(res, 200, { records: rows, total, limit, offset });
  });

  // GET /api/v1/vault-index/type-counts — record count per canonical type.
  addRoute("GET", "/api/v1/vault-index/type-counts", async ({ res }) => {
    const rows = db()
      .prepare(
        "SELECT record_type, COUNT(*) AS count FROM vault_index GROUP BY record_type",
      )
      .all();
    sendJson(res, 200, { counts: rows });
  });

  // POST /api/v1/vault-index/reconcile — force a full reconcile walk.
  addRoute("POST", "/api/v1/vault-index/reconcile", async ({ res }) => {
    sendJson(res, 200, reconcileVaultIndex());
  });

  // GET /api/v1/vault-index/* — one record's index row by vault path.
  addRoute("GET", "/api/v1/vault-index/*", async ({ res, params }) => {
    const p = (params.path ?? "").replace(/\\/g, "/");
    const row = db().prepare("SELECT * FROM vault_index WHERE path = ?").get(p);
    if (!row) throw new NotFoundError(`vault_index has no row for ${p}`);
    sendJson(res, 200, row);
  });
}
