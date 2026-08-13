/**
 * deskBulkTriageCore tests.
 * Run: cd packages/web && npx tsx --test src/dashboard/deskBulkTriageCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addToSelection, removeFromSelection, clearSelection, selectAll,
  canSubmit, mapPreviewResponse,
} from "./deskBulkTriageCore";

test("addToSelection adds an id", () => {
  assert.ok(addToSelection(new Set(), "a").has("a"));
});
test("addToSelection is idempotent", () => {
  assert.equal(addToSelection(new Set(["a"]), "a").size, 1);
});
test("addToSelection does not mutate original", () => {
  const orig = new Set(["a"]); addToSelection(orig, "b");
  assert.equal(orig.size, 1);
});
test("removeFromSelection removes an id", () => {
  const s = removeFromSelection(new Set(["a", "b"]), "a");
  assert.ok(!s.has("a")); assert.ok(s.has("b"));
});
test("removeFromSelection on missing id is safe", () => {
  assert.equal(removeFromSelection(new Set(["a"]), "z").size, 1);
});
test("clearSelection returns empty set", () => {
  assert.equal(clearSelection().size, 0);
});
test("selectAll selects every id", () => {
  const s = selectAll(["a", "b", "c"]);
  assert.equal(s.size, 3); assert.ok(s.has("c"));
});
test("selectAll on empty list returns empty set", () => {
  assert.equal(selectAll([]).size, 0);
});

test("empty selection cannot submit", () => {
  assert.equal(canSubmit(new Set()), false);
});
test("non-empty selection can submit", () => {
  assert.equal(canSubmit(new Set(["x"])), true);
});

test("maps valid server response", () => {
  const r = mapPreviewResponse({ would_apply: 5, would_skip: 2, noise_warning: "Warning.", reversal_note: "Manual." });
  assert.equal(r.would_apply, 5); assert.equal(r.noise_warning, "Warning."); assert.equal(r.reversal_note, "Manual.");
});
test("null noise_warning when absent", () => {
  assert.equal(mapPreviewResponse({ would_apply: 3 }).noise_warning, null);
});
test("null reversal_note when absent", () => {
  assert.equal(mapPreviewResponse({ would_apply: 3 }).reversal_note, null);
});
test("safe defaults on null input", () => {
  const r = mapPreviewResponse(null);
  assert.equal(r.would_apply, 0); assert.equal(r.would_skip, 0);
});
