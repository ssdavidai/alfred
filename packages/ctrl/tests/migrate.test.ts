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
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";


function cols(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (r) => r.name,
  );
}
// Latest migration version, derived from the migrations directory rather than
// hardcoded. A hardcoded number means every new migration breaks an unrelated
// test and the fix is a bump, which teaches nobody anything. Derived, this
// still catches a real failure — the runner not reaching the latest registered
// version — because expected and actual come from independent sources.
function latestMigrationVersion(): number {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "migrations");
  const nums = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => Number(f.slice(0, 4)))
    .filter((n) => Number.isFinite(n));
  return Math.max(...nums);
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function indexColumns(db: DatabaseSync, index: string): string[] {
  return (db.prepare(`PRAGMA index_info(${index})`).all() as { name: string }[]).map(
    (r) => r.name,
  );
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
    // Latest version moves as new migrations land. Today: 18
    // (0001_fix_pack + 0002_alfred_journal + 0003_tailscale_connection
    // + 0004_channel_tokens + 0005_ha_channel + 0006_files_table
    // + 0007_recall + 0008_ha_event_subscription
    // + 0009_ha_registry_vanished + 0010_files_cold_archive
    // + 0011_ha_tier4 + 0012_ha_integration_ref_removed_at
    // + 0013_recall_realtime + 0014_tool_disposition
    // + 0015_composio_user_defaults + 0016_files_extraction
    // + 0017_agent_profiles + 0018_channel_identity).
    assert.equal(v, latestMigrationVersion(), "migrated to latest version");
    assert.equal(userVersion(db), latestMigrationVersion());
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

    // 0017: agent_profile + channel_profile_binding tables present, the
    // four reserved infra rows seeded, the per-channel-kind default
    // bindings seeded, and channel_tokens.profile_slug column added
    // (#120 Lane I).
    assert.ok(
      tables.includes("agent_profile"),
      "0017: agent_profile table created",
    );
    assert.ok(
      tables.includes("channel_profile_binding"),
      "0017: channel_profile_binding table created",
    );
    const reservedSlugs = (
      db
        .prepare(
          "SELECT slug FROM agent_profile WHERE is_reserved = 1 ORDER BY slug",
        )
        .all() as { slug: string }[]
    ).map((r) => r.slug);
    assert.deepEqual(
      reservedSlugs,
      ["codex-builder", "heavy", "main", "workers"],
      "0017: four reserved infra profiles seeded",
    );
    const defaultBindingKinds = (
      db
        .prepare(
          "SELECT channel_kind FROM channel_profile_binding WHERE id LIKE 'binding-default-%' ORDER BY channel_kind",
        )
        .all() as { channel_kind: string }[]
    ).map((r) => r.channel_kind);
    assert.deepEqual(
      defaultBindingKinds,
      [
        "email",
        "ha",
        "omi",
        "paperclip",
        "recall",
        "slack",
        "sms",
        "tailscale",
        "telegram",
        "terminal",
        "voice",
      ],
      "0017: per-channel-kind default bindings seeded",
    );
    assert.ok(
      cols(db, "channel_tokens").includes("profile_slug"),
      "0017: channel_tokens.profile_slug column added",
    );

    // 0018: channel_identity table present + (profile_slug, channel_kind) PK
    // + the five expected columns. The table is empty at fresh-migrate time;
    // the route layer (PUT /channel-identities/:kind) is the only writer.
    assert.ok(
      tables.includes("channel_identity"),
      "0018: channel_identity table created",
    );
    const ciCols = cols(db, "channel_identity");
    for (const required of [
      "profile_slug",
      "channel_kind",
      "display_name",
      "avatar_path",
      "avatar_mime",
      "updated_at",
    ]) {
      assert.ok(
        ciCols.includes(required),
        `0018: channel_identity.${required} present`,
      );
    }
    // Composite PK enforces one row per (profile, channel_kind). Insert a
    // sentinel via the seeded 'main' profile then prove a second insert at
    // the same PK is rejected.
    db.prepare(
      `INSERT INTO channel_identity
         (profile_slug, channel_kind, display_name, avatar_path, avatar_mime)
       VALUES ('main', 'telegram', 'Alfred', NULL, NULL)`,
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO channel_identity
               (profile_slug, channel_kind, display_name)
             VALUES ('main', 'telegram', 'Alfred (dup)')`,
          )
          .run(),
      /UNIQUE constraint failed|PRIMARY KEY/i,
      "0018: composite PK rejects a second row for the same (profile, kind)",
    );

    db.close();
  });

  it("is idempotent — re-running applies nothing and does not error", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    runMigrations(db);
    const v2 = runMigrations(db);
    assert.equal(v2, latestMigrationVersion());
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

  it("0021 creates bounded Codex Desktop receipts, provenance, and deletion tombstones", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(schema);
    runMigrations(db);

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((r) => r.name),
    );
    for (const table of [
      "codex_desktop_installation",
      "codex_desktop_delivery_chunk",
      "codex_desktop_source_event",
      "codex_desktop_deletion",
    ]) {
      assert.ok(tables.has(table), `0021: ${table} created`);
    }

    const requiredColumns: Record<string, string[]> = {
      codex_desktop_installation: [
        "id", "product", "product_version", "adapter_version", "token_hash",
        "token_expires_at", "credential_rotated_at", "revoked_at",
        "health_state", "redaction_state", "retention_until",
      ],
      codex_desktop_delivery_chunk: [
        "id", "installation_id", "opaque_session_id", "sequence_start",
        "sequence_end", "idempotency_key", "canonical_payload_hash",
        "event_count", "projection_status", "existing_ingest_ref",
        "acknowledgement_at", "redaction_state", "retention_until",
      ],
      codex_desktop_source_event: [
        "id", "installation_id", "delivery_chunk_id", "source_event_id",
        "opaque_session_id", "opaque_turn_id", "event_sequence", "event_kind",
        "event_revision", "canonical_payload_hash", "projection_status",
        "existing_ingest_ref", "existing_journal_ref", "redaction_state",
        "retention_until",
      ],
      codex_desktop_deletion: [
        "id", "request_id", "request_payload_hash", "installation_id",
        "scope", "opaque_session_id", "operation", "status", "accepted_at",
        "completion_deadline", "completed_at", "server_complete",
        "client_cleanup_pending", "client_applied_at", "last_error_code",
        "tombstone_expires_at", "retention_until",
      ],
    };
    for (const [table, required] of Object.entries(requiredColumns)) {
      const actual = cols(db, table);
      for (const column of required) {
        assert.ok(actual.includes(column), `0021: ${table}.${column} present`);
      }
    }
    assert.equal(
      cols(db, "codex_desktop_installation").includes("token"),
      false,
      "0021: plaintext installation token is not stored",
    );

    const expectedIndexes: Record<string, string[]> = {
      uq_codex_desktop_chunk_idempotency: ["installation_id", "idempotency_key"],
      uq_codex_desktop_chunk_sequence: [
        "installation_id", "opaque_session_id", "sequence_start", "sequence_end",
      ],
      uq_codex_desktop_source_identity: ["installation_id", "source_event_id"],
      uq_codex_desktop_event_sequence: [
        "installation_id", "opaque_session_id", "event_sequence",
      ],
      uq_codex_desktop_deletion_request: ["request_id"],
      idx_codex_desktop_deletion_selector: [
        "installation_id", "scope", "opaque_session_id", "tombstone_expires_at",
      ],
      idx_codex_desktop_deletion_directive: [
        "installation_id", "client_cleanup_pending", "accepted_at", "id",
      ],
    };
    for (const [index, expected] of Object.entries(expectedIndexes)) {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
      ).get(index) as { name: string } | undefined;
      assert.equal(row?.name, index, `0021: ${index} exists`);
      assert.deepEqual(indexColumns(db, index), expected, `0021: ${index} columns`);
    }
    for (const index of [
      "idx_codex_desktop_installation_expiry",
      "idx_codex_desktop_installation_revoked",
      "idx_codex_desktop_installation_retention",
      "idx_codex_desktop_chunk_session",
      "idx_codex_desktop_chunk_projection",
      "idx_codex_desktop_chunk_retention",
      "idx_codex_desktop_source_chunk",
      "idx_codex_desktop_source_turn",
      "idx_codex_desktop_source_projection",
      "idx_codex_desktop_source_retention",
      "idx_codex_desktop_deletion_retention",
    ]) {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
      ).get(index) as { name: string } | undefined;
      assert.equal(row?.name, index, `0021: ${index} exists`);
    }

    const chunkFkTargets = new Set(
      (db.prepare("PRAGMA foreign_key_list(codex_desktop_delivery_chunk)").all() as { table: string }[])
        .map((r) => r.table),
    );
    assert.deepEqual(chunkFkTargets, new Set(["codex_desktop_installation"]));
    const sourceFkTargets = new Set(
      (db.prepare("PRAGMA foreign_key_list(codex_desktop_source_event)").all() as { table: string }[])
        .map((r) => r.table),
    );
    assert.ok(sourceFkTargets.has("codex_desktop_installation"));
    assert.ok(sourceFkTargets.has("codex_desktop_delivery_chunk"));
    const deletionFkTargets = new Set(
      (db.prepare("PRAGMA foreign_key_list(codex_desktop_deletion)").all() as { table: string }[])
        .map((r) => r.table),
    );
    assert.deepEqual(deletionFkTargets, new Set(["codex_desktop_installation"]));

    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    db.prepare(
      `INSERT INTO codex_desktop_installation
        (id, label, product, product_version, platform, adapter_version,
         token_hash, token_expires_at, retention_until)
       VALUES (?, ?, ?, ?, 'macos', ?, ?, ?, ?)`,
    ).run(
      "cdi_01JTESTINSTALLATION0000000", "Test Mac", "codex-cli", "0.135.0", "1",
      hashA, "2026-11-17T00:00:00.000Z", "2027-02-15T00:00:00.000Z",
    );

    const insertDeletion = db.prepare(
      `INSERT INTO codex_desktop_deletion
        (id, request_id, request_payload_hash, installation_id, scope,
         opaque_session_id, operation, accepted_at, completion_deadline,
         tombstone_expires_at, retention_until)
       VALUES (?, ?, ?, 'cdi_01JTESTINSTALLATION0000000', ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertDeletion.run(
      "deletion-1", "0198c5b1-77e3-7dc0-ad9c-e713736678d9", hashB,
      "session", "session-before-first-delivery", "delete",
      "2026-08-19T12:10:00.000Z", "2026-08-20T12:10:00.000Z",
      "2026-11-17T12:10:00.000Z", "2026-11-17T12:10:00.000Z",
    );
    const preDeliveryTombstone = db.prepare(
      `SELECT id, operation FROM codex_desktop_deletion
       WHERE installation_id = ? AND scope = 'session'
         AND opaque_session_id = ? AND tombstone_expires_at > ?`,
    ).get(
      "cdi_01JTESTINSTALLATION0000000",
      "session-before-first-delivery",
      "2026-08-19T12:11:00.000Z",
    ) as { id: string; operation: string } | undefined;
    assert.equal(
      preDeliveryTombstone?.id,
      "deletion-1",
      "0021: session tombstone is queryable before any matching delivery",
    );
    assert.equal(preDeliveryTombstone?.operation, "delete");
    assert.equal(
      (db.prepare(
        `SELECT COUNT(*) AS n FROM codex_desktop_delivery_chunk
         WHERE opaque_session_id = 'session-before-first-delivery'`,
      ).get() as { n: number }).n,
      0,
      "0021: pre-delivery session tombstone has no synthetic chunk",
    );
    assert.throws(
      () => insertDeletion.run(
        "deletion-request-collision", "0198c5b1-77e3-7dc0-ad9c-e713736678d9",
        hashA, "session", "another-session", "redact",
        "2026-08-19T12:10:01.000Z", "2026-08-20T12:10:01.000Z",
        "2026-11-17T12:10:01.000Z", "2026-11-17T12:10:01.000Z",
      ),
      /UNIQUE constraint failed/i,
      "0021: deletion request id collision is rejected",
    );
    assert.throws(
      () => insertDeletion.run(
        "deletion-invalid-session", "0198c5b1-77e3-7dc0-ad9c-e713736678da",
        hashA, "session", null, "delete",
        "2026-08-19T12:10:02.000Z", "2026-08-20T12:10:02.000Z",
        "2026-11-17T12:10:02.000Z", "2026-11-17T12:10:02.000Z",
      ),
      /CHECK constraint failed/i,
      "0021: session tombstone requires an opaque session selector",
    );
    assert.throws(
      () => insertDeletion.run(
        "deletion-invalid-installation", "0198c5b1-77e3-7dc0-ad9c-e713736678db",
        hashA, "installation", "must-be-null", "delete",
        "2026-08-19T12:10:03.000Z", "2026-08-20T12:10:03.000Z",
        "2026-11-17T12:10:03.000Z", "2026-11-17T12:10:03.000Z",
      ),
      /CHECK constraint failed/i,
      "0021: installation tombstone forbids a session selector",
    );

    const insertChunk = db.prepare(
      `INSERT INTO codex_desktop_delivery_chunk
        (id, installation_id, opaque_session_id, sequence_start, sequence_end,
         idempotency_key, canonical_payload_hash, event_count,
         acknowledgement_at, retention_until)
       VALUES (?, 'cdi_01JTESTINSTALLATION0000000', 'thread-opaque', ?, ?, ?, ?, 1, ?, ?)`,
    );
    insertChunk.run(
      "ack-1", 1, 1, "0191d4a0-0000-7000-8000-000000000001", hashA,
      "2026-08-19T12:00:00.000Z", "2026-09-18T12:00:00.000Z",
    );
    assert.throws(
      () => insertChunk.run(
        "ack-idem-collision", 2, 2, "0191d4a0-0000-7000-8000-000000000001", hashA,
        "2026-08-19T12:00:01.000Z", "2026-09-18T12:00:01.000Z",
      ),
      /UNIQUE constraint failed/i,
      "0021: installation-scoped idempotency key collision rejected",
    );
    assert.throws(
      () => insertChunk.run(
        "ack-sequence-collision", 1, 1, "0191d4a0-0000-7000-8000-000000000002", hashA,
        "2026-08-19T12:00:02.000Z", "2026-09-18T12:00:02.000Z",
      ),
      /UNIQUE constraint failed/i,
      "0021: installation/session/chunk sequence collision rejected",
    );

    const insertEvent = db.prepare(
      `INSERT INTO codex_desktop_source_event
        (id, installation_id, delivery_chunk_id, source_event_id,
         opaque_session_id, opaque_turn_id, event_sequence, event_kind,
         event_revision, canonical_payload_hash, observed_at, retention_until)
       VALUES (?, 'cdi_01JTESTINSTALLATION0000000', 'ack-1', ?,
               'thread-opaque', ?, ?, 'agent-turn-complete', 1, ?, ?, ?)`,
    );
    insertEvent.run(
      "event-row-1", "0191d4a0-0000-7000-8000-000000000010", "turn-opaque-1", 1,
      hashB, "2026-08-19T11:59:59.000Z", "2026-08-26T12:00:00.000Z",
    );
    assert.throws(
      () => insertEvent.run(
        "event-row-source-collision", "0191d4a0-0000-7000-8000-000000000010",
        "turn-opaque-2", 2, hashB, "2026-08-19T12:00:03.000Z",
        "2026-08-26T12:00:03.000Z",
      ),
      /UNIQUE constraint failed/i,
      "0021: installation/source-event identity collision rejected",
    );
    assert.throws(
      () => insertEvent.run(
        "event-row-sequence-collision", "0191d4a0-0000-7000-8000-000000000011",
        "turn-opaque-3", 1, hashB, "2026-08-19T12:00:04.000Z",
        "2026-08-26T12:00:04.000Z",
      ),
      /UNIQUE constraint failed/i,
      "0021: installation/session/event sequence collision rejected",
    );

    assert.equal(userVersion(db), latestMigrationVersion());
    runMigrations(db);
    for (const table of Object.keys(requiredColumns)) {
      const count = db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?",
      ).get(table) as { n: number };
      assert.equal(count.n, 1, `0021: ${table} remains single after second run`);
    }
    db.close();
  });

  it("0021 is statically imported and registered exactly once", () => {
    const migratePath = join(
      dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "migrate.ts",
    );
    const source = readFileSync(migratePath, "utf8");
    assert.equal(
      source.match(/import m0021 from "\.\/migrations\/0021_codex_desktop\.sql";/g)?.length,
      1,
      "0021 SQL has one static import",
    );
    assert.equal(
      source.match(/\{\s*version:\s*21,\s*name:\s*"codex_desktop",\s*sql:\s*m0021\s*\}/g)?.length,
      1,
      "version 21 has one MIGRATIONS entry",
    );
  });
});
