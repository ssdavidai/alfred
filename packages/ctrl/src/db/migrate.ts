// state.db migration runner.
//
// The repo shipped with NO migration mechanism: db/schema.sql is
// CREATE-IF-NOT-EXISTS only, so editing it to add/rename a column is a silent
// no-op on any existing DB (FAILURE-MODES Part 3, finding #2). This runner is
// the fix: numbered, ordered, idempotent SQL deltas gated on PRAGMA
// user_version, applied transactionally at boot from getStateDb().
//
// Rules (mirrors the state.db migration discipline in CLAUDE.md):
//   * schema.sql stays the v0 baseline; every column/table change after it is a
//     numbered migration here.
//   * never edit a migration after it has merged — append the next number.
//   * each migration's SQL is imported as a text string (esbuild `text` loader
//     in build.mjs; tests/text-loader.mjs for the test runner) so it travels in
//     the single-file bundle with no filesystem read at runtime.
import type { DatabaseSync } from "node:sqlite";
import m0001 from "./migrations/0001_fix_pack.sql";
import m0002 from "./migrations/0002_alfred_journal.sql";
import m0003 from "./migrations/0003_tailscale_connection.sql";
<<<<<<< HEAD
import m0004 from "./migrations/0004_channel_tokens.sql";
=======
import m0005 from "./migrations/0005_ha_channel.sql";
>>>>>>> a72f573e (feat(ctrl,db): 0003_ha_channel migration — 7 ha_* tables + loop-guard index (#110 PR1))
import m0006 from "./migrations/0006_files_table.sql";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Ordered, append-only. Each version is applied exactly once, in order.
const MIGRATIONS: Migration[] = [
  { version: 1, name: "fix_pack",             sql: m0001 },
  { version: 2, name: "alfred_journal",       sql: m0002 },
  { version: 3, name: "tailscale_connection", sql: m0003 },
<<<<<<< HEAD
  { version: 4, name: "channel_tokens",       sql: m0004 },
=======
  { version: 5, name: "ha_channel",           sql: m0005 },
>>>>>>> a72f573e (feat(ctrl,db): 0003_ha_channel migration — 7 ha_* tables + loop-guard index (#110 PR1))
  { version: 6, name: "files_table",          sql: m0006 },
];

/**
 * Apply every migration whose version is greater than the DB's current
 * `user_version`, each in its own transaction. Idempotent: re-running applies
 * nothing once the DB is at the latest version. Returns the version landed on.
 */
export function runMigrations(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  let current = row?.user_version ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      // m.version is an integer literal from this file, never user input —
      // safe to interpolate (PRAGMA values cannot be bound parameters).
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
      current = m.version;
      console.log(`[alfred-state.db] migration ${m.version} (${m.name}) applied`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.version} (${m.name}) failed: ${String(err)}`);
    }
  }
  return current;
}
