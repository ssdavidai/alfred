// attentionCore — pure response→view-model derivation for /attention (#584).
// Import-free; node:test-able. Four invariants enforced:
//   1. three displacement groups (explicit/inferred/autonomous) stay separate
//   2. unrated classes carry note="no_rate_established", never zero
//   3. only explicitly failed/blocked/aborted inferred → display_minutes=0; absent outcome credits at full rate
//   4. empty day is identifiable without inspecting items

export interface ExplicitItem { label: string; count: number; rate_minutes: number; minutes: number }
export interface InferredItem { label: string; bucket: string; minutes: number; turns?: number | null; tools?: number | null; evidence_kind: string; evidence_ref: string; outcome?: string | null }
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
  claimed_minutes: number; display_minutes: number; // 0 only for explicit failures — asymmetry is the point
  turns?: number | null; tools?: number | null; evidence_kind: string; evidence_ref: string;
  outcome?: string | null; is_blocked: boolean; blocked_reason: string | null;
}

export function deriveUnratedRows(unrated: UnratedEntry[]): UnratedRow[] {
  return (unrated ?? []).map((u) => ({ ...u, note: "no_rate_established" as const }));
}

// Outcomes that earn zero displacement credit. Absent / null is NOT failure —
// many older rows never had outcome written; silently zeroing them makes the
// statement contradict itself (total says one thing, every row says zero).
const EXPLICIT_FAILURES: ReadonlySet<string> = new Set(["failed", "blocked", "aborted"]);

export function deriveInferredDisplay(items: InferredItem[]): InferredDisplayItem[] {
  return (items ?? []).map((it) => {
    const explicitFail = typeof it.outcome === "string" && EXPLICIT_FAILURES.has(it.outcome);
    return { label: it.label, bucket: it.bucket, claimed_minutes: it.minutes, display_minutes: explicitFail ? 0 : it.minutes,
      turns: it.turns, tools: it.tools, evidence_kind: it.evidence_kind, evidence_ref: it.evidence_ref,
      outcome: it.outcome, is_blocked: explicitFail, blocked_reason: explicitFail ? `outcome: ${it.outcome} — no displacement credit` : null };
  });
}

// ── Presentational helpers ────────────────────────────────────────────────────

/** Build the "N turns · N tools" scale signal for a session row.
 *  Omits a component cleanly when its count is absent (null / undefined) —
 *  never leaves a bare unit label without a number.
 *  Examples:
 *    formatScaleSignal({turns:12,tools:85}) → "12 turns · 85 tools"
 *    formatScaleSignal({turns:3,tools:null}) → "3 turns"
 *    formatScaleSignal({}) → "" */
export function formatScaleSignal(item: { turns?: number | null; tools?: number | null }): string {
  const parts: string[] = [];
  if (item.turns != null) parts.push(`${item.turns} turns`);
  if (item.tools != null) parts.push(`${item.tools} tools`);
  return parts.join(" · ");
}

// Bare session identifier: only digits, underscores, hyphens, optionally
// prefixed with "Session " — carries no human-readable information beyond the ID.
const BARE_SESSION_RE = /^(?:[Ss]ession\s+)?[\d_-]+$/;

/** Return a readable label for an inferred item.
 *  Prefers `label` when present and not a bare session ID.
 *  Falls back to `evidence_kind` (type hint) when label is absent or raw.
 *  Returns "—" as last-resort placeholder; never invents a description. */
export function formatItemLabel(item: { label?: string | null; evidence_kind?: string | null }): string {
  const label = (item.label ?? "").trim();
  if (label && !BARE_SESSION_RE.test(label)) return label;
  const kind = (item.evidence_kind ?? "").trim();
  if (kind) return kind;
  return label || "—";
}

// Minimal structural shape accepted by isEmptyDay — satisfied by both
// AttentionDayResponse (raw) and AttentionDayViewModel (normalised).
interface _DayLike {
  nar_hours: number;
  displaced?: { explicit?: { items?: unknown[] | null } | null; inferred?: { items?: unknown[] | null } | null; autonomous?: { items?: unknown[] | null } | null } | null;
  unrated?: unknown[] | null;
}

export function isEmptyDay(day: _DayLike): boolean {
  if (!day || day.nar_hours > 0) return !day;
  const d = day.displaced;
  return !d || (
    (d.explicit?.items?.length ?? 0) === 0 &&
    (d.inferred?.items?.length ?? 0) === 0 &&
    (d.autonomous?.items?.length ?? 0) === 0 &&
    (day.unrated?.length ?? 0) === 0
  );
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

// ── Day view model — normalised, section-safe ────────────────────────────────
// Each top-level section is `null` when the API omits it (partial response or
// older ctrl-api build). The component renders "unavailable" for null sections;
// it never sees `undefined` and never crashes.

export interface AttentionDayViewModel {
  date: string; nar_hours: number;
  displaced: { total_hours: number; explicit: { hours: number; items: ExplicitItem[] }; inferred: { hours: number; items: InferredDisplayItem[] }; autonomous: { hours: number; items: AutonomousItem[] } } | null;
  engaged: { hours: number; events: number; bursts: number; gap_minutes: number; floor_minutes: number } | null;
  interruption: { hours: number; count: number; rate_minutes: number } | null;
  stats: { sessions: number; turns: number; self_corrections: number; blocked: number; hard_failures: number; return_ratio: number; autonomous_artifacts: number } | null;
  rates: { suppression_minutes_per_item: number; bucket_minutes: { S: number; M: number; L: number; XL: number }; interruption_minutes: number } | null;
  unrated: UnratedRow[];
}

/** Normalise a raw API day response into a fully-typed view model.
 *  Every absent top-level section becomes `null`; never `undefined`.
 *  Safe to call with `null`, `undefined`, or `{}`. */
export function normalizeAttentionDay(raw: unknown): AttentionDayViewModel {
  const r = (raw ?? {}) as Partial<AttentionDayResponse>;
  return {
    date: typeof r.date === "string" ? r.date : "—",
    nar_hours: typeof r.nar_hours === "number" ? r.nar_hours : 0,
    displaced: r.displaced != null ? {
      total_hours: r.displaced.total_hours ?? 0,
      explicit: { hours: r.displaced.explicit?.hours ?? 0, items: r.displaced.explicit?.items ?? [] },
      inferred: { hours: r.displaced.inferred?.hours ?? 0, items: deriveInferredDisplay(r.displaced.inferred?.items ?? []) },
      autonomous: { hours: r.displaced.autonomous?.hours ?? 0, items: r.displaced.autonomous?.items ?? [] },
    } : null,
    engaged: r.engaged != null ? {
      hours: r.engaged.hours ?? 0, events: r.engaged.events ?? 0,
      bursts: r.engaged.bursts ?? 0, gap_minutes: r.engaged.gap_minutes ?? 0, floor_minutes: r.engaged.floor_minutes ?? 0,
    } : null,
    interruption: r.interruption != null ? {
      hours: r.interruption.hours ?? 0, count: r.interruption.count ?? 0, rate_minutes: r.interruption.rate_minutes ?? 0,
    } : null,
    stats: r.stats != null ? {
      sessions: r.stats.sessions ?? 0, turns: r.stats.turns ?? 0, self_corrections: r.stats.self_corrections ?? 0,
      blocked: r.stats.blocked ?? 0, hard_failures: r.stats.hard_failures ?? 0,
      return_ratio: r.stats.return_ratio ?? 0, autonomous_artifacts: r.stats.autonomous_artifacts ?? 0,
    } : null,
    rates: r.rates != null ? {
      suppression_minutes_per_item: r.rates.suppression_minutes_per_item ?? 0,
      bucket_minutes: { S: r.rates.bucket_minutes?.S ?? 0, M: r.rates.bucket_minutes?.M ?? 0, L: r.rates.bucket_minutes?.L ?? 0, XL: r.rates.bucket_minutes?.XL ?? 0 },
      interruption_minutes: r.rates.interruption_minutes ?? 0,
    } : null,
    unrated: deriveUnratedRows(r.unrated ?? []),
  };
}

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
