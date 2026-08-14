// AttentionPage — NAR breakdown for /attention (#584).
// Day: canonical statement (hero band → three displacement groups → mess bill →
// statistics grid → rate card → unrated → sceptical footer).
// Range: per-day NAR column chart (SVG, no lib) + aggregate cells + composition bar.
import { useState } from "react";
import { useQuery, useAction, getAttentionStatement, getAttentionStats, recomputeAttention } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import {
  deriveDisplacementGroups, deriveUnratedRows, isEmptyDay, formatHours,
  deriveChartBars, deriveChartScale, deriveRangeAggregates,
  type AttentionDayResponse, type AttentionStatsResponse, type ChartBar, type ChartScaleResult,
} from "./attentionCore";

const now = () => new Date().toISOString().slice(0, 10);
const sevenAgo = () => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); };

// ── Shared primitives ─────────────────────────────────────────────────────────

function SH({ s }: { s: string }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.26em] mb-2 mt-8" style={{ color: "var(--marginalia)" }}>
      {s}
    </p>
  );
}

function TR({ l, r, dim }: { l: React.ReactNode; r: React.ReactNode; dim?: boolean }) {
  return (
    <div className={`flex justify-between items-baseline py-1 gap-4${dim ? " opacity-50" : ""}`}>
      <span className="font-sans text-sm">{l}</span>
      <span className="font-mono text-sm tabular-nums text-right shrink-0">{r}</span>
    </div>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline py-1.5 mt-1" style={{ borderTop: "2px solid var(--rule)" }}>
      <span className="font-sans text-sm font-semibold">{label}</span>
      <span className="font-mono text-sm tabular-nums font-semibold">{value}</span>
    </div>
  );
}

// bg-background so it works as a gap-px grid cell (parent sets the gap colour)
function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] mb-1.5" style={{ color: "var(--marginalia)" }}>
        {label}
      </p>
      <p className="font-mono text-base tabular-nums">{value}</p>
    </div>
  );
}

const Rule = () => <div className="border-t border-[var(--rule)] my-4" />;

// ── NAR column chart (hand-rolled SVG, no dependency) ─────────────────────────

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

// ── Day view ──────────────────────────────────────────────────────────────────

function DayView({ day, recomp, running }: { day: AttentionDayResponse; recomp(): void; running: boolean }) {
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

  const g = deriveDisplacementGroups(day.displaced);
  const un = deriveUnratedRows(day.unrated ?? []);
  const h = (v: number) => `${formatHours(v)} h`;
  const hm = (m: number) => h(m / 60);
  const Pill = ({ s }: { s: string }) => (
    <span className="inline-block border border-[var(--rule)] font-mono text-[9px] px-1.5 py-px mr-2 tracking-wide opacity-70">{s}</span>
  );

  return (
    <>
      {/* Hero band — NAR large with arithmetic right-aligned, rules above/below */}
      <div className="flex justify-between items-start gap-8 py-5 my-6"
        style={{ borderTop: "1px solid var(--brass)", borderBottom: "1px solid var(--brass)" }}>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.26em] mb-2" style={{ color: "var(--marginalia)" }}>
            Net Attention Returned
          </p>
          <span className="font-mono tabular-nums leading-none" style={{ fontSize: "clamp(40px,5vw,60px)" }}>
            {formatHours(day.nar_hours)}<span className="text-2xl opacity-40 ml-2">h</span>
          </span>
        </div>
        <div className="text-right font-mono text-xs tabular-nums shrink-0 mt-1"
          style={{ color: "var(--marginalia)", lineHeight: 2.2 }}>
          <p>{formatHours(day.displaced?.total_hours ?? 0)} displaced</p>
          <p>− {formatHours(day.engaged.hours)} engaged</p>
          <p>− {formatHours(day.interruption.hours)} interruption</p>
        </div>
      </div>

      {/* Displacement — Inferred */}
      <SH s="Displaced — inferred, conversational" />
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] mb-2 opacity-40">Estimated — model heuristic, not measured</p>
      {g.inferred.items.length === 0 ? <p className="text-xs opacity-40">None.</p> : g.inferred.items.map((it, i) => (
        <div key={i}>
          <TR l={<><Pill s={it.bucket} />{it.label}</>}
            r={it.is_blocked
              ? <><span className="line-through opacity-40 mr-1.5">{hm(it.claimed_minutes)}</span><span>0.00 h</span></>
              : hm(it.display_minutes)} />
          <p className="text-right font-mono text-[10px] opacity-40 mb-0.5">
            {it.turns}t · {it.tools} tools{it.is_blocked ? ` · ${it.blocked_reason}` : ""}
          </p>
        </div>
      ))}
      <TotalRow label="Inferred subtotal" value={h(g.inferred.hours)} />

      {/* Displacement — Explicit */}
      <SH s="Displaced — explicit, rate card" />
      {g.explicit.items.length === 0 ? <p className="text-xs opacity-40">None.</p> : g.explicit.items.map((it, i) => (
        <TR key={i} l={it.label}
          r={<><span className="opacity-40 mr-2">×{it.count} @ {it.rate_minutes} min</span>{hm(it.minutes)}</>} />
      ))}
      <TotalRow label="Explicit subtotal" value={h(g.explicit.hours)} />

      {/* Displacement — Autonomous */}
      <SH s="Displaced — autonomous, by artifact" />
      {g.autonomous.items.length === 0 ? <p className="text-xs opacity-40">None.</p> : g.autonomous.items.map((it, i) => (
        <TR key={i} l={<><Pill s={it.bucket} />{it.label}</>} r={hm(it.minutes)} />
      ))}
      <TotalRow label="Autonomous subtotal" value={h(g.autonomous.hours)} />

      {/* Grand total */}
      <div className="flex justify-between items-baseline py-2 mt-2" style={{ borderTop: "2px solid var(--rule)" }}>
        <span className="font-sans font-bold">Total displaced</span>
        <span className="font-mono tabular-nums font-bold">{h(day.displaced?.total_hours ?? 0)}</span>
      </div>
      <Rule />

      {/* Mess bill — engaged and interruption as negative rows with parameters */}
      <SH s="Mess bill" />
      <TR l={<>Engaged <span className="font-mono text-[10px] opacity-40 ml-2">
        ({day.engaged.events} events · {day.engaged.bursts} bursts · gap {day.engaged.gap_minutes} min · floor {day.engaged.floor_minutes} min)
      </span></>} r={`− ${h(day.engaged.hours)}`} />
      <TR l={<>Interruption <span className="font-mono text-[10px] opacity-40 ml-2">
        (×{day.interruption.count} @ {day.interruption.rate_minutes} min)
      </span></>} r={`− ${h(day.interruption.hours)}`} />
      <Rule />

      {/* Statistics — bordered grid */}
      <SH s="Statistics" />
      <div className="grid grid-cols-4 gap-px mt-2" style={{ background: "var(--rule)", border: "1px solid var(--rule)" }}>
        <StatCell label="Sessions" value={String(day.stats.sessions)} />
        <StatCell label="Turns" value={String(day.stats.turns)} />
        <StatCell label="Bursts" value={String(day.engaged.bursts)} />
        <StatCell label="Self-corrections" value={String(day.stats.self_corrections)} />
        <StatCell label="Blocked" value={`${day.stats.blocked} — 0.00 h`} />
        <StatCell label="Hard failures" value={String(day.stats.hard_failures)} />
        <StatCell label="Return ratio" value={day.stats.return_ratio.toFixed(2)} />
        <StatCell label="Artifacts" value={String(day.stats.autonomous_artifacts)} />
      </div>

      {/* Rate card in force */}
      <SH s="Rate card in force" />
      <TR l="Suppression" r={`${day.rates.suppression_minutes_per_item} min / item`} />
      <TR l="Interruption" r={`${day.rates.interruption_minutes} min`} />
      <TR l="Buckets" r={`S ${day.rates.bucket_minutes.S} · M ${day.rates.bucket_minutes.M} · L ${day.rates.bucket_minutes.L} · XL ${day.rates.bucket_minutes.XL} min`} />

      {/* Unrated action classes */}
      {un.length > 0 && (<>
        <SH s="Unrated action classes" />
        <p className="font-mono text-[10px] opacity-40 mb-2 uppercase tracking-[0.18em]">No rate established — contribute zero to NAR</p>
        {un.map((r) => (
          <TR key={r.action_class} l={<span className="font-mono text-xs">{r.action_class}</span>}
            r={`×${r.count} — no rate established`} dim />
        ))}
      </>)}

      <Rule />

      {/* Sceptical footer — keeps the number honest */}
      <p className="font-mono text-[10px] leading-relaxed" style={{ color: "var(--marginalia)" }}>
        Figures are estimates, not measurements. NAR = displaced − engaged − interruption.
        Inferred displacement is a model heuristic; blocked sessions contribute zero.
        Every figure is recomputable from the rate card above.
        Treat this as an honest account of displacement credit claimed — not a guarantee.
      </p>
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

      {/* Coverage note — warn when range is mostly empty */}
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
  const [tab, setTab] = useState<"day" | "range">("day");
  const [date, setDate] = useState(now());
  const [from, setFrom] = useState(sevenAgo());
  const [to, setTo] = useState(now());
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

        {/* Header — eyebrow + date as title */}
        <div className="mb-10">
          <p className="font-mono text-[10px] uppercase tracking-[0.32em] mb-3" style={{ color: "var(--marginalia)" }}>
            Alfred Black · Attention Statement
          </p>
          <h1 className="font-display tracking-[-0.02em] leading-[0.98]" style={{ fontSize: "clamp(44px,6vw,72px)" }}>
            {tab === "day" ? date : `${from} — ${to}`}
          </h1>
        </div>

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
            : dayQ.data ? <DayView day={dayQ.data as AttentionDayResponse} recomp={handleRecompute} running={running} /> : null
          : statsQ.isLoading ? <p className="font-mono text-xs opacity-40">Loading…</p>
            : statsQ.error ? <p className="font-mono text-xs" style={{ color: "oklch(0.42 0.12 30)" }}>{String((statsQ.error as any)?.message ?? "Failed.")}</p>
            : statsQ.data ? <RangeView stats={statsQ.data as AttentionStatsResponse} /> : null}

      </section>
    </Frame>
  );
}
