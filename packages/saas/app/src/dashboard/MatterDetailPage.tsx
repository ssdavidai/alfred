// MatterDetailPage — living-matter detail view (RFC #884).
//
// Reads getMatterDetail (proxies tenant ctrl-api /api/v1/matters/:id with
// frontmatter fallback). Layout is built around the narrative-layer fields
// added in RFC #884: current_state + as_of + timeline + tasks. The old
// "About / How it stands today / counts sidebar" structure has been retired
// — those are subsumed by current_state and the tasks list. The Edit button
// is preserved (it writes a triage record with intent=matter_edit, existing
// pattern).
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useQuery,
  getMatterDetail,
  createVaultRecord,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Markdown } from "../client/components/ab/Markdown";
import { PageOverture } from "../client/components/ab/PageOverture";

type TaskState = "pending" | "in_progress" | "done" | "archived";

// STATE-MUTATION Phase E (#893): `state_change` is a first-class
// timeline kind. The matter's timeline composer in ctrl-api unions
// state-change entries from the matter's `timeline` frontmatter and
// emits them with `kind: "state_change"`. The Phase-E render path
// only recognises briefing-sourced entries (source startsWith
// "briefing."); Phase I adds the deeper render for other sources
// (steward, nightly_narrative, task_closure, etc.).
type TimelineKind =
  | "signal"
  | "task_transition"
  | "action"
  | "state_change";

// ctrl-api shape for kind=state_change rows. Nested under `state_change`
// alongside the flat row fields (when/kind/headline/path) — see
// packages/ctrl/src/api/routes/matters.ts (StateChangeTimelineDetail).
interface StateChangeDetail {
  id?: string;
  source?: string;
  prior_as_of?: string | null;
  observed_window?: {
    start?: string;
    end?: string;
    signals?: number;
    decisions?: number;
    other?: string[];
  };
  changes?: Record<string, unknown>;
  reason?: string;
  confidence?: number;
  mode?: "shadow" | "live";
  audit_record?: string;
}

interface TimelineEntry {
  when: string;
  kind: TimelineKind;
  headline: string;
  path: string;
  // Phase E: populated only for kind=state_change.
  state_change?: StateChangeDetail;
}

interface MatterTask {
  id: string;
  name: string;
  state: TaskState;
  current_state: string | null;
  as_of: string | null;
}

interface MatterDetail {
  id: string;
  path: string;
  name: string;
  // RFC #884 — living narrative fields. Older ctrl-api builds will have
  // these as null/[]; the renderer handles either case.
  current_state: string | null;
  as_of: string | null;
  signal_count_24h: number;
  timeline: TimelineEntry[];
  tasks: MatterTask[];
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

// Phase E: parse the briefing slug-date out of a state_change entry's
// observed_window.other refs (first entry that starts with `briefing/`).
// Returns null when the entry is from a non-briefing source or the ref
// shape doesn't match. The slug-date matches the convention in
// packages/ctrl/src/api/routes/briefings.ts (`<YYYY-MM-DD>-<slot>`).
function parseBriefingSlugDate(entry: TimelineEntry): {
  slugDate: string;
  slot: "morning" | "evening";
} | null {
  const src = entry.state_change?.source ?? "";
  if (!src.startsWith("briefing.")) return null;
  const refs = entry.state_change?.observed_window?.other ?? [];
  for (const raw of refs) {
    if (typeof raw !== "string" || !raw.startsWith("briefing/")) continue;
    const stem = raw.slice("briefing/".length).replace(/\.md$/, "");
    const m = /^(\d{4}-\d{2}-\d{2})-(morning|evening)$/.exec(stem);
    if (m) {
      return { slugDate: stem, slot: m[2] as "morning" | "evening" };
    }
  }
  return null;
}

function briefingEyebrow(entry: TimelineEntry): string | null {
  const src = entry.state_change?.source ?? "";
  if (src === "briefing.morning") return "Briefing · Morning";
  if (src === "briefing.evening") return "Briefing · Evening";
  if (src.startsWith("briefing.")) return "Briefing";
  return null;
}

function deriveStatusPill(tasks: MatterTask[]): {
  label: "Active" | "Waiting" | "Done";
  color: string;
} {
  if (tasks.length === 0) {
    // No tasks at all — treat as "Waiting" by spec (nothing in progress).
    return { label: "Waiting", color: "var(--marginalia)" };
  }
  if (tasks.some((t) => t.state === "in_progress")) {
    return { label: "Active", color: "var(--brass)" };
  }
  if (tasks.every((t) => t.state === "done")) {
    return { label: "Done", color: "var(--marginalia)" };
  }
  if (tasks.every((t) => t.state === "pending")) {
    return { label: "Waiting", color: "var(--marginalia)" };
  }
  // Mixed pending/done/archived — closest meaning is "Waiting".
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
  const [submitting, setSubmitting] = useState(false);
  const [timelineCap, setTimelineCap] = useState(50);

  async function sendEdit() {
    if (!draft.trim() || !matter) return;
    setSubmitting(true);
    try {
      await createVaultRecord({
        type: "triage",
        name: `Matter edit — ${matter.name} — ${new Date().toISOString().slice(0, 10)}`,
        description: draft,
        fields: { matter: `[[matter/${matter.id}]]`, intent: "matter_edit" },
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
        <section className="mx-auto max-w-[860px] px-8 pt-12">
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
        <section className="mx-auto max-w-[860px] px-8 pt-12 pt-20 text-center">
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

  const tasks = Array.isArray(matter.tasks) ? matter.tasks : [];
  const timeline = Array.isArray(matter.timeline) ? matter.timeline : [];
  const statusPill = deriveStatusPill(tasks);
  // Newest-first; the server _should_ already sort, but enforce here so the
  // UI doesn't depend on it.
  const sortedTimeline = [...timeline].sort((a, b) =>
    a.when < b.when ? 1 : a.when > b.when ? -1 : 0,
  );
  const visibleTimeline = sortedTimeline.slice(0, timelineCap);
  const moreToShow = sortedTimeline.length > timelineCap;

  return (
    <Frame>
      <section className="mx-auto max-w-[860px] px-8 pt-12 pb-20">
        <Link
          to="/matters"
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--brass)" }}
        >
          ← All matters
        </Link>

        <div className="mt-4">
          <PageOverture
            eyebrow="Matter"
            title={matter.name}
            meta={statusPill.label}
          />
        </div>

        {/* current_state paragraph + as_of byline */}
        <section className="-mt-6 mb-10">
          <div className="mb-4">
            <StatusPill label={statusPill.label} color={statusPill.color} />
          </div>
          {matter.current_state ? (
            <>
              <div className="max-w-[64ch] font-body text-[18px] leading-[1.6]">
                <Markdown
                  source={matter.current_state}
                  useLiveResolver={false}
                />
              </div>
              {matter.as_of && (
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.22em] mt-4"
                  style={{ color: "var(--brass)" }}
                >
                  As of {fmtAsOf(matter.as_of)}
                </div>
              )}
            </>
          ) : (
            <p
              className="font-display italic text-[18px] max-w-[64ch]"
              style={{ color: "var(--marginalia)" }}
            >
              Alfred has not yet composed a current view for this matter. The
              next nightly run will.
            </p>
          )}
        </section>

        {/* Brass hr — no originX. The earlier version had a transform that
            broke the SVG-ish rule layout; plain hr.gilt renders correctly. */}
        <hr className="gilt mb-12" />

        {/* Timeline section */}
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
              No signals routed to this matter yet.
            </p>
          ) : (
            <>
              <ul>
                {visibleTimeline.map((row, i) => {
                  const isStateChange = row.kind === "state_change";
                  const briefingRef = isStateChange
                    ? parseBriefingSlugDate(row)
                    : null;
                  const eyebrow = isStateChange ? briefingEyebrow(row) : null;
                  const kindLabel =
                    row.kind === "task_transition"
                      ? "task"
                      : row.kind === "state_change"
                        ? "state"
                        : row.kind;
                  return (
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
                        {/* Phase E: briefing-sourced state changes carry
                            a slot eyebrow + click-through to the
                            briefing feed. Other state_change sources
                            (steward, nightly_narrative, …) get the
                            generic "state" tag on the right; Phase I
                            renders them in full. */}
                        {eyebrow && (
                          <div
                            className="font-mono text-[9px] uppercase tracking-[0.22em] mb-1"
                            style={{ color: "var(--brass)" }}
                          >
                            {briefingRef ? (
                              <Link
                                to={`/briefings#${briefingRef.slugDate}`}
                                style={{ color: "var(--brass)" }}
                              >
                                {eyebrow} →
                              </Link>
                            ) : (
                              eyebrow
                            )}
                          </div>
                        )}
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
                        {kindLabel}
                      </span>
                    </li>
                  );
                })}
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

        {/* Tasks section */}
        <section className="mb-14">
          <h2
            className="font-mono text-[10px] uppercase tracking-[0.22em] mb-6"
            style={{ color: "var(--brass)" }}
          >
            Tasks
          </h2>
          {tasks.length === 0 ? (
            <p
              className="font-display italic text-[16px]"
              style={{ color: "var(--marginalia)" }}
            >
              No tasks under this matter yet.
            </p>
          ) : (
            <ul>
              {tasks.map((t) => {
                const stateColor =
                  t.state === "in_progress"
                    ? "var(--brass)"
                    : t.state === "done"
                      ? "var(--marginalia)"
                      : t.state === "archived"
                        ? "var(--marginalia)"
                        : "var(--marginalia)";
                const stateLabel =
                  t.state === "in_progress"
                    ? "Active"
                    : t.state === "done"
                      ? "Done"
                      : t.state === "archived"
                        ? "Archived"
                        : "Pending";
                return (
                  <li
                    key={t.id}
                    className="py-4 border-b border-rule"
                  >
                    <div className="flex items-baseline gap-4 mb-1">
                      <StatusPill label={stateLabel} color={stateColor} />
                      <span
                        className="font-display tracking-tight"
                        style={{ fontSize: 18 }}
                      >
                        {t.name}
                      </span>
                    </div>
                    {t.current_state && (
                      <p
                        className="font-body text-[15px] leading-[1.5] max-w-[64ch] mt-2"
                        style={{ color: "var(--ink)" }}
                      >
                        {t.current_state}
                      </p>
                    )}
                    {t.as_of && (
                      <div
                        className="font-mono text-[10px] uppercase tracking-[0.22em] mt-2"
                        style={{ color: "var(--marginalia)" }}
                      >
                        as of {fmtAsOf(t.as_of)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Edit button — preserved from the previous layout. Writes a
            triage record with intent=matter_edit; the curator pipeline picks
            it up. */}
        <section>
          {asking ? (
            <div>
              <label
                className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
                style={{ color: "var(--brass)" }}
              >
                Ask Alfred to edit
              </label>
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What would you like Alfred to update on this matter?"
                className="w-full min-h-[100px] bg-transparent outline-none border p-3 font-body text-[16px]"
                style={{ borderColor: "var(--brass)" }}
              />
              <div className="flex gap-3 mt-3">
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
                  className="btn-link"
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
      </section>
    </Frame>
  );
}
