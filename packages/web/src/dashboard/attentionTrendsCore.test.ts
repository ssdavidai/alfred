/**
 * attentionTrendsCore unit tests (#584 TRENDS tab).
 * Run: cd packages/web && npx tsx --test src/dashboard/attentionTrendsCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  derivePeriodLabel, isPartialPeriod, GRAIN_FULL_DAYS,
  deriveNarBars, deriveSeriesMax, deriveTrendsSummary,
  deriveAllocationBars, deriveRatioBars, deriveBucketBars, deriveOutcomesBars,
  isReadGenerated, BUCKET_KEYS, LOW_ENGAGEMENT_HOURS,
  type TrendsPeriod,
} from "./attentionTrendsCore";

// ── Fixture factory ───────────────────────────────────────────────────────────

const mkP = (key: string, days: number, disp: number, eng: number, nar: number, ratio: number | null, ins = true, work = 0, life = 0): TrendsPeriod => ({
  key, start: key, end: key, days,
  nar_hours: nar, displaced_hours: disp, engaged_hours: eng, interruption_hours: 0, interruption_instrumented: ins,
  return_ratio: ratio,
  allocation: { work:{displaced_hours:work,engaged_hours:0}, life:{displaced_hours:life,engaged_hours:0}, unallocated:{displaced_hours:Math.max(disp-work-life,0),engaged_hours:eng} },
  by_class: { conversational:{displaced_hours:0,engaged_hours:0,count:0}, autonomous:{displaced_hours:0,engaged_hours:0,count:0}, explicit:{displaced_hours:0,engaged_hours:0,count:0} },
  by_bucket: { S:{count:14,displaced_hours:1}, M:{count:25,displaced_hours:3}, L:{count:10,displaced_hours:4}, XL:{count:6,displaced_hours:5} },
  unbucketed: { count: 216, displaced_hours: 0.1 },
  outcomes: { delivered: 26, failed: 18, unknown: 0 },
  sessions: 5,
});

// Real home data from the brief
const W21 = mkP("2026-W21", 2, 1.2, 0, 1.2, null, false);              // 2-day partial, uninstrumented
const W22 = mkP("2026-W22", 7, 16.5, 3.7, 12.7, 4.4, true, 3.3, 4.8);
const W32 = mkP("2026-W32", 7, 24.6, 6.8, 17.8, 3.6, true, 14.8, 2.5);
const W33 = mkP("2026-W33", 6, 22.5, 6.4, 15.4, 3.5, true, 14.0, 2.6); // 6-day partial
const W24 = mkP("2026-W24", 7, 11.6, 0.8, 10.8, 13.9, false);          // high ratio, low engagement

// ── 1. Period labels — all three grains ───────────────────────────────────────

test("label: renders for all three grains and falls through on unknown key", () => {
  assert.equal(derivePeriodLabel("2026-W22", "week"), "W22");
  assert.equal(derivePeriodLabel("2026-W9",  "week"), "W9");
  assert.equal(derivePeriodLabel("2026-05", "month"), "May");
  assert.equal(derivePeriodLabel("2026-01", "month"), "Jan");
  assert.equal(derivePeriodLabel("2026-12", "month"), "Dec");
  assert.equal(derivePeriodLabel("2026-Q2", "quarter"), "Q2");
  assert.equal(derivePeriodLabel("2026-Q4", "quarter"), "Q4");
  assert.equal(derivePeriodLabel("unknown", "week"), "unknown");
});

// ── 2. Partial period detection ────────────────────────────────────────────────

test("isPartialPeriod: W21 (2d) and W33 (6d) are partial; full weeks are not", () => {
  assert.equal(isPartialPeriod({ days: 7 }, "week"), false);
  assert.equal(isPartialPeriod({ days: 2 }, "week"), true,  "W21 (2d) must be flagged partial");
  assert.equal(isPartialPeriod({ days: 6 }, "week"), true,  "W33 (6d < 7) must be flagged partial");
  assert.equal(isPartialPeriod({ days: 28 }, "month"), false);
  assert.equal(isPartialPeriod({ days: 20 }, "month"), true);
  assert.ok(GRAIN_FULL_DAYS.week === 7 && GRAIN_FULL_DAYS.month > 0 && GRAIN_FULL_DAYS.quarter > 0);
});

// ── 3. NarBars — partial and uninstrumented flags ──────────────────────────────

test("deriveNarBars: partial and uninstrumented flags; values preserved; null-safe", () => {
  const bars = deriveNarBars([W21, W22, W32, W33], "week");
  assert.equal(bars[0].partial, true);  assert.equal(bars[0].uninstrumented, true,  "W21 uninstrumented");
  assert.equal(bars[1].partial, false); assert.equal(bars[1].uninstrumented, false, "W22 instrumented");
  assert.equal(bars[3].partial, true,  "W33 (6d) partial"); assert.equal(bars[3].uninstrumented, false);
  const [b32] = deriveNarBars([W32], "week");
  assert.equal(b32.displaced_hours, 24.6); assert.equal(b32.nar_hours, 17.8); assert.equal(b32.label, "W32");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(deriveNarBars(null as any, "week"), []);
});

// ── 4. Chart scaling — real range + all-zero guard ────────────────────────────

test("deriveSeriesMax: handles real home range (no clipping) and all-zero period", () => {
  const max = deriveSeriesMax([W21,W22,W32,W33].map(p => p.nar_hours));
  assert.ok(max >= 17.8, `max ${max} >= 17.8 — real range must not clip`);
  assert.equal(deriveSeriesMax([0, 0, 0]), 1, "all-zero → 1 guard");
  assert.equal(deriveSeriesMax([]), 1, "empty → 1 guard");
});

// ── 5. Summary — null ratio preserved; direction; delta ───────────────────────

test("deriveTrendsSummary: null ratio stays null (never 0); delta; direction; empty", () => {
  assert.deepEqual(deriveTrendsSummary([]), { latest_nar: null, nar_delta: null, latest_ratio: null, ratio_direction: null });
  const s1 = deriveTrendsSummary([W21]);
  assert.equal(s1.latest_ratio, null, "W21 return_ratio=null must remain null — em-dash in view");
  assert.equal(s1.nar_delta, null);
  const s2 = deriveTrendsSummary([W32, W33]);
  assert.equal(s2.ratio_direction, "down", "3.6→3.5 is down");
  assert.ok(Math.abs((s2.nar_delta ?? 0) - (15.4 - 17.8)) < 0.01);
  assert.equal(deriveTrendsSummary([W21, W32]).ratio_direction, null, "prev ratio null → direction null");
});

// ── 6. Allocation bars ────────────────────────────────────────────────────────

test("deriveAllocationBars: work/life values correct; total guard prevents div-by-zero", () => {
  const [bar] = deriveAllocationBars([W22], "week");
  assert.ok(Math.abs(bar.work - 3.3) < 0.01); assert.ok(Math.abs(bar.life - 4.8) < 0.01);
  const [z] = deriveAllocationBars([{ ...W21, allocation:{work:{displaced_hours:0,engaged_hours:0},life:{displaced_hours:0,engaged_hours:0},unallocated:{displaced_hours:0,engaged_hours:0}} }], "week");
  assert.ok(z.total > 0, "total guard: never 0 (would cause div-by-zero in chart)");
});

// ── 7. Ratio bars — honesty rules ─────────────────────────────────────────────

test("deriveRatioBars: null ratio preserved; low-engagement and uninstrumented flags", () => {
  const bars = deriveRatioBars([W21, W24, W32], "week");
  assert.equal(bars[0].ratio, null, "W21 null ratio — never coerced to 0");
  assert.equal(bars[1].low_engagement, true,  "W24 (0.8h < threshold) is low-engagement");
  assert.equal(bars[2].low_engagement, false, "W32 (6.8h) is not low-engagement");
  assert.equal(bars[0].uninstrumented, true); assert.equal(bars[2].uninstrumented, false);
  assert.ok(LOW_ENGAGEMENT_HOURS > 0);
});

// ── 8. Bucket bars — unbucketed NEVER among S/M/L/XL ─────────────────────────

test("deriveBucketBars: S/M/L/XL from by_bucket; unbucketed is footnote-only and excluded from sum", () => {
  const [bar] = deriveBucketBars([W32], "week");
  assert.equal(bar.S, 14); assert.equal(bar.M, 25); assert.equal(bar.L, 10); assert.equal(bar.XL, 6);
  assert.equal(bar.unbucketed_count, 216);
  assert.ok(bar.S + bar.M + bar.L + bar.XL < 300, "named sum must not include 216 unbucketed");
  assert.deepEqual(BUCKET_KEYS as readonly string[], ["S","M","L","XL"]);
  assert.ok(!(BUCKET_KEYS as readonly string[]).includes("unbucketed"));
});

// ── 9. Outcomes bars — W32 failure count preserved ────────────────────────────

test("deriveOutcomesBars: W32 18 failures survive derivation; total consistent", () => {
  const [bar] = deriveOutcomesBars([W32], "week");
  assert.equal(bar.failed, 18, "18 failures must reach the view unchanged");
  assert.equal(bar.delivered, 26);
  assert.equal(bar.total, bar.delivered + bar.failed + bar.unknown);
});

// ── 10. Read presence guard ───────────────────────────────────────────────────

test("isReadGenerated: null/undefined → false; object (even empty) → true", () => {
  assert.equal(isReadGenerated(null), false); assert.equal(isReadGenerated(undefined), false);
  assert.equal(isReadGenerated({ generated_at: "2026-08-10", observations: [] }), true);
  assert.equal(isReadGenerated({ generated_at: "2026-08-10", observations: [{ headline:"h",detail:"d",evidence:"e" }] }), true);
});
