/**
 * attentionCore unit tests (#584).
 * Run: cd packages/web && npx tsx --test src/dashboard/attentionCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveUnratedRows, deriveInferredDisplay, deriveDisplacementGroups,
  isEmptyDay, formatHours, formatMinutes,
  type AttentionDayResponse, type InferredItem,
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

// 2. Blocked / non-delivered → display_minutes=0
test("inferred: delivered passes at full minutes, no reason", () => {
  const [d] = deriveInferredDisplay([I]);
  assert.equal(d.display_minutes, 20); assert.equal(d.is_blocked, false); assert.equal(d.blocked_reason, null);
});
test("inferred: non-delivered → zero with reason (asymmetry visible via claimed_minutes)", () => {
  const [d] = deriveInferredDisplay([{ ...I, outcome: "aborted" }]);
  assert.equal(d.display_minutes, 0); assert.equal(d.claimed_minutes, 20);
  assert.equal(d.is_blocked, true); assert.match(d.blocked_reason ?? "", /aborted/);
  assert.match(d.blocked_reason ?? "", /no displacement credit/);
});
test("inferred: 'blocked' outcome → zero", () => {
  const [d] = deriveInferredDisplay([{ ...I, outcome: "blocked" }]);
  assert.equal(d.display_minutes, 0); assert.equal(d.is_blocked, true);
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
