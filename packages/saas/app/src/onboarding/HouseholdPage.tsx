// /household — the editor seam after the first brief (#854).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/household.tsx but wired
// to live tenant data instead of the redesign's localStorage `getPrincipal()`
// store:
//
//   • Standing rules ← getWorkspaceFile("RULES.md") + updateWorkspaceFile
//   • Chores ← getChores / pauseChore / resumeChore / deleteChore
//   • Matters ← getMattersIndex (M4 #859)

import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  useQuery,
  getWorkspaceFile,
  updateWorkspaceFile,
  getChores,
  pauseChore,
  resumeChore,
  deleteChore,
  getMattersIndex,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

// ---------------------------------------------------------------------------
// Section frame
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="border-b border-rule pb-3 mb-6">
        <h2 className="font-display text-3xl italic">{title}</h2>
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Standing rules — backed by RULES.md
//
// We treat each non-empty line of RULES.md as one "rule" entry. Edits, line
// adds, and removals are serialised back to the file with a single
// updateWorkspaceFile call. This matches how the legacy AGENTS/SOUL editors
// already operate (whole-file replace; no patch).
// ---------------------------------------------------------------------------

function RulesSection() {
  const { data, isLoading, refetch } = useQuery(
    getWorkspaceFile,
    { filename: "RULES.md" },
    { refetchInterval: false, retry: false },
  );

  const initial = ((data as any)?.content ?? "") as string;
  const [rules, setRules] = useState<string[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [newRule, setNewRule] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (seeded) return;
    if (data === undefined) return; // still loading
    const parsed = parseRules(initial);
    setRules(parsed);
    setSeeded(true);
  }, [data, initial, seeded]);

  const persist = async (next: string[]) => {
    setSaving(true);
    try {
      await updateWorkspaceFile({
        filename: "RULES.md",
        content: serializeRules(next),
      });
      await refetch();
    } catch (err) {
      console.error("updateWorkspaceFile(RULES.md) failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const addRule = async () => {
    const trimmed = newRule.trim();
    if (!trimmed) return;
    const next = [...rules, trimmed];
    setRules(next);
    setNewRule("");
    await persist(next);
  };

  const editRule = async (i: number, text: string) => {
    const next = rules.map((r, idx) => (idx === i ? text : r));
    setRules(next);
    setEditingIdx(null);
    await persist(next);
  };

  const removeRule = async (i: number) => {
    const next = rules.filter((_, idx) => idx !== i);
    setRules(next);
    await persist(next);
  };

  return (
    <Section title="Standing rules">
      {isLoading && !seeded ? (
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          A moment.
        </p>
      ) : (
        <>
          {rules.length === 0 ? (
            <p
              className="font-body italic text-[15px] mb-6"
              style={{ color: "var(--marginalia)" }}
            >
              No standing rules yet. Add one below — Alfred will keep it.
            </p>
          ) : (
            <ul className="border-t border-rule mb-6">
              {rules.map((r, i) => (
                <li key={i} className="border-b border-rule py-4">
                  {editingIdx === i ? (
                    <input
                      autoFocus
                      defaultValue={r}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") editRule(i, draft || r);
                        if (e.key === "Escape") setEditingIdx(null);
                      }}
                      onBlur={() => editRule(i, draft || r)}
                      className="w-full bg-transparent outline-none border-b font-display italic text-[20px] pb-1"
                      style={{ borderColor: "var(--brass)" }}
                    />
                  ) : (
                    <div className="grid grid-cols-[1fr_auto] gap-4 items-baseline">
                      <div className="font-body text-[18px] leading-snug">
                        {r}
                      </div>
                      <div className="font-mono text-[11px] uppercase tracking-[0.22em] flex gap-2 whitespace-nowrap">
                        <button
                          onClick={() => {
                            setEditingIdx(i);
                            setDraft(r);
                          }}
                          className="btn-ghost"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => removeRule(i)}
                          className="btn-ghost"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-[1fr_auto] gap-3 items-baseline">
            <input
              value={newRule}
              onChange={(e) => setNewRule(e.target.value)}
              placeholder="Add a standing rule for Alfred to keep."
              onKeyDown={(e) => {
                if (e.key === "Enter") addRule();
              }}
              className="w-full bg-transparent outline-none border-b font-display italic text-[20px] pb-1"
              style={{ borderColor: "var(--rule)" }}
            />
            <button
              onClick={addRule}
              disabled={saving || !newRule.trim()}
              className="btn-ghost"
              style={{ color: "var(--brass)", borderColor: "var(--brass)" }}
            >
              Add →
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

// Convert RULES.md content (markdown bullet list, with or without intro) to
// a flat array of rule strings. We accept lines that start with `- `, `* `,
// or are non-empty plain text — anything starting with `#` is treated as a
// section heading and ignored.
function parseRules(md: string): string[] {
  const out: string[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (/^[-*]\s+/.test(line)) {
      out.push(line.replace(/^[-*]\s+/, ""));
    } else {
      out.push(line);
    }
  }
  return out;
}

function serializeRules(rules: string[]): string {
  if (rules.length === 0) return "# RULES.md\n";
  const lines = ["# RULES.md", ""];
  for (const r of rules) lines.push(`- ${r}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Chores — live data via getChores / pauseChore / resumeChore / deleteChore
// ---------------------------------------------------------------------------

type Chore = {
  slug: string;
  name?: string;
  title?: string;
  description?: string;
  status?: string;
  schedule?: string;
};

function ChoresSection() {
  const { data, isLoading, refetch } = useQuery(getChores, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const [actioning, setActioning] = useState<string | null>(null);

  // ctrl-api list route returns either {chores: [...]} or just an array.
  const chores: Chore[] = useMemo(() => {
    const d: any = data;
    return Array.isArray(d) ? d : d?.chores ?? d?.results ?? d?.items ?? [];
  }, [data]);

  const handlePause = async (slug: string) => {
    setActioning(`pause-${slug}`);
    try {
      await pauseChore({ slug });
      await refetch();
    } catch (err) {
      console.error("pauseChore failed:", err);
    } finally {
      setActioning(null);
    }
  };

  const handleResume = async (slug: string) => {
    setActioning(`resume-${slug}`);
    try {
      await resumeChore({ slug });
      await refetch();
    } catch (err) {
      console.error("resumeChore failed:", err);
    } finally {
      setActioning(null);
    }
  };

  const handleDelete = async (slug: string) => {
    if (
      !window.confirm(
        `Delete chore "${slug}"? This stops its schedule and marks the record completed. The chore record + run history are preserved.`,
      )
    ) {
      return;
    }
    setActioning(`delete-${slug}`);
    try {
      await deleteChore({ slug });
      await refetch();
    } catch (err) {
      console.error("deleteChore failed:", err);
    } finally {
      setActioning(null);
    }
  };

  return (
    <Section title="Chores">
      {isLoading ? (
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          A moment.
        </p>
      ) : chores.length === 0 ? (
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          No chores yet. Alfred drafts chores from your morning Brief — they
          will appear here once they exist.
        </p>
      ) : (
        <ul className="border-t border-rule">
          {chores.map((c) => {
            const slug = c.slug;
            const label = c.title || c.name || slug;
            const paused = c.status === "paused";
            const busy = actioning?.endsWith(slug) ?? false;
            return (
              <li
                key={slug}
                className="border-b border-rule py-4 grid grid-cols-[1fr_auto] gap-4 items-baseline"
              >
                <div>
                  <div
                    className="font-body text-[18px] leading-snug"
                    style={{
                      color: paused ? "var(--marginalia)" : "var(--ink)",
                      textDecoration: paused ? "line-through" : "none",
                    }}
                  >
                    {label}
                  </div>
                  {c.description && (
                    <div
                      className="font-body italic text-[14px] mt-1"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {c.description}
                    </div>
                  )}
                  {c.schedule && (
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.22em] mt-1"
                      style={{ color: "var(--brass)" }}
                    >
                      {c.schedule}
                    </div>
                  )}
                </div>
                <div className="font-mono text-[11px] uppercase tracking-[0.22em] flex gap-2 whitespace-nowrap">
                  {paused ? (
                    <button
                      disabled={busy}
                      onClick={() => handleResume(slug)}
                      className="btn-ghost"
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => handlePause(slug)}
                      className="btn-ghost"
                    >
                      Pause
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => handleDelete(slug)}
                    className="btn-ghost"
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Matters — live, sourced from getMattersIndex (#859).
// ---------------------------------------------------------------------------

function MattersSection() {
  const { data, isLoading } = useQuery(getMattersIndex);
  const matters = data?.matters ?? [];

  return (
    <Section title="Matters">
      {isLoading ? (
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          Reading the file…
        </p>
      ) : matters.length === 0 ? (
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          Nothing yet. Every long-running concern you ask me to keep will
          gather here.
        </p>
      ) : (
        <ul className="space-y-3">
          {matters.map((m) => (
            <li
              key={m.id}
              className="grid grid-cols-[1fr_auto] gap-4 py-3 border-b border-rule items-baseline"
            >
              <div>
                <Link
                  to={`/matters/${encodeURIComponent(m.id)}`}
                  className="font-body text-[16px]"
                  style={{ color: "var(--ink)" }}
                >
                  {m.name}
                </Link>
                {m.summary && (
                  <p
                    className="font-body text-[14px] mt-1"
                    style={{ color: "var(--marginalia)" }}
                  >
                    {m.summary}
                  </p>
                )}
              </div>
              <span
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--brass)" }}
              >
                {m.counts.conversations + m.counts.decisions + m.counts.tasks + m.counts.drafts}{" "}
                items
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function HouseholdPage() {
  const navigate = useNavigate();

  return (
    <Frame>
      <section className="mx-auto max-w-[920px] px-8 py-14">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
          style={{ color: "var(--brass)" }}
        >
          Confirm
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-12">
          Your household.
        </h1>

        <div className="space-y-16">
          <MattersSection />
          <ChoresSection />
          <RulesSection />
        </div>

        <div className="mt-16 border-t border-rule pt-8 flex items-baseline justify-end">
          <button
            onClick={() => navigate("/preparing")}
            className="btn-brass"
          >
            Go to Today →
          </button>
        </div>
      </section>
    </Frame>
  );
}
