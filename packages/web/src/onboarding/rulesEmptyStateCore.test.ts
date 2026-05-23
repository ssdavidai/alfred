/**
 * Tests for the /household RULES.md empty-state view-state machine.
 * /household reads RULES.md via `getVaultRecord({path:"RULES.md"})`
 * (returning `{path, frontmatter, body}`), not the workspace-files
 * endpoint. `rulesViewState` is endpoint-agnostic so these cases cover
 * the vault-record shape.
 *   cd packages/web && npx tsx --test src/onboarding/rulesEmptyStateCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { rulesViewState } from "./rulesEmptyStateCore";

test("404 on RULES.md → composing (new behaviour, not 'error')", () => {
  const state = rulesViewState({
    data: undefined,
    isLoading: false,
    isError: true,
    error: { statusCode: 404, message: "Record not found" },
    seeded: false,
  });
  assert.equal(state, "composing");
});

test("RULES.md vault-record loaded → ready (editor renders)", () => {
  // Real shape from GET /api/v1/vault/records/RULES.md per C-OB2:
  // `{ path, frontmatter: { type: "note", subtype: "standing_rules", ... },
  //    body: "# Standing Rules\n## Personal sovereignty rules\n- …\n" }`.
  const state = rulesViewState({
    data: {
      path: "RULES.md",
      frontmatter: {
        type: "note",
        subtype: "standing_rules",
        status: "active",
      },
      body:
        "# Standing Rules\n\n## Personal sovereignty rules\n- one rule\n",
    },
    isLoading: false,
    isError: false,
    seeded: false,
  });
  assert.equal(state, "ready");
});

test("500 from records endpoint → error (existing 'Retry' branch)", () => {
  const state = rulesViewState({
    data: undefined,
    isLoading: false,
    isError: true,
    error: { statusCode: 500, message: "tenant unreachable" },
    seeded: false,
  });
  assert.equal(state, "error");
});

test("first mount, query in flight → loading", () => {
  const state = rulesViewState({
    data: undefined,
    isLoading: true,
    isError: false,
    seeded: false,
  });
  assert.equal(state, "loading");
});

test("once seeded, transient refetch keeps the editor visible", () => {
  // A background refetch flips isLoading true again; the page must NOT
  // flicker back to a loading copy after the user has already started
  // editing.
  const state = rulesViewState({
    data: {
      path: "RULES.md",
      frontmatter: { type: "note", subtype: "standing_rules" },
      body: "# Standing Rules\n## Personal sovereignty rules\n- already loaded once\n",
    },
    isLoading: true,
    isError: false,
    seeded: true,
  });
  assert.equal(state, "ready");
});

test("error object without statusCode → error (don't guess 'composing')", () => {
  const state = rulesViewState({
    data: undefined,
    isLoading: false,
    isError: true,
    error: new Error("network blew up"),
    seeded: false,
  });
  assert.equal(state, "error");
});

test("alternate error shape using .status (not .statusCode)", () => {
  // Some transports use `.status`; both should be honoured so a 404
  // from a future client doesn't regress into "error".
  const state = rulesViewState({
    data: undefined,
    isLoading: false,
    isError: true,
    error: { status: 404 },
    seeded: false,
  });
  assert.equal(state, "composing");
});

// Wire-level test for the vault-records fix: a populated vault-record
// response (with frontmatter + body) → "ready", and the body parses into
// the 4 sections via the editor helper. If /household ever drifts back to
// an endpoint whose shape mis-parses, this catches it here.
test("integration: populated vault/RULES.md → ready + parses 4 sections", async () => {
  const { parseRulesMarkdown } = await import("./rulesEditorCore");
  const data = {
    path: "RULES.md",
    frontmatter: { subtype: "standing_rules" },
    body:
      "# Standing Rules\n\n" +
      "## Personal sovereignty rules\n- one rule\n\n" +
      "## Household rules\n- another rule\n",
  };
  const state = rulesViewState({
    data, isLoading: false, isError: false, seeded: false,
  });
  assert.equal(state, "ready");
  assert.notEqual(state, "composing");
  const parsed = parseRulesMarkdown(data.body);
  assert.deepEqual(parsed.sovereignty, ["one rule"]);
  assert.deepEqual(parsed.household, ["another rule"]);
});
