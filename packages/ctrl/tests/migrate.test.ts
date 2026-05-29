// Phase 0.1 — state.db migration runner (FAILURE-MODES Part 3 finding #2 / FIX-CONTRACTS C5).
//
// The repo had NO migration mechanism: schema.sql is CREATE-IF-NOT-EXISTS only,
// so editing it to add a column is a silent no-op on an existing DB. These tests
// prove (a) that reality, then (b) that runMigrations() actually evolves the
// schema and is idempotent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import schema from "../src/db/schema.sql";
import { runMigrations } from "../src/db/migrate.js";

function cols(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (r) => r.name,
  );
}
function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

describe("state.db migration runner", () => {
  it("schema.sql alone does NOT add observation.processed_at (proves the runner is needed)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    assert.equal(
      cols(db, "observation").includes("processed_at"),
      false,
      "baseline CREATE-IF-NOT-EXISTS schema must lack processed_at",
    );
    assert.equal(userVersion(db), 0);
    db.close();
  });

  it("runMigrations adds processed_at and bumps user_version to latest", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    const v = runMigrations(db);
    // Latest version moves as new migrations land. Today: 6
    // (0001_fix_pack + 0002_alfred_journal + 0003_tailscale_connection
    // + 0004_channel_tokens + 0005_ha_channel + 0006_files_table).
    assert.equal(v, 6, "migrated to latest version");
    assert.equal(userVersion(db), 6);
    assert.ok(cols(db, "observation").includes("processed_at"), "0001: processed_at present after migrate");
    // 0002: alfred_journal + alfred_principal tables present.
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    assert.ok(tables.includes("alfred_journal"), "0002: alfred_journal table created");
    assert.ok(
      tables.includes("alfred_principal"),
      "0002: alfred_principal table created",
    );
    // 0003: tailscale_connection singleton table present, with the
    // CHECK(id=1) guard that pins the table to one row. Issue #109 PR 1.
    assert.ok(
      tables.includes("tailscale_connection"),
      "0003: tailscale_connection table created",
    );
    const tsCols = cols(db, "tailscale_connection");
    for (const required of [
      "id",
      "state",
      "tailnet_ip",
      "tailnet_hostname",
      "authkey_used_at",
      "auth_url",
      "last_status_probe_at",
      "last_error",
      "created_at",
      "updated_at",
    ]) {
      assert.ok(
        tsCols.includes(required),
        `0003: tailscale_connection.${required} present`,
      );
    }
    // Singleton guard: a second row at id=2 must be rejected by the CHECK.
    const now = Date.now();
    db.prepare(
      "INSERT INTO tailscale_connection (id, state, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(1, "disabled", now, now);
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO tailscale_connection (id, state, created_at, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(2, "disabled", now, now),
      /CHECK constraint failed/i,
      "0003: CHECK(id=1) blocks a second tailscale_connection row",
    );

    // 0004: channel_tokens table present (issue #111 PR 1).
    assert.ok(
      tables.includes("channel_tokens"),
      "0004: channel_tokens table created",
    );
    const ctCols = cols(db, "channel_tokens");
    for (const required of ["id", "channel", "token_hash", "created_at"]) {
      assert.ok(
        ctCols.includes(required),
        `0004: channel_tokens.${required} present`,
      );
    }

    db.close();
  });

  it("is idempotent — re-running applies nothing and does not error", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    runMigrations(db);
    const v2 = runMigrations(db);
    assert.equal(v2, 6);
    assert.equal(
      cols(db, "observation").filter((c) => c === "processed_at").length,
      1,
      "no duplicate-column error on re-run",
    );
    // Owner principal stays a single row (INSERT OR IGNORE).
    const ownerCount = (
      db
        .prepare("SELECT COUNT(*) as n FROM alfred_principal WHERE id='owner'")
        .get() as { n: number }
    ).n;
    assert.equal(ownerCount, 1, "owner principal is inserted once, not duplicated");
    db.close();
  });
});
