// #447 — /instincts must render frontmatter.tier, failing closed.
//
// The mapping is a safety surface: it tells Sir whether Alfred will act
// unattended. These tests pin it against the same rules the router uses
// (signal_actions._instinct_tier), so the badge and the gate cannot drift.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTONOMOUS_TIER,
  actsUnattended,
  autonomyStatement,
  discretionThreshold,
  effectiveThreshold,
  nextTier,
  progressNote,
  readTier,
  tierCaption,
} from "./instinctTierCore";

const inst = (tier: unknown, fm: Record<string, unknown> = {}) => ({
  path: "instinct/test.md",
  frontmatter: { name: "test", ...fm, ...(tier === undefined ? {} : { tier }) },
});

test("readTier returns each valid tier", () => {
  for (const t of ["Asking", "Confirming", "Acting"]) {
    assert.equal(readTier(inst(t)), t);
  }
});

test("readTier tolerates case and whitespace", () => {
  assert.equal(readTier(inst("  acting ")), "Acting");
  assert.equal(readTier(inst("ASKING")), "Asking");
  assert.equal(readTier(inst("cOnFiRmInG")), "Confirming");
});

test("readTier fails closed on absent tier", () => {
  assert.equal(readTier(inst(undefined)), "Asking");
  assert.equal(readTier({}), "Asking");
  assert.equal(readTier(null), "Asking");
  assert.equal(readTier(undefined), "Asking");
});

test("readTier fails closed on unknown or non-string tier", () => {
  assert.equal(readTier(inst("Autonomous")), "Asking");
  assert.equal(readTier(inst("")), "Asking");
  assert.equal(readTier(inst("   ")), "Asking");
  assert.equal(readTier(inst(1)), "Asking");
  assert.equal(readTier(inst(true)), "Asking");
  assert.equal(readTier(inst({ tier: "Acting" })), "Asking");
});

test("readTier ignores the legacy execution.tier shape", () => {
  // The exact live shape behind the 2026-08-06 ElevenLabs email: the nested
  // numeric tier + requires_approval:false must not buy autonomy when the
  // ladder says Asking.
  const rec = inst("Asking", {
    execution: { enabled: true, requires_approval: false, tier: 1 },
  });
  assert.equal(readTier(rec), "Asking");
  assert.equal(actsUnattended(rec), false);
});

test("readTier accepts a bare frontmatter mapping", () => {
  assert.equal(readTier({ tier: "Acting" }), "Acting");
});

test("only Acting acts unattended", () => {
  assert.equal(actsUnattended(inst("Acting")), true);
  assert.equal(actsUnattended(inst("Confirming")), false);
  assert.equal(actsUnattended(inst("Asking")), false);
  assert.equal(AUTONOMOUS_TIER, "Acting");
});

test("high observation count does NOT imply Acting", () => {
  // The old classifyStage() rendered >=20 observations as Acting. The
  // ladder is Reflection-driven, so a well-observed Asking instinct must
  // still read Asking — this is the live close-stale case (23 obs).
  const rec = inst("Asking", { observation_count: 23, confidence_score: 0.94 });
  assert.equal(readTier(rec), "Asking");
  assert.equal(actsUnattended(rec), false);
});

test("autonomy statements distinguish acting from waiting", () => {
  assert.match(autonomyStatement("Acting"), /without asking/i);
  assert.match(autonomyStatement("Confirming"), /confirm/i);
  assert.match(autonomyStatement("Asking"), /ask/i);
  // Neither non-Acting tier may claim autonomy.
  for (const s of ["Asking", "Confirming"] as const) {
    assert.doesNotMatch(autonomyStatement(s), /without asking/i);
  }
});

test("tier captions are distinct", () => {
  const caps = (["Asking", "Confirming", "Acting"] as const).map(tierCaption);
  assert.equal(new Set(caps).size, 3);
});

test("discretionThreshold matches the python table", () => {
  assert.equal(discretionThreshold(0), 0.95);
  assert.equal(discretionThreshold(4), 0.95);
  assert.equal(discretionThreshold(5), 0.9);
  assert.equal(discretionThreshold(9), 0.9);
  assert.equal(discretionThreshold(10), 0.85);
  assert.equal(discretionThreshold(19), 0.85);
  assert.equal(discretionThreshold(20), 0.8);
  assert.equal(discretionThreshold(49), 0.8);
  assert.equal(discretionThreshold(50), 0.75);
});

test("effectiveThreshold override is raise-only", () => {
  assert.equal(effectiveThreshold(inst("Acting", { discretion_threshold: 0.6 }), 10), 0.85);
  assert.equal(effectiveThreshold(inst("Acting", { discretion_threshold: 0.99 }), 10), 0.99);
});

test("effectiveThreshold ignores garbage overrides", () => {
  assert.equal(effectiveThreshold(inst("Acting", { discretion_threshold: "abc" }), 10), 0.85);
  assert.equal(effectiveThreshold(inst("Acting", { discretion_threshold: -1 }), 10), 0.85);
  assert.equal(effectiveThreshold(inst("Acting"), 10), 0.85);
  // Strings are what the vault actually stores.
  assert.equal(effectiveThreshold(inst("Acting", { discretion_threshold: "0.99" }), 10), 0.99);
});

test("nextTier walks the ladder and stops at the top", () => {
  assert.equal(nextTier("Asking"), "Confirming");
  assert.equal(nextTier("Confirming"), "Acting");
  assert.equal(nextTier("Acting"), null);
});

test("progressNote pluralises and never promises promotion", () => {
  assert.match(progressNote("Asking", 1), /^1 observation recorded/);
  assert.match(progressNote("Asking", 0), /^0 observations recorded/);
  assert.match(progressNote("Asking", 3), /proposes Confirming/);
  assert.match(progressNote("Acting", 30), /highest tier/);
});
