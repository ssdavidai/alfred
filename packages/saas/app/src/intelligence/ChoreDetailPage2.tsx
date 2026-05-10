// ChoreDetailPage2 — restyled per-chore detail view (#862).
//
// Reads getChore for frontmatter+body, getChoreSource for the underlying
// Python source. Renders title + description + schedule + run log +
// (collapsible) source. Action buttons wrap the existing chore ops.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useQuery,
  getChore,
  getChoreSource,
  pauseChore,
  resumeChore,
  deleteChore,
  triggerChore,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

interface RunLogEntry {
  timestamp: string;
  message: string;
}

function parseRunLog(body: string): RunLogEntry[] {
  if (!body) return [];
  const idx = body.indexOf("## Run log");
  if (idx < 0) return [];
  const after = body.slice(idx + "## Run log".length);
  const out: RunLogEntry[] = [];
  for (const line of after.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("- ")) continue;
    const rest = t.slice(2);
    const ci = rest.indexOf(":");
    if (ci < 0) {
      out.push({ timestamp: "", message: rest });
      continue;
    }
    out.push({
      timestamp: rest.slice(0, ci).trim(),
      message: rest.slice(ci + 1).trim(),
    });
  }
  return out.reverse();
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

export default function ChoreDetailPage2() {
  const { slug } = useParams<{ slug: string }>();
  const safeSlug = slug ?? "";
  const { data, refetch, isLoading } = useQuery(
    getChore,
    { slug: safeSlug },
    { enabled: Boolean(safeSlug), refetchInterval: 30_000, retry: false },
  );
  const { data: sourceData } = useQuery(
    getChoreSource,
    { slug: safeSlug },
    { enabled: Boolean(safeSlug), retry: false },
  );

  const [pending, setPending] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  if (!safeSlug) {
    return (
      <Frame>
        <section className="mx-auto max-w-[860px] px-8 py-20 text-center">
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

  const fm = (data?.frontmatter ?? {}) as Record<string, unknown>;
  const body = String(data?.body ?? "");
  const name = String(fm.name ?? safeSlug);
  const description = String(
    fm.user_facing_description ?? fm.description ?? "",
  );
  const cadence = String(
    fm.schedule_human ??
      fm.schedule_cron_human ??
      fm.schedule_cron ??
      "—",
  );
  const status = String(fm.status ?? "active").toLowerCase();
  const paused = status === "paused";
  const lastRun = fmtTime(fm.last_run_at);
  const nextRun = fmtTime(fm.next_run_at);
  const runLog = parseRunLog(body);
  const source = String(sourceData?.source ?? "");

  async function withPending(action: string, fn: () => Promise<unknown>) {
    setPending(action);
    try {
      await fn();
      await refetch();
    } catch (e) {
      console.error(`${action} failed`, e);
    } finally {
      setPending(null);
    }
  }

  return (
    <Frame>
      <section className="mx-auto max-w-[1080px] px-8 py-12">
        <Link
          to="/chores"
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--brass)" }}
        >
          ← All chores
        </Link>

        {isLoading && !data ? (
          <p
            className="font-body italic text-[16px] mt-8"
            style={{ color: "var(--marginalia)" }}
          >
            Reading the chore…
          </p>
        ) : (
          <>
            <h1 className="font-display text-5xl tracking-tight mt-4 mb-3">
              {name}
              {paused && (
                <span
                  className="font-display italic text-2xl ml-3"
                  style={{ color: "var(--marginalia)" }}
                >
                  (paused)
                </span>
              )}
            </h1>

            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-10"
              style={{ color: "var(--brass)" }}
            >
              {cadence} · last {lastRun} · next {nextRun}
            </div>

            <div className="grid md:grid-cols-[1fr_320px] gap-12 items-start border-t border-rule pt-8">
              <div className="space-y-8">
                {description && (
                  <section>
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
                      style={{ color: "var(--brass)" }}
                    >
                      What this is
                    </div>
                    <p
                      className="font-body text-[17px] leading-[1.6] max-w-[64ch] border-l pl-4"
                      style={{ borderColor: "var(--brass)" }}
                    >
                      {description}
                    </p>
                  </section>
                )}

                <section>
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
                    style={{ color: "var(--brass)" }}
                  >
                    Run log
                  </div>
                  {runLog.length === 0 ? (
                    <p
                      className="font-body italic text-[14px]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      No runs yet.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {runLog.slice(0, 30).map((r, i) => (
                        <li
                          key={`${r.timestamp}-${i}`}
                          className="font-mono text-[12px] grid grid-cols-[170px_1fr] gap-3 items-baseline border-b border-rule py-2"
                        >
                          <span style={{ color: "var(--marginalia)" }}>
                            {r.timestamp}
                          </span>
                          <span className="font-body text-[14px]">
                            {r.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {source && (
                  <section>
                    <button
                      onClick={() => setShowSource((s) => !s)}
                      className="font-mono text-[10px] uppercase tracking-[0.22em]"
                      style={{ color: "var(--brass)" }}
                    >
                      {showSource ? "▾ Hide source" : "▸ Show source"}
                    </button>
                    {showSource && (
                      <pre
                        className="mt-3 border border-rule p-4 font-mono text-[11px] leading-[1.55] overflow-auto"
                        style={{ maxHeight: 480 }}
                      >
                        {source}
                      </pre>
                    )}
                  </section>
                )}
              </div>

              <aside className="border border-rule p-5 space-y-4">
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.22em]"
                  style={{ color: "var(--brass)" }}
                >
                  Actions
                </div>
                <div className="flex flex-col gap-3">
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
                    className="btn-ghost text-left"
                  >
                    {pending === "pause" || pending === "resume"
                      ? "…"
                      : paused
                        ? "Resume"
                        : "Pause"}
                  </button>
                  <button
                    onClick={() =>
                      withPending("trigger", () =>
                        triggerChore({ slug: safeSlug }),
                      )
                    }
                    disabled={pending !== null}
                    className="btn-brass text-left"
                  >
                    {pending === "trigger" ? "…" : "Run now"}
                  </button>
                  <button
                    onClick={() => {
                      if (!confirm(`Delete chore "${name}"?`)) return;
                      withPending("delete", () =>
                        deleteChore({ slug: safeSlug }),
                      );
                    }}
                    disabled={pending !== null}
                    className="btn-link text-left"
                  >
                    {pending === "delete" ? "…" : "Delete"}
                  </button>
                </div>
              </aside>
            </div>
          </>
        )}
      </section>
    </Frame>
  );
}
