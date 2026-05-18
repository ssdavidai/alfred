import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

import m001 from "./migrations/001_init.sql";
import m002 from "./migrations/002_vault_index.sql";
import m003 from "./migrations/003_audit.sql";

// Append new migrations here. Files are SQL text loaded by esbuild.
// Never reorder; never edit a migration after it has shipped.
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: "001_init", sql: m001 },
  { version: 2, name: "002_vault_index", sql: m002 },
  { version: 3, name: "003_audit", sql: m003 },
];

let stateDb: DatabaseSync | null = null;

export function openStateDb(dbPath?: string): DatabaseSync {
  if (stateDb) return stateDb;

  const resolved =
    dbPath ?? process.env.ALFRED_STATE_DB ?? "/var/lib/alfred/state.db";
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  stateDb = new DatabaseSync(resolved);
  stateDb.exec("PRAGMA journal_mode = WAL");
  stateDb.exec("PRAGMA synchronous = NORMAL");
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
