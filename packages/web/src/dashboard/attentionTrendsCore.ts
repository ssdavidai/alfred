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
export interface TrendsCoverage { interruption_instrumented_from: string | null; days_total: number; days_with_data: number; data_from?: string | null }
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

// ── Period pickers (#trends-window) ──────────────────────────────────────────
// The Trends tab lets the principal choose WHICH weeks/months/quarters are
// compared. These helpers enumerate selectable periods and derive/clamp the
// window. Boundary conventions MUST match ctrl's periodKeyBounds
// (packages/ctrl/src/api/routes/attention.ts): ISO weeks Mon–Sun with the
// Thursday anchor, calendar months, calendar quarters.

export interface PeriodOption { key: string; label: string; start: string; end: string }

/** Mirror of ctrl periodKeyBounds — pure, UTC, no Date.now(). */
export function periodBoundsClient(grain: TrendsGrain, dateStr: string): PeriodOption {
  if (grain === "week") {
    const d = new Date(`${dateStr}T00:00:00Z`); const dow = d.getUTCDay() || 7;
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow + 1);
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    const thu = new Date(d); thu.setUTCDate(d.getUTCDate() - dow + 4);
    const wn = Math.ceil(((thu.getTime() - Date.UTC(thu.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
    const key = `${thu.getUTCFullYear()}-W${String(wn).padStart(2, "0")}`;
    const start = mon.toISOString().slice(0, 10);
    const mm = MONTH_ABBR[mon.getUTCMonth()]; const dd = mon.getUTCDate();
    return { key, label: `W${String(wn).padStart(2, "0")} · ${mm} ${dd}`, start, end: sun.toISOString().slice(0, 10) };
  }
  const [y, mo] = dateStr.slice(0, 7).split("-").map(Number);
  if (grain === "month") {
    const start = `${y}-${String(mo).padStart(2, "0")}-01`;
    return { key: dateStr.slice(0, 7), label: `${MONTH_ABBR[mo - 1]} ${y}`, start,
      end: new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10) };
  }
  const q = Math.ceil(mo / 3); const qm1 = (q - 1) * 3 + 1;
  return { key: `${y}-Q${q}`, label: `Q${q} ${y}`, start: `${y}-${String(qm1).padStart(2, "0")}-01`,
    end: new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10) };
}

/** Hard cap mirrored from the ctrl route — a wider request is a 400. */
export const TRENDS_MAX_DAYS = 400;
const DAY = 86400000;
function addDaysIso(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Every selectable period from the ledger's first entry (or a one-year
 * fallback when the API predates data_from) through today. Ascending.
 */
export function enumeratePeriodOptions(dataFrom: string | null | undefined, today: string, grain: TrendsGrain): PeriodOption[] {
  const floor = dataFrom && /^\d{4}-\d{2}-\d{2}$/.test(dataFrom) ? dataFrom : addDaysIso(today, -365);
  const out: PeriodOption[] = [];
  let cur = periodBoundsClient(grain, floor);
  const stop = new Date(`${today}T00:00:00Z`).getTime();
  // ≤400-day windows over a few years of grain periods — bounded, but belt it.
  for (let i = 0; i < 400; i++) {
    out.push(cur);
    const nextStart = addDaysIso(cur.end, 1);
    if (new Date(`${nextStart}T00:00:00Z`).getTime() > stop) break;
    cur = periodBoundsClient(grain, nextStart);
  }
  return out;
}

/** Default comparison window per grain: last 13 weeks / 6 months / 4 quarters. */
export const GRAIN_DEFAULT_PERIODS: Record<TrendsGrain, number> = { week: 13, month: 6, quarter: 4 };
export function defaultTrendsWindow(grain: TrendsGrain, today: string): { from: string; to: string } {
  const n = GRAIN_DEFAULT_PERIODS[grain];
  const latest = periodBoundsClient(grain, today);
  // Walk back n-1 periods from the current one.
  let start = latest;
  for (let i = 1; i < n; i++) start = periodBoundsClient(grain, addDaysIso(start.start, -1));
  return { from: start.start, to: today };
}

/**
 * Clamp a picked window: future end snaps to today, inverted ranges snap the
 * `to` up to the `from` period's end, and a span over the server's 400-day cap
 * pulls `from` forward to the start of the period containing (to − 399d).
 */
export function clampTrendsWindow(fromStart: string, toEnd: string, today: string, grain: TrendsGrain): { from: string; to: string } {
  let from = fromStart;
  let to = toEnd > today ? today : toEnd;
  if (from > to) to = periodBoundsClient(grain, from).end > today ? today : periodBoundsClient(grain, from).end;
  const span = Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY) + 1;
  if (span > TRENDS_MAX_DAYS) from = periodBoundsClient(grain, addDaysIso(to, -(TRENDS_MAX_DAYS - 1))).start;
  // A from pulled forward into a partial period must not precede the cap window.
  if (from < addDaysIso(to, -(TRENDS_MAX_DAYS - 1))) from = addDaysIso(to, -(TRENDS_MAX_DAYS - 1));
  return { from, to };
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

// ── Sentence engine ───────────────────────────────────────────────────────────
// Port of the AttentionTrends.html inline <script>. Pure functions; zero deps.
// JSX text rule: always \u escapes in strings — \x escapes render literally in JSX children.

/** Round to 1 dp, drop trailing zero for whole values. */
export function f1(n: number): string {
  const v = Math.round(n * 10) / 10;
  return v % 1 === 0 ? String(Math.round(v)) : v.toFixed(1);
}

export type Direction = "up" | "down" | "flat";
/** Direction at ±10% threshold. Zero base: up when b > 0, flat otherwise. */
export function dir(a: number, b: number): Direction {
  if (a === 0) return b > 0 ? "up" : "flat";
  const p = (b - a) / Math.abs(a);
  return p <= -0.10 ? "down" : p >= 0.10 ? "up" : "flat";
}

// Panel 1 — NET RETURNED

export interface NarHeadlineParams { nar: number; engaged: number | null; displaced: number }
/** HTML string for the NET RETURNED h2.
 *  When engaged is null no ratio is claimed (instrumentation was absent). */
export function deriveNarHeadline(p: NarHeadlineParams): string {
  const { nar, engaged, displaced } = p;
  if (engaged == null)
    return `<em>${f1(nar)} hours came back this week;</em> your time wasn’t measured.`;
  if (nar <= 0)
    return `<em>Nothing came back this week:</em> ${f1(engaged)} hours in, ${f1(displaced)} out.`;
  return `<em>${f1(nar)} hours came back this week,</em> for the ${f1(engaged)} you put in.`;
}

// Panel 2 — RETURN RATIO

export interface RatioHeadlineParams {
  ratio: number | null; engaged: number | null;
  /** null when no qualifying period clears the engagement floor — see deriveRatioPeak.
   *  NOTE: the design-system template omits this filter; re-syncing from it would reintroduce Bug 2. */
  peakValue: number | null; peakMonth: string;
  ratioSeries: (number | null)[];
}
/** HTML string for the RETURN RATIO h2.
 *  Returns null when engaged is null — no ratio claimed.
 *  Uses LOW_ENGAGEMENT_HOURS for the refuse-to-price floor (same constant as deriveRatioPeak). */
export function deriveRatioHeadline(p: RatioHeadlineParams): string | null {
  if (p.engaged == null) return null;
  // Bug 2 fix: use the shared constant so the refuse-to-price floor and peak-selection
  // floor are always identical. The design-system template had < 1 hardcoded.
  if (p.engaged < LOW_ENGAGEMENT_HOURS) return "Too little of your time was logged this week to price it.";
  if (p.ratio == null) return "No engagement data this week — return ratio unavailable.";
  const rs = (p.ratioSeries ?? []).filter((v): v is number => v != null);
  let streak = 1;
  for (let i = rs.length - 1; i > 0; i--) {
    if (rs[i - 1] > 0 && Math.abs(rs[i] - rs[i - 1]) / rs[i - 1] < 0.05) streak++;
    else break;
  }
  if (p.peakValue != null && p.ratio >= p.peakValue)
    return `An hour of you now buys <em>${f1(p.ratio)} hours</em> of work — the best yet.`;
  if (streak >= 3)
    return `An hour of you buys <em>${f1(p.ratio)} hours</em> of work — steady for ${streak} weeks.`;
  // When no qualifying peak exists, the comparison clause is omitted — the first half stands alone.
  if (p.peakValue == null)
    return `An hour of you now buys <em>${f1(p.ratio)} hours</em> of work.`;
  return `An hour of you now buys <em>${f1(p.ratio)} hours</em> of work. In ${p.peakMonth} it bought ${f1(p.peakValue)}.`;
}

/** Split ratio bars into solid (adjacent non-null) and gap (crossing-null) segments.
 *  A null produces a gap segment — never an interpolated point. */
export interface LineSegment { from: number; to: number; isGap: boolean }
export function deriveRatioLineSegmentsFromBars(bars: RatioBar[]): LineSegment[] {
  const segs: LineSegment[] = [];
  let last = -1;
  for (let i = 0; i < (bars ?? []).length; i++) {
    if (bars[i].ratio != null) {
      if (last >= 0) segs.push({ from: last, to: i, isGap: i > last + 1 });
      last = i;
    }
  }
  return segs;
}

/** Peak return-ratio period from a qualifying set. */
export interface RatioPeak { value: number; label: string }
/** Select the peak ratio period, excluding any period below LOW_ENGAGEMENT_HOURS.
 *  Reuses the same floor constant as the refuse-to-price rule in deriveRatioHeadline —
 *  a single threshold governs both sites; do not introduce a second literal here.
 *  Returns null when no period clears the floor (caller must omit the comparison clause). */
export function deriveRatioPeak(periods: TrendsPeriod[], grain: TrendsGrain): RatioPeak | null {
  const qualifying = (periods ?? []).filter(p =>
    (p.engaged_hours ?? 0) >= LOW_ENGAGEMENT_HOURS && p.return_ratio != null
  );
  if (!qualifying.length) return null;
  const peak = qualifying.reduce((best, p) => (p.return_ratio! > best.return_ratio!) ? p : best);
  return { value: peak.return_ratio!, label: derivePeriodLabel(peak.key, grain) };
}

// Panel 3 — ALFRED'S READ

export interface ReadHeadlineParams {
  dR: Direction; dX: Direction; dF: Direction;
  priorKey: string; latestKey: string; priorRatio: number; latestRatio: number;
  priorFailures: number; latestFailures: number; priorEngaged: number; latestEngaged: number;
  priorXLHours: number; latestXLHours: number;
}
/** HTML string chosen from 8 templates by direction triple (dR × dX × dF). */
export function deriveReadHeadline(p: ReadHeadlineParams): string {
  const { dR, dX, dF, priorFailures: af, latestFailures: bf,
    priorEngaged: ae, latestEngaged: be, priorRatio: ar, latestRatio: br,
    priorKey, latestKey } = p;
  const pct = (a: number, b: number) =>
    Math.abs(Math.round(((b - a) / Math.abs(a || 1)) * 1000) / 10);
  if (dR === "down" && dX === "up" && dF !== "up")
    return "Why the rate fell: <em>the work got bigger</em> — not worse.";
  if (dR === "down" && dX === "up")
    return "The rate fell: <em>bigger work,</em> and more of it failed.";
  if (dR === "down" && dF === "up")
    return `The rate fell where quality slipped: <em>failures rose ${af} → ${bf}.</em>`;
  if (dR === "down")
    return `The rate fell on your side of the desk: <em>your time rose ${f1(ae)} → ${f1(be)} hours.</em>`;
  if (dR === "up" && dF === "down")
    return "The rate improved: <em>less of your time, fewer failures.</em>";
  if (dR === "up")
    return "The rate improved <em>even as the work got bigger.</em>";
  if (dR === "flat")
    return `The rate held at <em>${f1(br)}×</em> across both weeks.`;
  return `Return ratio moved ${pct(ar, br)}% from ${priorKey} to ${latestKey}.`;
}

/** Last two full non-partial periods with non-null ratio — read panel source. */
export interface ReadPairData {
  priorKey: string; latestKey: string; priorRatio: number; latestRatio: number;
  priorXLHours: number; latestXLHours: number; priorFailures: number; latestFailures: number;
  priorFinished: number; latestFinished: number; priorEngaged: number; latestEngaged: number;
}
export function deriveReadPairData(periods: TrendsPeriod[], grain: TrendsGrain): ReadPairData | null {
  const full = (periods ?? []).filter(p => !isPartialPeriod(p, grain) && p.return_ratio != null);
  if (full.length < 2) return null;
  const pr = full[full.length - 2], la = full[full.length - 1];
  return {
    priorKey: pr.key, latestKey: la.key,
    priorRatio: pr.return_ratio!, latestRatio: la.return_ratio!,
    priorXLHours: pr.by_bucket?.XL?.displaced_hours ?? 0,
    latestXLHours: la.by_bucket?.XL?.displaced_hours ?? 0,
    priorFailures: pr.outcomes?.failed ?? 0, latestFailures: la.outcomes?.failed ?? 0,
    priorFinished: pr.outcomes?.delivered ?? 0, latestFinished: la.outcomes?.delivered ?? 0,
    priorEngaged: pr.engaged_hours, latestEngaged: la.engaged_hours,
  };
}

// Panel 4 — ALLOCATION

export interface AllocationHeadlineParams {
  totalNar: number; workFrac: number; lifeFrac: number; unassignedFrac: number;
}
/** HTML string for the ALLOCATION h2.
 *  Bug 1 fix: the old else-clause assumed work+life ≈ 1, so a large unassigned slice
 *  could flip the sentence to "mostly to life" even when work > life (live: 32/20/48%).
 *  Fix: (a) when unassigned leads all three, name it as the honest headline;
 *       (b) otherwise compare work vs life directly via each side's share of (work+life).
 *  Tail clause for unassigned > 25% is suppressed when unassigned already leads the headline.
 *  NOTE: the design-system template has the same bug; re-syncing from it reintroduces it. */
export function deriveAllocationHeadline(p: AllocationHeadlineParams): string {
  const { totalNar, workFrac, lifeFrac, unassignedFrac } = p;
  // When unassigned is the largest slice, the work/life split is genuinely unknown.
  if (unassignedFrac > workFrac && unassignedFrac > lifeFrac) {
    const pct = Math.round(unassignedFrac * 100);
    return `<em>${f1(totalNar)} returned hours</em> have gone across work and life — ${pct}% is still unassigned.`;
  }
  // Compare work vs life directly; apply bands on each side's share of (work+life).
  const wlTotal = Math.max(workFrac + lifeFrac, 0.001);
  let phrase: string;
  if (workFrac >= lifeFrac) {
    const wShare = workFrac / wlTotal;
    phrase = wShare >= 0.85 ? "almost entirely to work"
      : wShare >= 0.55 ? "mostly to work"
      : "to work and life evenly";
  } else {
    const lShare = lifeFrac / wlTotal;
    phrase = lShare >= 0.85 ? "almost entirely to life"
      : lShare >= 0.55 ? "mostly to life"
      : "to work and life evenly";
  }
  const tail = unassignedFrac > 0.25
    ? ` — ${Math.round(unassignedFrac * 100)}% still unassigned` : "";
  return `<em>${f1(totalNar)} returned hours</em> have gone ${phrase}.${tail}`;
}

/** Cumulative allocation totals across all periods in the window. */
export interface TrendsAllocTotals {
  totalNar: number; workFrac: number; lifeFrac: number; unassignedFrac: number;
}
export function deriveTrendsAllocTotals(periods: TrendsPeriod[]): TrendsAllocTotals {
  const totalNar = (periods ?? []).reduce((s, p) => s + (p.nar_hours ?? 0), 0);
  const tw = (periods ?? []).reduce((s, p) => s + (p.allocation?.work?.displaced_hours ?? 0), 0);
  const tl = (periods ?? []).reduce((s, p) => s + (p.allocation?.life?.displaced_hours ?? 0), 0);
  const tu = (periods ?? []).reduce((s, p) => s + (p.allocation?.unallocated?.displaced_hours ?? 0), 0);
  const tot = Math.max(tw + tl + tu, 0.001);
  return { totalNar: Math.round(totalNar * 10) / 10, workFrac: tw / tot, lifeFrac: tl / tot, unassignedFrac: tu / tot };
}
