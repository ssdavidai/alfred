// ChoreDetailPage2 — living-chore detail view (RFC #884).
//
// Rebuilt around current_state + as_of + timeline from `getChoreDetail2`.
// The existing pause/resume/trigger/delete actions are preserved below the
// timeline; cadence + last-run/next-run metadata is sourced from the
// existing `getChore` query (those fields aren't part of the new
// living-narrative shape).
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useQuery,
  getChore,
  getChoreDetail2,
  pauseChore,
  resumeChore,
  deleteChore,
  triggerChore,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Markdown } from "../client/components/ab/Markdown";
import { PageOverture } from "../client/components/ab/PageOverture";

type TaskState = "pending" | "in_progress" | "done" | "archived";

interface TimelineEntry {
  when: string;
  kind: "signal" | "task_transition" | "action";
  headline: string;
  path: string;
}

interface ChoreDetail {
  id: string;
  path: string;
  name: string;
  state: TaskState;
  current_state: string | null;
  as_of: string | null;
  timeline: TimelineEntry[];
}

function fmtAsOf(value: string | null): string {
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

function fmtTimelineWhen(value: string): string {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function fmtTime(value: unknown): string {
  if (!value) return "—";
  const s = String(value);
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return s;
  }
}

function deriveStatusPill(state: TaskState): {
  label: "Active" | "Waiting" | "Done" | "Archived";
  color: string;
} {
  if (state === "in_progress") return { label: "Active", color: "var(--brass)" };
  if (state === "done") return { label: "Done", color: "var(--marginalia)" };
  if (state === "archived") return { label: "Archived", color: "var(--marginalia)" };
  return { label: "Waiting", color: "var(--marginalia)" };
}

function StatusPill({
  label,
  color,
}: {
  label: string;
  color: string;
}) {
  return (
    <span
      className="inline-block font-mono text-[10px] uppercase tracking-[0.22em] py-1 px-3 border"
      style={{ color, borderColor: color }}
    >
      {label}
    </span>
  );
}

export default function ChoreDetailPage2() {
  const { slug } = useParams<{ slug: string }>();
  const safeSlug = slug ?? "";

  // Primary: the new living-narrative shape (current_state / as_of / timeline).
  const {
    data: detailData,
    isLoading: detailLoading,
  } = useQuery(
    getChoreDetail2,
    { id: safeSlug },
    { enabled: Boolean(safeSlug), refetchInterval: 30_000, retry: false },
  );
  // Secondary: existing chore query for cadence + last/next run + paused state.
  // Those fields aren't covered by the new narrative endpoint, so the existing
  // route remains the source of truth for scheduling metadata.
  const { data: choreData, refetch: refetchChore } = useQuery(
    getChore,
    { slug: safeSlug },
    { enabled: Boolean(safeSlug), refetchInterval: 30_000, retry: false },
  );

  const [pending, setPending] = useState<string | null>(null);
  const [timelineCap, setTimelineCap] = useState(50);

  if (!safeSlug) {
    return (
      <Frame>
        <section className="mx-auto max-w-[860px] px-8 pt-12 text-center">
          <p className="font-display italic text-2xl">No chore selected.</p>
          <Link
            to="/chores"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            ← Back to chores
          </Link>
        </section>
      </Frame>
    );
  }

  const chore = (detailData?.chore ?? null) as ChoreDetail | null;
  const fm = (choreData?.frontmatter ?? {}) as Record<string, unknown>;
  const cadence = String(
    fm.schedule_human ?? fm.schedule_cron_human ?? fm.schedule_cron ?? "—",
  );
  const status = String(fm.status ?? "active").toLowerCase();
  const paused = status === "paused";
  const lastRun = fmtTime(fm.last_run_at);
  const nextRun = fmtTime(fm.next_run_at);

  if (detailLoading && !chore) {
    return (
      <Frame>
        <section className="mx-auto max-w-[860px] px-8 pt-12">
          <p
            className="font-body italic text-[16px]"
            style={{ color: "var(--marginalia)" }}
          >
            Reading the chore…
          </p>
        </section>
      </Frame>
    );
  }

  if (!chore) {
    return (
      <Frame>
        <section className="mx-auto max-w-[860px] px-8 pt-12 text-center">
          <p className="font-display italic text-2xl">No such chore.</p>
          <Link
            to="/chores"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            ← Back to chores
          </Link>
        </section>
      </Frame>
    );
  }

  const statusPill = deriveStatusPill(chore.state);
  const sortedTimeline = [...(chore.timeline ?? [])].sort((a, b) =>
    a.when < b.when ? 1 : a.when > b.when ? -1 : 0,
  );
  const visibleTimeline = sortedTimeline.slice(0, timelineCap);
  const moreToShow = sortedTimeline.length > timelineCap;

  async function withPending(action: string, fn: () => Promise<unknown>) {
    setPending(action);
    try {
      await fn();
      await refetchChore();
    } catch (e) {
      console.error(`${action} failed`, e);
    } finally {
      setPending(null);
    }
  }

  return (
    <Frame>
      <section className="mx-auto max-w-[860px] px-8 pt-12 pb-20">
        <Link
          to="/chores"
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--brass)" }}
        >
          ← All chores
        </Link>

        <div className="mt-4">
          <PageOverture
            eyebrow="Chore"
            title={chore.name}
            meta={paused ? "Paused" : statusPill.label}
          />
        </div>

        {/* current_state paragraph + as_of byline */}
        <section className="-mt-6 mb-10">
          <div className="mb-4 flex items-baseline gap-3">
            <StatusPill label={statusPill.label} color={statusPill.color} />
            {paused && (
              <span
                className="font-display italic text-[18px]"
                style={{ color: "var(--marginalia)" }}
              >
                (paused)
              </span>
            )}
          </div>
          {chore.current_state ? (
            <>
              <div className="max-w-[64ch] font-body text-[18px] leading-[1.6]">
                <Markdown
                  source={chore.current_state}
                  useLiveResolver={false}
                />
              </div>
              {chore.as_of && (
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.22em] mt-4"
                  style={{ color: "var(--brass)" }}
                >
                  As of {fmtAsOf(chore.as_of)}
                </div>
              )}
            </>
          ) : (
            <p
              className="font-display italic text-[18px] max-w-[64ch]"
              style={{ color: "var(--marginalia)" }}
            >
              Alfred has not yet composed a current view for this chore. The
              next nightly run will.
            </p>
          )}
        </section>

        <hr className="gilt mb-12" />

        {/* Timeline */}
        <section className="mb-14">
          <h2
            className="font-mono text-[10px] uppercase tracking-[0.22em] mb-6"
            style={{ color: "var(--brass)" }}
          >
            Timeline
          </h2>
          {sortedTimeline.length === 0 ? (
            <p
              className="font-display italic text-[16px]"
              style={{ color: "var(--marginalia)" }}
            >
              No signals routed to this chore yet.
            </p>
          ) : (
            <>
              <ul>
                {visibleTimeline.map((row, i) => (
                  <li
                    key={`${row.path}-${row.when}-${i}`}
                    className="grid grid-cols-[110px_1fr_80px] gap-4 py-3 border-b border-rule items-baseline"
                  >
                    <span
                      className="font-mono text-[11px]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {fmtTimelineWhen(row.when)}
                    </span>
                    <span className="font-body text-[16px] leading-[1.5]">
                      {row.path ? (
                        <Link
                          to={`/vault?slug=${encodeURIComponent(row.path.replace(/\.md$/, ""))}`}
                          style={{ color: "var(--ink)" }}
                        >
                          {row.headline}
                        </Link>
                      ) : (
                        row.headline
                      )}
                    </span>
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.22em] text-right"
                      style={{ color: "var(--brass)" }}
                    >
                      {row.kind === "task_transition" ? "task" : row.kind}
                    </span>
                  </li>
                ))}
              </ul>
              {moreToShow && (
                <button
                  onClick={() => setTimelineCap((c) => c * 2)}
                  className="font-mono text-[10px] uppercase tracking-[0.22em] mt-4"
                  style={{ color: "var(--brass)" }}
                >
                  Show older →
                </button>
              )}
            </>
          )}
        </section>

        {/* Actions panel — preserved from the previous layout */}
        <section className="border-t border-rule pt-8">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4"
            style={{ color: "var(--brass)" }}
          >
            Schedule
          </div>
          <div
            className="font-mono text-[12px] mb-6"
            style={{ color: "var(--marginalia)" }}
          >
            {cadence} · last {lastRun} · next {nextRun}
          </div>

          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4"
            style={{ color: "var(--brass)" }}
          >
            Actions
          </div>
          <div className="flex flex-wrap items-baseline" style={{ gap: "0 24px" }}>
            <button
              onClick={() =>
                withPending(
                  paused ? "resume" : "pause",
                  () =>
                    paused
                      ? resumeChore({ slug: safeSlug })
                      : pauseChore({ slug: safeSlug }),
                )
              }
              disabled={pending !== null}
              className="btn-instruction"
              style={{ fontSize: 20 }}
            >
              {pending === "pause" || pending === "resume"
                ? "…"
                : paused
                  ? "Resume"
                  : "Pause"}
            </button>
            <span style={{ color: "var(--marginalia)" }}>·</span>
            <button
              onClick={() =>
                withPending("trigger", () => triggerChore({ slug: safeSlug }))
              }
              disabled={pending !== null}
              className="btn-instruction"
              style={{ fontSize: 20 }}
            >
              {pending === "trigger" ? "…" : "Run now"}
            </button>
            <span style={{ color: "var(--marginalia)" }}>·</span>
            <button
              onClick={() => {
                if (!confirm(`Delete chore "${chore.name}"?`)) return;
                withPending("delete", () => deleteChore({ slug: safeSlug }));
              }}
              disabled={pending !== null}
              className="btn-instruction"
              style={{ fontSize: 20 }}
            >
              {pending === "delete" ? "…" : "Delete"}
            </button>
          </div>
        </section>
      </section>
    </Frame>
  );
}
