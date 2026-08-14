// AttentionPage — NAR breakdown for /attention (#584).
// Day view: headline NAR, three separate displacement groups (explicit /
// inferred / autonomous), mess bill, stats, rate card, unrated classes.
// Range view: per-day series table + totals.
// Design constraints: groups never merged; unrated → "no rate established";
// blocked items at zero with reason; rate card always visible.
import { useState } from "react";
import { useQuery, useAction, getAttentionStatement, getAttentionStats, recomputeAttention } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { deriveDisplacementGroups, deriveUnratedRows, isEmptyDay, formatHours, type AttentionDayResponse, type SeriesPoint } from "./attentionCore";

const now = () => new Date().toISOString().slice(0, 10);
const sevenAgo = () => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); };

const mono10 = { color: "var(--marginalia)" } as const;
const ML = ({ s }: { s: string }) => <p className="font-mono text-[10px] uppercase tracking-[0.26em] mb-1 mt-4" style={mono10}>{s}</p>;
const Row = ({ l, r, dim }: { l: React.ReactNode; r: string; dim?: boolean }) => (
  <div className={`flex justify-between items-baseline py-0.5${dim ? " opacity-50" : ""}`}>
    <span className="text-sm font-sans">{l}</span>
    <span className="font-mono text-sm tabular-nums">{r}</span>
  </div>
);
const hr = <div className="border-t border-[var(--brass)]/20 my-3" />;

function DayView({ day, recomp, running }: { day: AttentionDayResponse; recomp(): void; running: boolean }) {
  if (isEmptyDay(day)) return (
    <div className="py-10 text-center">
      <p className="text-sm opacity-50">No attention data for {day.date}.</p>
      <button type="button" onClick={recomp} disabled={running} className="mt-4 font-mono text-[10px] uppercase tracking-[0.22em] border border-[var(--brass)]/40 px-4 py-2 hover:border-[var(--brass)] disabled:opacity-30 transition-colors">{running ? "Recomputing…" : "Recompute"}</button>
    </div>
  );

  const g = deriveDisplacementGroups(day.displaced);
  const un = deriveUnratedRows(day.unrated ?? []);
  const h = (v: number) => `${formatHours(v)} h`;
  const hm = (m: number) => h(m / 60);

  return (
    <div className="max-w-xl">
      <div className="flex justify-between items-baseline mb-4">
        <span className="font-mono text-[10px] uppercase tracking-[0.26em]" style={mono10}>Net Attention Returned</span>
        <span className="font-mono text-3xl tabular-nums">{formatHours(day.nar_hours)}<span className="ml-1 text-base opacity-40">h</span></span>
      </div>
      {hr}

      <ML s="Displacement — Explicit" />
      {g.explicit.items.length === 0 ? <p className="text-xs opacity-40">None.</p> : g.explicit.items.map((it, i) => (
        <Row key={i} l={<>{it.label} <span className="opacity-40 text-xs">(×{it.count} @ {it.rate_minutes} min)</span></>} r={hm(it.minutes)} />
      ))}
      <Row l="Subtotal" r={h(g.explicit.hours)} dim />

      <ML s="Displacement — Inferred" />
      {g.inferred.items.length === 0 ? <p className="text-xs opacity-40">None.</p> : g.inferred.items.map((it, i) => (
        <div key={i} className="py-0.5">
          <Row l={<>{it.label} <span className="font-mono text-xs opacity-40">[{it.bucket}]</span> <span className="opacity-30 text-xs">{it.turns}t {it.tools}tools</span></>} r={hm(it.display_minutes)} />
          {it.is_blocked && <p className="text-xs text-right italic opacity-40">{it.blocked_reason}</p>}
        </div>
      ))}
      <Row l="Subtotal" r={h(g.inferred.hours)} dim />

      <ML s="Displacement — Autonomous" />
      {g.autonomous.items.length === 0 ? <p className="text-xs opacity-40">None.</p> : g.autonomous.items.map((it, i) => (
        <Row key={i} l={<>{it.label} <span className="font-mono text-xs opacity-40">[{it.bucket}]</span></>} r={hm(it.minutes)} />
      ))}
      <Row l="Subtotal" r={h(g.autonomous.hours)} dim />

      <div className="flex justify-between items-baseline py-1 mt-2 border-t border-[var(--rule)]">
        <span className="font-sans text-sm font-semibold">Total displaced</span>
        <span className="font-mono text-sm tabular-nums">{h(day.displaced?.total_hours ?? 0)}</span>
      </div>
      {hr}

      <ML s="Mess bill" />
      <Row l={<>Engaged <span className="opacity-40 text-xs">({day.engaged.events} ev, {day.engaged.bursts} bursts)</span></>} r={h(day.engaged.hours)} />
      <Row l={<>Interruption <span className="opacity-40 text-xs">(×{day.interruption.count} @ {day.interruption.rate_minutes} min)</span></>} r={h(day.interruption.hours)} />

      <ML s="Statistics" />
      <p className="font-mono text-xs opacity-60">
        {day.stats.sessions} sessions · {day.stats.turns} turns · blocked {day.stats.blocked} · failures {day.stats.hard_failures} · return {day.stats.return_ratio.toFixed(2)} · artifacts {day.stats.autonomous_artifacts}
      </p>

      <ML s="Rate card in force" />
      <Row l="Suppression" r={`${day.rates.suppression_minutes_per_item} min/item`} />
      <Row l="Interruption" r={`${day.rates.interruption_minutes} min`} />
      <Row l="Buckets" r={`S=${day.rates.bucket_minutes.S} M=${day.rates.bucket_minutes.M} L=${day.rates.bucket_minutes.L} XL=${day.rates.bucket_minutes.XL} min`} />

      {un.length > 0 && (<>
        <ML s="Unrated action classes" />
        {un.map((r) => <Row key={r.action_class} l={<span className="font-mono text-xs">{r.action_class}</span>} r={`×${r.count} — no rate established`} />)}
      </>)}
      {hr}
      <button type="button" onClick={recomp} disabled={running} className="font-mono text-[10px] uppercase tracking-[0.22em] border border-[var(--brass)]/40 px-4 py-2 hover:border-[var(--brass)] disabled:opacity-30 transition-colors">{running ? "Recomputing…" : "Recompute this day"}</button>
    </div>
  );
}

function RangeView({ stats }: { stats: { series: SeriesPoint[]; totals: { nar_hours: number; displaced_hours: number; engaged_hours: number } } }) {
  const h = (v: number) => `${formatHours(v)} h`;
  return (
    <div className="max-w-xl">
      <ML s="Period totals" />
      <Row l="NAR" r={h(stats.totals.nar_hours)} /><Row l="Displaced" r={h(stats.totals.displaced_hours)} /><Row l="Engaged" r={h(stats.totals.engaged_hours)} />
      <ML s="Daily series" />
      {stats.series.length === 0 ? <p className="text-xs opacity-40">No data.</p> : (
        <table className="w-full text-xs font-mono">
          <thead><tr className="border-b border-[var(--rule)]"><th className="text-left py-1 opacity-40 font-normal">Date</th><th className="text-right py-1 opacity-40 font-normal">NAR</th><th className="text-right py-1 opacity-40 font-normal">Displaced</th><th className="text-right py-1 opacity-40 font-normal">Engaged</th></tr></thead>
          <tbody>{stats.series.map((pt) => (<tr key={pt.date} className="border-b border-[var(--rule)]/30 hover:bg-[var(--brass)]/5 transition-colors"><td className="py-1 tabular-nums">{pt.date}</td><td className="py-1 text-right tabular-nums">{formatHours(pt.nar_hours)}</td><td className="py-1 text-right tabular-nums opacity-60">{formatHours(pt.displaced_hours)}</td><td className="py-1 text-right tabular-nums opacity-60">{formatHours(pt.engaged_hours)}</td></tr>))}</tbody>
        </table>
      )}
    </div>
  );
}

export default function AttentionPage() {
  const [tab, setTab] = useState<"day" | "range">("day");
  const [date, setDate] = useState(now()); const [from, setFrom] = useState(sevenAgo()); const [to, setTo] = useState(now());
  const [running, setRunning] = useState(false);
  const dayQ = useQuery(getAttentionStatement, { date }, { enabled: tab === "day" });
  const statsQ = useQuery(getAttentionStats, { from, to }, { enabled: tab === "range" });
  const recompute = useAction(recomputeAttention);
  const din = (val: string, set: (v: string) => void, max?: string) => (
    <input type="date" value={val} max={max} onChange={(e) => set(e.target.value)} className="font-mono text-xs border border-[var(--rule)] bg-transparent px-2 py-1 focus:outline-none focus:border-[var(--brass)] transition-colors" />
  );
  async function handleRecompute() { setRunning(true); try { await recompute({ date }); await dayQ.refetch(); } finally { setRunning(false); } }

  return (
    <Frame>
      <div className="max-w-xl mb-6">
        <span className="font-mono text-[10px] uppercase tracking-[0.32em] block mb-3" style={mono10}>Attention</span>
        <h1 className="font-display tracking-[-0.02em] leading-[0.98]" style={{ fontSize: "clamp(44px,6vw,72px)" }}>Statement</h1>
        <p className="font-sans text-sm opacity-50 mt-2">NAR — what Alfred genuinely displaced, by source and kind. Every figure recomputable from the rate card.</p>
      </div>
      <div className="flex gap-6 mb-6 border-b border-[var(--rule)]">
        {(["day","range"] as const).map((t) => <button key={t} type="button" onClick={() => setTab(t)} className="font-mono text-[10px] uppercase tracking-[0.22em] pb-2 transition-colors" style={{ color: tab===t?"var(--brass)":"var(--marginalia)", borderBottom: tab===t?"1px solid var(--brass)":"1px solid transparent" }}>{t==="day"?"Day":"Range"}</button>)}
      </div>
      <div className="flex items-center gap-3 mb-6">
        {tab === "day" ? din(date, setDate, now()) : <>{din(from, setFrom, to)}<span className="font-mono text-xs opacity-40">to</span>{din(to, setTo, now())}</>}
      </div>
      {tab === "day"
        ? dayQ.isLoading ? <p className="text-xs opacity-40">Loading…</p>
          : dayQ.error ? <p className="text-xs text-red-500">{String((dayQ.error as any)?.message??"Failed.")}</p>
          : dayQ.data ? <DayView day={dayQ.data as AttentionDayResponse} recomp={handleRecompute} running={running} /> : null
        : statsQ.isLoading ? <p className="text-xs opacity-40">Loading…</p>
          : statsQ.error ? <p className="text-xs text-red-500">{String((statsQ.error as any)?.message??"Failed.")}</p>
          : statsQ.data ? <RangeView stats={statsQ.data as any} /> : null}
    </Frame>
  );
}
