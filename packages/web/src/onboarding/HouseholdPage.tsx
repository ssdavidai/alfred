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
import { rulesViewState } from "./rulesEmptyStateCore";
import {
  parseRulesMarkdown,
  serializeRules,
  SECTION_ORDER,
  SECTION_HEADING,
  type RulesSections,
} from "./rulesEditorCore";

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
// Standing rules — backed by RULES.md (C-OB2 schema).
//
// Lane II's onboarding pipeline composes RULES.md as 4 sections (sovereignty
// / household / communication / decision). The editor parses that body via
// `rulesEditorCore.parseRulesMarkdown`, renders one editable group per
// section, and on "Save changes" re-serializes via `serializeRules` and
// writes through `updateWorkspaceFile` — preserving the rest of the vault
// record (frontmatter is handled by the ctrl-api workspace endpoint).
// ---------------------------------------------------------------------------

const SECTION_PLACEHOLDER: Record<keyof RulesSections, string> = {
  sovereignty: "Add a personal sovereignty rule.",
  household: "Add a household rule.",
  communication: "Add a communication rule.",
  decision: "Add a decision rule.",
};

function emptySections(): RulesSections {
  return { sovereignty: [], household: [], communication: [], decision: [] };
}

function RulesSection() {
  const { data, isLoading, isError, error, refetch } = useQuery(
    getWorkspaceFile,
    { filename: "RULES.md" },
    { refetchInterval: false, retry: false },
  );

  const initial = ((data as any)?.content ?? "") as string;
  const [sections, setSections] = useState<RulesSections>(emptySections);
  const [drafts, setDrafts] = useState<Record<keyof RulesSections, string>>({
    sovereignty: "",
    household: "",
    communication: "",
    decision: "",
  });
  const [seeded, setSeeded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // C-OB2 — on a fresh tenant RULES.md doesn't exist yet (the onboarding
  // pipeline writes it after the first brief). A 404 from getWorkspaceFile
  // is the EXPECTED absence, not a fetch failure — render the "still
  // composing" copy instead of the generic "couldn't load — Retry" message.
  const view = rulesViewState({ data, isLoading, isError, error, seeded });

  useEffect(() => {
    if (seeded) return;
    if (data === undefined) return; // still loading
    setSections(parseRulesMarkdown(initial));
    setSeeded(true);
  }, [data, initial, seeded]);

  const updateSection = (key: keyof RulesSections, next: string[]) => {
    setSections((prev) => ({ ...prev, [key]: next }));
    setDirty(true);
    setSavedAt(null);
  };

  const editRule = (key: keyof RulesSections, idx: number, text: string) => {
    updateSection(
      key,
      sections[key].map((r, i) => (i === idx ? text : r)),
    );
  };

  const removeRule = (key: keyof RulesSections, idx: number) => {
    updateSection(
      key,
      sections[key].filter((_, i) => i !== idx),
    );
  };

  const addRule = (key: keyof RulesSections) => {
    const text = drafts[key].trim();
    if (!text) return;
    updateSection(key, [...sections[key], text]);
    setDrafts((prev) => ({ ...prev, [key]: "" }));
  };

  const saveAll = async () => {
    setSaving(true);
    try {
      // The ctrl-api workspace endpoint preserves the rest of the vault
      // record (subtype, created, created_by, updated_at) — we only replace
      // the body. `serializeRules` always emits the canonical `# Standing
      // Rules` header + the populated sections in canonical order.
      await updateWorkspaceFile({
        filename: "RULES.md",
        content: serializeRules(sections),
      });
      await refetch();
      setDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      console.error("updateWorkspaceFile(RULES.md) failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const title = view === "composing" ? "Standing rules — composing" : "Standing rules";

  return (
    <Section title={title}>
      {view === "composing" ? (
        // C-OB2 — RULES.md absent (404). The onboarding pipeline composes it
        // after the first brief lands. Don't render the "couldn't load —
        // Retry" message: the absence is expected, not a fetch failure.
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          Alfred is still composing your standing rules from the facts you
          confirmed. They'll appear here once your first brief is ready.
        </p>
      ) : view === "error" ? (
        // Fetch failed (retry:false, so it won't self-recover) — show an
        // explicit retry instead of hanging on "A moment." or rendering an
        // empty list that reads as "no rules" (FAILURE-MODES web bug #5).
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          Alfred couldn't load your standing rules just now.{" "}
          <button
            onClick={() => refetch()}
            className="underline"
            style={{
              color: "var(--brass)",
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </p>
      ) : view === "loading" ? (
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          A moment.
        </p>
      ) : (
        <div className="space-y-10">
          {SECTION_ORDER.map((key) => {
            const items = sections[key];
            const heading = SECTION_HEADING[key];
            return (
              <div key={key}>
                <h3
                  className="font-mono text-[11px] uppercase tracking-[0.22em] mb-3"
                  style={{ color: "var(--brass)" }}
                >
                  {heading}
                </h3>
                {items.length === 0 ? (
                  <p
                    className="font-body italic text-[14px] mb-3"
                    style={{ color: "var(--marginalia)" }}
                  >
                    No rules in this section yet. Add one below.
                  </p>
                ) : (
                  <ul className="border-t border-rule mb-3">
                    {items.map((rule, idx) => (
                      <li
                        key={idx}
                        className="border-b border-rule py-3 grid grid-cols-[1fr_auto] gap-3 items-baseline"
                      >
                        <input
                          value={rule}
                          onChange={(e) => editRule(key, idx, e.target.value)}
                          className="w-full bg-transparent outline-none font-body text-[16px] leading-snug"
                          style={{ color: "var(--ink)" }}
                        />
                        <button
                          onClick={() => removeRule(key, idx)}
                          className="btn-ghost font-mono text-[11px] uppercase tracking-[0.22em]"
                          disabled={saving}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="grid grid-cols-[1fr_auto] gap-3 items-baseline">
                  <input
                    value={drafts[key]}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    placeholder={SECTION_PLACEHOLDER[key]}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addRule(key);
                    }}
                    className="w-full bg-transparent outline-none border-b font-display italic text-[18px] pb-1"
                    style={{ borderColor: "var(--rule)" }}
                  />
                  <button
                    onClick={() => addRule(key)}
                    disabled={saving || !drafts[key].trim()}
                    className="btn-ghost font-mono text-[11px] uppercase tracking-[0.22em]"
                    style={{ color: "var(--brass)", borderColor: "var(--brass)" }}
                  >
                    Add rule →
                  </button>
                </div>
              </div>
            );
          })}

          <div className="border-t border-rule pt-4 flex items-baseline justify-between">
            <span
              className="font-body italic text-[13px]"
              style={{ color: "var(--marginalia)" }}
            >
              {saving
                ? "Saving…"
                : dirty
                  ? "Unsaved changes."
                  : savedAt
                    ? "Saved."
                    : ""}
            </span>
            <button
              onClick={saveAll}
              disabled={saving || !dirty}
              className="btn-brass"
            >
              Save changes
            </button>
          </div>
        </div>
      )}
    </Section>
  );
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
