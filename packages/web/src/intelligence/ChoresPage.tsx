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
  displayName: string;
  cadence: string;
  lastRelative: string;
  nextRelative: string;
  description: string;
  paused: boolean;
  category: string;
}

function fmtRelativePast(value: unknown): string {
  if (!value) return "never";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const diff = Date.now() - d.getTime();
  if (diff < 0) return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function fmtRelativeFuture(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return "imminent";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `in ${days}d`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function describeCron(cron: string): string {
  const trimmed = (cron || "").trim();
  if (!trimmed) return "no schedule";
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return trimmed;
  const [min, hour, dom, mon, dow] = parts;
  const dayMap: Record<string, string> = {
    "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed",
    "4": "Thu", "5": "Fri", "6": "Sat", "7": "Sun",
  };
  if (dom === "*" && mon === "*" && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    if (dow === "*") return `Daily ${time} UTC`;
    if (/^\d$/.test(dow) && dayMap[dow]) return `${dayMap[dow]} ${time} UTC`;
  }
  return trimmed;
}

function pickRows(data: any): ChoreRow[] {
  const arr: any[] = Array.isArray(data)
    ? data
    : (data?.chores ?? data?.results ?? data?.items ?? []);
  return arr.map((c) => {
    const fm = c?.frontmatter ?? c ?? {};
    const slug = String(c?.slug ?? c?.id ?? fm?.slug ?? fm?.name ?? "");
    const displayName = String(
      c?.display_name ?? fm?.display_name ?? c?.name ?? fm?.name ?? slug,
    );
    const cadence = describeCron(
      String(c?.schedule ?? fm?.schedule ?? c?.schedule_cron ?? ""),
    );
    const lastRelative = fmtRelativePast(
      c?.last_run ?? c?.last_run_at ?? fm?.last_run_at ?? fm?.last_run,
    );
    const nextRelative = fmtRelativeFuture(
      c?.next_run_at ?? fm?.next_run_at ?? "",
    );
    const description = String(
      c?.display_body ??
        fm?.display_body ??
        c?.user_facing_description ??
        fm?.user_facing_description ??
        c?.description ??
        fm?.description ??
        "",
    );
    const paused =
      String(c?.status ?? fm?.status ?? "").toLowerCase() === "paused";
    const category = String(c?.category ?? fm?.category ?? "").toLowerCase();
    return {
      slug,
      displayName,
      cadence,
      lastRelative,
      nextRelative,
      description,
      paused,
      category,
    };
  });
}

const CATEGORY_LABELS: Record<string, string> = {
  briefing: "Briefing",
  digest: "Digest",
  watch: "Watch",
  "context-build": "Context",
  prefetch: "Prefetch",
  maintenance: "Maintenance",
};

function CategoryChip({ category }: { category: string }) {
  if (!category) return null;
  const label = CATEGORY_LABELS[category] ?? category;
  return (
    <span
      className="inline-block font-mono text-[9px] uppercase tracking-[0.22em] py-0.5 px-1.5 border mr-2"
      style={{ color: "var(--marginalia)", borderColor: "var(--marginalia)" }}
    >
      {label}
    </span>
  );
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
  const [categoryFilter, setCategoryFilter] = useState<string>("");

  // Derive the category facets from the loaded chores so the filter
  // bar only shows categories that actually exist on this tenant.
  const categoriesPresent = Array.from(
    new Set(chores.map((c) => c.category).filter(Boolean)),
  ).sort();
  const filteredChores = categoryFilter
    ? chores.filter((c) => c.category === categoryFilter)
    : chores;

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
    if (!confirm(`Delete chore "${c.displayName}"? Its schedule stops; the run history is preserved.`)) {
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

        {/* Category filter — only render when there are categories
            populated. Defaults to "All"; clicking any chip filters. */}
        {categoriesPresent.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-6">
            <button
              onClick={() => setCategoryFilter("")}
              className="font-mono text-[10px] uppercase tracking-[0.22em] py-1 px-2 border"
              style={{
                color: categoryFilter === "" ? "var(--paper)" : "var(--brass)",
                background: categoryFilter === "" ? "var(--brass)" : "transparent",
                borderColor: "var(--brass)",
              }}
            >
              All ({chores.length})
            </button>
            {categoriesPresent.map((cat) => {
              const count = chores.filter((c) => c.category === cat).length;
              const active = categoryFilter === cat;
              return (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(active ? "" : cat)}
                  className="font-mono text-[10px] uppercase tracking-[0.22em] py-1 px-2 border"
                  style={{
                    color: active ? "var(--paper)" : "var(--brass)",
                    background: active ? "var(--brass)" : "transparent",
                    borderColor: "var(--brass)",
                  }}
                >
                  {CATEGORY_LABELS[cat] ?? cat} ({count})
                </button>
              );
            })}
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
        ) : filteredChores.length === 0 ? (
          <p
            className="font-body italic text-[16px]"
            style={{ color: "var(--marginalia)" }}
          >
            No chores in this category.
          </p>
        ) : (
          <ul className="border-t border-rule">
            {filteredChores.map((c) => {
              const isOpen = open === c.slug;
              return (
                <li key={c.slug} className="border-b border-rule">
                  <div className="grid grid-cols-[1fr_180px_160px_24px] gap-6 py-5 items-baseline">
                    <div>
                      <CategoryChip category={c.category} />
                      <Link
                        to={`/chores/${encodeURIComponent(c.slug)}`}
                        className="font-display text-[22px]"
                        style={{ opacity: c.paused ? 0.5 : 1, color: "var(--ink)" }}
                      >
                        {c.displayName}
                        {c.paused ? " (paused)" : ""}
                      </Link>
                    </div>
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
                      last {c.lastRelative}
                      {!c.paused && c.nextRelative !== "—" && ` · ${c.nextRelative}`}
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
                      {c.description ? (
                        <p
                          className="font-body text-[16px] leading-[1.6] border-l pl-4 mb-4"
                          style={{
                            borderColor: "var(--brass)",
                            color: "var(--ink)",
                          }}
                        >
                          {c.description}
                        </p>
                      ) : (
                        <p
                          className="font-body italic text-[15px] leading-[1.6] border-l pl-4 mb-4"
                          style={{
                            borderColor: "var(--marginalia)",
                            color: "var(--marginalia)",
                          }}
                        >
                          No description yet.
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
