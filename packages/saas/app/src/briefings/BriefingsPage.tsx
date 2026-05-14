// BriefingsPage — chronological feed of every briefing the composer
// has written (STATE-MUTATION Phase E, #893; spec §8).
//
// Reads getBriefings. Briefings are grouped by date (newest first);
// each row carries a slot pill, counts of observed matters /
// state_changes, and is expandable to reveal the full letterpress
// body (rendered via the shared Markdown component). Filter pills:
// All / Morning / Evening.
//
// Style mirrors ChoresPage (letterpress, brass tokens, monospace
// eyebrows). No backend writes — read-only feed.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, getBriefings, getBriefing } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Markdown } from "../client/components/ab/Markdown";

type Slot = "morning" | "evening";
type SlotFilter = "all" | Slot;

interface BriefingSummary {
  path: string;
  slug_date: string;
  slot: Slot;
  date: string;
  composed_at: string;
  prior_briefing: string | null;
  window: { start: string; end: string };
  observed_matters_count: number;
  state_changes_count: number;
  signals_count: number;
  decisions_count: number;
}

function fmtAbsolute(value: string): string {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function fmtRelativePast(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return fmtAbsolute(value);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function fmtDateHeading(date: string): string {
  if (!date) return "";
  try {
    const d = new Date(`${date}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return date;
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return date;
  }
}

function SlotPill({ slot }: { slot: Slot }) {
  const label = slot === "morning" ? "Morning Brief" : "Evening Brief";
  return (
    <span
      className="inline-block font-mono text-[10px] uppercase tracking-[0.22em] py-1 px-2 border"
      style={{ color: "var(--brass)", borderColor: "var(--brass)" }}
    >
      {label}
    </span>
  );
}

function CountBadge({ label, n }: { label: string; n: number }) {
  if (!n) return null;
  return (
    <span
      className="font-mono text-[10px] uppercase tracking-[0.22em] mr-3"
      style={{ color: "var(--marginalia)" }}
    >
      {n} {label}
      {n === 1 ? "" : "s"}
    </span>
  );
}

function ExpandedBriefing({ slugDate }: { slugDate: string }) {
  const { data, isLoading } = useQuery(getBriefing, { slugDate });
  if (isLoading) {
    return (
      <p
        className="font-body italic text-[15px]"
        style={{ color: "var(--marginalia)" }}
      >
        Reading the brief…
      </p>
    );
  }
  const body: string = String((data as any)?.body ?? "");
  if (!body.trim()) {
    return (
      <p
        className="font-body italic text-[15px]"
        style={{ color: "var(--marginalia)" }}
      >
        Alfred recorded the brief, but the body is empty.
      </p>
    );
  }
  return (
    <div className="max-w-[64ch] font-body text-[17px] leading-[1.6]">
      <Markdown source={body} useLiveResolver={true} />
    </div>
  );
}

function pickBriefings(data: any): BriefingSummary[] {
  const arr: any[] = Array.isArray(data)
    ? data
    : (data?.briefings ?? data?.items ?? []);
  return arr
    .filter((b) => b && typeof b === "object")
    .map((b) => ({
      path: String(b.path ?? ""),
      slug_date: String(b.slug_date ?? ""),
      slot: (b.slot === "evening" ? "evening" : "morning") as Slot,
      date: String(b.date ?? ""),
      composed_at: String(b.composed_at ?? ""),
      prior_briefing: b.prior_briefing ?? null,
      window: {
        start: String(b?.window?.start ?? ""),
        end: String(b?.window?.end ?? ""),
      },
      observed_matters_count: Number(b.observed_matters_count ?? 0) || 0,
      state_changes_count: Number(b.state_changes_count ?? 0) || 0,
      signals_count: Number(b.signals_count ?? 0) || 0,
      decisions_count: Number(b.decisions_count ?? 0) || 0,
    }))
    .filter((b) => b.slug_date);
}

function groupByDate(rows: BriefingSummary[]): Array<{
  date: string;
  rows: BriefingSummary[];
}> {
  const map = new Map<string, BriefingSummary[]>();
  for (const r of rows) {
    const k = r.date || r.composed_at.slice(0, 10);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  // Newest-first by date string; within a date the rows already sort
  // newest-first by composed_at because the ctrl-api list does.
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([date, rs]) => ({ date, rows: rs }));
}

export default function BriefingsPage() {
  const [filter, setFilter] = useState<SlotFilter>("all");
  const [open, setOpen] = useState<string | null>(null);

  // The ctrl-api accepts slot=all|morning|evening. We pass it through
  // when the user has selected a filter so the cache key changes and
  // the server-side total reflects the active filter.
  const queryArgs =
    filter === "all" ? { slot: "all", limit: 100 } : { slot: filter, limit: 100 };
  const { data, isLoading } = useQuery(getBriefings, queryArgs);
  const rows = pickBriefings(data);
  const grouped = groupByDate(rows);

  const totalMorning = rows.filter((r) => r.slot === "morning").length;
  const totalEvening = rows.filter((r) => r.slot === "evening").length;

  return (
    <Frame>
      <section className="mx-auto max-w-[1080px] px-8 py-12">
        <div className="flex items-baseline justify-between mb-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            Briefings
          </div>
          <Link
            to="/brief"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            ← Latest brief
          </Link>
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-2">
          Every brief Alfred has composed.
        </h1>
        <p
          className="font-body italic text-[17px] mb-10"
          style={{ color: "var(--marginalia)" }}
        >
          Morning at the start of the day. Evening at the close. Each one is
          a snapshot of the matters as they stood.
        </p>

        {/* Filter pills */}
        <div className="flex flex-wrap gap-2 mb-8">
          {(
            [
              ["all", `All (${rows.length})`],
              ["morning", `Morning (${totalMorning})`],
              ["evening", `Evening (${totalEvening})`],
            ] as Array<[SlotFilter, string]>
          ).map(([key, label]) => {
            const active = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className="font-mono text-[10px] uppercase tracking-[0.22em] py-1 px-2 border"
                style={{
                  color: active ? "var(--paper)" : "var(--brass)",
                  background: active ? "var(--brass)" : "transparent",
                  borderColor: "var(--brass)",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {isLoading ? (
          <p
            className="font-body italic text-[16px]"
            style={{ color: "var(--marginalia)" }}
          >
            Gathering the briefs…
          </p>
        ) : rows.length === 0 ? (
          <p
            className="font-body italic text-[16px]"
            style={{ color: "var(--marginalia)" }}
          >
            No briefings yet. The next scheduled run will compose one.
          </p>
        ) : (
          <div className="space-y-12">
            {grouped.map(({ date, rows: dayRows }) => (
              <section key={date}>
                <h2
                  className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4 pb-2 border-b border-rule"
                  style={{ color: "var(--marginalia)" }}
                >
                  {fmtDateHeading(date)}
                </h2>
                <ul>
                  {dayRows.map((b) => {
                    const isOpen = open === b.slug_date;
                    return (
                      <li
                        key={b.slug_date}
                        id={b.slug_date}
                        className="border-b border-rule scroll-mt-24"
                      >
                        <button
                          onClick={() =>
                            setOpen(isOpen ? null : b.slug_date)
                          }
                          className="w-full grid grid-cols-[140px_1fr_24px] gap-6 py-5 items-baseline text-left"
                          aria-expanded={isOpen}
                        >
                          <SlotPill slot={b.slot} />
                          <div>
                            <div
                              className="font-display text-[22px]"
                              style={{ color: "var(--ink)" }}
                            >
                              {b.slot === "morning"
                                ? "Morning Brief"
                                : "Evening Brief"}
                            </div>
                            <div
                              className="font-mono text-[11px] mt-1"
                              style={{ color: "var(--marginalia)" }}
                            >
                              composed {fmtRelativePast(b.composed_at)} ·{" "}
                              {fmtAbsolute(b.composed_at)}
                            </div>
                            <div className="mt-2">
                              <CountBadge
                                label="matter"
                                n={b.observed_matters_count}
                              />
                              <CountBadge
                                label="state change"
                                n={b.state_changes_count}
                              />
                              <CountBadge label="signal" n={b.signals_count} />
                              <CountBadge
                                label="decision"
                                n={b.decisions_count}
                              />
                            </div>
                          </div>
                          <span
                            className="text-right"
                            style={{ color: "var(--brass)" }}
                          >
                            {isOpen ? "▾" : "▸"}
                          </span>
                        </button>
                        {isOpen && (
                          <div className="pb-8 pr-6">
                            <div
                              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4"
                              style={{ color: "var(--marginalia)" }}
                            >
                              window {fmtAbsolute(b.window.start)} —{" "}
                              {fmtAbsolute(b.window.end)}
                            </div>
                            <ExpandedBriefing slugDate={b.slug_date} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>
    </Frame>
  );
}
