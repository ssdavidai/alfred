/**
 * F51 — ledger-row reversibility. Decision rows were hardcoded reversible:false
 * so the Undo control never showed even though reverseDecision existed. A row is
 * reversible iff the source marked it so AND it isn't already reversed AND it
 * has an id.
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/deskLedgerCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { rowReversible } from "./deskLedgerCore";

test("reversible when is_reversible and not yet reversed and has an id", () => {
  assert.equal(rowReversible({ is_reversible: true }, "dec-1"), true);
  assert.equal(rowReversible({ reversible: true }, "sw-1"), true);
});

test("not reversible once reversed_at is set", () => {
  assert.equal(
    rowReversible({ is_reversible: true, reversed_at: "2026-05-22T06:00:00Z" }, "dec-1"),
    false,
  );
});

test("not reversible when the source did not mark it (delegate / no flag)", () => {
  assert.equal(rowReversible({ is_reversible: false }, "dec-1"), false);
  assert.equal(rowReversible({}, "dec-1"), false);
});

test("not reversible without an id to reverse against", () => {
  assert.equal(rowReversible({ is_reversible: true }, ""), false);
  assert.equal(rowReversible({ is_reversible: true }, undefined), false);
});
