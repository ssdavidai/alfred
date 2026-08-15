// AttentionPage — Attention Statement redesign for /attention (#584).
// Day view: canonical statement (header → 01 The Account → 02 Where It Went →
// 03 The Ledger → rate card → footer). Range tab: unchanged.
import { useState } from "react";
import { useQuery, useAction, getAttentionStatement, getAttentionStats, recomputeAttention } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import logoCurrentcolor from "../client/assets/brand/alfred-logo-currentcolor.svg";
import {
  normalizeAttentionDay, isEmptyDay, formatHours, formatWholeMinutes,
  formatHeaderDate, deriveLedger, deriveBarGeometry, deriveAllocationBarWidths,
  LEDGER_PER_ITEM_NOTE,
  deriveChartBars, deriveChartScale, deriveRangeAggregates,
  type AttentionDayViewModel, type AttentionStatsResponse,
  type ChartBar, type ChartScaleResult, type BarGeometry,
} from "./attentionCore";

const now = () => new Date().toISOString().slice(0, 10);
/** Read an ISO date from the query string; fall back when absent or malformed. */
const dateParam = (key: string, fallback: string): string => {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(key);
  return v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
};
const sevenAgo = () => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); };

// ── Shared primitives ─────────────────────────────────────────────────────────

/** Section-label: "N · TITLE" in brass letterspaced mono caps + hairline rule. */
function SL({ n, title }: { n: string; title: string }) {
  return (
    <div className="flex items-center gap-3" style={{ marginTop: 34, marginBottom: 18 }}>
      <span className="font-mono text-[11px] uppercase tracking-[0.25em] shrink-0" style={{ color: "var(--brass)" }}>
        {n} · {title}
      </span>
      <div className="flex-1" style={{ borderTop: "1px solid var(--rule)", opacity: 0.35 }} />
    </div>
  );
}

/** Legacy section heading — retained for the Range tab. */
function SH({ s }: { s: string }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.26em] mb-2 mt-8" style={{ color: "var(--marginalia)" }}>
      {s}
    </p>
  );
}

// bg-background so it works as a gap-px grid cell (parent sets the gap colour).
function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] mb-1.5" style={{ color: "var(--marginalia)" }}>{label}</p>
      <p className="font-mono text-base tabular-nums">{value}</p>
    </div>
  );
}

// ── Section 01 bar chart — waterfall layout ───────────────────────────────────
// DISPLACED and NET share a baseline and grow upward (solid brass).
// THE MESS (hatched) floats in the vertical band between NET's top and
// DISPLACED's top — it never touches the baseline.
// Visual equation: DISPLACED = NET + THE MESS.

function AccountBars({ geo }: { geo: BarGeometry }) {
  const H = 140; const BAR_W = 84; const GAP = 28;
  const W = 3 * BAR_W + 2 * GAP;
  // Baseline Y in SVG pixels — at the bottom for positive NAR; inside the chart
  // for negative NAR (where NET extends below baseline and MESS crosses it).
  const baselineY = (geo.baseline_pct / 100) * H;
  // DISPLACED always starts at the SVG top (baseline_pct == displaced.height_pct).
  const dispH = Math.max((geo.displaced.height_pct / 100) * H, 1);
  const dispY = baselineY - dispH; // always 0 by construction
  // MESS starts at the same top as DISPLACED; its height can exceed DISPLACED when NAR<0.
  const messH = (geo.mess.height_pct / 100) * H;
  const messY = dispY;
  // NET: above baseline when NAR>=0, below when NAR<0.
  const netH = Math.max((geo.net.height_pct / 100) * H, geo.net.value_hours === 0 ? 1 : 0);
  const netY = geo.net.value_hours >= 0 ? baselineY - netH : baselineY;
  const bars = [
    { label: "DISPLACED", valH: geo.displaced.value_hours, y: dispY, barH: dispH,                 hatch: false },
    { label: "THE MESS",  valH: geo.mess.value_hours,      y: messY, barH: Math.max(messH, 0),    hatch: true  },
    { label: "NET",       valH: geo.net.value_hours,       y: netY,  barH: netH,                  hatch: false },
  ];
  return (
    <div className="flex flex-col items-start">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: "block", overflow: "visible" }}>
        <defs>
          <pattern id="hatch-mess" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--brass)" strokeWidth="1.5" opacity="0.55" />
          </pattern>
        </defs>
        {bars.map((bar, i) => {
          const x = i * (BAR_W + GAP);
          if (bar.barH <= 0) return null;
          return (
            <rect key={i} x={x} y={bar.y} width={BAR_W} height={bar.barH}
              fill={bar.hatch ? "url(#hatch-mess)" : "var(--brass)"}
              stroke={bar.hatch ? "var(--brass)" : "none"} strokeWidth={0.5}
              opacity={bar.hatch ? 0.8 : 0.82} />
          );
        })}
        {/* Baseline: at the bottom for positive NAR, inside the chart for negative NAR */}
        <line x1={0} y1={baselineY} x2={W} y2={baselineY} stroke="var(--rule)" strokeWidth={0.5} />
      </svg>
      <div style={{ display: "flex", width: W, gap: GAP, marginTop: 8 }}>
        {bars.map((bar, i) => (
          <div key={i} style={{ width: BAR_W, textAlign: "center", flexShrink: 0 }}>
            <p className="font-mono uppercase tracking-wide" style={{ fontSize: 9, color: "var(--marginalia)", lineHeight: 1.3 }}>
              {bar.label}
            </p>
            <p className="font-mono tabular-nums font-bold" style={{ fontSize: 11, color: "var(--brass)", marginTop: 2 }}>
              {bar.valH < 0 ? "−" : ""}{formatHours(Math.abs(bar.valH))}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Range-view chart ──────────────────────────────────────────────────────────

function NarChart({ bars, scale }: { bars: ChartBar[]; scale: ChartScaleResult }) {
  const BAR_W = 14; const GAP = 3; const H = 100;
  const W = Math.max(bars.length * (BAR_W + GAP) - GAP, 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 100, display: "block" }}>
      <line x1={0} y1={scale.baselineY} x2={W} y2={scale.baselineY} stroke="var(--rule)" strokeWidth={0.75} />
      {bars.map((bar, i) => {
        if (!bar.has_data) return null;
        const x = i * (BAR_W + GAP);
        const barPx = Math.max(Math.abs(bar.nar_hours) * scale.pixelsPerHour, 1);
        const y = bar.nar_hours >= 0 ? scale.baselineY - barPx : scale.baselineY;
        return <rect key={bar.date} x={x} y={y} width={BAR_W} height={barPx}
          fill={bar.nar_hours >= 0 ? "var(--brass)" : "var(--marginalia)"} opacity={0.8} />;
      })}
    </svg>
  );
}

// ── Day view — canonical Attention Statement ───────────────────────────────────

function DayView({ day, recomp, running }: { day: AttentionDayViewModel; recomp(): void; running: boolean }) {
  if (isEmptyDay(day)) {
    return (
      <div className="py-16 text-center">
        <p className="font-mono text-sm opacity-50">No attention data for {day.date}.</p>
        <button type="button" onClick={recomp} disabled={running}
          className="mt-6 font-mono text-[10px] uppercase tracking-[0.22em] border border-[var(--rule)] px-5 py-2 hover:border-[var(--brass)] disabled:opacity-30 transition-colors">
          {running ? "Recomputing…" : "Recompute"}
        </button>
      </div>
    );
  }

  const ledger = deriveLedger(day.displaced ?? undefined);
  const barGeo = deriveBarGeometry(
    day.displaced?.total_hours ?? 0,
    day.engaged?.hours ?? 0,
    day.interruption?.hours ?? 0,
  );
  const NA = "—";
  // Formatter for nullable hour/minute values: null stays "—", never "0.00".
  const fh = (v: number | null | undefined) => v != null ? formatHours(v) : NA;
  const fmtM = (v: number | null) => v !== null ? formatWholeMinutes(v) : NA;
  const barWidths = deriveAllocationBarWidths(day.allocation ?? undefined);
  const ALLOC_ROWS = [
    { label: "Work",        key: "work"        as const },
    { label: "Life",        key: "life"        as const },
    { label: "Unallocated", key: "unallocated" as const },
  ];

  return (
    <>
      {/* ── 01 THE ACCOUNT ─────────────────────────────────────────────── */}
      <SL n="01" title="THE ACCOUNT" />
      <div className="grid mb-6" style={{ gridTemplateColumns: "55% 45%", gap: "0 24px", alignItems: "start" }}>
        {/* NAR hero — left; sits at top of section */}
        <div>
          <div className="font-display tabular-nums leading-none" style={{ fontSize: 80, color: "var(--brass)" }}>
            {formatHours(day.nar_hours)}<span style={{ fontSize: 40, opacity: 0.5, marginLeft: 5 }}>h</span>
          </div>
          <p className="font-mono uppercase tracking-[0.28em] mt-2" style={{ fontSize: 10, color: "var(--brass)" }}>
            NET ATTENTION RETURNED
          </p>
        </div>
        {/* Three bars — right */}
        <div>
          <AccountBars geo={barGeo} />
        </div>
      </div>

      {/* ── 02 WHERE IT WENT ───────────────────────────────────────────── */}
      <SL n="02" title="WHERE IT WENT" />
      {/* Column headers — bar track column header is blank */}
      <div className="grid font-mono text-[11px] uppercase tracking-[0.1em] pb-1 mb-0"
        style={{ gridTemplateColumns: "1fr minmax(160px,300px) repeat(4,86px)", columnGap: 10, color: "var(--marginalia)", borderBottom: "1px solid var(--rule)", opacity: 0.7 }}>
        <span />
        <span />
        {(["DISPLACED","ENGAGED","INTERRUPT","NET"] as const).map(c => (
          <span key={c} className="text-right">{c}</span>
        ))}
      </div>
      {/* Rows: Work / Life / Unallocated.
          Bar track is proportional to each row's displaced hours, scaled
          to the largest of the three. Empty track always drawn — absence is
          legible, not invisible. Interruption is structurally zero for work
          and life (all interruption lands in unallocated by construction). */}
      {ALLOC_ROWS.map(({ label, key }) => {
        const bucket = day.allocation?.[key] ?? null;
        return (
          <div key={key} className="grid items-center"
            style={{ gridTemplateColumns: "1fr minmax(160px,300px) repeat(4,86px)", columnGap: 10, borderBottom: "1px solid var(--rule)", opacity: 0.75, minHeight: 21 }}>
            <span className="font-sans italic" style={{ fontSize: 13 }}>{label}</span>
            {/* bar track — faint container, brass fill proportional to displaced */}
            <div style={{ height: 10, background: "var(--rule)", opacity: 0.18, borderRadius: 1, position: "relative", overflow: "hidden" }}>
              {bucket != null && bucket.displaced_hours > 0 && (
                <div style={{ position: "absolute", top: 0, left: 0, height: "100%",
                  width: `${barWidths[key]}%`, background: "var(--brass)", opacity: 0.65, borderRadius: 1 }} />
              )}
            </div>
            {[fh(bucket?.displaced_hours), fh(bucket?.engaged_hours),
              fh(bucket?.interruption_hours), fh(bucket?.nar_hours)].map((v, ci) => (
              <span key={ci} className="font-mono text-[14px] tabular-nums text-right" style={{ opacity: bucket != null ? 0.85 : 0.35 }}>{v}</span>
            ))}
          </div>
        );
      })}
      {/* Reconciliation footnote: two honest measures of different scopes — not an error. */}
      {day.allocation_reconciliation != null && (
        <p className="font-mono text-[10px] mt-2" style={{ color: "var(--marginalia)" }}>
          Per-session attributed {formatHours(day.allocation_reconciliation.attributed_engaged_hours)} h engaged
          · day-level {formatHours(day.allocation_reconciliation.day_engaged_hours)} h
          · {formatHours(Math.abs(day.allocation_reconciliation.difference_hours))} h difference.
          {" "}Per-session clustering and whole-day burst clustering measure different scopes and are not expected to match.
        </p>
      )}

      {/* ── 03 THE LEDGER ──────────────────────────────────────────────── */}
      <SL n="03" title="THE LEDGER" />
      <p className="font-mono text-[10px] italic mb-3" style={{ color: "var(--marginalia)" }}>
        {LEDGER_PER_ITEM_NOTE}
      </p>
      {/* Column headers */}
      <div className="grid font-mono text-[11px] uppercase tracking-[0.1em] pb-1"
        style={{ gridTemplateColumns: "1fr repeat(3,86px)", columnGap: 10, color: "var(--marginalia)", borderBottom: "1px solid var(--rule)" }}>
        <span>WORK</span>
        {(["DISPLACED","ENGAGED","NAR"] as const).map(c => (
          <span key={c} className="text-right">{c}</span>
        ))}
      </div>
      {/* Groups: CONVERSATIONAL · EXPLICIT · AUTONOMOUS */}
      {ledger.groups.map((grp) => (
        <div key={grp.name}>
          {/* Group header — brass ~8px mono caps; name + subtotals on same line */}
          <div className="grid items-baseline" style={{ gridTemplateColumns: "1fr repeat(3,86px)", columnGap: 10, minHeight: 24, paddingTop: 4, paddingBottom: 4 }}>
            <span className="font-mono text-[11px] uppercase tracking-[0.22em]" style={{ color: "var(--brass)" }}>{grp.name}</span>
            <span className="font-mono text-[11px] tabular-nums text-right" style={{ color: "var(--brass)" }}>{formatWholeMinutes(grp.subtotal_displaced_min)}</span>
            <span className="font-mono text-[11px] tabular-nums text-right" style={{ color: "var(--brass)" }}>{fmtM(grp.subtotal_engaged_min)}</span>
            <span className="font-mono text-[11px] tabular-nums text-right" style={{ color: "var(--brass)" }}>{fmtM(grp.subtotal_nar_min)}</span>
          </div>
          {/* Item rows — 14px serif label, 14px mono numbers */}
          {grp.rows.length === 0
            ? <p className="font-mono text-[11px] opacity-35 pl-1 pb-1">None.</p>
            : grp.rows.map((row, i) => (
                <div key={i} className="grid items-baseline" style={{ gridTemplateColumns: "1fr repeat(3,86px)", columnGap: 10, minHeight: 24, paddingTop: 2, paddingBottom: 2 }}>
                  <span className="font-sans" style={{ fontSize: 14 }}>
                    {row.label}
                    {(row.count ?? 1) > 1
                      ? <span className="font-mono opacity-45 ml-1.5" style={{ fontSize: 11 }}>×{row.count}</span>
                      : null}
                  </span>
                  <span className="font-mono tabular-nums text-right" style={{ fontSize: 14 }}>{formatWholeMinutes(row.displaced_min)}</span>
                  <span className="font-mono tabular-nums text-right opacity-35" style={{ fontSize: 14 }}>{fmtM(row.engaged_min)}</span>
                  <span className="font-mono tabular-nums text-right opacity-35" style={{ fontSize: 14 }}>{fmtM(row.nar_min)}</span>
                </div>
              ))}
        </div>
      ))}
      {/* TOTAL rows — when some displacement is unmeasured, render two rows:
           1. MEASURED — shows the scope that ENGAGED and NAR actually cover
           2. TOTAL    — shows full displaced; ENGAGED/NAR show — (out of scope)
           This prevents the reader from computing "DISPLACED − ENGAGED" and getting
           a number different from NAR. When everything is measured, one row suffices. */}
      {ledger.unmeasured_displaced_min > 0 ? (
        <>
          <div className="grid items-baseline mt-0.5" style={{ gridTemplateColumns: "1fr repeat(3,86px)", columnGap: 10, borderTop: "2px solid var(--rule)", minHeight: 24, paddingTop: 4, paddingBottom: 2 }}>
            <span className="font-mono text-[11px] uppercase tracking-[0.22em]" style={{ color: "var(--brass)" }}>
              MEASURED
            </span>
            <span className="font-mono text-[11px] tabular-nums text-right" style={{ color: "var(--brass)" }}>{formatWholeMinutes(ledger.measured_displaced_min)}</span>
            <span className="font-mono text-[11px] tabular-nums text-right" style={{ color: "var(--brass)" }}>{fmtM(ledger.total_engaged_min)}</span>
            <span className="font-mono text-[11px] tabular-nums text-right" style={{ color: "var(--brass)" }}>{fmtM(ledger.total_nar_min)}</span>
          </div>
          <div className="grid items-baseline" style={{ gridTemplateColumns: "1fr repeat(3,86px)", columnGap: 10, borderTop: "1px solid var(--rule)", minHeight: 24, paddingTop: 2, paddingBottom: 4 }}>
            <span className="font-mono text-[11px] uppercase tracking-[0.22em]" style={{ color: "var(--brass)" }}>
              TOTAL
              <span className="font-mono text-[10px] normal-case tracking-normal opacity-50 ml-1.5">
                (+{formatWholeMinutes(ledger.unmeasured_displaced_min)} min no measurement)
              </span>
            </span>
            <span className="font-mono text-[11px] tabular-nums text-right" style={{ color: "var(--brass)" }}>{formatWholeMinutes(ledger.total_displaced_min)}</span>
            <span className="font-mono text-[11px] tabular-nums text-right opacity-35" style={{ color: "var(--brass)" }}>{NA}</span>
            <span className="font-mono text-[11px] tabular-nums text-right opacity-35" style={{ color: "var(--brass)" }}>{NA}</span>
          </div>
        </>
      ) : (
        <div className="grid items-baseline mt-0.5" style={{ gridTemplateColumns: "1fr repeat(3,86px)", columnGap: 10, borderTop: "2px solid var(--rule)", minHeight: 24, paddingTop: 4, paddingBottom: 4 }}>
          <span className="font-mono text-[11px] uppercase tracking-[0.22em]" style={{ color: "var(--brass)" }}>TOTAL</span>
          <span className="font-mono text-[11px] tabular-nums text-right" style={{ color: "var(--brass)" }}>{formatWholeMinutes(ledger.total_displaced_min)}</span>
          <span className="font-mono text-[11px] tabular-nums text-right" style={{ color: "var(--brass)" }}>{fmtM(ledger.total_engaged_min)}</span>
          <span className="font-mono text-[11px] tabular-nums text-right" style={{ color: "var(--brass)" }}>{fmtM(ledger.total_nar_min)}</span>
        </div>
      )}

      {/* Unrated action classes — zero contribution, must not be omitted */}
      {day.unrated.length > 0 && (
        <div className="mt-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] mb-1" style={{ color: "var(--marginalia)" }}>
            Unrated action classes — no rate established
          </p>
          {day.unrated.map((r) => (
            <div key={r.action_class} className="flex justify-between items-baseline py-0.5">
              <span className="font-mono text-[10px] opacity-55">{r.action_class}</span>
              <span className="font-mono text-[10px] tabular-nums opacity-55">×{r.count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Rate card — stay visible so every figure is recomputable by hand */}
      {day.rates != null && (
        <div className="mt-8 pt-4" style={{ borderTop: "1px solid var(--rule)" }}>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] mb-1.5" style={{ color: "var(--marginalia)" }}>
            Rate card in force
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-0.5 font-mono text-[10px]" style={{ color: "var(--marginalia)" }}>
            <span>Suppression {day.rates.suppression_minutes_per_item} min / item</span>
            <span>Interruption {day.rates.interruption_minutes} min</span>
            <span>S {day.rates.bucket_minutes.S} · M {day.rates.bucket_minutes.M} · L {day.rates.bucket_minutes.L} · XL {day.rates.bucket_minutes.XL} min</span>
          </div>
        </div>
      )}

      {/* FOOTER */}
      <div className="flex justify-between items-center mt-10 pt-2" style={{ borderTop: "1px solid var(--rule)" }}>
        <span className="font-mono text-[10px] uppercase tracking-[0.22em]" style={{ color: "var(--marginalia)" }}>
          Alfred Black · Attention Statement · {day.date}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.22em]" style={{ color: "var(--marginalia)" }}>
          Page 1 of 1
        </span>
      </div>

      <button type="button" onClick={recomp} disabled={running}
        className="mt-6 font-mono text-[10px] uppercase tracking-[0.22em] border border-[var(--rule)] px-5 py-2 hover:border-[var(--brass)] disabled:opacity-30 transition-colors">
        {running ? "Recomputing…" : "Recompute this day"}
      </button>
    </>
  );
}

// ── Range view ────────────────────────────────────────────────────────────────

function RangeView({ stats }: { stats: AttentionStatsResponse }) {
  const bars = deriveChartBars(stats.series);
  const scale = deriveChartScale(bars);
  const agg = deriveRangeAggregates(stats.series);
  const h = (v: number) => `${formatHours(v)} h`;
  const noData = agg.days_with_data === 0;

  return (
    <>
      {stats.rate_changed && (
        <div className="border border-[var(--brass)]/40 px-4 py-3 mb-6 font-mono text-xs" style={{ color: "var(--brass)" }}>
          Rate card changed within this range. Figures before and after the change are not directly comparable.
        </div>
      )}

      {/* Per-day NAR column chart */}
      <SH s="Net attention returned — per day" />
      {noData
        ? <p className="font-mono text-xs opacity-40 mt-2">No data in range.</p>
        : <div className="mt-3">
            <NarChart bars={bars} scale={scale} />
            <div className="flex justify-between font-mono text-[10px] mt-1.5 opacity-40">
              <span>{stats.from}</span><span>{stats.to}</span>
            </div>
          </div>}

      {/* Coverage note */}
      {agg.total_days > 0 && (
        <p className="font-mono text-[10px] mt-3 mb-0"
          style={{ color: agg.days_with_data < agg.total_days / 2 ? "var(--brass)" : "var(--marginalia)" }}>
          {agg.days_with_data} of {agg.total_days} days in range have data.
          {agg.days_with_data < agg.total_days / 2 ? " Range is mostly empty — averages are not meaningful." : ""}
        </p>
      )}

      {/* Aggregate cells */}
      <SH s="Range summary" />
      <div className="grid grid-cols-3 gap-px mt-2" style={{ background: "var(--rule)", border: "1px solid var(--rule)" }}>
        <StatCell label="Total NAR" value={h(agg.total_nar)} />
        <StatCell label="Mean / day" value={agg.days_with_data > 0 ? h(agg.mean_nar) : "—"} />
        <StatCell label="Days with data" value={agg.total_days > 0 ? `${agg.days_with_data} / ${agg.total_days}` : "0"} />
        <StatCell label="Best day" value={agg.best_day ? `${agg.best_day.date}  ${h(agg.best_day.nar_hours)}` : "—"} />
        <StatCell label="Worst day" value={agg.worst_day ? `${agg.worst_day.date}  ${h(agg.worst_day.nar_hours)}` : "—"} />
        <StatCell label="Displaced / engaged" value={noData ? "—" : `${h(stats.totals.displaced_hours)} / ${h(stats.totals.engaged_hours)}`} />
      </div>

      {/* Composition bar */}
      {!noData && (() => {
        const total = (stats.totals.displaced_hours + stats.totals.engaged_hours) || 1;
        const dispPct = (stats.totals.displaced_hours / total) * 100;
        return (
          <>
            <SH s="Period composition" />
            <p className="font-mono text-[10px] opacity-40 mb-2">
              Source breakdown (explicit / inferred / autonomous) requires per-day rate data — follow-up #584.
            </p>
            <div className="flex gap-px h-5 w-full overflow-hidden mt-1" style={{ border: "1px solid var(--rule)" }}>
              <div style={{ width: `${dispPct}%`, background: "var(--brass)", opacity: 0.75 }} title={`Displaced ${h(stats.totals.displaced_hours)}`} />
              <div className="flex-1" style={{ background: "var(--marginalia)", opacity: 0.25 }} title={`Engaged ${h(stats.totals.engaged_hours)}`} />
            </div>
            <div className="flex justify-between font-mono text-[10px] mt-1" style={{ color: "var(--marginalia)" }}>
              <span>Displaced {h(stats.totals.displaced_hours)}</span>
              <span>Engaged {h(stats.totals.engaged_hours)}</span>
            </div>
          </>
        );
      })()}
    </>
  );
}

// ── Page shell ────────────────────────────────────────────────────────────────

export default function AttentionPage() {
  const [tab, setTab] = useState<"day" | "range">(
    dateParam("from", "") !== "" ? "range" : "day");
  const [date, setDate] = useState(dateParam("date", now()));
  const [from, setFrom] = useState(dateParam("from", sevenAgo()));
  const [to, setTo] = useState(dateParam("to", now()));
  const [running, setRunning] = useState(false);
  const dayQ = useQuery(getAttentionStatement, { date }, { enabled: tab === "day" });
  const statsQ = useQuery(getAttentionStats, { from, to }, { enabled: tab === "range" });
  const recompute = useAction(recomputeAttention);

  async function handleRecompute() {
    setRunning(true);
    try { await recompute({ date }); await dayQ.refetch(); } finally { setRunning(false); }
  }

  const din = (val: string, set: (v: string) => void, max?: string) => (
    <input type="date" value={val} max={max} onChange={(e) => set(e.target.value)}
      className="font-mono text-xs border border-[var(--rule)] bg-transparent px-2 py-1 focus:outline-none focus:border-[var(--brass)] transition-colors" />
  );

  return (
    <Frame>
      <section className="mx-auto max-w-[900px] px-8 py-12">

        {/* Day-tab statement letterhead — mark + wordmark once, date right.
            Placed first so letterhead leads the document, controls follow (#1, #5). */}
        {tab === "day" && (
          <>
            <div className="flex justify-between items-baseline mb-0">
              <div className="flex items-center gap-2">
                <img src={logoCurrentcolor} alt="" className="h-7 w-auto" />
                <span className="font-mono text-[11px] uppercase tracking-[0.2em]" style={{ color: "var(--brass)" }}>Alfred Black</span>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: "var(--marginalia)" }}>
                {formatHeaderDate(date)}
              </span>
            </div>
            <div style={{ borderTop: "2px solid var(--brass)", marginTop: 6 }} />
            <div style={{ borderTop: "1px solid var(--rule)", marginTop: 4, opacity: 0.45 }} />
            <h2 className="font-display tracking-[-0.01em] mb-8" style={{ fontSize: 44, marginTop: 28 }}>
              Attention Statement.
            </h2>
          </>
        )}

        {/* Page-level header — shown on range tab; day tab has its own statement header */}
        {tab === "range" && (
          <div className="mb-10">
            <p className="font-mono text-[10px] uppercase tracking-[0.32em] mb-3" style={{ color: "var(--marginalia)" }}>
              Alfred Black · Attention Statement
            </p>
            <h1 className="font-display tracking-[-0.02em] leading-[0.98]" style={{ fontSize: "clamp(44px,6vw,72px)" }}>
              {from} — {to}
            </h1>
          </div>
        )}

        {/* Tab bar */}
        <div className="flex gap-6 mb-6 border-b border-[var(--rule)]">
          {(["day", "range"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className="font-mono text-[10px] uppercase tracking-[0.22em] pb-2 transition-colors"
              style={{ color: tab === t ? "var(--brass)" : "var(--marginalia)", borderBottom: tab === t ? "1px solid var(--brass)" : "1px solid transparent" }}>
              {t === "day" ? "Day" : "Range"}
            </button>
          ))}
        </div>

        {/* Date controls */}
        <div className="flex items-center gap-3 mb-8">
          {tab === "day"
            ? din(date, setDate, now())
            : <>{din(from, setFrom, to)}<span className="font-mono text-xs opacity-40">to</span>{din(to, setTo, now())}</>}
        </div>

        {/* Content */}
        {tab === "day"
          ? dayQ.isLoading ? <p className="font-mono text-xs opacity-40">Loading…</p>
            : dayQ.error ? <p className="font-mono text-xs" style={{ color: "oklch(0.42 0.12 30)" }}>{String((dayQ.error as any)?.message ?? "Failed.")}</p>
            : dayQ.data ? <DayView day={normalizeAttentionDay(dayQ.data)} recomp={handleRecompute} running={running} /> : null
          : statsQ.isLoading ? <p className="font-mono text-xs opacity-40">Loading…</p>
            : statsQ.error ? <p className="font-mono text-xs" style={{ color: "oklch(0.42 0.12 30)" }}>{String((statsQ.error as any)?.message ?? "Failed.")}</p>
            : statsQ.data ? <RangeView stats={statsQ.data as AttentionStatsResponse} /> : null}

      </section>
    </Frame>
  );
}
