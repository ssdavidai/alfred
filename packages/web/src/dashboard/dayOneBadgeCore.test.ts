/**
 * Phase-2 Lane III · Commit 2 — failing-test-first for the /desk Day-1
 * introduction badge.
 *
 *   (a) needs_attention card with tags=["day_one"] AND
 *       source="onboarding_seed" → badge visible
 *   (b) regular needs_attention card → no badge
 *   (c) onboarding_seed alone (no day_one tag) → no badge
 *   (d) day_one tag alone (different source) → no badge
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/dayOneBadgeCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractDayOneMarkers,
  isDayOneIntroduction,
} from "./dayOneBadgeCore";

test("top-level source + day_one tag → badge visible", () => {
  const record = {
    id: "01HXYZ",
    source: "onboarding_seed",
    tags: ["day_one", "intro"],
  };
  const m = extractDayOneMarkers(record);
  assert.equal(m.source, "onboarding_seed");
  assert.deepEqual(m.tags.sort(), ["day_one", "intro"]);
  assert.equal(isDayOneIntroduction(m), true);
});

test("markers nested under frontmatter (older NA shape) → badged", () => {
  const record = {
    frontmatter: { source: "onboarding_seed", tags: ["day_one"] },
  };
  assert.equal(isDayOneIntroduction(extractDayOneMarkers(record)), true);
});

test("markers split across top-level + frontmatter → badged", () => {
  const record = {
    tags: ["day_one"],
    frontmatter: { source: "onboarding_seed" },
  };
  assert.equal(isDayOneIntroduction(extractDayOneMarkers(record)), true);
});

test("regular needs_attention card → no badge", () => {
  const record = {
    action_what: "Reply to the Smythson invoice?",
    tags: ["email", "vendor"],
  };
  assert.equal(isDayOneIntroduction(extractDayOneMarkers(record)), false);
});

test("empty / null record → no badge", () => {
  assert.equal(isDayOneIntroduction(extractDayOneMarkers(null)), false);
  assert.equal(isDayOneIntroduction(extractDayOneMarkers({})), false);
});

test("onboarding_seed source but no day_one tag → no badge", () => {
  const record = { source: "onboarding_seed", tags: ["chore_prompt"] };
  assert.equal(isDayOneIntroduction(extractDayOneMarkers(record)), false);
});

test("day_one tag alone (different source) → no badge", () => {
  const record = { source: "signal_extractor", tags: ["day_one"] };
  assert.equal(isDayOneIntroduction(extractDayOneMarkers(record)), false);
});

test("tags stored as a comma-separated string still match", () => {
  const record = { source: "onboarding_seed", tags: "day_one, intro" };
  assert.equal(isDayOneIntroduction(extractDayOneMarkers(record)), true);
});

test("tag case is ignored — Day_One matches day_one", () => {
  const record = { source: "onboarding_seed", tags: ["Day_One"] };
  assert.equal(isDayOneIntroduction(extractDayOneMarkers(record)), true);
});

test("source comparison is exact — 'onboarding' alone is not a seed", () => {
  const record = { source: "onboarding", tags: ["day_one"] };
  assert.equal(isDayOneIntroduction(extractDayOneMarkers(record)), false);
});
