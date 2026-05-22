/**
 * F50 — Desk reconcile-on-success logic. Clear a card only on a real 2xx whose
 * effect landed. The trap is delegate: a 2xx can be a no-op (advisory card →
 * nothing_to_delegate, or a failed dispatch → dispatch_ok:false) and must keep
 * the card so failure isn't masked as success.
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/deskReconcileCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldClearCardOnSuccess } from "./deskReconcileCore";

test("non-delegate actions clear on any 2xx (sync flip already landed)", () => {
  assert.equal(shouldClearCardOnSuccess("defer", {}), true);
  assert.equal(shouldClearCardOnSuccess("delete", null), true);
  assert.equal(shouldClearCardOnSuccess("do", undefined), true);
  assert.equal(shouldClearCardOnSuccess("noise", {}), true);
});

test("delegate: dispatched / empty side-effects clears; no-op keeps the card", () => {
  assert.equal(shouldClearCardOnSuccess("delegate", { dispatch_ok: true }), true);
  assert.equal(shouldClearCardOnSuccess("delegate", null), true);
  assert.equal(shouldClearCardOnSuccess("delegate", { nothing_to_delegate: true }), false);
  assert.equal(shouldClearCardOnSuccess("delegate", { dispatch_ok: false }), false);
});
