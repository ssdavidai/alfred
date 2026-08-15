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
  trimEmptyEdgePeriods, READ_EMPTY_STATE_TEXT,
  POLL_GIVE_UP_MS, READ_POLL_PENDING_TEXT, READ_POLL_GAVE_UP_TEXT,
  f1, dir, deriveNarHeadline, deriveRatioHeadline,
  deriveRatioLineSegmentsFromBars, deriveReadHeadline, deriveAllocationHeadline,
  type TrendsPeriod, type ReadHeadlineParams, type RatioBar,
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

// ── 11. Empty-edge trimming ───────────────────────────────────────────────────

const EMPTY_P = mkP("2026-W20", 7, 0, 0, 0, null); // no displacement, no engagement, zero NAR

test("trimEmptyEdgePeriods: leading and trailing empty periods are removed; mid-series zero is kept", () => {
  // A genuinely quiet week (mid-series) must NOT be removed — absence in the middle
  // is data; absence at the edge is only range padding (e.g. W20 predating deployment).
  const midZero = mkP("2026-W25", 7, 0, 0, 0, null); // zero activity between two live weeks
  const series = [EMPTY_P, W22, midZero, W32, EMPTY_P];
  const trimmed = trimEmptyEdgePeriods(series);
  assert.equal(trimmed.length, 3, "leading and trailing W20 empties removed");
  assert.equal(trimmed[0].key, "2026-W22", "first kept period is W22");
  assert.equal(trimmed[1].key, "2026-W25", "mid-series zero is preserved");
  assert.equal(trimmed[2].key, "2026-W32", "last kept period is W32");

  // Leading only
  const leadOnly = [EMPTY_P, W32, W33];
  const tl = trimEmptyEdgePeriods(leadOnly);
  assert.equal(tl.length, 2); assert.equal(tl[0].key, "2026-W32");

  // All-empty series collapses to []
  assert.deepEqual(trimEmptyEdgePeriods([EMPTY_P, EMPTY_P]), []);

  // No empties → unchanged
  const noEmp = trimEmptyEdgePeriods([W22, W32]);
  assert.equal(noEmp.length, 2);

  // Null-safe
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(trimEmptyEdgePeriods(null as any), []);
});

// ── 12. Empty-state text honesty ──────────────────────────────────────────────

test("READ_EMPTY_STATE_TEXT: no claim of automatic or scheduled generation", () => {
  const t = READ_EMPTY_STATE_TEXT.toLowerCase();
  assert.ok(!t.includes("automatic"), "must not say 'automatic'");
  assert.ok(!t.includes("scheduled"), "must not say 'scheduled'");
  assert.ok(!t.includes("nightly"), "must not say 'nightly'");
  assert.ok(t.length > 10, "must be a real sentence, not empty");
});

// ── 13. Poll state constants ──────────────────────────────────────────────────

test("POLL_GIVE_UP_MS: strictly greater than the expected 2-minute generation time, not equal", () => {
  const EXPECTED_MAX_MS = 2 * 60 * 1000; // 2 min — top of the stated 1-2 min range
  assert.ok(POLL_GIVE_UP_MS > EXPECTED_MAX_MS,
    `give-up bound (${POLL_GIVE_UP_MS} ms) must strictly exceed expected generation time (${EXPECTED_MAX_MS} ms)`);
});

test("READ_POLL_GAVE_UP_TEXT: does not assert failure as a certainty; hedges with 'may'", () => {
  const t = READ_POLL_GAVE_UP_TEXT.toLowerCase();
  assert.ok(!t.includes("has failed"), "must not say 'has failed'");
  assert.ok(!t.includes("workflow failed"), "must not say 'workflow failed'");
  assert.ok(t.includes("may"), "must hedge with 'may'");
  assert.ok(READ_POLL_GAVE_UP_TEXT.length > 20, "must be a real sentence");
});

test("READ_POLL_GAVE_UP_TEXT and READ_POLL_PENDING_TEXT are distinct non-empty strings", () => {
  assert.notEqual(READ_POLL_GAVE_UP_TEXT, READ_POLL_PENDING_TEXT,
    "gave-up and pending messages must be distinct — they signal different states");
  assert.ok(READ_POLL_PENDING_TEXT.length > 10, "pending text must be a real sentence");
  assert.ok(READ_POLL_GAVE_UP_TEXT.length > 10, "gave-up text must be a real sentence");
});

// ── Sentence engine ───────────────────────────────────────────────────────────

// — deriveNarHeadline —
test("deriveNarHeadline: engaged null → wasn’t measured, no ratio claimed", () => {
  const s = deriveNarHeadline({ nar: 5, engaged: null, displaced: 10 });
  assert.ok(s.includes("wasn’t measured"), `got: ${s}`);
  assert.ok(!s.includes("you put in"), `must not claim ratio when unmeasured, got: ${s}`);
});
test("deriveNarHeadline: NAR ≤ 0 → nothing came back", () => {
  const s = deriveNarHeadline({ nar: 0, engaged: 4, displaced: 7 });
  assert.ok(s.includes("Nothing came back"), `got: ${s}`);
  const s2 = deriveNarHeadline({ nar: -2, engaged: 6, displaced: 8 });
  assert.ok(s2.includes("Nothing came back"), `got: ${s2}`);
});
test("deriveNarHeadline: positive NAR with engagement → came back … you put in", () => {
  const s = deriveNarHeadline({ nar: 12.5, engaged: 6, displaced: 18.5 });
  assert.ok(s.includes("came back this week"), `got: ${s}`);
  assert.ok(s.includes("you put in"), `got: ${s}`);
});

// — deriveRatioHeadline —
test("deriveRatioHeadline: engaged null → null (no ratio claimed)", () => {
  assert.strictEqual(deriveRatioHeadline({ ratio: 4, engaged: null, peakValue: 5, peakMonth: "Jun", ratioSeries: [4] }), null);
});
test("deriveRatioHeadline: engaged 0.5h → too little of your time", () => {
  const s = deriveRatioHeadline({ ratio: 3.5, engaged: 0.5, peakValue: 5, peakMonth: "Jun", ratioSeries: [3.5] });
  assert.ok(s?.includes("Too little of your time"), `got: ${s}`);
});
test("deriveRatioHeadline: ratio at peak → the best yet; 3 flat periods → steady for N weeks", () => {
  const sBest = deriveRatioHeadline({ ratio: 5.9, engaged: 6, peakValue: 5.85, peakMonth: "Jul", ratioSeries: [3, 4, 5.9] });
  assert.ok(sBest?.includes("the best yet"), `got: ${sBest}`);
  const sFlat = deriveRatioHeadline({ ratio: 3.5, engaged: 4, peakValue: 6, peakMonth: "Jul", ratioSeries: [3.5, 3.48, 3.52] });
  assert.ok(sFlat?.includes("steady for") && sFlat.includes("weeks"), `got: ${sFlat}`);
});

// — deriveRatioLineSegmentsFromBars: null produces gap segment, never interpolated point —
const mkRBars = (ratios: (number | null)[]): RatioBar[] =>
  ratios.map((r, i) => ({ key: `W${i}`, label: `W${i}`, ratio: r, low_engagement: false, uninstrumented: false }));

test("deriveRatioLineSegmentsFromBars: null in series → isGap=true; adjacent non-null → isGap=false", () => {
  const gap = deriveRatioLineSegmentsFromBars(mkRBars([3.5, null, 4.0]));
  assert.strictEqual(gap.length, 1); assert.strictEqual(gap[0].isGap, true);
  assert.strictEqual(gap[0].from, 0); assert.strictEqual(gap[0].to, 2);
  const solid = deriveRatioLineSegmentsFromBars(mkRBars([3, 4, 5]));
  assert.ok(solid.every(s => !s.isGap), "all solid when no nulls");
});

// — deriveReadHeadline (8 templates) —
const rh = (dR: string, dX: string, dF: string, extra: Partial<ReadHeadlineParams> = {}): string =>
  deriveReadHeadline({
    dR: dR as any, dX: dX as any, dF: dF as any,
    priorKey: "W1", latestKey: "W2",
    priorRatio: 4, latestRatio: 3,
    priorFailures: 5, latestFailures: 8,
    priorEngaged: 4, latestEngaged: 5,
    priorXLHours: 2, latestXLHours: 6,
    ...extra,
  });

test("read template 1: down+up+!up → work got bigger, not worse", () => {
  const s = rh("down", "up", "flat");
  assert.ok(s.includes("work got bigger"), `got: ${s}`);
  assert.ok(s.includes("not worse"), `got: ${s}`);
});
test("read template 2: down+up+up → bigger work and more failed", () => {
  const s = rh("down", "up", "up");
  assert.ok(s.includes("bigger work"), `got: ${s}`);
  assert.ok(s.includes("failed"), `got: ${s}`);
});
test("read template 3: down+flat+up → quality slipped, failures rose", () => {
  const s = rh("down", "flat", "up");
  assert.ok(s.includes("quality slipped"), `got: ${s}`);
  assert.ok(s.includes("failures rose"), `got: ${s}`);
});
test("read template 4: down+flat+flat → your side of the desk", () => {
  const s = rh("down", "flat", "flat");
  assert.ok(s.includes("your side of the desk"), `got: ${s}`);
  assert.ok(s.includes("your time rose"), `got: ${s}`);
});
test("read template 5: up+flat+down → fewer failures", () =>
  assert.ok(rh("up", "flat", "down").includes("fewer failures")));
test("read template 6: up+up+flat → improved even as the work", () =>
  assert.ok(rh("up", "up", "flat").includes("even as the work")));
test("read template 7: flat → held at X× across both weeks", () => {
  const s = rh("flat", "flat", "flat", { latestRatio: 3.5 });
  assert.ok(s.includes("held at"), `got: ${s}`);
  assert.ok(s.includes("across both weeks"), `got: ${s}`);
  assert.ok(s.includes("×") || s.includes("×"), `must include × char, got: ${s}`);
});

// — deriveAllocationHeadline —
test("allocation headline: workFrac ≥ 0.85 → almost entirely to work", () => {
  const s = deriveAllocationHeadline({ totalNar: 40, workFrac: 0.88, lifeFrac: 0.09, unassignedFrac: 0.03 });
  assert.ok(s.includes("almost entirely to work"), `got: ${s}`);
});
test("allocation headline: 0.60 ≤ workFrac < 0.85 → mostly to work", () => {
  const s = deriveAllocationHeadline({ totalNar: 30, workFrac: 0.70, lifeFrac: 0.25, unassignedFrac: 0.05 });
  assert.ok(s.includes("mostly to work"), `got: ${s}`);
});
test("allocation headline: 0.40 ≤ workFrac < 0.60 → to work and life evenly", () => {
  const s = deriveAllocationHeadline({ totalNar: 20, workFrac: 0.50, lifeFrac: 0.45, unassignedFrac: 0.05 });
  assert.ok(s.includes("to work and life evenly"), `got: ${s}`);
});
test("allocation headline: workFrac < 0.40 → mostly to life", () => {
  const s = deriveAllocationHeadline({ totalNar: 15, workFrac: 0.30, lifeFrac: 0.65, unassignedFrac: 0.05 });
  assert.ok(s.includes("mostly to life"), `got: ${s}`);
});
test("allocation headline: unassigned > 25% → tail clause appended", () => {
  const s = deriveAllocationHeadline({ totalNar: 20, workFrac: 0.55, lifeFrac: 0.15, unassignedFrac: 0.30 });
  assert.ok(s.includes("still unassigned"), `tail clause expected, got: ${s}`);
  assert.ok(s.includes("30%"), `must include pct, got: ${s}`);
});
