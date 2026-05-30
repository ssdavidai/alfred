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
    // Latest version moves as new migrations land. Today: 16
    // (0001_fix_pack + 0002_alfred_journal + 0003_tailscale_connection
    // + 0004_channel_tokens + 0005_ha_channel + 0006_files_table
    // + 0007_recall + 0008_ha_event_subscription
    // + 0009_ha_registry_vanished + 0010_files_cold_archive
    // + 0011_ha_tier4 + 0012_ha_integration_ref_removed_at
    // + 0013_recall_realtime + 0014_tool_disposition
    // + 0015_composio_user_defaults + 0016_files_extraction).
    assert.equal(v, 16, "migrated to latest version");
    assert.equal(userVersion(db), 16);
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

    // 0008: ha_event_subscription table present (issue #110 PR 4).
    assert.ok(
      tables.includes("ha_event_subscription"),
      "0008: ha_event_subscription table created",
    );
    const subCols = cols(db, "ha_event_subscription");
    for (const required of [
      "id",
      "filter_json",
      "started_at",
      "last_event_at",
      "closed_at",
    ]) {
      assert.ok(
        subCols.includes(required),
        `0008: ha_event_subscription.${required} present`,
      );
    }

    // 0009: ha_registry.vanished_at column added (#110 PR 5). The
    // HaBootstrapWorkflow tombstones (does NOT delete) entities that
    // vanished from HA between pulls; the dashboard's "live" partial
    // index over `vanished_at IS NULL` keeps the live read cheap.
    const haRegCols = cols(db, "ha_registry");
    assert.ok(
      haRegCols.includes("vanished_at"),
      "0009: ha_registry.vanished_at column added",
    );

    // 0010: file_blobs table + files.cold_promoted_at / ref_count
    // columns + idx_files_last_accessed (issue #114 PR 5).
    assert.ok(
      tables.includes("file_blobs"),
      "0010: file_blobs table created",
    );
    const blobCols = cols(db, "file_blobs");
    for (const required of [
      "sha256",
      "path",
      "size_bytes",
      "ref_count",
      "created_at",
      "cold_promoted_at",
    ]) {
      assert.ok(
        blobCols.includes(required),
        `0010: file_blobs.${required} present`,
      );
    }
    const fileCols = cols(db, "files");
    assert.ok(
      fileCols.includes("cold_promoted_at"),
      "0010: files.cold_promoted_at present",
    );
    assert.ok(
      fileCols.includes("ref_count"),
      "0010: files.ref_count present",
    );
    // The PR 1 UNIQUE constraint on files.path is gone (dedupe needs
    // two files.id rows to point at the same path). Verify the
    // constraint was dropped: inserting two rows with the same path
    // must succeed.
    const filesNow = Date.now();
    db.prepare(
      `INSERT INTO files
        (id, path, size_bytes, sha256, content_type, original_filename,
         principal_label, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "01HFTEST0000000000000000A",
      "01HFTEST/dup.bin",
      4,
      "abc",
      null,
      "dup.bin",
      null,
      "principal",
      filesNow,
    );
    assert.doesNotThrow(() =>
      db
        .prepare(
          `INSERT INTO files
            (id, path, size_bytes, sha256, content_type, original_filename,
             principal_label, uploaded_by, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "01HFTEST0000000000000000B",
          "01HFTEST/dup.bin",
          4,
          "abc",
          null,
          "dup.bin",
          null,
          "principal",
          filesNow,
        ),
      "0010: files.path UNIQUE constraint dropped — dedupe needs shared paths",
    );

    // 0011: Tier 4 HA autonomy — ha_backup_ref + ha_integration_ref +
    // ha_user_ref tables present (#115/#158 PR1).
    for (const t of ["ha_backup_ref", "ha_integration_ref", "ha_user_ref"]) {
      assert.ok(tables.includes(t), `0011: ${t} table created`);
    }
    for (const required of [
      "id",
      "ha_backup_id",
      "triggered_by",
      "decision_ref",
      "ts",
    ]) {
      assert.ok(
        cols(db, "ha_backup_ref").includes(required),
        `0011: ha_backup_ref.${required} present`,
      );
    }
    for (const required of ["entry_id", "installed_by", "decision_ref", "installed_at"]) {
      assert.ok(
        cols(db, "ha_integration_ref").includes(required),
        `0011: ha_integration_ref.${required} present`,
      );
    }
    // 0012: PR4 follow-up — soft-delete column on ha_integration_ref.
    assert.ok(
      cols(db, "ha_integration_ref").includes("removed_at"),
      "0012: ha_integration_ref.removed_at present",
    );
    for (const required of ["ha_user_id", "name", "decision_ref", "llat_vw_id", "created_at"]) {
      assert.ok(
        cols(db, "ha_user_ref").includes(required),
        `0011: ha_user_ref.${required} present`,
      );
    }

    // 0016: files.{alfred_read_at, summary, extraction_error} present.
    // These are the three columns the FileExtractionWorkflow writes
    // back via PATCH /api/v1/files/:id/extraction (#114 Lane B).
    const filesColsAfter = cols(db, "files");
    for (const required of [
      "alfred_read_at",
      "summary",
      "extraction_error",
    ]) {
      assert.ok(
        filesColsAfter.includes(required),
        `0016: files.${required} present`,
      );
    }

    db.close();
  });

  it("is idempotent — re-running applies nothing and does not error", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    runMigrations(db);
    const v2 = runMigrations(db);
    assert.equal(v2, 16);
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
