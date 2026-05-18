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
import { Link } from "react-router-dom";
import {
  useQuery,
  getRecentJudgments,
  getStewardFeed,
  getRecentDecisions,
  getStateChanges,
  getStateChangeSources,
  getAuditFeed2,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

type Outcome = "Handled" | "Held" | "Asked";
type FilterPill = "All" | Outcome;
// Phase I (#897 §11.2): top-level tab — Decisions ledger (legacy) vs
// the new cross-target State Changes feed shipped by Phase A (#889).
type TopTab = "decisions" | "state_changes";
// Decision lifecycle states — surfaced as small badges so the principal
// can scan what's settled vs in-flight in the ledger.
type DecisionState =
  | "open"
  | "scheduled"
  | "executing"
  | "completed"
  | "reversed";

interface Row {
  key: string;
  when: string;       // ISO for sort
  whenDisplay: string;
  input: string;
  conf: number | null;
  path: string;       // HANDLED / HELD / ASKED
  outcome: Outcome;
  state?: DecisionState;
  intent?: string;
  executeAt?: string;
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

// STORE-P2-4: adapter from the SQL audit row shape into the page's Row
// type. Outcome classification (HANDLED / HELD / ASKED) follows the
// mapping in the issue:
//   HANDLED → action_type ∈ {steward_action, auto_task_created, desk_action}
//   HELD    → action_type = state_change AND prior_state ≠ new_state
//   ASKED   → action_type = needs_attention_action AND payload has a
//             needs_attention_path
// Anything else is dropped — the ledger only surfaces decisions the
// principal would care to scan.
function classifyAuditOutcome(row: any): Outcome | null {
  const actionType = String(row?.action_type ?? "");
  let payload: any = null;
  if (row?.payload) {
    try {
      payload =
        typeof row.payload === "string"
          ? JSON.parse(row.payload)
          : row.payload;
    } catch {
      payload = null;
    }
  }
  if (
    actionType === "steward_action" ||
    actionType === "auto_task_created" ||
    actionType === "desk_action"
  ) {
    return "Handled";
  }
  if (actionType === "state_change") {
    const prior = String(
      payload?.prior_state ?? payload?.from ?? payload?.previous ?? "",
    );
    const next = String(
      payload?.new_state ?? payload?.to ?? payload?.state ?? "",
    );
    if (prior && next && prior !== next) return "Held";
    // Bare state-change records without a delta surface as Held anyway —
    // the principal still wants to see that something held.
    return "Held";
  }
  if (actionType === "needs_attention_action") {
    if (payload && (payload.needs_attention_path || payload.target_path)) {
      return "Asked";
    }
    return "Asked";
  }
  return null;
}

function mapAuditRowForDecisions(row: any): Row | null {
  const outcome = classifyAuditOutcome(row);
  if (!outcome) return null;
  let when = "";
  try {
    const ns = BigInt(String(row?.ts ?? "0"));
    const ms = Number(ns / 1_000_000n);
    if (Number.isFinite(ms) && ms > 0) {
      when = new Date(ms).toISOString();
    }
  } catch {
    when = "";
  }
  if (!when) return null;
  let payload: any = null;
  if (row?.payload) {
    try {
      payload =
        typeof row.payload === "string"
          ? JSON.parse(row.payload)
          : row.payload;
    } catch {
      payload = null;
    }
  }
  const targetId = String(row?.target_id ?? "");
  const input =
    String(payload?.summary ?? payload?.title ?? payload?.headline ?? "")
      .trim() ||
    String(row?.reasoning ?? "").trim() ||
    targetId.replace(/^[a-z_]+\//, "").replace(/\.md$/, "") ||
    String(row?.action_type ?? "—");
  return {
    key: `a:${String(row?.id ?? `${row?.action_type}:${targetId}:${when}`)}`,
    when,
    whenDisplay: fmtWhen(when),
    input,
    conf: null,
    path: outcome.toUpperCase(),
    outcome,
  };
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
  // New decision records — every Desk click since the cascade went
  // live. Polled faster than the others so the ledger reflects
  // in-flight work in close to real time.
  const { data: decisions } = useQuery(
    getRecentDecisions,
    { limit: 200 },
    {
      refetchInterval: 15_000,
      retry: false,
    },
  );
  // STORE-P2-4: SQL-backed audit feed. Adds steward_action /
  // auto_task_created / state_change / needs_attention_action rows so
  // the ledger reflects every alfred-learn writer the audit table
  // captures. STORE-P2-5 retired the legacy markdown-walking sources;
  // this is now additive against the markdown-only judgments/steward
  // queries (which read non-audit record types like vault/event/ items
  // that haven't been migrated to the SQL audit trail).
  const { data: auditSql } = useQuery(
    getAuditFeed2,
    { limit: 200 },
    {
      refetchInterval: 60_000,
      retry: false,
    },
  );

  const [filter, setFilter] = useState<FilterPill>("All");
  // Phase I top-level tab. "decisions" = legacy HANDLED/HELD/ASKED ledger;
  // "state_changes" = cross-target state_change feed.
  const [topTab, setTopTab] = useState<TopTab>("decisions");

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
    // Decision records — every Desk click. We classify the outcome by
    // intent ↦ outcome pill so they integrate with the existing
    // HANDLED/HELD/ASKED filters: done & take_mine → Handled, defer →
    // Held, delegate → Asked.
    const ds = Array.isArray(decisions?.decisions) ? decisions?.decisions : [];
    for (const d of ds ?? []) {
      const when = String(d?.created ?? "");
      const intent = String(d?.intent ?? "").toLowerCase();
      const state = String(d?.state ?? "open").toLowerCase() as DecisionState;
      const headline =
        String(d?.source_headline ?? "").trim() ||
        String(d?.source_record ?? "").replace(/\.md$/, "").split("/").pop() ||
        `decision ${intent}`;
      const outcome: Outcome =
        intent === "delegate"
          ? "Asked"
          : intent === "defer"
            ? "Held"
            : "Handled";
      const executeAt = String(d?.execute_at ?? "").trim();
      out.push({
        key: `d:${d?.id ?? when}`,
        when,
        whenDisplay: fmtWhen(when),
        input: `${intentVerb(intent)} ${headline}`,
        conf: null,
        path: outcome.toUpperCase(),
        outcome,
        state,
        intent,
        executeAt: executeAt || undefined,
      });
    }
    // STORE-P2-4: SQL audit rows. The legacy markdown audit sources were
    // retired in STORE-P2-5 (vault/event/ migration moved to the SQL
    // audit table), so this loop no longer needs to dedupe against
    // markdown-walking rows — it just appends.
    const auditRows = Array.isArray((auditSql as any)?.results)
      ? ((auditSql as any).results as any[])
      : [];
    for (const r of auditRows) {
      const row = mapAuditRowForDecisions(r);
      if (!row) continue;
      out.push(row);
    }
    out.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
    return out;
  }, [judgments, steward, decisions, auditSql]);

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
        <h1 className="font-display text-6xl italic mb-8">Decisions</h1>

        {/* Phase I top-level tabs */}
        <div className="flex items-baseline gap-8 mb-10 border-b border-rule pb-2">
          {(
            [
              ["decisions", "Decisions"],
              ["state_changes", "State Changes"],
            ] as Array<[TopTab, string]>
          ).map(([id, label]) => {
            const active = topTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTopTab(id)}
                className="font-mono text-[11px] uppercase tracking-[0.28em] pb-2"
                style={{
                  color: active ? "var(--brass)" : "var(--marginalia)",
                  borderBottom: active
                    ? "1px solid var(--brass)"
                    : "1px solid transparent",
                  marginBottom: -9,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {topTab === "state_changes" ? <StateChangesTab /> : null}
        {topTab === "decisions" ? <DecisionsLedger
          rows={rows}
          filtered={filtered}
          filter={filter}
          setFilter={setFilter}
          days={days}
          totals={totals}
          max={max}
        /> : null}
      </section>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Decisions ledger — the legacy HANDLED/HELD/ASKED feed + 30-day chart.
// Extracted from the page body so the State Changes tab can render
// independently without duplicating the existing layout.
// ---------------------------------------------------------------------------

function DecisionsLedger({
  rows,
  filtered,
  filter,
  setFilter,
  days,
  totals,
  max,
}: {
  rows: Row[];
  filtered: Row[];
  filter: FilterPill;
  setFilter: (f: FilterPill) => void;
  days: { handled: number; held: number; asked: number }[];
  totals: { handled: number; held: number; asked: number };
  max: number;
}) {
  return (
    <>
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
                <th className="text-left py-3 pl-4 uppercase tracking-[0.2em] text-[10px] font-normal">
                  Status
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
                  <td className="py-3 font-body text-[15px]">
                    {r.input}
                    {r.executeAt && (
                      <span
                        className="block font-mono text-[11px] italic"
                        style={{ color: "var(--marginalia)", marginTop: 2 }}
                      >
                        Fires {fmtWhen(r.executeAt)}
                      </span>
                    )}
                  </td>
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
                  <td className="py-3 pl-4">
                    {r.state ? <StateBadge state={r.state} /> : (
                      <span style={{ color: "var(--marginalia)" }}>—</span>
                    )}
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Phase I (#897 §11.2): State Changes tab.
//
// Cross-target chronological feed of every state_change timeline entry on
// matter/* and task/* records. Wraps getStateChanges + getStateChangeSources
// (state/operations.ts). Filter pills are derived live from the sources
// histogram; counts come straight from the ctrl-api response.
//
// Pagination: 50 per fetch, "Load more" extends the page. The ctrl-api
// endpoint caps `limit` at 200; we hold at 50 and let the user step.
// ---------------------------------------------------------------------------

interface StateChangeRow {
  target_path: string;
  when: string;
  id: string;
  source: string;
  reason: string;
  confidence: number;
  mode: "shadow" | "live";
  audit_record: string;
}

function StateChangesTab() {
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(50);

  const { data: sourcesData } = useQuery(
    getStateChangeSources,
    undefined,
    { refetchInterval: false, staleTime: 5 * 60_000, retry: false },
  );
  const sources: Array<{ source: string; count: number; last_seen: string }> =
    Array.isArray((sourcesData as any)?.sources)
      ? (sourcesData as any).sources
      : [];

  const { data: entriesData, isLoading } = useQuery(
    getStateChanges,
    { source: sourceFilter ?? undefined, limit },
    { refetchInterval: 60_000, retry: false },
  );
  const entries: StateChangeRow[] = Array.isArray(
    (entriesData as any)?.entries,
  )
    ? (entriesData as any).entries
    : [];
  const total = Number((entriesData as any)?.total ?? entries.length);

  return (
    <>
      {/* Filter pills — live from the sources histogram */}
      <div className="flex items-baseline gap-x-5 gap-y-2 mb-6 flex-wrap">
        <button
          type="button"
          onClick={() => setSourceFilter(null)}
          className="font-mono text-[10px] uppercase tracking-[0.22em] pb-0.5"
          style={{
            color: sourceFilter === null ? "var(--brass)" : "var(--marginalia)",
            borderBottom:
              sourceFilter === null
                ? "1px solid var(--brass)"
                : "1px solid transparent",
          }}
        >
          All
        </button>
        {sources.length === 0 ? (
          <span
            className="font-body italic text-[14px]"
            style={{ color: "var(--marginalia)" }}
          >
            No state-change sources seen in the last 30 days.
          </span>
        ) : (
          sources.map((s) => {
            const active = sourceFilter === s.source;
            return (
              <button
                key={s.source}
                type="button"
                onClick={() => setSourceFilter(active ? null : s.source)}
                className="font-mono text-[10px] uppercase tracking-[0.22em] pb-0.5"
                style={{
                  color: active ? "var(--brass)" : "var(--marginalia)",
                  borderBottom: active
                    ? "1px solid var(--brass)"
                    : "1px solid transparent",
                }}
              >
                {s.source} · {s.count}
              </button>
            );
          })
        )}
      </div>

      {/* Entries table */}
      {isLoading && entries.length === 0 ? (
        <p
          className="font-body italic text-[16px] py-8"
          style={{ color: "var(--marginalia)" }}
        >
          Reading state changes…
        </p>
      ) : entries.length === 0 ? (
        <p
          className="font-body italic text-[16px] py-8"
          style={{ color: "var(--marginalia)" }}
        >
          {sourceFilter
            ? `No state changes from ${sourceFilter}.`
            : "No state changes recorded yet."}
        </p>
      ) : (
        <>
          <table className="w-full font-mono text-[12px]">
            <thead>
              <tr
                className="border-y border-rule"
                style={{ color: "var(--marginalia)" }}
              >
                <th className="text-left py-3 uppercase tracking-[0.2em] text-[10px] font-normal w-[110px]">
                  When
                </th>
                <th className="text-left py-3 uppercase tracking-[0.2em] text-[10px] font-normal w-[180px]">
                  Source
                </th>
                <th className="text-left py-3 uppercase tracking-[0.2em] text-[10px] font-normal">
                  Target
                </th>
                <th className="text-left py-3 uppercase tracking-[0.2em] text-[10px] font-normal">
                  Reason
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const targetSlug = e.target_path
                  .replace(/^matter\//, "")
                  .replace(/^task\//, "")
                  .replace(/\.md$/, "");
                const isMatter = e.target_path.startsWith("matter/");
                const targetHref = isMatter
                  ? `/matters/${encodeURIComponent(targetSlug)}`
                  : `/vault?slug=${encodeURIComponent(e.target_path.replace(/\.md$/, ""))}`;
                return (
                  <tr
                    key={e.id || `${e.target_path}-${e.when}`}
                    className="border-b border-rule"
                  >
                    <td className="py-3" style={{ color: "var(--marginalia)" }}>
                      {fmtRelativeWhen(e.when)}
                    </td>
                    <td className="py-3" style={{ color: "var(--brass)" }}>
                      {e.source}
                      {e.mode === "shadow" && (
                        <span
                          className="ml-2 font-mono text-[9px] uppercase tracking-[0.2em]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          shadow
                        </span>
                      )}
                    </td>
                    <td className="py-3">
                      <Link to={targetHref} style={{ color: "var(--ink)" }}>
                        {targetSlug}
                      </Link>
                    </td>
                    <td className="py-3 font-body text-[14px]">
                      {truncateLineLocal(e.reason, 100)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-4 flex items-baseline justify-between">
            <span
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              {entries.length} of {total}
            </span>
            {entries.length < total && (
              <button
                type="button"
                onClick={() => setLimit((l) => Math.min(l + 50, 200))}
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--brass)" }}
              >
                Load more →
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

function fmtRelativeWhen(value: string): string {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 60_000) return "just now";
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  } catch {
    return value;
  }
}

function truncateLineLocal(s: string, limit = 100): string {
  const flat = (s || "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit - 1).trimEnd() + "…";
}

/** Verb the principal sees in the ledger for each decision intent. */
function intentVerb(intent: string): string {
  if (intent === "delegate") return "Delegated:";
  if (intent === "defer") return "Deferred:";
  if (intent === "done") return "Closed:";
  if (intent === "take_mine") return "Took on:";
  return "Acted on:";
}

/** Status badge — small monospace pill colored by lifecycle state. */
function StateBadge({ state }: { state: DecisionState }) {
  const palette: Record<
    DecisionState,
    { bg: string; fg: string; label: string }
  > = {
    open: { bg: "var(--paper-2)", fg: "var(--marginalia)", label: "ROUTING" },
    scheduled: {
      bg: "var(--brass-faint)",
      fg: "var(--brass)",
      label: "SCHEDULED",
    },
    executing: { bg: "var(--ink)", fg: "var(--paper)", label: "ACTIVE" },
    completed: {
      bg: "transparent",
      fg: "var(--marginalia)",
      label: "DONE",
    },
    reversed: {
      bg: "transparent",
      fg: "var(--brass)",
      label: "REVERSED",
    },
  };
  const p = palette[state] ?? palette.open;
  return (
    <span
      className="font-mono text-[10px] tracking-[0.22em]"
      style={{
        background: p.bg,
        color: p.fg,
        padding: "3px 8px",
        display: "inline-block",
        textAlign: "center",
      }}
    >
      {p.label}
    </span>
  );
}
