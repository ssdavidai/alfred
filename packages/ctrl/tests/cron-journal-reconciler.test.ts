// cron-journal-reconciler.test.ts — GH #418 read-side reconciler.
// Tests: journal + idempotency; no-deliver + schema-degrade without throwing.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import schema from "../src/db/schema.sql";
import { runMigrations } from "../src/db/migrate.js";
import { reconcileCronOutbounds } from "../src/db/hermesCronJournal.js";
const JOB_ID = "aabbccddeeff";
const SESSION_ID = `cron_${JOB_ID}_20260812_060000`;
const NOW = Date.now() / 1000;
function makeAlfredDb() {
  const db = new DatabaseSync(":memory:"); db.exec(schema); runMigrations(db); return db;
}
function seedHermesDb(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT NOT NULL,started_at REAL NOT NULL,ended_at REAL);CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT,finish_reason TEXT,timestamp REAL NOT NULL);`);
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(SESSION_ID, "cron", NOW - 3600, NOW - 3500);
  db.prepare("INSERT INTO messages VALUES(null,?,?,?,?,?)").run(SESSION_ID, "assistant", "cron briefing text", "stop", NOW - 3505);
  db.close();
}
function writeJobs(dir: string, deliver: string) {
  fs.mkdirSync(path.join(dir, "main", "cron"), { recursive: true });
  const jobs = [{ id: JOB_ID, name: "test-job", deliver, origin: { platform: "slack", chat_id: "C0ORIG" } }];
  fs.writeFileSync(path.join(dir, "main", "cron", "jobs.json"), JSON.stringify({ jobs }));
}
describe("reconcileCronOutbounds", () => {
  let tmpDir: string;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-"));
    writeJobs(tmpDir, "slack:C0TEST001");
    seedHermesDb(path.join(tmpDir, "main", "state.db"));
  });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
  it("journals first pass; second pass is idempotent", () => {
    const db = makeAlfredDb();
    const r = reconcileCronOutbounds(db, tmpDir, "main");
    assert.equal(r.journaled, 1); assert.equal(r.skipped, 0);
    const row = db.prepare("SELECT * FROM alfred_journal WHERE hermes_session_id=?").get(SESSION_ID) as Record<string, unknown>;
    assert.ok(row); assert.equal(row.channel, "slack"); assert.equal(row.chat_id, "C0TEST001");
    assert.equal(row.direction, "outbound"); assert.equal(row.status, "delivered");
    assert.ok(String(row.message).includes("cron briefing"));
    const r2 = reconcileCronOutbounds(db, tmpDir, "main");
    assert.equal(r2.journaled, 0, "second pass must not re-journal"); assert.equal(r2.skipped, 1);
    db.close();
  });
  it("skips no-deliver sessions AND degrades on schema mismatch without throwing", () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cj-nd-"));
    try {
      writeJobs(dir2, ""); seedHermesDb(path.join(dir2, "main", "state.db"));
      assert.equal(reconcileCronOutbounds(makeAlfredDb(), dir2, "main").journaled, 0);
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "cj-schema-"));
    try {
      writeJobs(dir3, "slack:C0TEST001");
      const hdb = new DatabaseSync(path.join(dir3, "main", "state.db"));
      hdb.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT NOT NULL,started_at REAL NOT NULL,ended_at REAL);CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT,timestamp REAL NOT NULL);`);
      hdb.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(SESSION_ID, "cron", NOW - 3600, NOW - 3500);
      hdb.close();
      assert.doesNotThrow(() => reconcileCronOutbounds(makeAlfredDb(), dir3, "main"));
    } finally { fs.rmSync(dir3, { recursive: true, force: true }); }
  });
});
