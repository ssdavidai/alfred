// AttentionPage — Attention Statement redesign for /attention (#584).
// Day view: canonical statement (header → 01 The Account → 02 Where It Went →
// 03 The Ledger → rate card → footer). Range tab: unchanged.
import { useState, useEffect, useRef, Fragment } from "react";
import type { CSSProperties } from "react";
import { useQuery, useAction, getAttentionStatement, getAttentionStats, recomputeAttention, getAttentionTrends, interpretAttentionTrends } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import logoWhite from "../client/assets/brand/alfred-logo-white.svg";
import {
  normalizeAttentionDay, isEmptyDay, formatHours, formatWholeMinutes,
  formatHeaderDate, deriveLedger, deriveBarGeometry, deriveAllocationBarWidths,
  LEDGER_PER_ITEM_NOTE,
  deriveChartBars, deriveChartScale, deriveRangeAggregates,
  type AttentionDayViewModel, type AttentionStatsResponse,
  type ChartBar, type ChartScaleResult, type BarGeometry,
} from "./attentionCore";
import {
  deriveNarBars, deriveSeriesMax, deriveRatioBars, deriveBucketBars,
  isReadGenerated, LOW_ENGAGEMENT_HOURS, trimEmptyEdgePeriods,
  READ_EMPTY_STATE_TEXT, POLL_GIVE_UP_MS, READ_POLL_PENDING_TEXT, READ_POLL_GAVE_UP_TEXT,
  f1, dir, deriveNarHeadline, deriveRatioHeadline, deriveRatioLineSegmentsFromBars,
  deriveReadHeadline, deriveReadPairData, deriveAllocationHeadline, deriveTrendsAllocTotals,
  type TrendsGrain, type AttentionTrendsResponse,
} from "./attentionTrendsCore";

const now = () => new Date().toISOString().slice(0, 10);
/** Read an ISO date from the query string; fall back when absent or malformed. */
const dateParam = (key: string, fallback: string): string => {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(key);
  return v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
};
const sevenAgo = () => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); };
const thirteenWeeksAgo = () => { const d = new Date(); d.setDate(d.getDate() - 91); return d.toISOString().slice(0, 10); };

// ── Shared primitives ─────────────────────────────────────────────────────────

/** Section-label: "N · TITLE" in brass letterspaced mono caps + hairline rule.
 *  Matches the template's .sechead pattern exactly: baseline-aligned, 14px gap,
 *  hairline (not rule) for the trailing line so the dark-document contrast holds. */
function SL({ n, title, mt = 26 }: { n: string; title: string; mt?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: mt }}>
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 10,
        letterSpacing: "0.28em", textTransform: "uppercase", color: "var(--brass)", whiteSpace: "nowrap" }}>
        {n} · {title}
      </span>
      <span style={{ flex: 1, borderTop: `1px solid ${HAIR}` }} />
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

// ── Design-system constants (lifted verbatim from AttentionStatementDark.html) ─
// Hair values are not in the product CSS vars — inlined to match the template exactly.
const HAIR  = "oklch(0.94 0.012 80 / 0.16)";
const HAIR2 = "oklch(0.94 0.012 80 / 0.24)";
// Hatch from the template .hatch rule.
const HATCH_BG = "repeating-linear-gradient(-45deg,oklch(0.94 0.012 80 / 0.3) 0 2.5px,transparent 2.5px 6px)";
// Wool-page background — used for the 1px visual gap inside the DISPLACED bar.
const WOOL_BG = "oklch(0.18 0.006 60)";
// Dark-mode CSS variable overrides: keep these in sync with the template's :root block.
// Spread into a wool wrapper so the day-view always renders with the dark palette
// regardless of the user's system theme (the statement is always the dark document).
const DARK_VARS: Record<string, string> = {
  "--ink":        "oklch(0.94 0.012 80)",
  "--rule":       "oklch(0.94 0.012 80 / 0.22)",
  "--marginalia": "oklch(0.70 0.008 80)",
  "--brass":      "oklch(0.62 0.09 75)",
};

// ── Section 01 bar chart — CSS-div waterfall matching the template ────────────
// Three independent bars at proportional heights, matching AttentionStatementDark.html:
//   DISPLACED — flex-end column: lighter-brass mess cap + 1px page-bg gap + solid-brass net body.
//   THE MESS  — hatch div hanging from the TOP of its 104px container (not flex-end).
//   NET       — flex-end column: solid-brass bar pushed to the baseline.
// All three bars share the same 104px height; captions sit below.

function AccountBars({ geo }: { geo: BarGeometry }) {
  const H = 104, BW = 66, GAP = 26;
  // When NAR >= 0 displaced.height_pct == 100 (displaced is the scale reference).
  // When NAR < 0  all three pcts are < 100 and the chart clips gracefully.
  const messH = Math.max(Math.round((geo.mess.height_pct / 100) * H), 0);
  const netH  = Math.max(Math.round((geo.net.height_pct  / 100) * H), 0);
  // DISPLACED internal split: lighter-brass mess cap + 1px gap + solid-brass net body.
  // The 1px gap sits between the lighter and solid segments so the split is legible.
  const gapPx = (messH > 0 && netH > 0) ? 1 : 0;
  const netBodyH = Math.max(H - messH - gapPx, 0);

  const captions = [
    { label: "DISPLACED", val: geo.displaced.value_hours, labelColor: "var(--marginalia)" as const, valColor: "var(--ink)" as const },
    { label: "THE MESS",  val: geo.mess.value_hours,      labelColor: "var(--marginalia)" as const, valColor: "var(--ink)" as const },
    { label: "NET",       val: geo.net.value_hours,        labelColor: "var(--brass)"     as const, valColor: "var(--brass)"  as const },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      {/* Bar columns */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: GAP, height: H }}>
        {/* DISPLACED: flex-end, full 104px — lighter cap + gap + solid body */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", height: H, width: BW }}>
          {messH > 0 && <div style={{ height: messH, background: "oklch(0.62 0.09 75 / 0.45)" }} />}
          {gapPx > 0 && <div style={{ height: gapPx, background: WOOL_BG }} />}
          {netBodyH > 0 && <div style={{ height: netBodyH, background: "var(--brass)" }} />}
        </div>
        {/* THE MESS: hatch hangs from the TOP of the 104px box */}
        <div style={{ height: H, width: BW }}>
          {messH > 0 && <div style={{ height: messH, background: HATCH_BG }} />}
        </div>
        {/* NET: solid brass pushed to the bottom */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", height: H, width: BW }}>
          {netH > 0 && <div style={{ height: netH, background: "var(--brass)" }} />}
        </div>
      </div>
      {/* Captions: labels + values matching the template's caption block */}
      <div style={{ display: "flex", gap: GAP, marginTop: 8 }}>
        {captions.map(({ label, val, labelColor, valColor }, i) => (
          <div key={i} style={{ width: BW, textAlign: "center" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 7.5,
              letterSpacing: "0.14em", color: labelColor, textTransform: "uppercase", lineHeight: 1.4 }}>
              {label}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 9.5,
              letterSpacing: "0.06em", color: valColor, marginTop: 3 }}>
              {val < 0 ? "−" : ""}{formatHours(Math.abs(val))}
            </div>
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

// ── Day view — dark Attention Statement matching AttentionStatementDark.html ───
// The entire day document renders on a wool-dark surface with forced dark CSS
// variables so the statement looks the same regardless of system theme.
// The letterhead (logo · date · double rule · title) lives inside this component
// so the document is self-contained.

function DayView({ day, date, recomp, running }: {
  day: AttentionDayViewModel; date: string; recomp(): void; running: boolean;
}) {
  // ── shared formatters ──────────────────────────────────────────────────────
  const NA = "—";
  const fmtM = (v: number | null) => v !== null ? formatWholeMinutes(v) : NA;
  // Section 02: negative figures render as "− X.XX" (Unicode minus + space).
  const fmtNeg = (v: number) => v > 0 ? `− ${formatHours(v)}` : NA;
  // Section 02: NET column always gets the "h" suffix.
  const fmtNet = (v: number) => (v < 0 ? `−${formatHours(Math.abs(v))}` : formatHours(v)) + " h";

  // ── letterhead ─────────────────────────────────────────────────────────────
  const Letterhead = () => (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <img src={logoWhite} alt="Alfred Black" style={{ height: 34, width: "auto", display: "block" }} />
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 11.5,
            letterSpacing: "0.32em", textTransform: "uppercase", color: "var(--ink)" }}>
            ALFRED&nbsp;BLACK
          </span>
        </div>
        <div style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700,
          fontSize: 9.5, letterSpacing: "0.2em", color: "var(--marginalia)", lineHeight: 1.9 }}>
          {formatHeaderDate(date)}
        </div>
      </div>
      {/* Double rule: top and bottom 1px solid ink, height 4px — as in the template */}
      <div style={{ borderTop: "1px solid var(--ink)", borderBottom: "1px solid var(--ink)",
        height: 4, margin: "14px 0 20px" }} />
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 30,
        letterSpacing: "-0.015em", lineHeight: 1.05, margin: 0 }}>
        Attention Statement.
      </h1>
    </>
  );

  // ── wool wrapper (dark surface + forced dark-palette CSS vars) ─────────────
  const wrapStyle = { padding: "36px 58px 30px", ...DARK_VARS } as CSSProperties;

  if (isEmptyDay(day)) {
    return (
      <div className="wool" style={wrapStyle}>
        <Letterhead />
        <div style={{ paddingTop: 48, textAlign: "center" }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--marginalia)" }}>
            No attention data for {date}.
          </p>
          <button type="button" onClick={recomp} disabled={running}
            style={{ marginTop: 24, fontFamily: "var(--font-mono)", fontSize: 10, textTransform: "uppercase",
              letterSpacing: "0.22em", border: "1px solid var(--rule)", padding: "8px 20px",
              color: "var(--ink)", background: "transparent", cursor: running ? "not-allowed" : "pointer",
              opacity: running ? 0.3 : 1 }}>
            {running ? "Recomputing…" : "Recompute"}
          </button>
        </div>
      </div>
    );
  }

  const ledger = deriveLedger(day.displaced ?? undefined);
  const barGeo = deriveBarGeometry(
    day.displaced?.total_hours ?? 0,
    day.engaged?.hours ?? 0,
    day.interruption?.hours ?? 0,
  );
  const totalDisp = Math.max(day.displaced?.total_hours ?? 0, 0.001);

  // ── section 02 grid styles ─────────────────────────────────────────────────
  // Grid: 96px label | 1fr bar track | 62px displaced | 58px engaged | 62px interrupt | 64px net
  const GRID02: CSSProperties = {
    display: "grid", gridTemplateColumns: "96px 1fr 62px 58px 62px 64px",
    gap: "7px 12px", alignItems: "center",
    fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 9, letterSpacing: "0.06em",
  };
  const COL_HEAD: CSSProperties = { fontFamily: "var(--font-mono)", fontWeight: 800,
    fontSize: 7.5, letterSpacing: "0.18em", textTransform: "uppercase", textAlign: "right" };

  // ── section 03 grid styles ─────────────────────────────────────────────────
  const GRID03: CSSProperties = { display: "grid", gridTemplateColumns: "1fr 82px 82px 82px",
    fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 11, letterSpacing: 0 };
  // .h — column header: 7.5px dim, hair2 bottom border
  const hSty: CSSProperties = { fontSize: 7.5, fontWeight: 800, letterSpacing: "0.16em",
    color: "var(--marginalia)", borderBottom: `1px solid ${HAIR2}`, paddingBottom: 5 };
  // .g — group row: 8px brass, no bottom border
  const gSty: CSSProperties = { borderBottom: "none", padding: "9px 0 2px", fontSize: 8,
    fontWeight: 800, letterSpacing: "0.24em", color: "var(--brass)" };
  // regular item cell: faint bottom rule
  const cSty: CSSProperties = { padding: "2.5px 0", borderBottom: "1px solid oklch(0.94 0.012 80 / 0.09)" };
  // .t — total row: 2px brass top border
  const tSty: CSSProperties = { borderBottom: "none", borderTop: "2px solid var(--brass)",
    marginTop: 5, padding: "7px 0 0", color: "var(--brass)", fontWeight: 800,
    fontSize: 9.5, letterSpacing: "0.06em" };

  const ALLOC_ROWS = [
    { label: "Work",        key: "work"        as const, dim: false },
    { label: "Life",        key: "life"        as const, dim: false },
    { label: "Unallocated", key: "unallocated" as const, dim: true  },
  ];

  return (
    <div className="wool" style={wrapStyle}>
      <Letterhead />

      {/* ── 01 THE ACCOUNT ─────────────────────────────────────────────── */}
      <SL n="01" title="THE ACCOUNT" mt={24} />
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between",
        gap: 44, marginTop: 16 }}>
        {/* NAR hero */}
        <div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 76,
            letterSpacing: "-0.02em", lineHeight: 1, color: "var(--brass)", margin: "0 0 12px" }}>
            {day.nar_hours < 0 ? "−" : ""}{formatHours(Math.abs(day.nar_hours))} h
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 8.5,
            letterSpacing: "0.26em", textTransform: "uppercase", color: "var(--brass)" }}>
            NET ATTENTION RETURNED
          </div>
        </div>
        {/* Waterfall bars */}
        <AccountBars geo={barGeo} />
      </div>

      {/* ── 02 WHERE IT WENT ───────────────────────────────────────────── */}
      <SL n="02" title="WHERE IT WENT" />
      <div style={{ ...GRID02, marginTop: 10 }}>
        {/* Header row */}
        <span /><span />
        <span style={{ ...COL_HEAD, color: "var(--marginalia)" }}>DISPLACED</span>
        <span style={{ ...COL_HEAD, color: "var(--marginalia)" }}>ENGAGED</span>
        <span style={{ ...COL_HEAD, color: "var(--marginalia)" }}>INTERRUPT</span>
        <span style={{ ...COL_HEAD, color: "var(--brass)" }}>NET</span>
        {/* Allocation rows */}
        {ALLOC_ROWS.map(({ label, key, dim }) => {
          const b = day.allocation?.[key] ?? null;
          const fillW = b != null && b.displaced_hours > 0
            ? Math.min((b.displaced_hours / totalDisp) * 100, 100) : 0;
          const brassPct = b != null && b.displaced_hours > 0
            ? (Math.max(b.nar_hours, 0) / b.displaced_hours) * 100 : 0;
          const tc = dim ? "var(--marginalia)" : "var(--ink)";
          return (
            <Fragment key={key}>
              {/* Row label: display italic per template */}
              <span style={{ fontFamily: "var(--font-display)", fontStyle: "italic",
                fontSize: 11.5, letterSpacing: "0.02em", color: tc }}>
                {label}
              </span>
              {/* Bar track: faint container + brass/hatch fill */}
              <div style={{ height: 8, background: "oklch(0.94 0.012 80 / 0.08)" }}>
                {fillW > 0 && (
                  <div style={{ width: `${fillW}%`, height: "100%", display: "flex" }}>
                    <div style={{ width: `${brassPct}%`, background: "var(--brass)" }} />
                    <div style={{ flex: 1, background: HATCH_BG }} />
                  </div>
                )}
              </div>
              <span style={{ textAlign: "right", color: tc }}>
                {b != null ? formatHours(b.displaced_hours) : NA}
              </span>
              <span style={{ textAlign: "right", color: "var(--marginalia)" }}>
                {b != null ? fmtNeg(b.engaged_hours) : NA}
              </span>
              <span style={{ textAlign: "right", color: "var(--marginalia)" }}>
                {b != null ? fmtNeg(b.interruption_hours) : NA}
              </span>
              <span style={{ textAlign: "right", color: b != null && !dim ? "var(--brass)" : "var(--marginalia)" }}>
                {b != null ? fmtNet(b.nar_hours) : NA}
              </span>
            </Fragment>
          );
        })}
      </div>
      {/* Reconciliation footnote — per-session vs day-level clustering disagree by design */}
      {day.allocation_reconciliation != null && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--marginalia)",
          letterSpacing: "0.06em", marginTop: 7, lineHeight: 1.5 }}>
          Per-session attributed {formatHours(day.allocation_reconciliation.attributed_engaged_hours)} h engaged
          · day-level {formatHours(day.allocation_reconciliation.day_engaged_hours)} h
          · {formatHours(Math.abs(day.allocation_reconciliation.difference_hours))} h difference.
          {" "}Per-session and whole-day burst clustering measure different scopes.
        </p>
      )}

      {/* ── 03 THE LEDGER ──────────────────────────────────────────────── */}
      <SL n="03" title="THE LEDGER" />
      <div style={{ ...GRID03, marginTop: 10 }}>
        {/* Column headers */}
        <span style={hSty}>WORK</span>
        <span style={{ ...hSty, textAlign: "right" }}>DISPLACED</span>
        <span style={{ ...hSty, textAlign: "right", color: "var(--marginalia)" }}>ENGAGED</span>
        <span style={{ ...hSty, textAlign: "right", color: "var(--brass)" }}>NAR</span>

        {/* Groups: CONVERSATIONAL · EXPLICIT · AUTONOMOUS */}
        {ledger.groups.map((grp) => (
          <Fragment key={grp.name}>
            {/* Group header row */}
            <span style={gSty}>{grp.name}</span>
            <span style={{ ...gSty, textAlign: "right" }}>{formatWholeMinutes(grp.subtotal_displaced_min)}</span>
            <span style={{ ...gSty, textAlign: "right", color: "var(--marginalia)" }}>{fmtM(grp.subtotal_engaged_min)}</span>
            <span style={{ ...gSty, textAlign: "right" }}>{fmtM(grp.subtotal_nar_min)}</span>
            {/* Item rows */}
            {grp.rows.length === 0
              ? <span style={{ ...cSty, gridColumn: "1 / -1", color: "var(--marginalia)", fontSize: 10 }}>None.</span>
              : grp.rows.map((row, i) => (
                  <Fragment key={i}>
                    <span style={cSty}>
                      {row.label}
                      {(row.count ?? 1) > 1 && (
                        <span style={{ fontFamily: "var(--font-mono)", color: "var(--marginalia)",
                          fontSize: 9, marginLeft: 6 }}>
                          {"\u00d7"}{row.count}
                        </span>
                      )}
                    </span>
                    <span style={{ ...cSty, textAlign: "right" }}>{formatWholeMinutes(row.displaced_min)}</span>
                    <span style={{ ...cSty, textAlign: "right", color: "var(--marginalia)" }}>{fmtM(row.engaged_min)}</span>
                    <span style={{ ...cSty, textAlign: "right", color: "var(--brass)" }}>{fmtM(row.nar_min)}</span>
                  </Fragment>
                ))}
          </Fragment>
        ))}

        {/* TOTAL / MEASURED+TOTAL rows — honesty: show the scope split when unmeasured exists */}
        {ledger.unmeasured_displaced_min > 0 ? (
          <>
            <span style={{ ...tSty }}>MEASURED</span>
            <span style={{ ...tSty, textAlign: "right" }}>{formatWholeMinutes(ledger.measured_displaced_min)}</span>
            <span style={{ ...tSty, textAlign: "right", color: "var(--marginalia)" }}>{fmtM(ledger.total_engaged_min)}</span>
            <span style={{ ...tSty, textAlign: "right" }}>{fmtM(ledger.total_nar_min)}</span>
            {/* TOTAL row (second): full displaced, engaged/NAR out-of-scope */}
            <span style={{ ...tSty, borderTop: "1px solid var(--brass)", marginTop: 2, fontSize: 9,
              letterSpacing: "0.04em" }}>
              TOTAL
              <span style={{ fontWeight: 700, fontSize: 8, letterSpacing: "0.08em",
                color: "var(--marginalia)", marginLeft: 6 }}>
                (+{formatWholeMinutes(ledger.unmeasured_displaced_min)} min no measurement)
              </span>
            </span>
            <span style={{ ...tSty, borderTop: "1px solid var(--brass)", marginTop: 2, textAlign: "right" }}>
              {formatWholeMinutes(ledger.total_displaced_min)}
            </span>
            <span style={{ ...tSty, borderTop: "1px solid var(--brass)", marginTop: 2,
              textAlign: "right", color: "var(--marginalia)" }}>{NA}</span>
            <span style={{ ...tSty, borderTop: "1px solid var(--brass)", marginTop: 2,
              textAlign: "right", color: "var(--marginalia)" }}>{NA}</span>
          </>
        ) : (
          <>
            <span style={tSty}>TOTAL</span>
            <span style={{ ...tSty, textAlign: "right" }}>{formatWholeMinutes(ledger.total_displaced_min)}</span>
            <span style={{ ...tSty, textAlign: "right", color: "var(--marginalia)" }}>{fmtM(ledger.total_engaged_min)}</span>
            <span style={{ ...tSty, textAlign: "right" }}>{fmtM(ledger.total_nar_min)}</span>
          </>
        )}
      </div>
      {/* Honesty marker: name which classes carry no engagement measurement */}
      <p style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.1em",
        color: "var(--marginalia)", marginTop: 7, lineHeight: 1.5 }}>
        {LEDGER_PER_ITEM_NOTE}
      </p>

      {/* Unrated action classes — zero displaced contribution; must not be omitted */}
      {day.unrated.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 8, fontWeight: 800,
            letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--marginalia)",
            marginBottom: 6 }}>
            Unrated action classes — no rate established
          </p>
          {day.unrated.map((r) => (
            <div key={r.action_class}
              style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9,
                color: "var(--marginalia)" }}>{r.action_class}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9,
                color: "var(--marginalia)" }}>{"\u00d7"}{r.count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Rate card — every figure in the statement is recomputable from this */}
      {day.rates != null && (
        <div style={{ marginTop: 22, paddingTop: 9, borderTop: `1px solid ${HAIR}` }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 8, fontWeight: 800,
            letterSpacing: "0.22em", textTransform: "uppercase",
            color: "var(--marginalia)", marginBottom: 5 }}>
            Rate card in force
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0 24px",
            fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--marginalia)",
            letterSpacing: "0.06em" }}>
            <span>Suppression {day.rates.suppression_minutes_per_item} min / item</span>
            <span>Interruption {day.rates.interruption_minutes} min</span>
            <span>S {day.rates.bucket_minutes.S} · M {day.rates.bucket_minutes.M} · L {day.rates.bucket_minutes.L} · XL {day.rates.bucket_minutes.XL} min</span>
          </div>
        </div>
      )}

      {/* Footer — matches the template's .foot */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 40,
        borderTop: `1px solid ${HAIR}`, paddingTop: 9,
        fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 8,
        letterSpacing: "0.22em", color: "var(--marginalia)" }}>
        <span>ALFRED BLACK · ATTENTION STATEMENT · {day.date}</span>
        <span>PAGE 1 OF 1</span>
      </div>

      <button type="button" onClick={recomp} disabled={running}
        style={{ marginTop: 20, fontFamily: "var(--font-mono)", fontSize: 10,
          textTransform: "uppercase", letterSpacing: "0.22em",
          border: "1px solid var(--rule)", padding: "8px 20px",
          color: "var(--ink)", background: "transparent",
          cursor: running ? "not-allowed" : "pointer", opacity: running ? 0.3 : 1 }}>
        {running ? "Recomputing…" : "Recompute this day"}
      </button>
    </div>
  );
}

// ── Range view — dark Attention Statement matching the DAY tab treatment ───────
// Self-contained wool-dark document: letterhead (logo · date range · double rule
// · title) + three numbered sections + footer. All information from the old view
// is preserved; only the visual treatment changes.

function RangeView({ stats }: { stats: AttentionStatsResponse }) {
  const bars = deriveChartBars(stats.series);
  const scale = deriveChartScale(bars);
  const agg = deriveRangeAggregates(stats.series);
  const h = (v: number) => `${formatHours(v)} h`;
  const noData = agg.days_with_data === 0;

  const wrapStyle = { padding: "36px 58px 30px", ...DARK_VARS, "--background": WOOL_BG } as CSSProperties;

  return (
    <div className="wool" style={wrapStyle}>

      {/* ── Letterhead ──────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <img src={logoWhite} alt="Alfred Black" style={{ height: 34, width: "auto", display: "block" }} />
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 11.5,
            letterSpacing: "0.32em", textTransform: "uppercase", color: "var(--ink)" }}>
            ALFRED&nbsp;BLACK
          </span>
        </div>
        <div style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700,
          fontSize: 9.5, letterSpacing: "0.2em", color: "var(--marginalia)", lineHeight: 1.9 }}>
          {stats.from} — {stats.to}
        </div>
      </div>
      {/* 4px double rule — top and bottom 1px solid ink, height 4px */}
      <div style={{ borderTop: "1px solid var(--ink)", borderBottom: "1px solid var(--ink)",
        height: 4, margin: "14px 0 20px" }} />
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 30,
        letterSpacing: "-0.015em", lineHeight: 1.05, margin: 0 }}>
        Attention Statement.
      </h1>

      {/* Rate-change honesty warning */}
      {stats.rate_changed && (
        <div style={{ border: "1px solid oklch(0.62 0.09 75 / 0.4)", padding: "12px 16px",
          marginTop: 20, fontFamily: "var(--font-mono)", fontSize: 11,
          letterSpacing: "0.06em", color: "var(--brass)" }}>
          Rate card changed within this range. Figures before and after the change are not directly comparable.
        </div>
      )}

      {/* ── 01 NET ATTENTION RETURNED ───────────────────────────────────── */}
      <SL n="01" title="NET ATTENTION RETURNED" mt={24} />
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: 32, marginTop: 16 }}>
        {/* Hero total NAR — display serif brass, mirrors the DAY tab hero */}
        <div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 76,
            letterSpacing: "-0.02em", lineHeight: 1, color: "var(--brass)", margin: "0 0 12px" }}>
            {noData ? "—" : `${agg.total_nar < 0 ? "−" : ""}${formatHours(Math.abs(agg.total_nar))} h`}
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 8.5,
            letterSpacing: "0.26em", textTransform: "uppercase", color: "var(--brass)" }}>
            NET ATTENTION RETURNED
          </div>
        </div>
        {/* Per-day NAR column chart */}
        <div style={{ flex: 1 }}>
          {noData
            ? <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--marginalia)" }}>
                No data in range.
              </p>
            : <>
                <NarChart bars={bars} scale={scale} />
                <div style={{ display: "flex", justifyContent: "space-between",
                  fontFamily: "var(--font-mono)", fontSize: 9, marginTop: 6,
                  color: "var(--marginalia)", letterSpacing: "0.06em" }}>
                  <span>{stats.from}</span><span>{stats.to}</span>
                </div>
              </>
          }
        </div>
      </div>
      {/* Coverage note — honesty marker: partial ranges are flagged */}
      {agg.total_days > 0 && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 9, marginTop: 10,
          color: agg.days_with_data < agg.total_days / 2 ? "var(--brass)" : "var(--marginalia)",
          letterSpacing: "0.06em" }}>
          {agg.days_with_data} of {agg.total_days} days in range have data.
          {agg.days_with_data < agg.total_days / 2 ? " Range is mostly empty — averages are not meaningful." : ""}
        </p>
      )}

      {/* ── 02 SUMMARY ──────────────────────────────────────────────────── */}
      <SL n="02" title="SUMMARY" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        background: "var(--rule)", border: "1px solid var(--rule)", marginTop: 16 }}>
        {([
          ["Total NAR",           h(agg.total_nar)],
          ["Mean / day",          agg.days_with_data > 0 ? h(agg.mean_nar) : "—"],
          ["Days with data",      agg.total_days > 0 ? `${agg.days_with_data} / ${agg.total_days}` : "0"],
          ["Best day",            agg.best_day ? `${agg.best_day.date}  ${h(agg.best_day.nar_hours)}` : "—"],
          ["Worst day",           agg.worst_day ? `${agg.worst_day.date}  ${h(agg.worst_day.nar_hours)}` : "—"],
          ["Displaced / engaged", noData ? "—" : `${h(stats.totals.displaced_hours)} / ${h(stats.totals.engaged_hours)}`],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label} style={{ background: WOOL_BG, padding: "12px 16px" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 9,
              letterSpacing: "0.22em", textTransform: "uppercase",
              color: "var(--marginalia)", marginBottom: 5 }}>
              {label}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 14,
              letterSpacing: 0, color: "var(--ink)" }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* ── 03 PERIOD COMPOSITION ───────────────────────────────────────── */}
      {!noData && (() => {
        const total = (stats.totals.displaced_hours + stats.totals.engaged_hours) || 1;
        const dispPct = (stats.totals.displaced_hours / total) * 100;
        return (
          <>
            <SL n="03" title="PERIOD COMPOSITION" />
            <p style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.06em",
              color: "var(--marginalia)", opacity: 0.6, marginTop: 6, marginBottom: 6 }}>
              Source breakdown (explicit / inferred / autonomous) requires per-day rate data — follow-up #584.
            </p>
            <div style={{ display: "flex", gap: 1, height: 20, width: "100%",
              overflow: "hidden", border: "1px solid var(--rule)", marginTop: 4 }}>
              <div style={{ width: `${dispPct}%`, background: "var(--brass)", opacity: 0.75 }}
                title={`Displaced ${h(stats.totals.displaced_hours)}`} />
              <div style={{ flex: 1, background: "var(--marginalia)", opacity: 0.25 }}
                title={`Engaged ${h(stats.totals.engaged_hours)}`} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between",
              fontFamily: "var(--font-mono)", fontSize: 9, marginTop: 4,
              color: "var(--marginalia)", letterSpacing: "0.06em" }}>
              <span>Displaced {h(stats.totals.displaced_hours)}</span>
              <span>Engaged {h(stats.totals.engaged_hours)}</span>
            </div>
          </>
        );
      })()}

      {/* Footer — matches the template's .foot */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 40,
        borderTop: `1px solid ${HAIR}`, paddingTop: 9,
        fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 8,
        letterSpacing: "0.22em", color: "var(--marginalia)" }}>
        <span>ALFRED BLACK · ATTENTION STATEMENT · {stats.from} — {stats.to}</span>
        <span>PAGE 1 OF 1</span>
      </div>
    </div>
  );
}

// ── Trends view (#584 — canonical 4-panel report) ────────────────────────────

function TrendsView({ data, grain, setGrain, interpretingRead, onGenerateRead, readTimedOut, onRetry }: {
  data: AttentionTrendsResponse; grain: TrendsGrain; setGrain: (g: TrendsGrain) => void;
  interpretingRead: boolean; onGenerateRead: () => void; readTimedOut: boolean; onRetry: () => void;
}) {
  const ps = trimEmptyEdgePeriods(data.periods ?? []);
  if (!ps.length) return <p className="font-mono text-xs opacity-40 mt-12">No data for this period.</p>;

  const nb = deriveNarBars(ps, grain);
  const rb = deriveRatioBars(ps, grain);
  const bb = deriveBucketBars(ps, grain);
  const N = ps.length;
  const GP = 4;
  const BW = Math.min(Math.max(Math.round((560 - Math.max(N - 1, 0) * GP) / Math.max(N, 1)), 10), 56);
  const CW = N * BW + Math.max(N - 1, 0) * GP;
  const H_UP = 96; const H_DN = 36; // mirrored NAR chart heights
  const SVG_H = 168;                 // ratio line-plot height

  const barPx = (v: number, mx: number, h: number) => Math.max(Math.round(Math.max(v, 0) / mx * h), 0);
  const maxNar = deriveSeriesMax(nb.map(b => b.nar_hours));
  const maxEng = deriveSeriesMax(nb.map(b => b.engaged_hours));
  const validR = rb.filter(b => b.ratio != null && !b.low_engagement).map(b => b.ratio!);
  const maxR = deriveSeriesMax(validR.length ? validR : rb.filter(b => b.ratio != null).map(b => b.ratio!));
  const chartMax = maxR * 1.1;
  const xc = (i: number) => i * (BW + GP) + BW / 2;
  const ry = (r: number) => SVG_H - 10 - (r / chartMax) * (SVG_H - 20);

  // Sentence engine inputs
  const lastP = ps[ps.length - 1];
  const engNow = lastP.engaged_hours > 0 ? lastP.engaged_hours : null;
  const narHtml = deriveNarHeadline({ nar: lastP.nar_hours, engaged: engNow, displaced: lastP.displaced_hours });

  const peakIdx = rb.reduce((bi, b, i) => (b.ratio ?? 0) > (rb[bi].ratio ?? 0) ? i : bi, 0);
  const peakBar = rb[peakIdx];
  const peakMonth = ps[peakIdx]?.start
    ? new Date(ps[peakIdx].start).toLocaleString("en", { month: "short" }) : "";
  const ratioHtml = deriveRatioHeadline({
    ratio: lastP.return_ratio, engaged: engNow,
    peakValue: peakBar?.ratio ?? 1, peakMonth,
    ratioSeries: rb.map(b => b.ratio),
  });

  const readPair = deriveReadPairData(ps, grain);
  let readHtml: string | null = null;
  if (readPair) {
    const dR = dir(readPair.priorRatio, readPair.latestRatio);
    const dX = dir(readPair.priorXLHours, readPair.latestXLHours);
    const dF = dir(readPair.priorFailures, readPair.latestFailures);
    readHtml = deriveReadHeadline({
      dR, dX, dF,
      priorKey: readPair.priorKey, latestKey: readPair.latestKey,
      priorRatio: readPair.priorRatio, latestRatio: readPair.latestRatio,
      priorFailures: readPair.priorFailures, latestFailures: readPair.latestFailures,
      priorEngaged: readPair.priorEngaged, latestEngaged: readPair.latestEngaged,
      priorXLHours: readPair.priorXLHours, latestXLHours: readPair.latestXLHours,
    });
  }

  const allocTotals = deriveTrendsAllocTotals(ps);
  const allocHtml = deriveAllocationHeadline(allocTotals);

  const uninstrumentedCount = nb.filter(b => b.uninstrumented).length;
  const totalUnbucketed = bb.reduce((s, b) => s + b.unbucketed_count, 0);
  const lineSegs = deriveRatioLineSegmentsFromBars(rb);

  // Month-based x-axis: show month name at each month boundary; "NOW" for the last period.
  const MONTHS_ABR = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const xLabel = (i: number): string => {
    if (i === N - 1) return "NOW";
    if (!ps[i]?.start) return "";
    const m = new Date(ps[i].start).getMonth();
    if (i === 0 || new Date(ps[i - 1]?.start).getMonth() !== m) return MONTHS_ABR[m];
    return "";
  };

  const wrapStyle = { padding: "36px 58px 30px", ...DARK_VARS, "--background": WOOL_BG } as CSSProperties;
  const ML: CSSProperties = { fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 8,
    letterSpacing: "0.2em", color: "var(--marginalia)", textTransform: "uppercase" };
  const H2S: CSSProperties = { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 22,
    letterSpacing: "-0.01em", lineHeight: 1.3, margin: "14px 0 20px", color: "var(--ink)" };
  const pairArr: CSSProperties = { color: "var(--brass)", fontSize: 22, fontStyle: "normal" };
  const pDelta = (a: number, b: number) => b > a + 0.001 ? "▲" : b < a - 0.001 ? "▼" : "";

  return (
    <div className="wool" style={wrapStyle}>
      {/* att-h em: styled normal weight, brass — matches template's `h2 em { font-style:normal; color:var(--brass) }` */}
      <style>{`.att-h em { font-style: normal; color: var(--brass); }`}</style>

      {/* Letterhead */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <img src={logoWhite} alt="Alfred Black" style={{ height: 34, width: "auto", display: "block" }} />
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 11.5,
            letterSpacing: "0.32em", textTransform: "uppercase", color: "var(--ink)" }}>
            ALFRED&nbsp;BLACK
          </span>
        </div>
        <div style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700,
          fontSize: 9.5, letterSpacing: "0.2em", color: "var(--marginalia)", lineHeight: 1.9 }}>
          {data.from} {"—"} {data.to}
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--ink)", borderBottom: "1px solid var(--ink)", height: 4, margin: "14px 0 20px" }} />
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 30,
        letterSpacing: "-0.015em", lineHeight: 1.05, margin: "0 0 20px" }}>
        Attention Trends.
      </h1>

      {/* Grain selector */}
      <div className="flex gap-4 mb-10">
        {(["week", "month", "quarter"] as TrendsGrain[]).map(g => (
          <button key={g} type="button" onClick={() => setGrain(g)}
            className="font-mono text-[10px] uppercase tracking-[0.22em] pb-1 transition-colors"
            style={{ color: grain === g ? "var(--brass)" : "var(--marginalia)", borderBottom: grain === g ? "1px solid var(--brass)" : "1px solid transparent" }}>
            {g === "week" ? "Weekly" : g === "month" ? "Monthly" : "Quarterly"}
          </button>
        ))}
      </div>

      {/* 01 NET RETURNED — mirrored chart: GIVEN BACK above axis, YOUR TIME below */}
      <SL n="01" title="NET RETURNED" mt={0} />
      <h2 className="att-h" style={H2S} dangerouslySetInnerHTML={{ __html: narHtml }} />
      <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 0, marginBottom: 4 }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ height: H_UP, display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 8 }}>
            <span style={{ ...ML, fontSize: 7, letterSpacing: "0.12em" }}>GIVEN{" "}BACK</span>
          </div>
          <div style={{ height: 1, borderTop: `1px solid ${HAIR2}` }} />
          <div style={{ height: H_DN, display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 8 }}>
            <span style={{ ...ML, fontSize: 7, letterSpacing: "0.12em" }}>YOUR{" "}TIME</span>
          </div>
        </div>
        <div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${N}, 1fr)`, gap: GP }}>
            {nb.map((b, i) => {
              const upH = barPx(b.nar_hours, maxNar, H_UP);
              const dnH = barPx(b.engaged_hours, maxEng, H_DN);
              return (
                <div key={b.key} style={{ opacity: b.uninstrumented ? 0.38 : 1 }}>
                  <div style={{ height: H_UP, display: "flex", alignItems: "flex-end" }}>
                    <div style={{ width: "100%", height: Math.max(upH, 1), boxSizing: "border-box" as const,
                      background: upH > 1 ? "var(--brass)" : "transparent",
                      border: b.partial ? `1px dashed var(--brass)` : undefined,
                      opacity: upH > 1 ? 1 : 0.14 }} />
                  </div>
                  <div style={{ height: 1, borderTop: `1px solid ${HAIR2}` }} />
                  <div style={{ height: H_DN }}>
                    {dnH > 0 && <div style={{ width: "100%", height: dnH, background: HATCH_BG }} />}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${N}, 1fr)`, gap: GP, marginTop: 5 }}>
            {nb.map((b, i) => { const lbl = xLabel(i); return (
              <div key={b.key} style={{ ...ML, fontSize: 7.5, textAlign: "center",
                color: lbl === "NOW" ? "var(--brass)" : "var(--marginalia)", opacity: lbl ? 1 : 0 }}>
                {lbl || " "}
              </div>
            ); })}
          </div>
        </div>
      </div>
      {uninstrumentedCount > 0 && (
        <p style={{ ...ML, marginTop: 6, fontStyle: "italic", textTransform: "none" }}>
          {uninstrumentedCount} of {N} {grain}s have unmeasured interruption costs {"—"} not shown as zero
        </p>
      )}

      {/* 02 RETURN RATIO — SVG line plot; nulls draw as gap segments, never interpolated */}
      <SL n="02" title="RETURN RATIO" />
      {ratioHtml
        ? <h2 className="att-h" style={H2S} dangerouslySetInnerHTML={{ __html: ratioHtml }} />
        : <p style={{ ...ML, marginTop: 14, marginBottom: 20, fontStyle: "italic" }}>Engagement not measured for this period.</p>}
      <svg width={CW} height={SVG_H + 18} style={{ display: "block", maxWidth: "100%", overflow: "visible" }}
        role="img" aria-label="Return ratio trend">
        <line x1={0} y1={ry(1)} x2={CW} y2={ry(1)} stroke={HAIR2} strokeWidth={1} strokeDasharray="3 4" />
        <text x={CW + 4} y={ry(1)} dominantBaseline="middle" fontSize={7.5} fontFamily="monospace" fill="var(--marginalia)">1{"×"}</text>
        {lineSegs.map((seg, si) => {
          const pts = seg.isGap
            ? `${xc(seg.from)},${ry(rb[seg.from].ratio!)} ${xc(seg.to)},${ry(rb[seg.to].ratio!)}`
            : `${xc(seg.from)},${ry(rb[seg.from].ratio!)} ${xc(seg.to)},${ry(rb[seg.to].ratio!)}`;
          return <polyline key={si} points={pts} fill="none" stroke="var(--brass)"
            strokeWidth={seg.isGap ? 1.5 : 2.5} strokeDasharray={seg.isGap ? "4 5" : undefined} opacity={seg.isGap ? 0.3 : 1} />;
        })}
        {peakBar?.ratio != null && peakIdx !== N - 1 && (
          <g>
            <circle cx={xc(peakIdx)} cy={ry(peakBar.ratio)} r={4} fill="var(--brass)" />
            <text x={xc(peakIdx)} y={ry(peakBar.ratio) - 9} textAnchor="middle" fontSize={8.5} fontFamily="monospace" fill="var(--brass)">{f1(peakBar.ratio)}{"×"}</text>
          </g>
        )}
        {rb[N - 1]?.ratio != null && (
          <g>
            <circle cx={xc(N - 1)} cy={ry(rb[N - 1].ratio!)} r={4} fill="none" stroke="var(--brass)" strokeWidth={2} />
            <text x={xc(N - 1)} y={ry(rb[N - 1].ratio!) - 9} textAnchor="middle" fontSize={8} fontFamily="monospace" fill="var(--brass)">NOW</text>
          </g>
        )}
        {nb.map((b, i) => { const lbl = xLabel(i); return lbl ? (
          <text key={b.key} x={xc(i)} y={SVG_H + 14} textAnchor="middle" fontSize={8} fontFamily="monospace"
            fill={lbl === "NOW" ? "var(--brass)" : "var(--marginalia)"}>{lbl}</text>
        ) : null; })}
      </svg>
      <p style={{ ...ML, marginTop: 4, fontStyle: "italic", textTransform: "none" }}>
        {"—"} = no data {"·"} dim = engaged {"<"} {LOW_ENGAGEMENT_HOURS}h (ratio unreliable)
      </p>

      {/* 03 ALFRED'S READ — algorithmic sentence from direction triple + last-two-periods pairs */}
      <SL n="03" title={readPair ? `ALFRED'S READ · ${readPair.priorKey} → ${readPair.latestKey}` : "ALFRED'S READ"} />
      {readHtml && readPair ? (
        <>
          <h2 className="att-h" style={H2S} dangerouslySetInnerHTML={{ __html: readHtml }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 2 }}>
            {([
              { label: "HOURS IN THE BIGGEST TASKS", prior: readPair.priorXLHours, latest: readPair.latestXLHours, sfx: " h" },
              { label: "FAILED TASKS", prior: readPair.priorFailures, latest: readPair.latestFailures, sfx: "" },
              { label: "FINISHED TASKS", prior: readPair.priorFinished, latest: readPair.latestFinished, sfx: "" },
            ] as const).map(({ label, prior, latest, sfx }) => (
              <div key={label} style={{ padding: "22px 18px 16px", background: WOOL_BG }}>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 30,
                  lineHeight: 1, marginBottom: 10, letterSpacing: "-0.015em" }}>
                  {f1(prior)} <span style={pairArr}>{"→"}</span> {f1(latest)}{sfx}
                  {pDelta(prior, latest) && <>{" "}<span style={pairArr}>{pDelta(prior, latest)}</span></>}
                </div>
                <div style={ML}>{label}</div>
              </div>
            ))}
          </div>
          {totalUnbucketed > 0 && (
            <p style={{ ...ML, marginTop: 8, fontStyle: "italic", textTransform: "none" }}>
              + {totalUnbucketed} vigilance sweeps (unbucketed {"—"} not counted in task size totals)
            </p>
          )}
        </>
      ) : (
        <p style={{ ...ML, marginTop: 14, fontStyle: "italic", textTransform: "none" }}>
          {readPair === null ? "Not enough full periods to compare." : ""}
        </p>
      )}

      {/* 04 ALLOCATION — cumulative strip across the full window */}
      <SL n="04" title="ALLOCATION" />
      <h2 className="att-h" style={H2S} dangerouslySetInnerHTML={{ __html: allocHtml }} />
      <div style={{ height: 16, display: "flex", overflow: "hidden", borderRadius: 2, gap: 1 }}>
        {([["work", "var(--brass)", 0.85], ["life", "var(--marginalia)", 0.55],
          ["unallocated", "oklch(0.62 0.09 75 / 0.35)", 1]] as const).map(([k, col, op]) => {
          const frac = k === "work" ? allocTotals.workFrac : k === "life" ? allocTotals.lifeFrac : allocTotals.unassignedFrac;
          return frac > 0.005 ? <div key={k} style={{ flex: frac, background: col, opacity: op }} /> : null;
        })}
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
        {([["work", "WORK", "var(--brass)"], ["life", "LIFE", "var(--marginalia)"],
          ["unallocated", "NOT YET ASSIGNED", "oklch(0.62 0.09 75 / 0.6)"]] as const).map(([k, lbl, col]) => {
          const frac = k === "work" ? allocTotals.workFrac : k === "life" ? allocTotals.lifeFrac : allocTotals.unassignedFrac;
          return (
            <span key={k} style={{ ...ML, color: col }}>
              {lbl}: {Math.round(frac * 100)}%
            </span>
          );
        })}
      </div>

      {/* 05 ALFRED'S OBSERVATIONS — LLM-generated, explicitly triggered; no nightly schedule */}
      <div className="mb-10">
        <SL n="05" title="ALFRED'S OBSERVATIONS" />
        {isReadGenerated(data.read) ? (
          data.read!.observations.length === 0
            ? <p className="font-mono text-xs mt-4 opacity-40">Alfred ran the analysis but found no patterns to surface for this period.</p>
            : <div className="mt-4 flex flex-col gap-6">
                {data.read!.observations.map((obs, i) => (
                  <div key={i} className="grid grid-cols-[1fr_2fr] gap-6 pb-6 border-b border-[var(--rule)] last:border-0">
                    <p className="font-display text-lg leading-snug">{obs.headline}</p>
                    <div>
                      <p className="font-mono text-sm mb-2">{obs.detail}</p>
                      <p className="font-mono text-[10px] opacity-50">{obs.evidence}</p>
                    </div>
                  </div>
                ))}
              </div>
        ) : interpretingRead ? (
          <p className="font-mono text-xs mt-4 opacity-50">{READ_POLL_PENDING_TEXT}</p>
        ) : readTimedOut ? (
          <div className="mt-4">
            <p className="font-mono text-xs opacity-50">{READ_POLL_GAVE_UP_TEXT}</p>
            <button type="button" onClick={onRetry}
              className="mt-4 font-mono text-[10px] uppercase tracking-[0.22em] border border-[var(--rule)] px-5 py-2 hover:border-[var(--brass)] transition-colors">
              Try again
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <p className="font-mono text-xs opacity-50">{READ_EMPTY_STATE_TEXT}</p>
            <button type="button" onClick={onGenerateRead}
              className="mt-4 font-mono text-[10px] uppercase tracking-[0.22em] border border-[var(--rule)] px-5 py-2 hover:border-[var(--brass)] transition-colors">
              Generate Alfred{"'"}s read
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ borderTop: `1px solid ${HAIR}`, marginTop: 32, paddingTop: 14,
        display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 8.5,
          letterSpacing: "0.28em", textTransform: "uppercase", color: "var(--marginalia)" }}>
          ALFRED BLACK {"·"} ATTENTION TRENDS {"·"} {data.from} {"—"} {data.to}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 8.5,
          letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--marginalia)", opacity: 0.5 }}>
          PAGE 1 OF 1
        </span>
      </div>
    </div>
  );
}

// ── Page shell ────────────────────────────────────────────────────────────────

export default function AttentionPage() {
  const [tab, setTab] = useState<"day" | "range" | "trends">(
    dateParam("from", "") !== "" ? "range" : "day");
  const [date, setDate] = useState(dateParam("date", now()));
  const [from, setFrom] = useState(dateParam("from", sevenAgo()));
  const [to, setTo] = useState(dateParam("to", now()));
  const [running, setRunning] = useState(false);
  const [grain, setGrain] = useState<TrendsGrain>("week");
  const [trendsFrom] = useState(thirteenWeeksAgo);
  const [trendsTo] = useState(now);
  const [interpretingRead, setInterpretingRead] = useState(false);
  const [readTimedOut, setReadTimedOut] = useState(false);
  // Timestamp recorded when polling starts; compared against POLL_GIVE_UP_MS in the interval.
  const pollStartRef = useRef<number>(0);
  const dayQ = useQuery(getAttentionStatement, { date }, { enabled: tab === "day" });
  const statsQ = useQuery(getAttentionStats, { from, to }, { enabled: tab === "range" });
  const trendsQ = useQuery(getAttentionTrends, { grain, from: trendsFrom, to: trendsTo }, { enabled: tab === "trends" });
  const recompute = useAction(recomputeAttention);
  const interpretTrends = useAction(interpretAttentionTrends);

  // Poll for the read every 15 s while it is being generated; give up after POLL_GIVE_UP_MS.
  // Interval is cleared on unmount and when the read arrives (see effect below).
  useEffect(() => {
    if (!interpretingRead) return;
    const id = setInterval(() => {
      if (Date.now() - pollStartRef.current > POLL_GIVE_UP_MS) {
        setInterpretingRead(false);
        setReadTimedOut(true);
        clearInterval(id);
        return;
      }
      trendsQ.refetch();
    }, 15_000);
    return () => clearInterval(id);
  }, [interpretingRead]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop polling once the read appears in the data.
  useEffect(() => {
    if (interpretingRead && (trendsQ.data as AttentionTrendsResponse | undefined)?.read != null) {
      setInterpretingRead(false);
    }
  }, [interpretingRead, trendsQ.data]);

  async function handleRecompute() {
    setRunning(true);
    try { await recompute({ date }); await dayQ.refetch(); } finally { setRunning(false); }
  }

  // Only enter the polling state after the trigger call succeeds.
  // A thrown or non-2xx response means nothing was started — stay on the idle state.
  async function handleGenerateRead() {
    setReadTimedOut(false);
    try {
      await interpretTrends({ grain, from: trendsFrom, to: trendsTo });
      pollStartRef.current = Date.now();
      setInterpretingRead(true);
    } catch { /* trigger rejected — stay on idle; user sees the button */ }
  }

  const din = (val: string, set: (v: string) => void, max?: string) => (
    <input type="date" value={val} max={max} onChange={(e) => set(e.target.value)}
      className="font-mono text-xs border border-[var(--rule)] bg-transparent px-2 py-1 focus:outline-none focus:border-[var(--brass)] transition-colors" />
  );

  return (
    <Frame>
      <section className="mx-auto max-w-[900px] px-8 py-12">

        {/* Tab bar */}
        <div className="flex gap-6 mb-6 border-b border-[var(--rule)]">
          {(["day", "range", "trends"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className="font-mono text-[10px] uppercase tracking-[0.22em] pb-2 transition-colors"
              style={{ color: tab === t ? "var(--brass)" : "var(--marginalia)", borderBottom: tab === t ? "1px solid var(--brass)" : "1px solid transparent" }}>
              {t === "day" ? "Day" : t === "range" ? "Range" : "Trends"}
            </button>
          ))}
        </div>

        {/* Date controls — Trends uses internal grain selector; no date pickers */}
        {tab !== "trends" && (
          <div className="flex items-center gap-3 mb-8">
            {tab === "day"
              ? din(date, setDate, now())
              : <>{din(from, setFrom, to)}<span className="font-mono text-xs opacity-40">to</span>{din(to, setTo, now())}</>}
          </div>
        )}

        {/* Content */}
        {tab === "day"
          ? dayQ.isLoading ? <p className="font-mono text-xs opacity-40">Loading…</p>
            : dayQ.error ? <p className="font-mono text-xs" style={{ color: "oklch(0.42 0.12 30)" }}>{String((dayQ.error as any)?.message ?? "Failed.")}</p>
            : dayQ.data ? <DayView day={normalizeAttentionDay(dayQ.data)} date={date} recomp={handleRecompute} running={running} /> : null
          : tab === "range"
            ? statsQ.isLoading ? <p className="font-mono text-xs opacity-40">Loading…</p>
              : statsQ.error ? <p className="font-mono text-xs" style={{ color: "oklch(0.42 0.12 30)" }}>{String((statsQ.error as any)?.message ?? "Failed.")}</p>
              : statsQ.data ? <RangeView stats={statsQ.data as AttentionStatsResponse} /> : null
            : trendsQ.isLoading ? <p className="font-mono text-xs opacity-40">Loading…</p>
              : trendsQ.error ? <p className="font-mono text-xs" style={{ color: "oklch(0.42 0.12 30)" }}>{String((trendsQ.error as any)?.message ?? "Failed.")}</p>
              : trendsQ.data ? <TrendsView data={trendsQ.data as AttentionTrendsResponse} grain={grain} setGrain={setGrain} interpretingRead={interpretingRead} onGenerateRead={handleGenerateRead} readTimedOut={readTimedOut} onRetry={handleGenerateRead} /> : null}

      </section>
    </Frame>
  );
}
