// ChoresPage — recurring workflows, restyled (#862).
//
// Reads getChores; displays one row per chore with cadence + last/next +
// description. Inline expand reveals description body + Pause/Resume/
// Delete + a "Run now" trigger. The legacy /dashboard/tasks page redirects
// here.
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useQuery,
  getChores,
  pauseChore,
  resumeChore,
  triggerChore,
  deleteChore,
  createVaultRecord,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

interface ChoreRow {
  slug: string;
  name: string;
  cadence: string;
  last: string;
  next: string;
  description: string;
  paused: boolean;
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

function pickRows(data: any): ChoreRow[] {
  const arr: any[] = Array.isArray(data)
    ? data
    : (data?.chores ?? data?.results ?? data?.items ?? []);
  return arr.map((c) => {
    const fm = c?.frontmatter ?? c ?? {};
    const slug = String(c?.slug ?? c?.id ?? fm?.slug ?? fm?.name ?? "");
    const name = String(c?.name ?? fm?.name ?? slug);
    const cadence = String(
      c?.schedule_cron_human ??
        c?.schedule_human ??
        fm?.schedule_human ??
        c?.cadence ??
        fm?.schedule_cron ??
        c?.schedule_cron ??
        "—",
    );
    const last = fmtTime(c?.last_run ?? c?.last_run_at ?? fm?.last_run_at);
    const next = fmtTime(
      c?.next_run ?? c?.next_run_at ?? fm?.next_run_at ?? "",
    );
    const description = String(
      c?.user_facing_description ??
        c?.description ??
        fm?.user_facing_description ??
        fm?.description ??
        "",
    );
    const paused =
      String(c?.status ?? fm?.status ?? "").toLowerCase() === "paused";
    return { slug, name, cadence, last, next, description, paused };
  });
}

export default function ChoresPage() {
  const { data, refetch } = useQuery(getChores, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const chores = pickRows(data);

  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  async function togglePause(c: ChoreRow) {
    setPending(c.slug);
    try {
      if (c.paused) await resumeChore({ slug: c.slug });
      else await pauseChore({ slug: c.slug });
      await refetch();
    } catch (e) {
      console.error("toggle pause failed", e);
    } finally {
      setPending(null);
    }
  }

  async function runNow(c: ChoreRow) {
    setPending(c.slug);
    try {
      await triggerChore({ slug: c.slug });
      await refetch();
    } catch (e) {
      console.error("trigger failed", e);
    } finally {
      setPending(null);
    }
  }

  async function remove(c: ChoreRow) {
    if (!confirm(`Delete chore "${c.name}"? Its schedule stops; the run history is preserved.`)) {
      return;
    }
    setPending(c.slug);
    try {
      await deleteChore({ slug: c.slug });
      await refetch();
    } catch (e) {
      console.error("delete failed", e);
    } finally {
      setPending(null);
    }
  }

  async function submitNew() {
    const text = draft.trim();
    if (!text) return;
    try {
      // Drop the request into the triage pipe; the curator picks it up
      // and passes it to the chore-generator workflow.
      await createVaultRecord({
        type: "triage",
        name: `Chore request — ${new Date().toISOString().slice(0, 10)} — ${text.slice(0, 60)}`,
        description: text,
        fields: { intent: "chore_request" },
      });
      setDraft("");
      setAdding(false);
    } catch (e) {
      console.error("submit chore request failed", e);
    }
  }

  return (
    <Frame>
      <section className="mx-auto max-w-[1080px] px-8 py-12">
        <div className="flex items-baseline justify-between mb-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            Chores
          </div>
          <button onClick={() => setAdding(true)} className="btn-ghost">
            + New chore
          </button>
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-10">
          What Alfred runs on a schedule.
        </h1>

        {adding && (
          <div className="border border-rule p-5 mb-6">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
              style={{ color: "var(--marginalia)" }}
            >
              Tell Alfred what you'd like done, and how often.
            </div>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNew();
                if (e.key === "Escape") {
                  setAdding(false);
                  setDraft("");
                }
              }}
              placeholder="e.g. Remind me to ring my sister on Sunday evenings"
              className="w-full bg-transparent outline-none border-b font-display italic text-[20px] pb-2"
              style={{ borderColor: "var(--brass)" }}
            />
            <div className="flex gap-2 mt-4">
              <button
                onClick={submitNew}
                className="btn-brass"
                style={{ fontSize: "1rem" }}
              >
                Send to Alfred
              </button>
              <button
                onClick={() => {
                  setAdding(false);
                  setDraft("");
                }}
                className="btn-ghost"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {chores.length === 0 ? (
          <p
            className="font-body italic text-[16px]"
            style={{ color: "var(--marginalia)" }}
          >
            No chores yet. Tell me what you'd like done on a schedule and
            I'll set it up.
          </p>
        ) : (
          <ul className="border-t border-rule">
            {chores.map((c) => {
              const isOpen = open === c.slug;
              return (
                <li key={c.slug} className="border-b border-rule">
                  <div className="grid grid-cols-[1fr_220px_180px_24px] gap-6 py-5 items-baseline">
                    <Link
                      to={`/chores/${encodeURIComponent(c.slug)}`}
                      className="font-display text-[22px]"
                      style={{ opacity: c.paused ? 0.5 : 1, color: "var(--ink)" }}
                    >
                      {c.name}
                      {c.paused ? " (paused)" : ""}
                    </Link>
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.22em]"
                      style={{ color: "var(--brass)" }}
                    >
                      {c.cadence}
                    </span>
                    <span
                      className="font-mono text-[11px]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      last {c.last} · next {c.next}
                    </span>
                    <button
                      onClick={() => setOpen(isOpen ? null : c.slug)}
                      className="text-right"
                      style={{ color: "var(--brass)" }}
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                  </div>
                  {isOpen && (
                    <div className="pb-6 pr-12">
                      {c.description && (
                        <p
                          className="font-body text-[16px] leading-[1.6] border-l pl-4 mb-4"
                          style={{
                            borderColor: "var(--brass)",
                            color: "var(--ink)",
                          }}
                        >
                          {c.description}
                        </p>
                      )}
                      <div className="flex gap-1 items-baseline">
                        <button
                          onClick={() => togglePause(c)}
                          disabled={pending === c.slug}
                          className="btn-link"
                        >
                          {c.paused ? "Resume" : "Pause"}
                        </button>
                        <button
                          onClick={() => runNow(c)}
                          disabled={pending === c.slug}
                          className="btn-link"
                        >
                          Run now
                        </button>
                        <Link
                          to={`/chores/${encodeURIComponent(c.slug)}`}
                          className="btn-link"
                        >
                          Open
                        </Link>
                        <button
                          onClick={() => remove(c)}
                          disabled={pending === c.slug}
                          className="btn-link"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Frame>
  );
}
