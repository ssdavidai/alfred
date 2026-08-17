// Unit tests for instinctOpsCore.ts (#459, #584).
// Run: cd packages/web && npx tsx --test src/intuition/instinctOpsCore.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deriveInstinctSlug, observationProseFromRow, OBSERVATION_PATH } from "./instinctOpsCore.js";

// ── 1. slug derivation ────────────────────────────────────────────────────────

test("slug: vault path with directory", () => {
  assert.equal(deriveInstinctSlug("instinct/foo-bar.md"), "foo-bar");
});
test("slug: bare .md slug", () => {
  assert.equal(deriveInstinctSlug("foo-bar.md"), "foo-bar");
});
test("slug: bare slug no extension", () => {
  assert.equal(deriveInstinctSlug("foo-bar"), "foo-bar");
});
test("slug: mid-string dots preserved", () => {
  assert.equal(deriveInstinctSlug("instinct/foo.bar.baz"), "foo.bar.baz");
  assert.equal(deriveInstinctSlug("foo.bar.baz"), "foo.bar.baz");
});
test("slug: double-.md bug is fixed — idempotent", () => {
  // The original bug: split("/").pop() on "instinct/foo.md" → "foo.md" (not "foo").
  assert.equal(deriveInstinctSlug("instinct/close-stale-cards.md"), "close-stale-cards");
  assert.equal(
    deriveInstinctSlug(deriveInstinctSlug("instinct/close-stale-cards.md")),
    "close-stale-cards",
  );
});

// ── 2. observations endpoint path ────────────────────────────────────────────

test("OBSERVATION_PATH is the state endpoint", () => {
  assert.equal(OBSERVATION_PATH, "/api/v1/state/observations");
  assert.ok(!OBSERVATION_PATH.includes("vault"));
});
test("operations.ts uses state endpoint, not vault/list/observation", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "./operations.ts"), "utf8");
  assert.ok(src.includes("/api/v1/state/observations"), "must reference state endpoint");
  assert.ok(!src.includes("/api/v1/vault/list/observation"), "must not reference empty vault dir");
});

// ── 3. observation row prose — missing text renders nothing ───────────────────

test("prose: empty / null / undefined row → empty string", () => {
  assert.equal(observationProseFromRow({}), "");
  assert.equal(observationProseFromRow(null), "");
  assert.equal(observationProseFromRow(undefined), "");
  assert.equal(observationProseFromRow({ kind: "pattern_proposal" }), "");
});
test("prose: state DB summary returned", () => {
  assert.equal(observationProseFromRow({ summary: "Alfred noticed billing" }), "Alfred noticed billing");
});
test("prose: whitespace-only summary → empty string (no stray bullet)", () => {
  assert.equal(observationProseFromRow({ summary: "   " }), "");
});
test("prose: falls back to frontmatter.fact for legacy vault rows", () => {
  assert.equal(
    observationProseFromRow({ frontmatter: { fact: "vault fact" } }),
    "vault fact",
  );
});
test("prose: summary takes priority over frontmatter.fact", () => {
  assert.equal(
    observationProseFromRow({ summary: "state summary", frontmatter: { fact: "vault fact" } }),
    "state summary",
  );
});

// ── 4. no user-facing "Patterns" label ───────────────────────────────────────

test('Frame.tsx nav label is "Instincts"', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "../client/components/ab/Frame.tsx"),
    "utf8",
  );
  assert.ok(!src.includes('label: "Patterns"'), 'Frame.tsx still has label: "Patterns"');
  assert.ok(src.includes('label: "Instincts"'), 'Frame.tsx missing label: "Instincts"');
});
test("InstinctsPage.tsx has no Patterns JSX label or toggle", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "./InstinctsPage.tsx"), "utf8");
  assert.ok(!/>\s*Patterns\s*</.test(src), "still renders >Patterns< JSX label");
  assert.ok(!src.includes('"Patterns:'), 'still has "Patterns:" toggle label');
});
