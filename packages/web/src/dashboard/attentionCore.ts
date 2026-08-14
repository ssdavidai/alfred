// attentionCore — pure response→view-model derivation for /attention (#584).
// Import-free; node:test-able. Four invariants enforced:
//   1. three displacement groups (explicit/inferred/autonomous) stay separate
//   2. unrated classes carry note="no_rate_established", never zero
//   3. non-delivered inferred → display_minutes=0 + blocked_reason
//   4. empty day is identifiable without inspecting items

export interface ExplicitItem { label: string; count: number; rate_minutes: number; minutes: number }
export interface InferredItem { label: string; bucket: string; minutes: number; turns: number; tools: number; evidence_kind: string; evidence_ref: string; outcome: string }
export interface AutonomousItem { label: string; bucket: string; minutes: number; evidence_kind: string; evidence_ref: string }
export interface UnratedEntry { action_class: string; count: number }

export interface AttentionDayResponse {
  date: string; nar_hours: number;
  displaced: { total_hours: number; explicit: { hours: number; items: ExplicitItem[] }; inferred: { hours: number; items: InferredItem[] }; autonomous: { hours: number; items: AutonomousItem[] } };
  engaged: { hours: number; events: number; bursts: number; gap_minutes: number; floor_minutes: number };
  interruption: { hours: number; count: number; rate_minutes: number };
  stats: { sessions: number; turns: number; self_corrections: number; blocked: number; hard_failures: number; return_ratio: number; autonomous_artifacts: number };
  rates: { suppression_minutes_per_item: number; bucket_minutes: { S: number; M: number; L: number; XL: number }; interruption_minutes: number };
  unrated: UnratedEntry[];
}

export interface SeriesPoint { date: string; nar_hours: number; displaced_hours: number; engaged_hours: number }
export interface AttentionStatsResponse {
  from: string; to: string;
  series: SeriesPoint[];
  totals: { nar_hours: number; displaced_hours: number; engaged_hours: number };
  rate_changed?: boolean; // backend audits rate changes; absent means not detected
}

export interface UnratedRow { action_class: string; count: number; note: "no_rate_established" }
export interface InferredDisplayItem {
  label: string; bucket: string;
  claimed_minutes: number; display_minutes: number; // 0 when not delivered — asymmetry is the point
  turns: number; tools: number; evidence_kind: string; evidence_ref: string;
  outcome: string; is_blocked: boolean; blocked_reason: string | null;
}

export function deriveUnratedRows(unrated: UnratedEntry[]): UnratedRow[] {
  return (unrated ?? []).map((u) => ({ ...u, note: "no_rate_established" as const }));
}

export function deriveInferredDisplay(items: InferredItem[]): InferredDisplayItem[] {
  return (items ?? []).map((it) => {
    const ok = it.outcome === "delivered";
    return { label: it.label, bucket: it.bucket, claimed_minutes: it.minutes, display_minutes: ok ? it.minutes : 0,
      turns: it.turns, tools: it.tools, evidence_kind: it.evidence_kind, evidence_ref: it.evidence_ref,
      outcome: it.outcome, is_blocked: !ok, blocked_reason: ok ? null : `outcome: ${it.outcome} — no displacement credit` };
  });
}

export function isEmptyDay(day: AttentionDayResponse): boolean {
  if (!day || day.nar_hours > 0) return !day;
  const d = day.displaced;
  return !d || (d.explicit.items.length === 0 && d.inferred.items.length === 0 &&
    d.autonomous.items.length === 0 && (day.unrated ?? []).length === 0);
}

export function deriveDisplacementGroups(displaced: AttentionDayResponse["displaced"]): {
  explicit: { hours: number; items: ExplicitItem[] };
  inferred: { hours: number; items: InferredDisplayItem[] };
  autonomous: { hours: number; items: AutonomousItem[] };
} {
  return {
    explicit: { hours: displaced?.explicit?.hours ?? 0, items: displaced?.explicit?.items ?? [] },
    inferred: { hours: displaced?.inferred?.hours ?? 0, items: deriveInferredDisplay(displaced?.inferred?.items ?? []) },
    autonomous: { hours: displaced?.autonomous?.hours ?? 0, items: displaced?.autonomous?.items ?? [] },
  };
}

export const formatHours = (h: number) => (h ?? 0).toFixed(2);
export const formatMinutes = (m: number) => (m ?? 0).toFixed(1);

// ── Range view derivations ────────────────────────────────────────────────────

export interface ChartBar {
  date: string; nar_hours: number; displaced_hours: number; engaged_hours: number;
  has_data: boolean; // false → day has no activity (render as gap, not zero bar)
}

export interface ChartScaleResult {
  baselineY: number;   // px from top to the zero axis
  pixelsPerHour: number; // px per hour of NAR
}

export interface RangeAggregates {
  total_nar: number; mean_nar: number;
  best_day: { date: string; nar_hours: number } | null;
  worst_day: { date: string; nar_hours: number } | null;
  days_with_data: number; total_days: number;
}

export function deriveChartBars(series: SeriesPoint[]): ChartBar[] {
  return (series ?? []).map((pt) => ({
    date: pt.date, nar_hours: pt.nar_hours,
    displaced_hours: pt.displaced_hours, engaged_hours: pt.engaged_hours,
    has_data: pt.displaced_hours > 0 || pt.nar_hours !== 0,
  }));
}

export function deriveChartScale(bars: ChartBar[], chartHeight = 100): ChartScaleResult {
  const maxPos = bars.reduce((m, b) => Math.max(m, b.nar_hours), 0);
  const maxNeg = bars.reduce((m, b) => Math.max(m, -b.nar_hours), 0);
  const total = maxPos + maxNeg || 1;
  return { baselineY: (maxPos / total) * chartHeight, pixelsPerHour: chartHeight / total };
}

export function deriveRangeAggregates(series: SeriesPoint[]): RangeAggregates {
  const pts = series ?? [];
  const withData = pts.filter((p) => p.displaced_hours > 0 || p.nar_hours !== 0);
  if (withData.length === 0) {
    return { total_nar: 0, mean_nar: 0, best_day: null, worst_day: null, days_with_data: 0, total_days: pts.length };
  }
  const total_nar = withData.reduce((s, p) => s + p.nar_hours, 0);
  const best = withData.reduce((a, b) => (b.nar_hours > a.nar_hours ? b : a));
  const worst = withData.reduce((a, b) => (b.nar_hours < a.nar_hours ? b : a));
  return {
    total_nar, mean_nar: total_nar / withData.length,
    best_day: { date: best.date, nar_hours: best.nar_hours },
    worst_day: { date: worst.date, nar_hours: worst.nar_hours },
    days_with_data: withData.length, total_days: pts.length,
  };
}
