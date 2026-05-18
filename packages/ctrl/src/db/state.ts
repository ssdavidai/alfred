import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

import m001 from "./migrations/001_init.sql";
import m002 from "./migrations/002_vault_index.sql";
import m003 from "./migrations/003_audit.sql";
import m004 from "./migrations/004_signal_observation_embedding.sql";

// Append new migrations here. Files are SQL text loaded by esbuild.
// Never reorder; never edit a migration after it has shipped.
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: "001_init", sql: m001 },
  { version: 2, name: "002_vault_index", sql: m002 },
  { version: 3, name: "003_audit", sql: m003 },
  { version: 4, name: "004_signal_observation_embedding", sql: m004 },
];

let stateDb: DatabaseSync | null = null;

export function openStateDb(dbPath?: string): DatabaseSync {
  if (stateDb) return stateDb;

  const resolved =
    dbPath ?? process.env.ALFRED_STATE_DB ?? "/var/lib/alfred/state.db";
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  // STORE-P3-1: allowExtension is a constructor-time flag for node:sqlite
  // — without it, db.loadExtension() throws "extension loading is not
  // allowed". We unconditionally open with allowExtension:true so the
  // tenant runtime can load sqlite-vec for the Phase 3 embedding table;
  // see comment below about how the .so reaches the runtime.
  stateDb = new DatabaseSync(resolved, { allowExtension: true });
  stateDb.exec("PRAGMA journal_mode = WAL");
  stateDb.exec("PRAGMA synchronous = NORMAL");

  // STORE-P3-1: load sqlite-vec extension. The .so is bundled into the
  // alfred-init image at /usr/local/lib/sqlite-vec.so (pinned version,
  // see packages/openclaw/init/Dockerfile) and staged onto the shared
  // /mnt/encrypted/alfred volume by the init container's entrypoint.
  // ctrl-api sees that path as /mnt/encrypted/alfred/sqlite-vec.so via
  // its bind mount. Required for the Phase 3 `embedding` vec0 virtual
  // table that P3-2 introduces. On a laptop dev box the file usually
  // won't exist yet — tolerate that for now so existing CLI/TUI flows
  // (provision, list, health, migrate-status) keep working. Once P3-2
  // ships the embedding table, this should become a fatal error.
  // File is `vec.so` (not `sqlite-vec.so`) on purpose: node:sqlite
  // derives the init symbol from the filename, looking for
  // `sqlite3_<basename>_init`. sqlite-vec exports
  // `sqlite3_vec_init`, so the file must be named `vec.so`. P3-1
  // originally shipped it as sqlite-vec.so, which crashed ctrl-api
  // on every tenant (incident: revert fbcb553).
  const sqliteVecPath =
    process.env.SQLITE_VEC_PATH ?? "/mnt/encrypted/alfred/vec.so";
  try {
    stateDb.enableLoadExtension(true);
    // node:sqlite derives the init symbol from the filename
    // (sqlite-vec.so → sqlite3_sqlitevec_init) but sqlite-vec exports
    // sqlite3_vec_init. Pass the entry point explicitly so the
    // automatic derivation doesn't undefined-symbol on us. See
    // the P3-2 outage incident (revert fbcb553).
    stateDb.loadExtension(sqliteVecPath, "sqlite3_vec_init");
    // Re-disable after load: defence-in-depth against attacker-controlled
    // SQL trying to dlopen() arbitrary paths through the same connection.
    stateDb.enableLoadExtension(false);
  } catch (err) {
    console.warn(
      `sqlite-vec load failed (${sqliteVecPath}): ${(err as Error).message}`,
    );
  }

  return stateDb;
}

export function closeStateDb(): void {
  if (stateDb) {
    stateDb.close();
    stateDb = null;
  }
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
}

function appliedVersions(db: DatabaseSync): Set<number> {
  const rows = db
    .prepare("SELECT version FROM _migrations")
    .all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

export async function runMigrations(
  db: DatabaseSync,
): Promise<{ applied: number[]; skipped: number[] }> {
  ensureMigrationsTable(db);
  const already = appliedVersions(db);
  const applied: number[] = [];
  const skipped: number[] = [];

  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);

  for (const m of ordered) {
    if (already.has(m.version)) {
      skipped.push(m.version);
      continue;
    }
    try {
      db.exec("BEGIN");
      db.exec(m.sql);
      const stmt = db.prepare(
        "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
      );
      stmt.run(m.version, m.name, Date.now());
      db.exec("COMMIT");
      applied.push(m.version);
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw new Error(
        `migration ${m.version} (${m.name}) failed: ${(err as Error).message}`,
      );
    }
  }

  return { applied, skipped };
}

export function listMigrations(
  db: DatabaseSync,
): { version: number; name: string; applied_at: number }[] {
  ensureMigrationsTable(db);
  const rows = db
    .prepare(
      "SELECT version, name, applied_at FROM _migrations ORDER BY version ASC",
    )
    .all() as { version: number; name: string; applied_at: number }[];
  return rows;
}

export function knownMigrations(): { version: number; name: string }[] {
  return MIGRATIONS.map(({ version, name }) => ({ version, name }));
}
