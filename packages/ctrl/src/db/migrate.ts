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
import m0004 from "./migrations/0004_channel_tokens.sql";
import m0005 from "./migrations/0005_ha_channel.sql";
import m0006 from "./migrations/0006_files_table.sql";
import m0007 from "./migrations/0007_recall.sql";
import m0008 from "./migrations/0008_ha_event_subscription.sql";
import m0009 from "./migrations/0009_ha_registry_vanished.sql";
import m0010 from "./migrations/0010_files_cold_archive.sql";
import m0011 from "./migrations/0011_ha_tier4.sql";
import m0012 from "./migrations/0012_ha_integration_ref_removed_at.sql";
import m0013 from "./migrations/0013_recall_realtime.sql";
import m0014 from "./migrations/0014_tool_disposition.sql";
import m0015 from "./migrations/0015_composio_user_defaults.sql";
import m0016 from "./migrations/0016_files_extraction.sql";
import m0017 from "./migrations/0017_agent_profiles.sql";

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
  { version: 4, name: "channel_tokens",       sql: m0004 },
  { version: 5, name: "ha_channel",           sql: m0005 },
  { version: 6, name: "files_table",          sql: m0006 },
  { version: 7, name: "recall",               sql: m0007 },
  { version: 8, name: "ha_event_subscription", sql: m0008 },
  { version: 9, name: "ha_registry_vanished", sql: m0009 },
  { version: 10, name: "files_cold_archive",  sql: m0010 },
  { version: 11, name: "ha_tier4",            sql: m0011 },
  { version: 12, name: "ha_integration_ref_removed_at", sql: m0012 },
  { version: 13, name: "recall_realtime",     sql: m0013 },
  { version: 14, name: "tool_disposition",    sql: m0014 },
  { version: 15, name: "composio_user_defaults", sql: m0015 },
  { version: 16, name: "files_extraction",    sql: m0016 },
  { version: 17, name: "agent_profiles",      sql: m0017 },
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
