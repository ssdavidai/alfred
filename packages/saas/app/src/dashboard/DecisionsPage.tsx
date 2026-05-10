// DecisionsPage — audit feed with HANDLED/HELD/ASKED filters (#861).
//
// Source: merge of getRecentJudgments + getStewardFeed into a single
// chronologically-sorted client feed. Each entry is mapped to the
// unified row type {when, input, conf, path, outcome}. The queue of
// outstanding decisions lives at /desk; this page is the LEDGER —
// every decision Alfred has made on your behalf.
//
// 30-day chart: bucket the merged feed by day and render a stacked-bar
// on inline SVG (the redesign's hand-drawn aesthetic, not recharts —
// recharts isn't in deps and the chart is intentionally austere).
//
// Filter pills toggle visibility per outcome. "All" is the default.
import { useMemo, useState } from "react";
import { useQuery, getRecentJudgments, getStewardFeed } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

type Outcome = "Handled" | "Held" | "Asked";
type FilterPill = "All" | Outcome;

interface Row {
  key: string;
  when: string;       // ISO for sort
  whenDisplay: string;
  input: string;
  conf: number | null;
  path: string;       // HANDLED / HELD / ASKED
  outcome: Outcome;
}

function classifyOutcome(item: any): Outcome {
  // Steward feed prefixes: steward-action, signal-action, auto-task-created,
  // needs_attention_action.
  const fm = (item?.frontmatter ?? {}) as Record<string, unknown>;
  const action = String(fm.action ?? fm.decision ?? "").toLowerCase();
  const status = String(fm.status ?? "").toLowerCase();
  const path = String(item?.path ?? "");
  if (action.includes("ask") || status === "asked" || path.includes("needs_attention")) {
    return "Asked";
  }
  if (action.includes("hold") || status === "held" || status === "review") {
    return "Held";
  }
  return "Handled";
}

function fmtWhen(value: string): string {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    const yest = new Date(today);
    yest.setDate(yest.getDate() - 1);
    const isYest =
      d.getFullYear() === yest.getFullYear() &&
      d.getMonth() === yest.getMonth() &&
      d.getDate() === yest.getDate();
    const time = d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (sameDay) return time;
    if (isYest) return `Yest ${time}`;
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  } catch {
    return value;
  }
}

function dayKey(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export default function DecisionsPage() {
  const { data: judgments } = useQuery(getRecentJudgments, undefined, {
    refetchInterval: 60_000,
    retry: false,
  });
  const { data: steward } = useQuery(getStewardFeed, undefined, {
    refetchInterval: 60_000,
    retry: false,
  });

  const [filter, setFilter] = useState<FilterPill>("All");

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const ju = Array.isArray(judgments?.results) ? judgments?.results : [];
    for (const j of ju ?? []) {
      const fm = (j?.frontmatter ?? {}) as Record<string, unknown>;
      const when = String(fm.created ?? "");
      const conf =
        fm.confidence != null
          ? Number(fm.confidence)
          : fm.discretion_score != null
            ? Number(fm.discretion_score)
            : null;
      out.push({
        key: `j:${j?.path ?? when}`,
        when,
        whenDisplay: fmtWhen(when),
        input: String(
          fm.observation ?? fm.input ?? j?.name ?? j?.path ?? "—",
        ),
        conf: Number.isFinite(conf) ? (conf as number) : null,
        path: classifyOutcome(j).toUpperCase(),
        outcome: classifyOutcome(j),
      });
    }
    const sw = Array.isArray(steward?.results) ? steward?.results : [];
    for (const s of sw ?? []) {
      const fm = (s?.frontmatter ?? {}) as Record<string, unknown>;
      const when = String(fm.created ?? "");
      const outcome = classifyOutcome(s);
      out.push({
        key: `s:${s?.path ?? when}`,
        when,
        whenDisplay: fmtWhen(when),
        input: String(
          fm.summary ??
            fm.action ??
            fm.target ??
            s?.body_preview ??
            s?.name ??
            "—",
        ),
        conf:
          fm.confidence != null && Number.isFinite(Number(fm.confidence))
            ? Number(fm.confidence)
            : null,
        path: outcome.toUpperCase(),
        outcome,
      });
    }
    out.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
    return out;
  }, [judgments, steward]);

  const filtered = useMemo(
    () => (filter === "All" ? rows : rows.filter((r) => r.outcome === filter)),
    [rows, filter],
  );

  // Bucket into 30 days.
  const days = useMemo(() => {
    const buckets = new Map<
      string,
      { handled: number; held: number; asked: number }
    >();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - (29 - i));
      buckets.set(d.toISOString().slice(0, 10), {
        handled: 0,
        held: 0,
        asked: 0,
      });
    }
    for (const r of rows) {
      const k = dayKey(r.when);
      const b = buckets.get(k);
      if (!b) continue;
      if (r.outcome === "Handled") b.handled += 1;
      else if (r.outcome === "Held") b.held += 1;
      else b.asked += 1;
    }
    return Array.from(buckets.values());
  }, [rows]);

  const totals = useMemo(
    () =>
      days.reduce(
        (acc, d) => ({
          handled: acc.handled + d.handled,
          held: acc.held + d.held,
          asked: acc.asked + d.asked,
        }),
        { handled: 0, held: 0, asked: 0 },
      ),
    [days],
  );
  const max = Math.max(
    1,
    ...days.map((d) => d.handled + d.held + d.asked),
  );

  return (
    <Frame>
      <section className="mx-auto max-w-[900px] px-8 py-12">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
          style={{ color: "var(--brass)" }}
        >
          The ledger
        </div>
        <h1 className="font-display text-6xl italic mb-12">Decisions</h1>

        <div className="border border-rule p-6 mb-10">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em] mb-4"
            style={{ color: "var(--marginalia)" }}
          >
            30 days · by outcome
          </div>
          <div className="flex gap-8 items-end">
            <div className="flex items-end gap-1 h-[140px] flex-1">
              {days.map((d, i) => {
                const total = d.handled + d.held + d.asked;
                const h = (total / max) * 140;
                const handledH = total > 0 ? (d.handled / total) * h : 0;
                const heldH = total > 0 ? (d.held / total) * h : 0;
                const askedH = total > 0 ? (d.asked / total) * h : 0;
                return (
                  <div
                    key={i}
                    className="flex-1 flex flex-col justify-end"
                    style={{ height: 140 }}
                    title={`H:${d.handled} · h:${d.held} · ?:${d.asked}`}
                  >
                    <div
                      style={{
                        height: askedH,
                        background:
                          "color-mix(in oklab, var(--brass) 60%, var(--ink))",
                      }}
                    />
                    <div style={{ height: heldH, background: "var(--brass)" }} />
                    <div style={{ height: handledH, background: "var(--ink)" }} />
                  </div>
                );
              })}
            </div>
            <div className="font-mono text-[12px] space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3"
                  style={{ background: "var(--ink)" }}
                />{" "}
                Handled · {totals.handled.toLocaleString()}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3"
                  style={{ background: "var(--brass)" }}
                />{" "}
                Held · {totals.held}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3"
                  style={{
                    background:
                      "color-mix(in oklab, var(--brass) 60%, var(--ink))",
                  }}
                />{" "}
                Asked · {totals.asked}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-baseline gap-4 mb-4">
          {(["All", "Handled", "Held", "Asked"] as FilterPill[]).map((f) => {
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{
                  color: active ? "var(--brass)" : "var(--marginalia)",
                  borderBottom: active
                    ? "1px solid var(--brass)"
                    : "1px solid transparent",
                  paddingBottom: 2,
                }}
              >
                {f}
              </button>
            );
          })}
          <span
            className="ml-auto font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            {filtered.length} of {rows.length}
          </span>
        </div>

        {filtered.length === 0 ? (
          <p
            className="font-body italic text-[16px] py-8"
            style={{ color: "var(--marginalia)" }}
          >
            Nothing on the ledger yet.
          </p>
        ) : (
          <table className="w-full font-mono text-[12px]">
            <thead>
              <tr
                className="border-y border-rule"
                style={{ color: "var(--marginalia)" }}
              >
                <th className="text-left py-3 uppercase tracking-[0.2em] text-[10px] font-normal">
                  When
                </th>
                <th className="text-left py-3 uppercase tracking-[0.2em] text-[10px] font-normal">
                  Input
                </th>
                <th className="text-right py-3 uppercase tracking-[0.2em] text-[10px] font-normal">
                  Conf
                </th>
                <th className="text-left py-3 pl-6 uppercase tracking-[0.2em] text-[10px] font-normal">
                  Path
                </th>
                <th className="text-right py-3 uppercase tracking-[0.2em] text-[10px] font-normal">
                  Outcome
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((r) => (
                <tr key={r.key} className="border-b border-rule">
                  <td className="py-3" style={{ color: "var(--marginalia)" }}>
                    {r.whenDisplay}
                  </td>
                  <td className="py-3 font-body text-[15px]">{r.input}</td>
                  <td className="py-3 text-right">
                    {r.conf != null ? r.conf.toFixed(2) : "—"}
                  </td>
                  <td
                    className="py-3 pl-6 font-extrabold"
                    style={{
                      color:
                        r.outcome === "Asked"
                          ? "var(--brass)"
                          : r.outcome === "Held"
                            ? "var(--brass)"
                            : "var(--ink)",
                    }}
                  >
                    {r.path}
                  </td>
                  <td className="py-3 text-right" style={{ color: "var(--brass)" }}>
                    {r.outcome === "Handled"
                      ? "✓"
                      : r.outcome === "Held"
                        ? "◆"
                        : "◌"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Frame>
  );
}
