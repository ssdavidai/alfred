// MatterDetailPage — single-matter long view (#859).
//
// Reads getMatterDetail (proxies tenant ctrl-api /api/v1/matters/:id).
// Three columns: about/status/recent decisions on the left, tally
// expandable into vault links on the right. "Ask Alfred to edit" hooks
// into createVaultRecord with type=triage so the request enters the
// curator pipeline.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useQuery,
  getMatterDetail,
  createVaultRecord,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Markdown } from "../client/components/ab/Markdown";

interface VaultLink {
  title: string;
  path: string;
  date: string;
}

interface RecentDecision {
  date: string;
  label: string;
  outcome: "Handled" | "Held" | "Asked";
  path: string;
}

interface MatterDetail {
  id: string;
  path: string;
  name: string;
  summary: string;
  last: string;
  next: string;
  about: string;
  counts: {
    conversations: number;
    decisions: number;
    tasks: number;
    drafts: number;
  };
  recent_decisions: RecentDecision[];
  vault_by_category: {
    conversations: VaultLink[];
    decisions: VaultLink[];
    tasks: VaultLink[];
    drafts: VaultLink[];
  };
}

function fmtDate(value: string): string {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch {
    return value;
  }
}

export default function MatterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const safeId = id ?? "";
  const { data, isLoading } = useQuery(
    getMatterDetail,
    { id: safeId },
    { enabled: Boolean(safeId) },
  );
  const matter = (data?.matter ?? null) as MatterDetail | null;

  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState("");
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function sendEdit() {
    if (!draft.trim() || !matter) return;
    setSubmitting(true);
    try {
      await createVaultRecord({
        type: "triage",
        name: `Matter edit — ${matter.name} — ${new Date().toISOString().slice(0, 10)}`,
        description: draft,
        fields: { matter: `[[matter/${matter.id}]]` },
      });
      setAsking(false);
      setDraft("");
    } catch (e) {
      console.error("matter edit submit failed", e);
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <Frame>
        <section className="mx-auto max-w-[860px] px-8 py-20">
          <p
            className="font-body italic text-[16px]"
            style={{ color: "var(--marginalia)" }}
          >
            Reading the file…
          </p>
        </section>
      </Frame>
    );
  }

  if (!matter) {
    return (
      <Frame>
        <section className="mx-auto max-w-[860px] px-8 py-20 text-center">
          <p className="font-display italic text-2xl">No such matter.</p>
          <Link
            to="/matters"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            ← Back to matters
          </Link>
        </section>
      </Frame>
    );
  }

  const counts = matter.counts;
  const cats: Array<[
    keyof MatterDetail["counts"],
    keyof MatterDetail["vault_by_category"],
  ]> = [
    ["conversations", "conversations"],
    ["decisions", "decisions"],
    ["tasks", "tasks"],
    ["drafts", "drafts"],
  ];

  return (
    <Frame>
      <section className="mx-auto max-w-[1080px] px-8 py-12">
        <Link
          to="/matters"
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--brass)" }}
        >
          ← All matters
        </Link>
        <h1 className="font-display text-5xl tracking-tight mt-4 mb-3">
          {matter.name}
        </h1>
        {matter.summary && (
          <p
            className="font-body text-[18px] max-w-[60ch] mb-10"
            style={{ color: "var(--marginalia)" }}
          >
            {matter.summary}
          </p>
        )}

        <div className="grid md:grid-cols-[1fr_300px] gap-12 items-start border-t border-rule pt-8">
          <div className="space-y-8">
            {matter.about && (
              <section>
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
                  style={{ color: "var(--brass)" }}
                >
                  What this is
                </div>
                <div className="max-w-[64ch]">
                  <Markdown source={matter.about} useLiveResolver={false} />
                </div>
              </section>
            )}

            <section>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
                style={{ color: "var(--brass)" }}
              >
                How it stands today
              </div>
              <p className="font-body text-[17px]">
                Last activity: {fmtDate(matter.last) || "—"}.
                {matter.next ? <> Next: {matter.next}</> : null}
              </p>
            </section>

            {matter.recent_decisions.length > 0 && (
              <section>
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
                  style={{ color: "var(--brass)" }}
                >
                  Recent decisions
                </div>
                <table className="w-full font-mono text-[12px]">
                  <thead>
                    <tr
                      className="border-y border-rule"
                      style={{ color: "var(--marginalia)" }}
                    >
                      <th className="text-left py-2 uppercase tracking-[0.2em] text-[10px] font-normal">
                        Date
                      </th>
                      <th className="text-left py-2 uppercase tracking-[0.2em] text-[10px] font-normal">
                        Decision
                      </th>
                      <th className="text-right py-2 uppercase tracking-[0.2em] text-[10px] font-normal">
                        Outcome
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {matter.recent_decisions.map((r, i) => (
                      <tr key={`${r.path}-${i}`} className="border-b border-rule">
                        <td
                          className="py-3 pr-3"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {fmtDate(r.date)}
                        </td>
                        <td className="py-3 pr-3 font-body text-[15px]">
                          {r.label}
                        </td>
                        <td
                          className="py-3 text-right font-extrabold"
                          style={{
                            color:
                              r.outcome === "Asked"
                                ? "var(--brass)"
                                : "var(--ink)",
                          }}
                        >
                          {r.outcome}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="font-mono text-[11px] mt-3">
                  <Link to="/decisions" style={{ color: "var(--brass)" }}>
                    See all decisions →
                  </Link>
                </p>
              </section>
            )}

            <section>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
                style={{ color: "var(--brass)" }}
              >
                Ask Alfred to edit
              </div>
              {asking ? (
                <div>
                  <textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="What would you like Alfred to update on this matter?"
                    className="w-full min-h-[100px] bg-transparent outline-none border border-rule p-3 font-body text-[16px]"
                    style={{ borderColor: "var(--brass)" }}
                  />
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={sendEdit}
                      disabled={submitting || !draft.trim()}
                      className="btn-brass"
                      style={{ fontSize: "1rem" }}
                    >
                      {submitting ? "…" : "Send"}
                    </button>
                    <button
                      onClick={() => {
                        setAsking(false);
                        setDraft("");
                      }}
                      className="btn-ghost"
                      disabled={submitting}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setAsking(true)}
                  className="btn-brass"
                  style={{ fontSize: "1rem" }}
                >
                  Ask Alfred to edit →
                </button>
              )}
            </section>
          </div>

          <aside className="border border-rule p-5">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
              style={{ color: "var(--brass)" }}
            >
              Tally
            </div>
            {cats.map(([countKey, catKey]) => {
              const items = matter.vault_by_category[catKey] ?? [];
              const v = counts[countKey];
              const isOpen = openCat === countKey;
              return (
                <div key={countKey} className="border-b border-rule">
                  <button
                    onClick={() => setOpenCat(isOpen ? null : countKey)}
                    className="w-full grid grid-cols-[1fr_auto_auto] gap-3 py-2 font-mono text-[12px] items-baseline text-left"
                  >
                    <span
                      className="uppercase tracking-[0.2em] text-[10px]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {countKey}
                    </span>
                    <span style={{ color: "var(--brass)" }}>{String(v)}</span>
                    <span style={{ color: "var(--marginalia)" }}>
                      {isOpen ? "−" : "+"}
                    </span>
                  </button>
                  {isOpen && items.length > 0 && (
                    <ul className="pb-3 pl-1 space-y-1">
                      {items.slice(0, 12).map((t) => (
                        <li key={t.path}>
                          <Link
                            to={`/vault?slug=${encodeURIComponent(t.path.replace(/\.md$/, ""))}`}
                            className="font-body text-[14px]"
                            style={{ color: "var(--ink)" }}
                          >
                            · {t.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </aside>
        </div>
      </section>
    </Frame>
  );
}
