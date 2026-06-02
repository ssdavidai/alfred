// `requireDecisionRef` middleware — #115/#158 PR1.
//
// Coverage:
//   1. Missing decision_ref → 400 ValidationError.
//   2. Malformed decision_ref (whitespace / control chars / too short) → 400.
//   3. Path-traversal attempt (../) → 400.
//   4. Decision file doesn't exist → 400 DECISION_REF_INVALID.
//   5. Decision in 'reversed' state → 400 DECISION_REF_REVERSED.
//   6. Decision in 'open' state → returns DecisionLookup.
//   7. Decision in 'completed' state → returns DecisionLookup.
//   8. Malformed frontmatter (no `---`) → 400 DECISION_REF_INVALID.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decision-ref-mw-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";

const { requireDecisionRef } = await import(
  "../src/api/middleware/decision_ref.js"
);
const { ValidationError, ApiError } = await import("../src/api/errors.js");

const DECISIONS_DIR = path.join(process.env.VAULT_PATH!, "decision");
fs.mkdirSync(DECISIONS_DIR, { recursive: true });

function writeDecision(id: string, fm: Record<string, unknown>, body = "test"): void {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === "string") {
      lines.push(`${k}: "${v}"`);
    } else if (v === null) {
      lines.push(`${k}: null`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(body);
  fs.writeFileSync(path.join(DECISIONS_DIR, `${id}.md`), lines.join("\n"), "utf-8");
}

describe("requireDecisionRef middleware", () => {
  before(() => {
    // Seed a few decisions covering the state spectrum.
    writeDecision("01H7TEST0000000000000000A", {
      type: "decision",
      created: "2026-05-29T18:00:00Z",
      principal: "owner",
      source: "needs_attention",
      intent: "take_mine",
      state: "completed",
    });
    writeDecision("01H7TEST0000000000000000B", {
      type: "decision",
      created: "2026-05-29T18:01:00Z",
      principal: "owner",
      source: "approval",
      intent: "delegate",
      state: "reversed",
    });
    writeDecision("01H7TEST0000000000000000C", {
      type: "decision",
      created: "2026-05-29T18:02:00Z",
      principal: "owner",
      source: "approval",
      intent: "take_mine",
      state: "open",
    });
    // Malformed (no closing frontmatter).
    fs.writeFileSync(
      path.join(DECISIONS_DIR, "01H7BAD0000000000000000X.md"),
      "---\ntype: decision\nno-closing-fence-here\n",
      "utf-8",
    );
  });

  it("missing decision_ref → ValidationError", () => {
    assert.throws(() => requireDecisionRef({}), (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.match((err as Error).message, /decision_ref required/);
      return true;
    });
  });

  it("body is not an object → ValidationError", () => {
    assert.throws(() => requireDecisionRef(undefined), ValidationError);
    assert.throws(() => requireDecisionRef("string"), ValidationError);
    assert.throws(() => requireDecisionRef(null), ValidationError);
  });

  it("malformed decision_ref (whitespace) → ValidationError", () => {
    assert.throws(
      () => requireDecisionRef({ decision_ref: "has space" }),
      ValidationError,
    );
  });

  it("malformed decision_ref (too short) → ValidationError", () => {
    assert.throws(
      () => requireDecisionRef({ decision_ref: "abc" }),
      ValidationError,
    );
  });

  it("decision_ref containing slashes (path traversal) → ValidationError", () => {
    assert.throws(
      () => requireDecisionRef({ decision_ref: "../../../etc/passwd" }),
      ValidationError,
    );
  });

  it("decision_ref containing slash → ValidationError", () => {
    assert.throws(
      () => requireDecisionRef({ decision_ref: "foo/bar/baz" }),
      ValidationError,
    );
  });

  it("decision file does not exist → ApiError(DECISION_REF_INVALID)", () => {
    assert.throws(
      () => requireDecisionRef({ decision_ref: "00000000000000000000000000" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).statusCode, 400);
        assert.equal((err as ApiError).code, "DECISION_REF_INVALID");
        return true;
      },
    );
  });

  it("decision in 'reversed' state → ApiError(DECISION_REF_REVERSED)", () => {
    assert.throws(
      () => requireDecisionRef({ decision_ref: "01H7TEST0000000000000000B" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).statusCode, 400);
        assert.equal((err as ApiError).code, "DECISION_REF_REVERSED");
        return true;
      },
    );
  });

  it("decision in 'completed' state → returns DecisionLookup", () => {
    const lookup = requireDecisionRef({
      decision_ref: "01H7TEST0000000000000000A",
    });
    assert.equal(lookup.id, "01H7TEST0000000000000000A");
    assert.equal(lookup.state, "completed");
    assert.equal(lookup.intent, "take_mine");
    assert.equal(lookup.source, "needs_attention");
  });

  it("decision in 'open' state → returns DecisionLookup", () => {
    const lookup = requireDecisionRef({
      decision_ref: "01H7TEST0000000000000000C",
    });
    assert.equal(lookup.state, "open");
    assert.equal(lookup.intent, "take_mine");
  });

  it("decision file with malformed frontmatter → ApiError(DECISION_REF_INVALID)", () => {
    assert.throws(
      () => requireDecisionRef({ decision_ref: "01H7BAD0000000000000000X" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).code, "DECISION_REF_INVALID");
        return true;
      },
    );
  });
});
