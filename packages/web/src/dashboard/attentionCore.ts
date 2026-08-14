// attentionCore — pure response→view-model derivation for /attention (#584).
// Import-free; node:test-able. Four invariants enforced:
//   1. three displacement groups (explicit/inferred/autonomous) stay separate
//   2. unrated classes carry note="no_rate_established", never zero
//   3. only explicitly failed/blocked/aborted inferred → display_minutes=0; absent outcome credits at full rate
//   4. empty day is identifiable without inspecting items

export interface ExplicitItem { label: string; count: number; rate_minutes: number; minutes: number }
export interface InferredItem { label: string; bucket: string; minutes: number; turns?: number | null; tools?: number | null; evidence_kind: string; evidence_ref: string; outcome?: string | null; engaged_minutes?: number | null; nar_minutes?: number | null }
export interface AutonomousItem { label: string; bucket: string; minutes: number; evidence_kind: string; evidence_ref: string; engaged_minutes?: number | null; nar_minutes?: number | null }
export interface UnratedEntry { action_class: string; count: number }

export interface AllocationBucket { displaced_hours: number; engaged_hours: number; interruption_hours: number; nar_hours: number }
export interface AllocationBlock { work: AllocationBucket; life: AllocationBucket; unallocated: AllocationBucket }
export interface AllocationReconciliation { attributed_engaged_hours: number; day_engaged_hours: number; difference_hours: number }

export interface AttentionDayResponse {
  date: string; nar_hours: number;
  displaced: { total_hours: number; explicit: { hours: number; items: ExplicitItem[] }; inferred: { hours: number; items: InferredItem[] }; autonomous: { hours: number; items: AutonomousItem[] } };
  engaged: { hours: number; events: number; bursts: number; gap_minutes: number; floor_minutes: number };
  interruption: { hours: number; count: number; rate_minutes: number };
  stats: { sessions: number; turns: number; self_corrections: number; blocked: number; hard_failures: number; return_ratio: number; autonomous_artifacts: number };
  rates: { suppression_minutes_per_item: number; bucket_minutes: { S: number; M: number; L: number; XL: number }; interruption_minutes: number };
  unrated: UnratedEntry[];
  allocation?: AllocationBlock | null;
  allocation_reconciliation?: AllocationReconciliation | null;
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
  engaged_minutes: number | null; // null = not measured; never zero-substituted
  nar_minutes: number | null;     // null when engaged is null
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
      outcome: it.outcome, is_blocked: explicitFail, blocked_reason: explicitFail ? `outcome: ${it.outcome} — no displacement credit` : null,
      engaged_minutes: it.engaged_minutes ?? null, nar_minutes: it.nar_minutes ?? null };
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
  allocation: AllocationBlock | null;
  allocation_reconciliation: AllocationReconciliation | null;
}

/** Normalise one AllocationBucket — all fields default to 0 when absent. */
function _normAllocBucket(b: Partial<AllocationBucket> | null | undefined): AllocationBucket {
  return {
    displaced_hours:    b?.displaced_hours    ?? 0,
    engaged_hours:      b?.engaged_hours      ?? 0,
    interruption_hours: b?.interruption_hours ?? 0,
    nar_hours:          b?.nar_hours          ?? 0,
  };
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
    allocation: r.allocation != null ? {
      work:        _normAllocBucket(r.allocation.work),
      life:        _normAllocBucket(r.allocation.life),
      unallocated: _normAllocBucket(r.allocation.unallocated),
    } : null,
    allocation_reconciliation: r.allocation_reconciliation != null ? {
      attributed_engaged_hours: r.allocation_reconciliation.attributed_engaged_hours ?? 0,
      day_engaged_hours:        r.allocation_reconciliation.day_engaged_hours        ?? 0,
      difference_hours:         r.allocation_reconciliation.difference_hours         ?? 0,
    } : null,
  };
}

// ── Header date format ────────────────────────────────────────────────────────

const _DAYS = ["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"] as const;
const _MONTHS = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"] as const;

/** Format "2026-08-14" → "THURSDAY 14 AUGUST 2026" (uppercase, UTC-based day-of-week). */
export function formatHeaderDate(dateStr: string): string {
  const parts = (dateStr ?? "").split("-").map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return (dateStr ?? "").toUpperCase();
  const [y, m, d] = parts;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${_DAYS[dt.getUTCDay()]} ${d} ${_MONTHS[m - 1]} ${y}`;
}

// ── Whole-minute formatter (section 03 uses minutes, not hours) ───────────────

/** Round to nearest whole minute and return as a plain string (no unit).
 *  Section 03 ledger columns use whole minutes; section 01 uses hours. */
export function formatWholeMinutes(minutes: number): string {
  return String(Math.round(minutes ?? 0));
}

// ── Autonomous row collapsing ─────────────────────────────────────────────────

export interface CollapsedAutonomousRow {
  label: string; bucket: string; count: number; total_minutes: number;
}

/** Group AutonomousItems with identical labels into one collapsed row.
 *  Preserves insertion order of first occurrence; adopts that occurrence's bucket.
 *  Invariant: sum(result[i].total_minutes) == sum(items[i].minutes). */
export function collapseAutonomousRows(items: AutonomousItem[]): CollapsedAutonomousRow[] {
  const map = new Map<string, CollapsedAutonomousRow>();
  for (const it of (items ?? [])) {
    const row = map.get(it.label);
    if (row) { row.count += 1; row.total_minutes += it.minutes; }
    else map.set(it.label, { label: it.label, bucket: it.bucket, count: 1, total_minutes: it.minutes });
  }
  return Array.from(map.values());
}

// ── Ledger view model (section 03) ────────────────────────────────────────────

/** Em-dash sentinel — used as a display constant when a measured column is absent. */
export const LEDGER_COL_NA = "—" as const;
export type LedgerColNA = typeof LEDGER_COL_NA;

export interface LedgerItemRow {
  label: string;
  displaced_min: number;        // always available from API
  engaged_min: number | null;   // null = not measured (chore run, desk decision)
  nar_min: number | null;       // null when engaged is null — unknown ≠ zero
  count?: number;               // present only on collapsed autonomous rows (count > 1)
}

export interface LedgerGroup {
  name: "CONVERSATIONAL" | "EXPLICIT" | "AUTONOMOUS";
  rows: LedgerItemRow[];
  subtotal_displaced_min: number;       // == sum(rows[i].displaced_min)
  subtotal_engaged_min: number | null;  // null when all rows are null; sum of non-null otherwise
  subtotal_nar_min: number | null;      // same rule
}

export interface LedgerViewModel {
  groups: LedgerGroup[];
  total_displaced_min: number;       // == sum(groups[i].subtotal_displaced_min)
  total_engaged_min: number | null;  // null when no group has a measured row
  total_nar_min: number | null;      // same rule
}

/** Sum only the non-null values in an array.
 *  Returns null when the array is empty or every element is null. */
function sumNullable(values: (number | null)[]): number | null {
  const measured = values.filter((v): v is number => v !== null);
  return measured.length > 0 ? measured.reduce((a, b) => a + b, 0) : null;
}

/** Build the three-group ledger from the NORMALISED displaced block.
 *  Groups: CONVERSATIONAL (inferred) · EXPLICIT (rate-card) · AUTONOMOUS (collapsed).
 *  Invariants:
 *    group.subtotal_displaced_min == sum(rows[i].displaced_min)
 *    total_displaced_min         == sum(groups[i].subtotal_displaced_min)
 *  Null-sum rule: subtotal/total for engaged/nar is null when no measured rows exist. */
export function deriveLedger(
  displaced: AttentionDayViewModel["displaced"] | null | undefined,
): LedgerViewModel {
  // Takes the ALREADY-NORMALISED displaced block, not the raw response.
  // normalizeAttentionDay has run deriveInferredDisplay; running it again here
  // read `it.minutes`, which does not exist on InferredDisplayItem, so every
  // conversational row rendered NaN. Consume display_minutes directly.
  const convRows: LedgerItemRow[] = (displaced?.inferred?.items ?? []).map((it) => ({
    label: formatItemLabel(it), displaced_min: it.display_minutes,
    engaged_min: it.engaged_minutes, nar_min: it.nar_minutes,
  }));
  // Explicit (rate-card) and autonomous items carry no per-session engagement measurement.
  const explRows: LedgerItemRow[] = (displaced?.explicit?.items ?? []).map((it) => ({
    label: it.label, displaced_min: it.minutes,
    engaged_min: null, nar_min: null,
  }));
  const autoRows: LedgerItemRow[] = collapseAutonomousRows(displaced?.autonomous?.items ?? []).map((it) => ({
    label: it.label, displaced_min: it.total_minutes,
    engaged_min: null, nar_min: null,
    ...(it.count > 1 ? { count: it.count } : {}),
  }));
  const rowSum = (rows: LedgerItemRow[]) => rows.reduce((s, r) => s + r.displaced_min, 0);
  const groups: LedgerGroup[] = [
    { name: "CONVERSATIONAL", rows: convRows, subtotal_displaced_min: rowSum(convRows),
      subtotal_engaged_min: sumNullable(convRows.map(r => r.engaged_min)),
      subtotal_nar_min:     sumNullable(convRows.map(r => r.nar_min)) },
    { name: "EXPLICIT", rows: explRows, subtotal_displaced_min: rowSum(explRows),
      subtotal_engaged_min: null, subtotal_nar_min: null },
    { name: "AUTONOMOUS", rows: autoRows, subtotal_displaced_min: rowSum(autoRows),
      subtotal_engaged_min: null, subtotal_nar_min: null },
  ];
  return {
    groups,
    total_displaced_min: groups.reduce((s, g) => s + g.subtotal_displaced_min, 0),
    total_engaged_min: sumNullable(groups.map(g => g.subtotal_engaged_min)),
    total_nar_min:     sumNullable(groups.map(g => g.subtotal_nar_min)),
  };
}

/** Note rendered below section 03 column headers: names which row types carry no measurement. */
export const LEDGER_PER_ITEM_NOTE = "Chore runs and desk decisions carry no per-session engagement measurement — their ENGAGED and NAR columns show —." as const;

// ── Section 02 bar geometry ───────────────────────────────────────────────────

export interface AllocationBarWidths { work: number; life: number; unallocated: number }

/** Compute bar-track fill widths (0–100%) for the three allocation rows.
 *  Each row's width is proportional to its displaced_hours, scaled to the
 *  largest of the three. An all-zero allocation produces all-zero widths
 *  (empty tracks) — absence stays legible rather than vanishing.
 *  Safe to call with null / undefined. */
export function deriveAllocationBarWidths(
  allocation: AllocationBlock | null | undefined,
): AllocationBarWidths {
  if (!allocation) return { work: 0, life: 0, unallocated: 0 };
  const maxDisp = Math.max(
    allocation.work.displaced_hours,
    allocation.life.displaced_hours,
    allocation.unallocated.displaced_hours,
    0.001,
  );
  return {
    work:        (allocation.work.displaced_hours        / maxDisp) * 100,
    life:        (allocation.life.displaced_hours        / maxDisp) * 100,
    unallocated: (allocation.unallocated.displaced_hours / maxDisp) * 100,
  };
}

// ── Section 01 bar geometry ───────────────────────────────────────────────────

export interface BarGeometry {
  /** DISPLACED — solid brass, typically the tallest bar; sets the scale. */
  displaced: { value_hours: number; height_pct: number };
  /** THE MESS — hatched, floats between NET's top edge and DISPLACED's top edge.
   *  y_offset_pct: percentage-units above baseline where the mess bar's BOTTOM sits
   *  (equals net.height_pct). Invariant: y_offset_pct + height_pct == displaced.height_pct. */
  mess: { value_hours: number; height_pct: number; y_offset_pct: number };
  /** NET — NAR = displaced − mess; solid brass, grows from baseline. */
  net: { value_hours: number; height_pct: number };
}

/** Compute waterfall bar geometry for the three-bar SVG in section 01.
 *  DISPLACED and NET share a baseline and grow upward.
 *  THE MESS floats as a hatched slice between NET's top and DISPLACED's top —
 *  it does not touch the baseline.
 *  Invariants (enforced by algebra, tested separately):
 *    mess.y_offset_pct + mess.height_pct == displaced.height_pct
 *    net.height_pct    + mess.height_pct == displaced.height_pct
 *  Negative NAR (mess > displaced) is handled by clamping net to 0, which keeps
 *  all values non-negative while preserving net.value_hours for the label. */
export function deriveBarGeometry(
  displaced_hours: number, engaged_hours: number, interruption_hours: number,
  barHeight = 100,
): BarGeometry {
  const d    = Math.max(displaced_hours ?? 0, 0);
  const mess = (engaged_hours ?? 0) + (interruption_hours ?? 0);
  const net  = d - mess;
  // Scale: displaced is always the reference bar (tallest when NAR >= 0).
  // When mess > displaced (negative NAR) use mess so bars stay inside [0, barHeight].
  const maxMag  = Math.max(d, mess, 0.001);
  const dispPct = (d / maxMag) * barHeight;
  const netPct  = (Math.max(net, 0) / maxMag) * barHeight; // clamped — negative NAR → 0
  const messPct = dispPct - netPct;                         // invariant holds by construction
  return {
    displaced: { value_hours: d,    height_pct: dispPct },
    mess:      { value_hours: mess, height_pct: messPct, y_offset_pct: netPct },
    net:       { value_hours: net,  height_pct: netPct },
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
