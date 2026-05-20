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

  it("runMigrations adds processed_at and bumps user_version to 1", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    const v = runMigrations(db);
    assert.equal(v, 1, "migrated to version 1");
    assert.equal(userVersion(db), 1);
    assert.ok(cols(db, "observation").includes("processed_at"), "processed_at present after migrate");
    db.close();
  });

  it("is idempotent — re-running applies nothing and does not error", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    runMigrations(db);
    const v2 = runMigrations(db);
    assert.equal(v2, 1);
    assert.equal(
      cols(db, "observation").filter((c) => c === "processed_at").length,
      1,
      "no duplicate-column error on re-run",
    );
    db.close();
  });
});
