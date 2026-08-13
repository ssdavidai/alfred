// journal-solicited.test.ts — migration 0019 writers (#563 item 2).
// Verifies solicited column values: cron→0, HA reply→1, Paperclip/phone→null,
// inbound→null, explicit null→null (not 0), truthy non-int→null, omitted→null.
//
// NOTE: migrate.ts does not yet register 0019 (orchestrator must add the
// import + MIGRATIONS entry — migrate.ts is forbidden-zone for Lane I).
// makeDb() applies the migration SQL directly in the interim; after
// migrate.ts registration the try/catch absorbs the duplicate-column error.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import schema from "../src/db/schema.sql";
import migration0019 from "../src/db/migrations/0019_journal_solicited.sql";
import { runMigrations } from "../src/db/migrate.js";
import { appendJournal } from "../src/db/alfredJournal.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  runMigrations(db);
  try { db.exec(migration0019); } catch { /* already applied after migrate.ts registers 0019 */ }
  return db;
}

function getSolicited(db: DatabaseSync, id: string): number | null {
  const r = db.prepare("SELECT solicited FROM alfred_journal WHERE id = ?")
    .get(id) as { solicited: number | null } | undefined;
  return r?.solicited ?? null;
}

describe("solicited — cron outbound → 0", () => {
  it("cron outbound records solicited=0 (Alfred initiated)", () => {
    const db = makeDb();
    const e = appendJournal(db, {
      channel: "slack", chat_id: "C0CRON", direction: "outbound",
      message: "briefing", source_kind: "cron", solicited: 0,
    });
    assert.strictEqual(getSolicited(db, e.id), 0);
    assert.strictEqual(e.solicited, 0, "round-trip");
    db.close();
  });
});

describe("solicited — HA outbound → 1", () => {
  it("HA reply records solicited=1 (reply to principal turn)", () => {
    const db = makeDb();
    const e = appendJournal(db, {
      channel: "ha-conversation", chat_id: "ha-install-1", direction: "outbound",
      message: "Good morning, Sir.", source_kind: "ha-conversation-reply",
      hermes_profile: "main", solicited: 1,
    });
    assert.strictEqual(getSolicited(db, e.id), 1);
    assert.strictEqual(e.solicited, 1, "round-trip");
    db.close();
  });
});

describe("solicited — Paperclip outbound → null", () => {
  it("Paperclip reply records solicited=null (platform-initiated, not principal)", () => {
    const db = makeDb();
    const e = appendJournal(db, {
      channel: "paperclip", chat_id: "paperclip-agent-001", direction: "outbound",
      message: "Task acknowledged.", source_kind: "paperclip-reply", solicited: null,
    });
    assert.strictEqual(getSolicited(db, e.id), null);
    assert.strictEqual(e.solicited, null, "round-trip");
    db.close();
  });
});

describe("solicited — phone transcript → null", () => {
  it("phone transcript records solicited=null (call direction unknown at write time)", () => {
    const db = makeDb();
    const e = appendJournal(db, {
      channel: "voice", chat_id: "+15551234567", direction: "outbound",
      message: "Call summary.", source_kind: "voice-call-transcript", solicited: null,
    });
    assert.strictEqual(getSolicited(db, e.id), null);
    db.close();
  });
});

describe("solicited — inbound rows", () => {
  it("inbound rows store null when solicited is omitted", () => {
    const db = makeDb();
    const e = appendJournal(db, {
      channel: "ha-conversation", chat_id: "ha-install-1", direction: "inbound",
      message: "What's on my brief?", source_kind: "ha-conversation-turn",
    });
    assert.strictEqual(getSolicited(db, e.id), null);
    db.close();
  });
});

describe("solicited — null integrity (guards silent default-to-0 regression)", () => {
  it("explicit null stores null — NOT 0 (a 0 default inflates the interruption term)", () => {
    // This test must break if any future refactor defaults solicited to 0.
    // Wrong 0 inflates NAR's AI-caused-interruption subtraction term silently.
    const db = makeDb();
    const e = appendJournal(db, {
      channel: "slack", chat_id: "U-OWNER", direction: "outbound",
      message: "unknown provenance", source_kind: "system", solicited: null,
    });
    assert.strictEqual(getSolicited(db, e.id), null,
      "explicit null must store null, never 0");
    assert.strictEqual(e.solicited, null,
      "returned entry must carry null, not 0");
    db.close();
  });

  it("truthy non-integer collapses to null (normalisation)", () => {
    const db = makeDb();
    const e = appendJournal(db, {
      channel: "slack", chat_id: "U-OWNER", direction: "outbound",
      message: "test", solicited: ("yes" as unknown) as number,
    });
    assert.strictEqual(getSolicited(db, e.id), null,
      "truthy non-integer must collapse to null, not 1");
    db.close();
  });

  it("omitting solicited stores null — NOT 0", () => {
    const db = makeDb();
    const e = appendJournal(db, {
      channel: "telegram", chat_id: "100000000", direction: "outbound",
      message: "notification",
      // solicited deliberately omitted
    });
    assert.strictEqual(getSolicited(db, e.id), null,
      "omitting solicited must default to null, never 0");
    assert.strictEqual(e.solicited, null,
      "returned entry must carry null, not 0");
    db.close();
  });
});
