/**
 * Phase-2 Lane III · Commit 1 — failing-test-first for the /household
 * RULES.md empty-state.
 *
 *   (a) 404 on getWorkspaceFile("RULES.md") → "composing"  (the new
 *       behaviour; current code renders "couldn't load — Retry")
 *   (b) RULES.md fetched successfully           → "ready"
 *   (c) 500 from the workspace endpoint         → "error"
 *
 * Run with:
 *   cd packages/web && npx vitest run src/onboarding/rulesEmptyStateCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { rulesViewState } from "./rulesEmptyStateCore";

test("404 on RULES.md → composing (new behaviour, not 'error')", () => {
  const state = rulesViewState({
    data: undefined,
    isLoading: false,
    isError: true,
    error: { statusCode: 404, message: "RULES.md not found" },
    seeded: false,
  });
  assert.equal(state, "composing");
});

test("RULES.md fixture loaded → ready (editor renders)", () => {
  const state = rulesViewState({
    data: { content: "# RULES.md\n\n- Confirm large outbound moves with sir." },
    isLoading: false,
    isError: false,
    seeded: false,
  });
  assert.equal(state, "ready");
});

test("500 from workspace endpoint → error (existing 'Retry' branch)", () => {
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
    data: { content: "# RULES.md\n- Already loaded once." },
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
