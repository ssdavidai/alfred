// engaged-time.test.ts — unit tests for clusterBursts (#563 item 1).
//
// All expected values are computed by hand from the fixture inputs.
// The function sorts its input internally; the unsorted-input test
// verifies that contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterBursts } from "../src/db/engagedTime.js";

const MIN = 60_000; // one minute in milliseconds

// ─── helpers ────────────────────────────────────────────────────────────────

function d(isoStr: string): Date { return new Date(isoStr); }

// ─── tests ──────────────────────────────────────────────────────────────────

test("empty input returns zero and does not throw", () => {
  const result = clusterBursts([], 5 * MIN, 2 * MIN);
  assert.equal(result.totalMs, 0);
  assert.equal(result.burstCount, 0);
});

test("two events inside the gap threshold form one burst", () => {
  // t0 and t1 are 3 min apart; gap threshold is 5 min → same burst.
  // Span = 3 min > floor 2 min, so contribution = 3 min.
  const t0 = d("2026-08-01T09:00:00Z");
  const t1 = d("2026-08-01T09:03:00Z");
  const { totalMs, burstCount } = clusterBursts([t0, t1], 5 * MIN, 2 * MIN);
  assert.equal(burstCount, 1);
  assert.equal(totalMs, 3 * MIN);
});

test("two events outside the gap threshold form two bursts", () => {
  // t0 and t1 are 10 min apart; gap threshold is 5 min → separate bursts.
  // Each is an isolated event (span 0), floored at 2 min each → total 4 min.
  const t0 = d("2026-08-01T09:00:00Z");
  const t1 = d("2026-08-01T09:10:00Z");
  const { totalMs, burstCount } = clusterBursts([t0, t1], 5 * MIN, 2 * MIN);
  assert.equal(burstCount, 2);
  assert.equal(totalMs, 4 * MIN);
});

test("isolated single event contributes the floor, not zero", () => {
  // A single timestamp has span 0; the floor applies.
  const t0 = d("2026-08-01T10:00:00Z");
  const { totalMs, burstCount } = clusterBursts([t0], 5 * MIN, 2 * MIN);
  assert.equal(burstCount, 1);
  assert.equal(totalMs, 2 * MIN);
});

test("unsorted input produces the same result as sorted input", () => {
  // t0, t1 are 2 min apart (same burst); t2 is 18 min after t1 (new burst).
  // Sorted:   burst 1 = [t0, t1] span 2 min; burst 2 = [t2] span 0 → floor 2 min.
  //           totalMs = 2+2 = 4 min, burstCount = 2.
  // Unsorted: [t2, t0, t1] — must produce identical result.
  const t0 = d("2026-08-01T09:00:00Z");
  const t1 = d("2026-08-01T09:02:00Z");
  const t2 = d("2026-08-01T09:20:00Z");

  const fromSorted   = clusterBursts([t0, t1, t2], 5 * MIN, 2 * MIN);
  const fromUnsorted = clusterBursts([t2, t0, t1], 5 * MIN, 2 * MIN);

  assert.equal(fromUnsorted.totalMs,    fromSorted.totalMs);
  assert.equal(fromUnsorted.burstCount, fromSorted.burstCount);

  // Sanity-check the expected values (derived by hand above).
  assert.equal(fromSorted.totalMs, 4 * MIN);
  assert.equal(fromSorted.burstCount, 2);
});

test("floor sensitivity: different floor values produce different totals", () => {
  // A single isolated event has span 0, so total = floor exactly.
  // floor=2min → totalMs=2min; floor=5min → totalMs=5min.
  const t0 = d("2026-08-01T10:00:00Z");
  const r2 = clusterBursts([t0], 5 * MIN, 2 * MIN);
  const r5 = clusterBursts([t0], 5 * MIN, 5 * MIN);
  assert.equal(r2.totalMs, 2 * MIN);
  assert.equal(r5.totalMs, 5 * MIN);
  assert.notEqual(r2.totalMs, r5.totalMs); // the parameter cannot be a no-op
});

test("floor does not apply when burst span exceeds it", () => {
  // t0 and t1 are 10 min apart within a 15 min gap threshold → one burst.
  // Span = 10 min > floor 2 min, so contribution = 10 min (not 2 min).
  const t0 = d("2026-08-01T09:00:00Z");
  const t1 = d("2026-08-01T09:10:00Z");
  const { totalMs, burstCount } = clusterBursts([t0, t1], 15 * MIN, 2 * MIN);
  assert.equal(burstCount, 1);
  assert.equal(totalMs, 10 * MIN);
});

test("three events spanning two bursts — mixed span and floor", () => {
  // t0+t1 are 3 min apart (same burst, span 3 min > floor 2 min).
  // t1→t2 gap is 8 min > 5 min threshold → new burst; t2 is isolated, floor applies.
  // Burst 1: 3 min. Burst 2: 2 min (floor). Total: 5 min.
  const t0 = d("2026-08-01T09:00:00Z");
  const t1 = d("2026-08-01T09:03:00Z");
  const t2 = d("2026-08-01T09:11:00Z");
  const { totalMs, burstCount } = clusterBursts([t0, t1, t2], 5 * MIN, 2 * MIN);
  assert.equal(burstCount, 2);
  assert.equal(totalMs, 5 * MIN);
});
