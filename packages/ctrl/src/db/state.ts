// ============================================================================
// alfred-state.db — Store 2 open/init module.
//
// This is ctrl-api's own SQLite file (node:sqlite). ctrl-api is the SOLE
// process with a write handle (single-writer discipline, PLAN.md Part I).
//
// The file is named `alfred-state.db` (not `state.db`) to avoid a name
// collision with Hermes' own gateway-session store at $HERMES_HOME/state.db.
//
// Responsibilities:
//   * open alfred-state.db at STATE_DB_PATH, apply WAL + busy_timeout PRAGMAs,
//   * exec the CREATE-only schema (schema.sql),
//   * load the sqlite-vec loadable extension and create the `embedding`
//     vec0 virtual table once the extension is available,
//   * expose the singleton handle to the route layer.
// ============================================================================

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import schema from "./schema.sql";
import { runMigrations } from "./migrate.js";

const STATE_DB_PATH =
  process.env.STATE_DB_PATH ??
  path.join(process.cwd(), "data", "alfred-state.db");

// sqlite-vec loadable extension. The ctrl-api Dockerfile bakes it in and sets
// SQLITE_VEC_PATH. If absent (e.g. local dev without the extension), vector
// features degrade gracefully — embedding writes/queries 503 but everything
// else works.
const SQLITE_VEC_PATH = process.env.SQLITE_VEC_PATH ?? "";

// nomic-embed-text produces 768-dim vectors (alfred-learn surveyor / Ollama).
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? "768");

let _db: DatabaseSync | null = null;
let _vecLoaded = false;

/** Whether the sqlite-vec extension is loaded and the `embedding` table exists. */
export function vecAvailable(): boolean {
  return _vecLoaded;
}

/**
 * Open (or return the cached) alfred-state.db handle. Idempotent — safe to call from
 * every route module's top level.
 */
export function getStateDb(): DatabaseSync {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(STATE_DB_PATH), { recursive: true });

  const db = new DatabaseSync(STATE_DB_PATH, { allowExtension: true });

  // WAL: concurrent readers (alfred-learn, the vault daemon open read-only)
  // never block ctrl-api's single writer. busy_timeout absorbs the rare lock
  // contention window. foreign_keys for the routing_decision → signal FK.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(schema);

  // Apply numbered migrations. schema.sql is CREATE-only and cannot evolve
  // existing columns; runMigrations() carries every delta after the v0 baseline
  // (see db/migrate.ts). Idempotent, transactional, gated on user_version.
  runMigrations(db);

  // Load sqlite-vec and create the vec0 virtual table. A vec0 table cannot be
  // created by the plain schema.sql exec above — the extension must be loaded
  // first.
  if (SQLITE_VEC_PATH && fs.existsSync(SQLITE_VEC_PATH)) {
    try {
      db.enableLoadExtension(true);
      db.loadExtension(SQLITE_VEC_PATH);
      // Re-disable extension loading once vec0 is in — defence in depth so a
      // later `loadExtension` can't be reached through a SQL injection path.
      db.enableLoadExtension(false);
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS embedding USING vec0(embedding float[${EMBEDDING_DIM}])`,
      );
      _vecLoaded = true;
      console.log(
        `[alfred-state.db] sqlite-vec loaded; embedding[${EMBEDDING_DIM}] ready`,
      );
    } catch (err) {
      console.error(
        `[alfred-state.db] sqlite-vec load failed (vector search disabled): ${err}`,
      );
      _vecLoaded = false;
    }
  } else {
    console.warn(
      "[alfred-state.db] SQLITE_VEC_PATH not set or missing — vector search disabled",
    );
  }

  _db = db;
  return db;
}

export function closeStateDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _vecLoaded = false;
  }
}

export { STATE_DB_PATH };
