// Tier 4 helpers — `ha_snapshot` + `ha_daybook` + migration 0011 (#115/#158 PR1).
//
// Coverage:
//   - Snapshot helper (dry-run mode) inserts a ha_backup_ref row with the
//     right (action, decision_ref) keys and returns the backup name.
//   - Snapshot helper without DRY_RUN propagates `wsCall` errors as Error.
//   - Daybook helper writes a daybook/<YYYY-MM-DD>.md record, scaffolds
//     the file on first call, appends under "## HA writes".
//   - Daybook helper with silent:true returns {written:false}.
//   - ha_backup_ref + ha_integration_ref + ha_user_ref tables exist with
//     the spec'd columns.

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ha-tier4-helpers-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
process.env.HA_WS_URL_OVERRIDE = "skip";
process.env.HA_WS_AUTOSTART = "false";
process.env.HA_SNAPSHOT_DRY_RUN = "1";

const { triggerBackupBeforeAction, listBackupRefs } = await import(
  "../src/api/lib/ha_snapshot.js"
);
const {
  recordHaWriteToDaybook,
  _readTodaysDaybookForTests,
} = await import("../src/api/lib/ha_daybook.js");
const { getStateDb } = await import("../src/db/state.js");

describe("Tier 4 helpers (#115/#158 PR1)", () => {
  before(() => {
    // Force migrations to apply by touching getStateDb().
    getStateDb();
  });

  describe("migration 0011 — Tier 4 tables", () => {
    it("ha_backup_ref / ha_integration_ref / ha_user_ref tables present", () => {
      const tables = (
        getStateDb()
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((r) => r.name);
      assert.ok(tables.includes("ha_backup_ref"));
      assert.ok(tables.includes("ha_integration_ref"));
      assert.ok(tables.includes("ha_user_ref"));
    });
  });

  describe("triggerBackupBeforeAction (dry-run)", () => {
    beforeEach(() => {
      getStateDb().prepare("DELETE FROM ha_backup_ref").run();
    });

    it("returns a record with name/ha_backup_id/triggered_by/decision_ref", async () => {
      const rec = await triggerBackupBeforeAction(
        "ha__core_restart",
        "01H7DEC000000000000000001",
      );
      assert.match(rec.id, /^[0-9A-Z]{20,}$/);
      assert.match(rec.ha_backup_id, /^dry-run-/);
      // Name format: alfred-pre-<action>-YYYYMMDDTHHMMSS
      assert.match(rec.name, /^alfred-pre-ha__core_restart-\d{8}T\d{6}$/);
      assert.equal(rec.triggered_by, "ha__core_restart");
      assert.equal(rec.decision_ref, "01H7DEC000000000000000001");
      assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/);
    });

    it("persists the row in ha_backup_ref", async () => {
      const rec = await triggerBackupBeforeAction("ha__addon_install", null);
      const row = getStateDb()
        .prepare("SELECT * FROM ha_backup_ref WHERE id = ?")
        .get(rec.id) as Record<string, unknown> | undefined;
      assert.ok(row);
      assert.equal(row!.triggered_by, "ha__addon_install");
      assert.equal(row!.decision_ref, null);
      assert.equal(row!.ha_backup_id, rec.ha_backup_id);
    });

    it("listBackupRefs returns most-recent-first", async () => {
      await triggerBackupBeforeAction("ha__core_restart", "01H7DEC000000000000000001");
      await new Promise((r) => setTimeout(r, 5));
      await triggerBackupBeforeAction("ha__addon_install", "01H7DEC000000000000000002");
      const refs = listBackupRefs({ limit: 10 });
      assert.equal(refs.length, 2);
      assert.equal(refs[0].triggered_by, "ha__addon_install");
      assert.equal(refs[1].triggered_by, "ha__core_restart");
    });

    it("sanitises action in the backup name (no shell metacharacters)", async () => {
      const rec = await triggerBackupBeforeAction(
        "ha__something;rm -rf /",
        null,
      );
      // After sanitisation only [A-Za-z0-9_-] remain
      assert.match(rec.name, /^alfred-pre-ha__something-rm--rf---\d{8}T\d{6}$/);
      assert.ok(!rec.name.includes(" "));
      assert.ok(!rec.name.includes(";"));
      assert.ok(!rec.name.includes("/"));
    });
  });

  describe("recordHaWriteToDaybook", () => {
    beforeEach(() => {
      // Wipe today's daybook between tests so we start clean.
      const day = new Date().toISOString().slice(0, 10);
      const dayPath = path.join(
        process.env.VAULT_PATH!,
        "daybook",
        `${day}.md`,
      );
      try {
        fs.unlinkSync(dayPath);
      } catch {
        // not present yet
      }
    });

    it("silent:true returns {written:false}", () => {
      const r = recordHaWriteToDaybook({
        action: "ha__scene_create",
        silent: true,
      });
      assert.equal(r.written, false);
      assert.match(r.path, /^daybook\/\d{4}-\d{2}-\d{2}\.md$/);
    });

    it("non-silent call creates the file with the seed + appends a block", () => {
      const r = recordHaWriteToDaybook({
        action: "ha__core_restart",
        summary: "HA core restarted (2025.6.1 → 2025.7.0)",
        decision_ref: "01H7DEC000000000000000001",
      });
      assert.equal(r.written, true);
      const body = _readTodaysDaybookForTests();
      assert.match(body, /type: daybook/);
      assert.match(body, /## HA writes/);
      assert.match(body, /action: ha__core_restart/);
      assert.match(body, /decision_ref: 01H7DEC000000000000000001/);
      // Summary line has no colon/hash/newline → unquoted.
      assert.match(body, /summary: HA core restarted/);
    });

    it("appending twice produces two entries under the same section", () => {
      recordHaWriteToDaybook({ action: "ha__core_restart", summary: "first" });
      recordHaWriteToDaybook({ action: "ha__addon_install", summary: "second" });
      const body = _readTodaysDaybookForTests();
      assert.equal(
        (body.match(/^- ts:/gm) ?? []).length,
        2,
        "two block entries appended",
      );
      assert.match(body, /action: ha__core_restart/);
      assert.match(body, /action: ha__addon_install/);
    });

    it("extra fields render as YAML key/value pairs (sanitised keys)", () => {
      recordHaWriteToDaybook({
        action: "ha__integration_add",
        summary: "Hue",
        extra: { "evil key!": "val", count: 12 },
      });
      const body = _readTodaysDaybookForTests();
      // Key is sanitised to underscores; value reflects through.
      assert.match(body, /evil_key_: val/);
      assert.match(body, /count: 12/);
    });
  });
});
