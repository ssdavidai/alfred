// NAR v1 — burst clustering and statement unit tests. Issue #570.
// Fixtures constructed directly, never derived from production queries.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clusterBursts, computeNarStatement, DEFAULT_RATES, type RateTable } from "../src/db/nar.js";

const GAP   = DEFAULT_RATES.gap_threshold_min * 60_000; // 5 min in ms
const FLOOR = DEFAULT_RATES.burst_floor_min   * 60_000; // 2 min in ms

describe("clusterBursts", () => {
  it("two events inside gap threshold → one burst", () => {
    const ts = [new Date("2026-07-01T10:00:00Z"), new Date("2026-07-01T10:03:00Z")];
    const { burstCount, totalMs } = clusterBursts(ts, GAP, FLOOR);
    assert.strictEqual(burstCount, 1);
    assert.strictEqual(totalMs, 3 * 60_000); // 3 min span, above floor
  });

  it("two events outside gap threshold → two bursts, both floored", () => {
    const ts = [new Date("2026-07-01T10:00:00Z"), new Date("2026-07-01T10:10:00Z")];
    const { burstCount, totalMs } = clusterBursts(ts, GAP, FLOOR);
    assert.strictEqual(burstCount, 2);
    assert.strictEqual(totalMs, 2 * FLOOR);
  });

  it("isolated event gets the floor, not zero", () => {
    const { burstCount, totalMs } = clusterBursts([new Date("2026-07-01T10:00:00Z")], GAP, FLOOR);
    assert.strictEqual(burstCount, 1);
    assert.strictEqual(totalMs, FLOOR);
  });

  it("empty input → zeros, no throw", () => {
    const { burstCount, totalMs } = clusterBursts([], GAP, FLOOR);
    assert.strictEqual(burstCount, 0);
    assert.strictEqual(totalMs, 0);
  });

  it("first two close, third far → two bursts with correct totals", () => {
    const ts = [
      new Date("2026-07-01T10:00:00Z"),
      new Date("2026-07-01T10:02:00Z"), // 2 min — within threshold
      new Date("2026-07-01T10:20:00Z"), // 18 min — outside threshold
    ];
    const { burstCount, totalMs } = clusterBursts(ts, GAP, FLOOR);
    assert.strictEqual(burstCount, 2);
    assert.strictEqual(totalMs, 2 * 60_000 + FLOOR); // 2-min burst + floored isolated
  });

  it("gap exactly equal to threshold is same burst (inclusive boundary)", () => {
    const ts = [new Date("2026-07-01T10:00:00Z"), new Date("2026-07-01T10:05:00Z")];
    assert.strictEqual(clusterBursts(ts, GAP, FLOOR).burstCount, 1);
  });
});

describe("computeNarStatement", () => {
  it("empty month → all zeros, no throw", () => {
    const s = computeNarStatement("2026-07",
      { noise: 0, done: 0, delegate: 0, defer: 0, take_mine: 0 }, [], 0, DEFAULT_RATES);
    assert.strictEqual(s.displaced.total_hours, 0);
    assert.strictEqual(s.mess_bill.total_hours, 0);
    assert.strictEqual(s.interruption.total_hours, 0);
    assert.strictEqual(s.nar, 0);
    assert.strictEqual(s.mess_bill.burst_count, 0);
    assert.strictEqual(s.mess_bill.event_count, 0);
  });

  it("rates in response match those used in arithmetic — custom table (no drift)", () => {
    // Non-default noise rate: if code used DEFAULT_RATES internally but reported custom,
    // the arithmetic assertion would expose it.
    const custom: RateTable = { ...DEFAULT_RATES, decision_noise_min: 6 };
    const s = computeNarStatement("2026-07",
      { noise: 10, done: 0, delegate: 0, defer: 0, take_mine: 0 }, [], 0, custom);
    assert.strictEqual(s.rates.decision_noise_min, 6);
    assert.strictEqual(s.displaced.total_hours, 1.0); // 10 × 6 min = 60 min = 1.0 h
  });

  it("positive NAR when displaced dominates; counts are surfaced", () => {
    // 1 delegate = 10 min displaced; 1 isolated event = 2 min mess bill
    const s = computeNarStatement("2026-07",
      { noise: 0, done: 0, delegate: 1, defer: 0, take_mine: 0 },
      [new Date("2026-07-15T10:00:00Z")], 0, DEFAULT_RATES);
    assert.ok(s.nar >= 0, `expected non-negative NAR, got ${s.nar}`);
    assert.strictEqual(s.displaced.counts.delegate, 1);
    assert.strictEqual(s.mess_bill.event_count, 1);
  });

  it("negative NAR reported honestly when mess_bill dominates", () => {
    const ts = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 6, 1, 10, i)));
    const s = computeNarStatement("2026-07",
      { noise: 0, done: 0, delegate: 0, defer: 0, take_mine: 0 }, ts, 0, DEFAULT_RATES);
    assert.ok(s.nar < 0, `expected negative NAR, got ${s.nar}`);
    assert.strictEqual(s.mess_bill.burst_count, 1);
  });

  it("self-consistent: displaced − mess_bill − interruption === nar exactly", () => {
    // 6 done × 3 min = 18 min displaced → toH(18) = 0.3
    // 2 events 3 min apart (above 2 min floor) → burst 3 min → toH(3) = 0.1
    // 1 interruption × 3 min rate → toH(3) = 0.1
    // Pre-fix bug: nar = toH(18-3-3) = toH(12) = 0.2; round-then-subtract: 0.3-0.1-0.1 = 0.1
    const custom: RateTable = { ...DEFAULT_RATES, interruption_min: 3 };
    const ts = [new Date("2026-07-01T10:00:00Z"), new Date("2026-07-01T10:03:00Z")];
    const s = computeNarStatement("2026-07",
      { noise: 0, done: 6, delegate: 0, defer: 0, take_mine: 0 }, ts, 1, custom);
    const expected = +(s.displaced.total_hours - s.mess_bill.total_hours - s.interruption.total_hours).toFixed(1);
    assert.strictEqual(s.nar, expected, "nar must equal displaced − mess_bill − interruption after rounding");
  });
});
