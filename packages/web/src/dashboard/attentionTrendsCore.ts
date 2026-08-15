// attentionTrendsCore.ts — pure derivations for the TRENDS tab (#584).
// No imports; node:test-able. Hand-rolled SVG only — no charting library added.

export type TrendsGrain = "week" | "month" | "quarter";
export interface AllocationSlice { displaced_hours: number; engaged_hours: number }
export interface ClassSlice { displaced_hours: number; engaged_hours: number; count: number }
export interface SizeSlice { count: number; displaced_hours: number }
export interface TrendsPeriod {
  key: string; start: string; end: string; days: number;
  nar_hours: number; displaced_hours: number; engaged_hours: number;
  interruption_hours: number; interruption_instrumented: boolean;
  return_ratio: number | null;  // null when engaged_hours === 0
  allocation: { work: AllocationSlice; life: AllocationSlice; unallocated: AllocationSlice };
  by_class: { conversational: ClassSlice; autonomous: ClassSlice; explicit: ClassSlice };
  by_bucket: { S: SizeSlice; M: SizeSlice; L: SizeSlice; XL: SizeSlice };
  unbucketed: { count: number; displaced_hours: number };
  outcomes: { delivered: number; failed: number; unknown: number };
  sessions: number;
}
export interface TrendsCoverage { interruption_instrumented_from: string | null; days_total: number; days_with_data: number }
export interface TrendsObservation { headline: string; detail: string; evidence: string }
export interface TrendsRead { generated_at: string; observations: TrendsObservation[] }
export interface AttentionTrendsResponse {
  grain: TrendsGrain; from: string; to: string;
  coverage: TrendsCoverage; periods: TrendsPeriod[]; read: TrendsRead | null;
}

// ── Period label ───────────────────────────────────────────────────────────────

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"] as const;
/** "2026-W22" → "W22"; "2026-05" → "May"; "2026-Q2" → "Q2". */
export function derivePeriodLabel(key: string, grain: TrendsGrain): string {
  if (grain === "week")  { const m = /W(\d{1,2})$/.exec(key); return m ? `W${m[1]}` : key; }
  if (grain === "month") { const m = /^(\d{4})-(\d{2})$/.exec(key); if (m) return MONTH_ABBR[parseInt(m[2],10)-1] ?? key; return key; }
  const m = /Q(\d)$/.exec(key); return m ? `Q${m[1]}` : key;
}

// ── Partial period ─────────────────────────────────────────────────────────────

/** Minimum day count for a full period per grain. Partials must be visually marked — not treated as low-NAR weeks. */
export const GRAIN_FULL_DAYS: Record<TrendsGrain, number> = { week: 7, month: 28, quarter: 84 };
export function isPartialPeriod(period: Pick<TrendsPeriod, "days">, grain: TrendsGrain): boolean {
  return (period.days ?? 0) < GRAIN_FULL_DAYS[grain];
}

// ── NAR chart ─────────────────────────────────────────────────────────────────

export interface NarBar {
  key: string; label: string; nar_hours: number; displaced_hours: number; engaged_hours: number;
  partial: boolean;        // partial period — must be visually distinguished
  uninstrumented: boolean; // interruption_instrumented=false — cost is unmeasured, not zero
}
export function deriveNarBars(periods: TrendsPeriod[], grain: TrendsGrain): NarBar[] {
  return (periods ?? []).map((p) => ({
    key: p.key, label: derivePeriodLabel(p.key, grain),
    nar_hours: p.nar_hours, displaced_hours: p.displaced_hours, engaged_hours: p.engaged_hours,
    partial: isPartialPeriod(p, grain), uninstrumented: !p.interruption_instrumented,
  }));
}
/** Largest absolute value in the series; returns 1 when all zero (no div-by-zero). */
export function deriveSeriesMax(values: number[]): number {
  return Math.max(...(values ?? []).map((v) => Math.abs(v ?? 0)), 1);
}

// ── Summary headline pair ──────────────────────────────────────────────────────

export interface TrendsSummary {
  latest_nar: number | null; nar_delta: number | null;
  latest_ratio: number | null; ratio_direction: "up" | "down" | "flat" | null;
}
export function deriveTrendsSummary(periods: TrendsPeriod[]): TrendsSummary {
  const ps = periods ?? [];
  if (!ps.length) return { latest_nar: null, nar_delta: null, latest_ratio: null, ratio_direction: null };
  const last = ps[ps.length - 1]; const prev = ps.length > 1 ? ps[ps.length - 2] : null;
  const ratio_direction: TrendsSummary["ratio_direction"] =
    last.return_ratio == null || prev?.return_ratio == null ? null
    : last.return_ratio > prev.return_ratio + 0.05 ? "up"
    : last.return_ratio < prev.return_ratio - 0.05 ? "down" : "flat";
  return { latest_nar: last.nar_hours, nar_delta: prev != null ? last.nar_hours - prev.nar_hours : null, latest_ratio: last.return_ratio, ratio_direction };
}

// ── Allocation trend ───────────────────────────────────────────────────────────

export interface AllocationBar { key: string; label: string; work: number; life: number; unallocated: number; total: number }
export function deriveAllocationBars(periods: TrendsPeriod[], grain: TrendsGrain): AllocationBar[] {
  return (periods ?? []).map((p) => {
    const w = p.allocation?.work?.displaced_hours ?? 0;
    const l = p.allocation?.life?.displaced_hours ?? 0;
    const u = p.allocation?.unallocated?.displaced_hours ?? 0;
    return { key: p.key, label: derivePeriodLabel(p.key, grain), work: w, life: l, unallocated: u, total: Math.max(w+l+u, 0.001) };
  });
}

// ── Return-ratio trend ─────────────────────────────────────────────────────────

/** Periods where engaged < this threshold have a misleading ratio — de-emphasise them. */
export const LOW_ENGAGEMENT_HOURS = 1;
export interface RatioBar {
  key: string; label: string;
  ratio: number | null; // null preserved from API — display renders "—", never 0
  low_engagement: boolean; uninstrumented: boolean;
}
export function deriveRatioBars(periods: TrendsPeriod[], grain: TrendsGrain): RatioBar[] {
  return (periods ?? []).map((p) => ({
    key: p.key, label: derivePeriodLabel(p.key, grain),
    ratio: p.return_ratio, // null never coerced to 0
    low_engagement: (p.engaged_hours ?? 0) < LOW_ENGAGEMENT_HOURS,
    uninstrumented: !p.interruption_instrumented,
  }));
}

// ── Bucket distribution (S/M/L/XL only — unbucketed is NOT a size) ────────────

export type BucketKey = "S" | "M" | "L" | "XL";
export const BUCKET_KEYS: readonly BucketKey[] = ["S", "M", "L", "XL"] as const;
export interface BucketBar {
  key: string; label: string; S: number; M: number; L: number; XL: number;
  unbucketed_count: number; // footnote only — never a bar
}
export function deriveBucketBars(periods: TrendsPeriod[], grain: TrendsGrain): BucketBar[] {
  return (periods ?? []).map((p) => ({
    key: p.key, label: derivePeriodLabel(p.key, grain),
    S: p.by_bucket?.S?.count ?? 0, M: p.by_bucket?.M?.count ?? 0,
    L: p.by_bucket?.L?.count ?? 0, XL: p.by_bucket?.XL?.count ?? 0,
    unbucketed_count: p.unbucketed?.count ?? 0,
  }));
}

// ── Outcomes trend ─────────────────────────────────────────────────────────────

export interface OutcomesBar { key: string; label: string; delivered: number; failed: number; unknown: number; total: number }
export function deriveOutcomesBars(periods: TrendsPeriod[], grain: TrendsGrain): OutcomesBar[] {
  return (periods ?? []).map((p) => {
    const d = p.outcomes?.delivered ?? 0; const f = p.outcomes?.failed ?? 0; const u = p.outcomes?.unknown ?? 0;
    return { key: p.key, label: derivePeriodLabel(p.key, grain), delivered: d, failed: f, unknown: u, total: d+f+u };
  });
}

// ── Read presence guard ────────────────────────────────────────────────────────

/** True when Alfred's read has been generated (observations may be empty). */
export function isReadGenerated(read: TrendsRead | null | undefined): read is TrendsRead {
  return read != null && Array.isArray(read.observations);
}

// ── Empty-state text (exported so the test can assert honesty) ─────────────────

/** Displayed when no read has been generated for the current window.
 *  Must NOT claim automatic or scheduled generation — there is no nightly job for this. */
export const READ_EMPTY_STATE_TEXT = "No read has been generated for this window.";

/** How long the generate-read poll runs before giving up.
 *  Must be strictly greater than the expected 1-2 min generation time. */
export const POLL_GIVE_UP_MS = 5 * 60 * 1000; // 5 minutes

/** Shown while the read poll is active and waiting for the workflow to complete. */
export const READ_POLL_PENDING_TEXT =
  "Generating Alfred's read — this takes a minute or two. The page will update automatically.";

/** Shown when the poll reaches its lifetime limit.
 *  Must NOT assert failure as a certainty — the workflow may simply be slow. */
export const READ_POLL_GAVE_UP_TEXT =
  "The read was requested and has not appeared after several minutes. The workflow may have failed or may simply be slow. Try again when ready.";

// ── Empty-edge trimming ────────────────────────────────────────────────────────

/** A period is data-empty when all key fields are zero — no displacement, no engagement, no NAR.
 *  This distinguishes "system not yet deployed" padding from a genuine quiet week. */
export function isEmptyPeriod(p: TrendsPeriod): boolean {
  return (p.nar_hours ?? 0) === 0 && (p.displaced_hours ?? 0) === 0 && (p.engaged_hours ?? 0) === 0;
}

/** Remove leading and trailing periods that contain no data at all.
 *  A zero-activity period in the MIDDLE of the series is preserved — a quiet week
 *  that falls between active weeks reads correctly as a quiet week, not as padding. */
export function trimEmptyEdgePeriods(periods: TrendsPeriod[]): TrendsPeriod[] {
  if (!periods?.length) return [];
  let s = 0, e = periods.length - 1;
  while (s <= e && isEmptyPeriod(periods[s])) s++;
  while (e >= s && isEmptyPeriod(periods[e])) e--;
  return periods.slice(s, e + 1);
}
