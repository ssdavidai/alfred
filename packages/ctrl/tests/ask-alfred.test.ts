// A surface asks Alfred through ctrl-api: both turns are journaled, the
// principal's cross-surface memory is put in front of the model, and the
// reply comes back — one Alfred, from a Mac menu bar as from Slack.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import schema from "../src/db/schema.sql";
import { runMigrations } from "../src/db/migrate.js";
import { appendJournal, bindPrincipalChannel, resolvePrincipal } from "../src/db/alfredJournal.js";
import { askAlfred, extractHermesText, formatContinuityBlock } from "../src/api/askAlfred.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:"); db.exec(schema); runMigrations(db); return db;
}

describe("askAlfred", () => {
  it("journals both turns on a private surface bound to the owner and hands memory to the model", async () => {
    const db = makeDb();
    bindPrincipalChannel(db, "slack", "D0DM", "owner");
    appendJournal(db, { channel: "slack", chat_id: "D0DM", direction: "outbound", message: "The office is cooling to 21°C." });
    const seen: { input: string; sessionKey: string }[] = [];
    const r = await askAlfred(db, { message: "what did you set the AC to?", channel: "mac", chat_id: "device-1" }, {
      callHermes: async (input, sessionKey) => { seen.push({ input, sessionKey }); return { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "21°C, Sir." }] }] }; },
    });
    assert.equal(r.reply, "21°C, Sir.");
    assert.equal(seen[0].sessionKey, "mac:device-1");
    assert.ok(seen[0].input.includes("[ALFRED-CONTINUITY"), "memory block precedes the question");
    assert.ok(seen[0].input.includes("cooling to 21°C"), "the Slack turn is in the block");
    assert.ok(seen[0].input.trimEnd().endsWith("what did you set the AC to?"));
    assert.equal(resolvePrincipal(db, "mac", "device-1"), "owner");
    const rows = db.prepare("SELECT direction, message, principal_id FROM alfred_journal WHERE channel='mac' ORDER BY ts").all() as any[];
    assert.deepEqual(rows.map((x) => [x.direction, x.principal_id]), [["inbound", "owner"], ["outbound", "owner"]]);
    assert.equal(rows[1].message, "21°C, Sir.");
  });

  it("keeps the question journaled and reports the failure when Hermes gives nothing back", async () => {
    const db = makeDb();
    await assert.rejects(
      askAlfred(db, { message: "hello?", channel: "mac", chat_id: "device-2" }, { callHermes: async () => ({ output: [] }) }),
      /no reply/,
    );
    const rows = db.prepare("SELECT direction FROM alfred_journal WHERE channel='mac'").all() as any[];
    assert.deepEqual(rows.map((x) => x.direction), ["inbound"]);
  });

  it("extractHermesText tolerates the shapes Hermes has used", () => {
    assert.equal(extractHermesText({ output_text: "plain" }), "plain");
    assert.equal(extractHermesText({ output: "str" }), "str");
    assert.equal(extractHermesText({ output: [{ type: "message", content: [{ text: "a" }, { text: "b" }] }] }), "a\nb");
    assert.equal(extractHermesText(null), "");
  });

  it("formatContinuityBlock renders oldest first with the authoritative marker", () => {
    const block = formatContinuityBlock([
      { ts: "2026-09-03T10:15:14Z", channel: "slack", direction: "outbound", message: "Pong, Sir." },
      { ts: "2026-09-03T10:15:11Z", channel: "slack", direction: "inbound", message: "ping" },
    ] as any);
    assert.ok(block.startsWith("[ALFRED-CONTINUITY — authoritative]"));
    assert.ok(block.indexOf("principal → YOU on slack: ping") < block.indexOf("YOU → principal on slack: Pong, Sir."));
    assert.ok(block.trimEnd().endsWith("[/ALFRED-CONTINUITY]"));
  });
});
