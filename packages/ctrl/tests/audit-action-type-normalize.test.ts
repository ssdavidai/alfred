// F5 — appendAudit normalises action_type to one casing convention.
//
// Writers store mixed casing: ctrl writes underscore (`desk_action`,
// `needs_attention_action`, `decision`, `state_change`) while learn (via POST
// /api/v1/state/audit) writes hyphen (`signal-action`, `steward-action`,
// `steward-source-pruned`). A grouped SQL reader filtering on action_type is
// fragmented by the hyphen/underscore split. Pick one convention — underscore,
// matching the schema's documented `signal_action | steward_action | desk_action`
// and the C2 signal-status convention — and normalise at the write boundary
// (appendAudit), the single inserter every ctrl writer and the HTTP audit
// endpoint route through.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-norm-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { appendAudit } = await import("../src/api/routes/state.js");

describe("appendAudit — action_type normalisation (F5)", () => {
  before(() => getStateDb());

  it("stores hyphenated action_types in the underscore convention", async () => {
    const id = appendAudit({
      action_type: "signal-action",
      actor: "alfred",
      summary: "routed a signal",
    });
    const row = getStateDb()
      .prepare("SELECT action_type FROM audit WHERE id = ?")
      .get(id) as { action_type: string };
    assert.equal(row.action_type, "signal_action", "signal-action → signal_action");
  });

  it("normalises steward-source-pruned and uppercases too", async () => {
    const id = appendAudit({
      action_type: "Steward-Source-Pruned",
      actor: "alfred",
      summary: "pruned",
    });
    const row = getStateDb()
      .prepare("SELECT action_type FROM audit WHERE id = ?")
      .get(id) as { action_type: string };
    assert.equal(row.action_type, "steward_source_pruned");
  });

  it("leaves already-underscore types unchanged", async () => {
    for (const t of ["decision", "desk_action", "needs_attention_action", "state_change"]) {
      const id = appendAudit({ action_type: t, actor: "principal", summary: "x" });
      const row = getStateDb()
        .prepare("SELECT action_type FROM audit WHERE id = ?")
        .get(id) as { action_type: string };
      assert.equal(row.action_type, t, `${t} must be unchanged`);
    }
  });
});
