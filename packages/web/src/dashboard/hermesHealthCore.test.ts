/**
 * Hermes-auth banner — passive-signal derivation.
 *
 * Run with:  cd packages/web && npx tsx --test src/dashboard/hermesHealthCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveHermesHealthFromProgress } from "./hermesHealthCore";

const NOW = Date.parse("2026-05-23T12:00:00Z");
const RECENT = "2026-05-23T11:30:00Z"; // 30 min ago
const OLD = "2026-05-23T10:00:00Z";    // 2 h ago

test("empty progress reads healthy", () => {
  const h = deriveHermesHealthFromProgress({}, NOW);
  assert.equal(h.healthy, true);
  assert.deepEqual(h.degradedStages, []);
  assert.equal(h.lastDegradeWithinHour, false);
});

test("recent degrade on patterns/personalize reads unhealthy", () => {
  const h = deriveHermesHealthFromProgress(
    { stage: "done", degraded_stages: ["patterns", "personalize"], started_at: RECENT },
    NOW,
  );
  assert.equal(h.healthy, false);
  assert.deepEqual(h.degradedStages, ["patterns", "personalize"]);
  assert.equal(h.lastDegradeWithinHour, true);
});

test("old degrade (>1h) reads healthy (stale)", () => {
  const h = deriveHermesHealthFromProgress(
    { degraded_stages: ["patterns", "personalize"], started_at: OLD },
    NOW,
  );
  assert.equal(h.healthy, true);
  assert.equal(h.lastDegradeWithinHour, false);
});

test("any single stage degraded (e.g. metadata) still reads unhealthy", () => {
  const h = deriveHermesHealthFromProgress(
    { degraded_stages: ["metadata"], started_at: RECENT },
    NOW,
  );
  assert.equal(h.healthy, false);
  assert.deepEqual(h.degradedStages, ["metadata"]);
});

test("malformed progress reads healthy (fail-safe)", () => {
  assert.equal(deriveHermesHealthFromProgress(null, NOW).healthy, true);
  assert.equal(deriveHermesHealthFromProgress(undefined, NOW).healthy, true);
  assert.equal(deriveHermesHealthFromProgress("oops", NOW).healthy, true);
  assert.equal(deriveHermesHealthFromProgress(42, NOW).healthy, true);
  assert.equal(deriveHermesHealthFromProgress([], NOW).healthy, true);
  assert.equal(
    deriveHermesHealthFromProgress({ degraded_stages: "not-an-array" }, NOW).healthy,
    true,
  );
  assert.equal(
    deriveHermesHealthFromProgress(
      { degraded_stages: [123, null, ""], started_at: RECENT }, NOW,
    ).healthy,
    true,
  );
});

test("degraded_stages without a parseable timestamp reads healthy", () => {
  const h = deriveHermesHealthFromProgress({ degraded_stages: ["patterns"] }, NOW);
  assert.equal(h.healthy, true);
});

test("accepts updated_at / degraded_at as recency anchors", () => {
  assert.equal(
    deriveHermesHealthFromProgress(
      { degraded_stages: ["patterns"], updated_at: RECENT }, NOW,
    ).healthy,
    false,
  );
  assert.equal(
    deriveHermesHealthFromProgress(
      { degraded_stages: ["patterns"], degraded_at: RECENT }, NOW,
    ).healthy,
    false,
  );
});

test("future timestamp does not count as recent (clock-skew guard)", () => {
  const future = new Date(NOW + 5 * 60_000).toISOString();
  const h = deriveHermesHealthFromProgress(
    { degraded_stages: ["patterns"], started_at: future }, NOW,
  );
  assert.equal(h.healthy, true);
});
