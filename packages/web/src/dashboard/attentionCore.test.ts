/**
 * attentionCore unit tests (#584).
 * Run: cd packages/web && npx tsx --test src/dashboard/attentionCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveUnratedRows, deriveInferredDisplay, deriveDisplacementGroups,
  isEmptyDay, formatHours, formatMinutes,
  deriveChartBars, deriveChartScale, deriveRangeAggregates,
  normalizeAttentionDay, formatScaleSignal, formatItemLabel,
  formatHeaderDate, formatWholeMinutes,
  collapseAutonomousRows, deriveLedger, LEDGER_COL_NA,
  deriveBarGeometry,
  type AttentionDayResponse, type InferredItem, type InferredDisplayItem, type SeriesPoint, type AutonomousItem,
} from "./attentionCore";

const I: InferredItem = { label: "x", bucket: "M", minutes: 20, turns: 10, tools: 5, evidence_kind: "session", evidence_ref: "s", outcome: "delivered" };

const E: AttentionDayResponse = {
  date: "2026-08-14", nar_hours: 0,
  displaced: { total_hours: 0, explicit: { hours: 0, items: [] }, inferred: { hours: 0, items: [] }, autonomous: { hours: 0, items: [] } },
  engaged: { hours: 0, events: 0, bursts: 0, gap_minutes: 10, floor_minutes: 2 },
  interruption: { hours: 0, count: 0, rate_minutes: 2 },
  stats: { sessions: 0, turns: 0, self_corrections: 0, blocked: 0, hard_failures: 0, return_ratio: 0, autonomous_artifacts: 0 },
  rates: { suppression_minutes_per_item: 0.5, bucket_minutes: { S: 5, M: 20, L: 60, XL: 120 }, interruption_minutes: 2 },
  unrated: [],
};

// 1. Unrated → note="no_rate_established"
test("unrated: carries note=no_rate_established on every entry", () => {
  const rows = deriveUnratedRows([{ action_class: "desk_decision_done", count: 1 }, { action_class: "chore_run", count: 3 }]);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.note, "no_rate_established");
  assert.equal(rows[0].action_class, "desk_decision_done");
});
test("unrated: empty → []", () => assert.deepEqual(deriveUnratedRows([]), []));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
test("unrated: null-tolerant", () => assert.deepEqual(deriveUnratedRows(null as any), []));

// 2. Outcome gate — only explicit failures zero credit; absent ≠ failed
test("inferred: delivered passes at full minutes, no reason", () => {
  const [d] = deriveInferredDisplay([I]);
  assert.equal(d.display_minutes, 20); assert.equal(d.is_blocked, false); assert.equal(d.blocked_reason, null);
});
test("inferred: outcome null → full credit, not blocked (absent ≠ failed)", () => {
  const [d] = deriveInferredDisplay([{ ...I, outcome: null }]);
  assert.equal(d.display_minutes, 20);
  assert.equal(d.is_blocked, false);
  assert.equal(d.blocked_reason, null);
});
test("inferred: outcome undefined (key absent) → full credit, not blocked", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [d] = deriveInferredDisplay([{ ...I, outcome: undefined as any }]);
  assert.equal(d.display_minutes, 20);
  assert.equal(d.is_blocked, false);
  assert.equal(d.blocked_reason, null);
});
test("inferred: explicit 'aborted' → zero with reason (asymmetry visible via claimed_minutes)", () => {
  const [d] = deriveInferredDisplay([{ ...I, outcome: "aborted" }]);
  assert.equal(d.display_minutes, 0); assert.equal(d.claimed_minutes, 20);
  assert.equal(d.is_blocked, true); assert.match(d.blocked_reason ?? "", /aborted/);
  assert.match(d.blocked_reason ?? "", /no displacement credit/);
});
test("inferred: explicit 'failed' → zero, reason present, claimed_minutes preserved", () => {
  const [d] = deriveInferredDisplay([{ ...I, minutes: 45, outcome: "failed" }]);
  assert.equal(d.display_minutes, 0);
  assert.equal(d.claimed_minutes, 45);
  assert.equal(d.is_blocked, true);
  assert.match(d.blocked_reason ?? "", /no displacement credit/);
});
test("inferred: explicit 'blocked' outcome → zero", () => {
  const [d] = deriveInferredDisplay([{ ...I, outcome: "blocked" }]);
  assert.equal(d.display_minutes, 0); assert.equal(d.is_blocked, true);
});
// Sum invariant: rows must sum to section total (the key correctness property).
// Mix: delivered=30, null-outcome=20, aborted=15. Non-failed sum=50; aborted=0.
test("inferred: sum of display_minutes equals non-failed total (rows consistent with section total)", () => {
  const items = deriveInferredDisplay([
    { ...I, minutes: 30, outcome: "delivered" },
    { ...I, minutes: 20, outcome: null },
    { ...I, minutes: 15, outcome: "aborted" },
  ]);
  const displaySum = items.reduce((s, it) => s + it.display_minutes, 0);
  // 30 (delivered) + 20 (null-outcome credited) + 0 (aborted) = 50
  assert.equal(displaySum, 50);
  // The API's inferred.hours for these items = 50 / 60; rows and total agree.
  assert.ok(Math.abs(displaySum / 60 - 50 / 60) < 0.001);
});

// 3. Empty day detection
test("isEmptyDay: all-zero → true", () => assert.equal(isEmptyDay(E), true));
test("isEmptyDay: nar_hours>0 → false", () => assert.equal(isEmptyDay({ ...E, nar_hours: 7.51 }), false));
test("isEmptyDay: unrated entries → false", () => assert.equal(isEmptyDay({ ...E, unrated: [{ action_class: "x", count: 1 }] }), false));

// 4. Three distinct groups, never merged
test("deriveDisplacementGroups: three keys; inferred has display_minutes, explicit does not", () => {
  const g = deriveDisplacementGroups({
    total_hours: 12, explicit: { hours: 0.13, items: [{ label: "S", count: 1, rate_minutes: 0.5, minutes: 8 }] },
    inferred: { hours: 10, items: [I] }, autonomous: { hours: 1, items: [{ label: "B", bucket: "M", minutes: 30, evidence_kind: "chore_run", evidence_ref: "y" }] },
  });
  assert.ok("explicit" in g && "inferred" in g && "autonomous" in g);
  assert.equal(g.explicit.items.length, 1); assert.equal(g.inferred.items.length, 1); assert.equal(g.autonomous.items.length, 1);
  assert.ok("display_minutes" in g.inferred.items[0]); assert.ok(!("display_minutes" in g.explicit.items[0]));
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
test("deriveDisplacementGroups: null safe", () => { const g = deriveDisplacementGroups(null as any); assert.equal(g.explicit.items.length, 0); });

// Formatters
test("formatHours: 2dp", () => { assert.equal(formatHours(7.51), "7.51"); assert.equal(formatHours(0), "0.00"); });
test("formatMinutes: 1dp", () => { assert.equal(formatMinutes(0.5), "0.5"); assert.equal(formatMinutes(120), "120.0"); });

// 5. deriveChartBars
const mkPt = (date: string, nar: number, disp = 0, eng = 0): SeriesPoint => ({ date, nar_hours: nar, displaced_hours: disp, engaged_hours: eng });
test("chartBars: has_data true when displaced>0", () => {
  const [b] = deriveChartBars([mkPt("2026-08-14", 1.5, 2, 0.5)]);
  assert.equal(b.has_data, true); assert.equal(b.nar_hours, 1.5);
});
test("chartBars: has_data false when displaced=0 and nar=0", () => {
  const [b] = deriveChartBars([mkPt("2026-08-14", 0, 0, 0)]);
  assert.equal(b.has_data, false);
});
test("chartBars: has_data true when nar_hours non-zero (even if displaced=0)", () => {
  const [b] = deriveChartBars([mkPt("2026-08-14", -0.5, 0, 0)]);
  assert.equal(b.has_data, true);
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
test("chartBars: null-safe → []", () => assert.deepEqual(deriveChartBars(null as any), []));

// 6. deriveChartScale
test("chartScale: all positive → baselineY at chartHeight", () => {
  const bars = [{ date: "d", nar_hours: 5, displaced_hours: 5, engaged_hours: 0, has_data: true }];
  const s = deriveChartScale(bars, 100);
  assert.equal(s.baselineY, 100); // baseline at bottom
});
test("chartScale: all negative → baselineY at 0 (baseline at top)", () => {
  const bars = [{ date: "d", nar_hours: -5, displaced_hours: 5, engaged_hours: 0, has_data: true }];
  const s = deriveChartScale(bars, 100);
  assert.equal(s.baselineY, 0);
});
test("chartScale: equal positive+negative → baseline at 50", () => {
  const bars = [
    { date: "a", nar_hours: 5, displaced_hours: 5, engaged_hours: 0, has_data: true },
    { date: "b", nar_hours: -5, displaced_hours: 5, engaged_hours: 0, has_data: true },
  ];
  const s = deriveChartScale(bars, 100);
  assert.equal(s.baselineY, 50);
});
test("chartScale: all-zero guard → pixelsPerHour uses total=1", () => {
  const s = deriveChartScale([], 100);
  assert.equal(s.pixelsPerHour, 100); // 100/1
});

// 7. deriveRangeAggregates
test("rangeAgg: empty series → all zero, no best/worst", () => {
  const agg = deriveRangeAggregates([]);
  assert.equal(agg.total_nar, 0); assert.equal(agg.best_day, null); assert.equal(agg.days_with_data, 0);
});
test("rangeAgg: all empty days → days_with_data=0", () => {
  const agg = deriveRangeAggregates([mkPt("a", 0), mkPt("b", 0)]);
  assert.equal(agg.days_with_data, 0); assert.equal(agg.total_days, 2);
});
test("rangeAgg: picks correct best and worst day", () => {
  const agg = deriveRangeAggregates([mkPt("a", 3, 3), mkPt("b", 7, 7), mkPt("c", 1, 1)]);
  assert.equal(agg.best_day?.date, "b"); assert.equal(agg.worst_day?.date, "c");
});
test("rangeAgg: mean excludes days without data", () => {
  const agg = deriveRangeAggregates([mkPt("a", 4, 4), mkPt("b", 0, 0), mkPt("c", 6, 6)]);
  // only a and c have data → mean = 10 / 2 = 5
  assert.equal(agg.days_with_data, 2); assert.equal(agg.total_days, 3);
  assert.ok(Math.abs(agg.mean_nar - 5) < 0.001);
});
test("rangeAgg: negative NAR becomes worst_day correctly", () => {
  const agg = deriveRangeAggregates([mkPt("a", 2, 5, 3), mkPt("b", -1, 1, 2)]);
  assert.equal(agg.worst_day?.date, "b"); assert.equal(agg.best_day?.date, "a");
});

// 8. normalizeAttentionDay — defensive normaliser (#584)

// stats absent is the live production crash; other sections are defensive.
test("normalizeAttentionDay: stats absent → null (not zero-filled)", () => {
  const vm = normalizeAttentionDay({
    date: "2026-08-14", nar_hours: 0.5,
    displaced: { total_hours: 0.5, explicit: { hours: 0.5, items: [] }, inferred: { hours: 0, items: [] }, autonomous: { hours: 0, items: [] } },
    engaged: { hours: 0.1, events: 2, bursts: 1, gap_minutes: 10, floor_minutes: 2 },
    interruption: { hours: 0.05, count: 1, rate_minutes: 3 },
    rates: { suppression_minutes_per_item: 0.5, bucket_minutes: { S: 5, M: 20, L: 60, XL: 120 }, interruption_minutes: 2 }, unrated: [],
  });
  assert.equal(vm.stats, null); assert.ok(vm.displaced !== null); assert.equal(vm.nar_hours, 0.5);
});
test("normalizeAttentionDay: every absent section → null or [], no throw", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const min = normalizeAttentionDay(null as any);
  assert.equal(min.displaced, null); assert.equal(min.engaged, null); assert.equal(min.interruption, null);
  assert.equal(min.rates, null); assert.equal(min.stats, null); assert.deepEqual(min.unrated, []);
});
test("normalizeAttentionDay: displaced.inferred.items absent → []", () => {
  const vm = normalizeAttentionDay({ date: "2026-08-14", nar_hours: 0,
    displaced: { total_hours: 0, explicit: { hours: 0, items: [] }, inferred: { hours: 0 }, autonomous: { hours: 0, items: [] } },
  });
  assert.deepEqual(vm.displaced?.inferred.items, []);
});
test("normalizeAttentionDay: full response → no section null, values preserved", () => {
  const vm = normalizeAttentionDay(E);
  assert.equal(vm.date, E.date); assert.ok(vm.stats !== null); assert.equal(vm.stats?.sessions, 0);
  assert.ok(vm.displaced !== null); assert.ok(vm.engaged !== null); assert.ok(vm.rates !== null);
});

// 9. formatScaleSignal — scale signal must carry the numbers, not bare unit labels
test("formatScaleSignal: both counts → 'N turns · N tools'", () => {
  assert.equal(formatScaleSignal({ turns: 12, tools: 85 }), "12 turns · 85 tools");
});
test("formatScaleSignal: only turns present → 'N turns', no bare · tools", () => {
  assert.equal(formatScaleSignal({ turns: 3, tools: null }), "3 turns");
  assert.equal(formatScaleSignal({ turns: 3 }), "3 turns");
});
test("formatScaleSignal: only tools present → 'N tools', no bare turns ·", () => {
  assert.equal(formatScaleSignal({ turns: null, tools: 7 }), "7 tools");
  assert.equal(formatScaleSignal({ tools: 7 }), "7 tools");
});
test("formatScaleSignal: neither present → empty string", () => {
  assert.equal(formatScaleSignal({}), "");
  assert.equal(formatScaleSignal({ turns: null, tools: undefined }), "");
});
test("formatScaleSignal: zero is a valid count, not omitted", () => {
  assert.equal(formatScaleSignal({ turns: 0, tools: 0 }), "0 turns · 0 tools");
});

// 10. formatItemLabel — degrade gracefully from bare session IDs
test("formatItemLabel: descriptive label → returned as-is", () => {
  assert.equal(formatItemLabel({ label: "Email thread: Q3 planning", evidence_kind: "session" }), "Email thread: Q3 planning");
});
test("formatItemLabel: label with channel annotation → not bare, returned as-is", () => {
  // "Session 20260715_113 (slack)" has readable info beyond the ID
  assert.equal(formatItemLabel({ label: "Session 20260715_113 (slack)", evidence_kind: "session" }), "Session 20260715_113 (slack)");
});
test("formatItemLabel: bare session ID → falls back to evidence_kind", () => {
  assert.equal(formatItemLabel({ label: "Session 20260715_113", evidence_kind: "session" }), "session");
});
test("formatItemLabel: null label → falls back to evidence_kind", () => {
  assert.equal(formatItemLabel({ label: null, evidence_kind: "chore_run" }), "chore_run");
});
test("formatItemLabel: neither label nor evidence_kind → honest placeholder", () => {
  assert.equal(formatItemLabel({ label: null, evidence_kind: null }), "—");
  assert.equal(formatItemLabel({}), "—");
});

// 11. formatHeaderDate
test("formatHeaderDate: known date returns full uppercased day/month string", () => {
  // 2026-08-14 is a Friday (UTC)
  assert.equal(formatHeaderDate("2026-08-14"), "FRIDAY 14 AUGUST 2026");
});
test("formatHeaderDate: Monday", () => {
  // 2026-08-10 is a Monday
  assert.equal(formatHeaderDate("2026-08-10"), "MONDAY 10 AUGUST 2026");
});
test("formatHeaderDate: malformed input does not throw", () => {
  const result = formatHeaderDate("not-a-date");
  assert.ok(typeof result === "string" && result.length > 0);
});

// 12. formatWholeMinutes
test("formatWholeMinutes: float rounds to nearest integer", () => {
  assert.equal(formatWholeMinutes(120.4), "120");
  assert.equal(formatWholeMinutes(119.6), "120");
});
test("formatWholeMinutes: zero", () => {
  assert.equal(formatWholeMinutes(0), "0");
});

// 13. collapseAutonomousRows
const mkAuto = (label: string, minutes: number, bucket = "S"): AutonomousItem => ({ label, bucket, minutes, evidence_kind: "chore_run", evidence_ref: "x" });

test("collapseAutonomousRows: identical labels collapse into one with summed minutes", () => {
  const items = [mkAuto("Vigilance", 0.01), mkAuto("Vigilance", 0.01), mkAuto("Vigilance", 0.01)];
  const rows = collapseAutonomousRows(items);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 3);
  assert.ok(Math.abs(rows[0].total_minutes - 0.03) < 0.0001);
});
test("collapseAutonomousRows: distinct labels preserved separately", () => {
  const items = [mkAuto("A", 5), mkAuto("B", 10), mkAuto("A", 5)];
  const rows = collapseAutonomousRows(items);
  assert.equal(rows.length, 2);
  const a = rows.find(r => r.label === "A");
  assert.ok(a && a.count === 2 && Math.abs(a.total_minutes - 10) < 0.0001);
});
test("collapseAutonomousRows: sum invariant — collapsed total == input total", () => {
  const items = [mkAuto("X", 3), mkAuto("X", 7), mkAuto("Y", 4), mkAuto("Y", 1)];
  const rows = collapseAutonomousRows(items);
  const collapsedSum = rows.reduce((s, r) => s + r.total_minutes, 0);
  const rawSum = items.reduce((s, i) => s + i.minutes, 0);
  assert.ok(Math.abs(collapsedSum - rawSum) < 0.0001);
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
test("collapseAutonomousRows: null-safe → []", () => assert.deepEqual(collapseAutonomousRows(null as any), []));

// 14. deriveLedger
// deriveLedger consumes the NORMALISED view model, not the raw response —
// normalizeAttentionDay has already run deriveInferredDisplay. Fixtures must
// therefore be display items carrying display_minutes, not raw minutes.
const mkInferred = (label: string, minutes: number, outcome?: string): InferredDisplayItem => {
  const failed = outcome !== undefined && outcome !== "delivered";
  return {
    label, bucket: "M", claimed_minutes: minutes, display_minutes: failed ? 0 : minutes,
    evidence_kind: "session", evidence_ref: "s", outcome: outcome ?? "delivered",
    is_blocked: failed, blocked_reason: failed ? `${outcome} — no displacement credit` : null,
  };
};

test("deriveLedger: group names are CONVERSATIONAL / EXPLICIT / AUTONOMOUS", () => {
  // E is a RAW response; deriveLedger takes the normalised view model, so go
  // through the real normaliser rather than casting — that is the actual path
  // the page uses, and casting here is what let the shape drift in the first place.
  const vm = deriveLedger(normalizeAttentionDay(E).displaced);
  const names = vm.groups.map(g => g.name);
  assert.deepEqual(names, ["CONVERSATIONAL", "EXPLICIT", "AUTONOMOUS"]);
});
test("deriveLedger: group subtotals equal sum of row displaced_min", () => {
  const displaced = {
    total_hours: 3,
    inferred: { hours: 1, items: [mkInferred("X", 30), mkInferred("Y", 30)] },
    explicit: { hours: 0.5, items: [{ label: "A", count: 1, rate_minutes: 5, minutes: 30 }] },
    autonomous: { hours: 0.5, items: [mkAuto("Z", 15), mkAuto("Z", 15)] },
  };
  const vm = deriveLedger(displaced);
  for (const g of vm.groups) {
    const rowSum = g.rows.reduce((s, r) => s + r.displaced_min, 0);
    assert.ok(Math.abs(rowSum - g.subtotal_displaced_min) < 0.0001,
      `${g.name}: rowSum=${rowSum} subtotal=${g.subtotal_displaced_min}`);
  }
});
test("deriveLedger: total_displaced_min equals sum of group subtotals", () => {
  const displaced = {
    total_hours: 3,
    inferred: { hours: 1, items: [mkInferred("X", 60)] },
    explicit: { hours: 0.5, items: [{ label: "A", count: 2, rate_minutes: 5, minutes: 10 }] },
    autonomous: { hours: 0.5, items: [mkAuto("Z", 20)] },
  };
  const vm = deriveLedger(displaced);
  const groupTotal = vm.groups.reduce((s, g) => s + g.subtotal_displaced_min, 0);
  assert.ok(Math.abs(groupTotal - vm.total_displaced_min) < 0.0001);
});
test("deriveLedger: autonomous rows with same label are collapsed (count > 1)", () => {
  const displaced = {
    total_hours: 0, inferred: { hours: 0, items: [] }, explicit: { hours: 0, items: [] },
    autonomous: { hours: 0, items: [mkAuto("V", 0.01), mkAuto("V", 0.01), mkAuto("V", 0.01)] },
  };
  const vm = deriveLedger(displaced);
  const autoGroup = vm.groups.find(g => g.name === "AUTONOMOUS")!;
  assert.equal(autoGroup.rows.length, 1);
  assert.equal(autoGroup.rows[0].count, 3);
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
test("deriveLedger: null displaced → all groups empty, total=0", () => {
  const vm = deriveLedger(null as any);
  assert.equal(vm.total_displaced_min, 0);
  for (const g of vm.groups) assert.equal(g.rows.length, 0);
  assert.equal(vm.engaged, LEDGER_COL_NA);
});

// 15. deriveBarGeometry
test("deriveBarGeometry: displaced is the tallest bar (height_pct=100) when it dominates", () => {
  const bg = deriveBarGeometry(12, 3, 1.52, 100);
  assert.equal(bg.displaced.height_pct, 100); // 12 is max
  assert.ok(bg.mess.height_pct < 100);
  assert.ok(bg.net.height_pct < 100);
});
test("deriveBarGeometry: net value equals displaced minus mess", () => {
  const bg = deriveBarGeometry(12.03, 3, 1.52, 100);
  assert.ok(Math.abs(bg.net.value_hours - (12.03 - 3 - 1.52)) < 0.0001);
});
test("deriveBarGeometry: all-zero guard — no division by zero", () => {
  const bg = deriveBarGeometry(0, 0, 0, 100);
  assert.ok(isFinite(bg.displaced.height_pct));
  assert.ok(isFinite(bg.mess.height_pct));
  assert.ok(isFinite(bg.net.height_pct));
});

// Regression: deriveLedger consumed the RAW response shape while the component
// passed the NORMALISED view model. deriveInferredDisplay ran twice, the second
// pass read `it.minutes` (absent on InferredDisplayItem), and every
// conversational row rendered NaN. wasp build caught the type error; tsx could
// not, because tsc cannot run pre-codegen in this package.
test("deriveLedger reads display_minutes from normalised items — never NaN", () => {
  const vm = {
    total_hours: 1,
    explicit: { hours: 0, items: [] },
    inferred: { hours: 1, items: [
      { label: "Invoice rebuilt", bucket: "L", claimed_minutes: 60, display_minutes: 60,
        turns: 6, tools: 57, evidence_kind: "session", evidence_ref: "s1",
        outcome: "delivered", is_blocked: false, blocked_reason: null },
      { label: "Failed thing", bucket: "M", claimed_minutes: 20, display_minutes: 0,
        turns: 2, tools: 3, evidence_kind: "session", evidence_ref: "s2",
        outcome: "failed", is_blocked: true, blocked_reason: "failed — no displacement credit" },
    ] },
    autonomous: { hours: 0, items: [] },
  };
  const l = deriveLedger(vm as never);
  const conv = l.groups.find((g) => g.name === "CONVERSATIONAL")!;
  for (const r of conv.rows) assert.ok(Number.isFinite(r.displaced_min), `NaN in ${r.label}`);
  assert.equal(conv.rows[0].displaced_min, 60);
  assert.equal(conv.rows[1].displaced_min, 0, "blocked row credits zero");
  assert.equal(conv.subtotal_displaced_min, 60, "subtotal is the sum of displayed rows");
  assert.equal(l.total_displaced_min, 60);
});
