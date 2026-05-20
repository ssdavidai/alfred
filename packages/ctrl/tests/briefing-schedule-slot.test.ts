// C10 — briefing schedule slot input.
//
// install-standard created the briefing_morning/_evening Temporal schedules
// with `--input {"chore_slug":"briefing-morning"}` (a dict). But learn's
// BriefingWorkflow.run(self, slot) expects a POSITIONAL string "morning"/
// "evening" and does slot.strip() — so it crashed on the dict on every fire.
//
// Frozen contract C10: pass the positional slot string for those two
// templates; keep the {chore_slug,...} dict for every other workflow. This
// tests the constructed `--input` value (scheduleInputForTemplate).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-slot-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { scheduleInputForTemplate } = await import("../src/api/routes/chores.js");

describe("scheduleInputForTemplate (C10)", () => {
  it("passes the positional 'morning' slot string for briefing_morning", () => {
    const input = scheduleInputForTemplate("briefing_morning", {
      chore_slug: "briefing-morning",
    });
    assert.equal(input, JSON.stringify("morning"));
    // and it deserializes to a bare string, not a dict (what crashed slot.strip)
    assert.equal(typeof JSON.parse(input), "string");
    assert.equal(JSON.parse(input), "morning");
  });

  it("passes the positional 'evening' slot string for briefing_evening", () => {
    const input = scheduleInputForTemplate("briefing_evening", {
      chore_slug: "briefing-evening",
    });
    assert.equal(JSON.parse(input), "evening");
    assert.equal(typeof JSON.parse(input), "string");
  });

  it("keeps the {chore_slug,...} dict envelope for non-briefing templates", () => {
    const env = { chore_slug: "subscription-watcher", channel: "slack:default" };
    const input = scheduleInputForTemplate("subscription_watcher", env);
    const parsed = JSON.parse(input);
    assert.equal(typeof parsed, "object");
    assert.deepEqual(parsed, env);
  });
});
