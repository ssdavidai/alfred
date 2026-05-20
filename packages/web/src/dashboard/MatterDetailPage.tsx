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
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  useQuery,
  getMatterDetail,
  getVaultRecord,
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

// Phase I: confidence-pill formatter + colour bands.
function ConfidencePill({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color =
    confidence >= 0.85
      ? "#2f6f4f"
      : confidence >= 0.6
        ? "#b48a3c"
        : "var(--marginalia)";
  return (
    <span
      className="font-mono text-[10px] uppercase tracking-[0.18em] py-0.5 px-1.5 border"
      style={{ color, borderColor: color }}
    >
      {pct}%
    </span>
  );
}

function truncateLine(s: string, limit = 90): string {
  const flat = (s || "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit - 1).trimEnd() + "…";
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
  const navigate = useNavigate();
  // History-aware back: return to wherever the principal came from (e.g.
  // /household during onboarding), falling back to the matters index on a
  // direct load. The back link was hardcoded to /matters and dropped the
  // /household entry path (FAILURE-MODES web bug #7).
  const goBack = () =>
    window.history.length > 1 ? navigate(-1) : navigate("/matters");
  const backLinkStyle = {
    color: "var(--brass)",
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
  } as const;
  // Phase I: expand-in-place for state_change rows. Tracks the timeline
  // entry id (or composite key fallback) of the currently-open row.
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);

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
          <button
            onClick={goBack}
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={backLinkStyle}
          >
            ← Back
          </button>
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
        <button
          onClick={goBack}
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={backLinkStyle}
        >
          ← Back
        </button>

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
                  const sc = row.state_change;
                  const rowKey =
                    sc?.id || `${row.path}-${row.when}-${i}-${row.kind}`;
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
                  // Phase I: state_change rows render an inline summary
                  // (source · confidence pill · reason) and click to
                  // expand into a diff panel below the row.
                  const expanded = isStateChange && expandedRowKey === rowKey;
                  const source = sc?.source ?? "";
                  const reason = sc?.reason ?? "";
                  const confidence =
                    typeof sc?.confidence === "number" ? sc.confidence : 1.0;
                  return (
                    <li
                      key={rowKey}
                      className="py-3 border-b border-rule"
                    >
                      <div
                        className="grid grid-cols-[110px_1fr_80px] gap-4 items-baseline"
                        style={isStateChange ? { cursor: "pointer" } : undefined}
                        onClick={() => {
                          if (!isStateChange) return;
                          setExpandedRowKey(expanded ? null : rowKey);
                        }}
                      >
                        <span
                          className="font-mono text-[11px]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {fmtTimelineWhen(row.when)}
                        </span>
                        <span className="font-body text-[16px] leading-[1.5]">
                          {/* Phase E: briefing-sourced state changes
                              carry a slot eyebrow + click-through to
                              the briefing feed. Phase I expands the
                              other state_change sources (steward,
                              nightly_narrative, …) into the inline
                              summary line below. */}
                          {eyebrow && (
                            <div
                              className="font-mono text-[9px] uppercase tracking-[0.22em] mb-1"
                              style={{ color: "var(--brass)" }}
                            >
                              {briefingRef ? (
                                <Link
                                  to={`/briefings#${briefingRef.slugDate}`}
                                  style={{ color: "var(--brass)" }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {eyebrow} →
                                </Link>
                              ) : (
                                eyebrow
                              )}
                            </div>
                          )}
                          {isStateChange ? (
                            <div className="flex items-baseline gap-2 flex-wrap">
                              {/* Phase I marker — filled square in brass */}
                              <span
                                aria-hidden="true"
                                style={{
                                  display: "inline-block",
                                  width: 8,
                                  height: 8,
                                  background: "var(--brass)",
                                  marginRight: 2,
                                  transform: "translateY(1px)",
                                }}
                              />
                              {source && (
                                <code
                                  className="font-mono text-[12px]"
                                  style={{ color: "var(--brass)" }}
                                >
                                  {source}
                                </code>
                              )}
                              <ConfidencePill confidence={confidence} />
                              {reason && (
                                <span
                                  className="font-body text-[15px] leading-[1.5]"
                                  style={{ color: "var(--ink)" }}
                                >
                                  · {truncateLine(reason, 110)}
                                </span>
                              )}
                            </div>
                          ) : row.path ? (
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
                          {isStateChange ? (expanded ? "▾" : kindLabel) : kindLabel}
                        </span>
                      </div>
                      {expanded && sc && (
                        <StateChangeExpandedPanel
                          state_change={sc}
                          mode={sc.mode}
                        />
                      )}
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

// ---------------------------------------------------------------------------
// Phase I (#897, spec §11.2): inline expansion panel for state_change rows.
//
// Reads the full audit record at `state_change.audit_record` via
// getVaultRecord (vault PATCH/GET). The audit record carries:
//   - changes: per-field { from, to }
//   - undo_recipe.expires_at — drives Undo button visibility
//   - body — the full reason markdown (timeline only carries the truncated
//     1-line summary)
//
// The Undo button is rendered iff:
//   - mode === "live" (shadow audits didn't move state)
//   - undo_recipe.expires_at > now (7-day window)
//
// For Phase I we surface the Undo button but the actual wire is a follow-up:
// ctrl-api does not yet expose a generic state-change undo endpoint (the
// existing /api/v1/steward/undo/:action_id is steward-specific). Clicking
// the button surfaces an informational message; the wire ships in Phase J.
// ---------------------------------------------------------------------------

interface StateChangePanelProps {
  state_change: StateChangeDetail;
  mode: "shadow" | "live" | undefined;
}

function StateChangeExpandedPanel({ state_change, mode }: StateChangePanelProps) {
  const auditPath = state_change.audit_record ?? "";
  const { data: auditData, isLoading: auditLoading, error: auditError } =
    useQuery(
      getVaultRecord,
      { path: auditPath },
      { enabled: Boolean(auditPath), retry: false },
    );

  const audit = (auditData ?? null) as
    | { frontmatter?: Record<string, unknown>; body?: string; content?: string }
    | null;
  const fm = (audit?.frontmatter ?? {}) as Record<string, unknown>;
  const fullChanges = (fm.changes ?? state_change.changes ?? {}) as Record<
    string,
    { from?: unknown; to?: unknown }
  >;
  const undoRecipe = (fm.undo_recipe ?? null) as
    | { expires_at?: string; vault_patch?: { revert_fields?: Record<string, unknown> } }
    | null;
  const expiresAtRaw =
    typeof undoRecipe?.expires_at === "string" ? undoRecipe.expires_at : null;
  const expiresMs = expiresAtRaw ? Date.parse(expiresAtRaw) : NaN;
  const undoExpired = !Number.isFinite(expiresMs) || Date.now() >= expiresMs;
  const undoEligible = mode === "live" && !undoExpired && undoRecipe != null;
  const auditBody = String(audit?.body ?? audit?.content ?? "").trim();
  // Strip any frontmatter that the record endpoint returned in `body`.
  const reasonBody = auditBody.replace(/^---[\s\S]*?---\s*/, "").trim();

  return (
    <div
      className="mt-3 ml-[110px] pl-4 border-l"
      style={{ borderColor: "var(--brass)" }}
    >
      {auditLoading && !audit ? (
        <p
          className="font-body italic text-[14px]"
          style={{ color: "var(--marginalia)" }}
        >
          Reading audit record…
        </p>
      ) : auditError ? (
        <p
          className="font-body italic text-[14px]"
          style={{ color: "var(--marginalia)" }}
        >
          Audit record not available ({auditPath}).
        </p>
      ) : (
        <>
          {/* Per-field diff */}
          {Object.keys(fullChanges).length > 0 && (
            <div className="mb-4">
              <div
                className="font-mono text-[9px] uppercase tracking-[0.22em] mb-2"
                style={{ color: "var(--marginalia)" }}
              >
                Changes
              </div>
              <ul className="space-y-3">
                {Object.entries(fullChanges).map(([field, change]) => {
                  const fromRaw =
                    (change as any)?.from ?? (change as any)?.prior ?? null;
                  const toRaw =
                    (change as any)?.to ?? (change as any)?.new ?? null;
                  return (
                    <li key={field}>
                      <code
                        className="font-mono text-[11px] uppercase tracking-[0.18em]"
                        style={{ color: "var(--brass)" }}
                      >
                        {field}
                      </code>
                      <div className="mt-1 grid grid-cols-[60px_1fr] gap-x-3 gap-y-1 items-baseline">
                        <span
                          className="font-mono text-[10px] uppercase tracking-[0.2em]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          before
                        </span>
                        <span
                          className="font-body text-[14px] leading-[1.5]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {fmtDiffValue(fromRaw)}
                        </span>
                        <span
                          className="font-mono text-[10px] uppercase tracking-[0.2em]"
                          style={{ color: "var(--brass)" }}
                        >
                          after
                        </span>
                        <span
                          className="font-body text-[14px] leading-[1.5]"
                          style={{ color: "var(--ink)" }}
                        >
                          {fmtDiffValue(toRaw)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Reason markdown */}
          {(state_change.reason || reasonBody) && (
            <div className="mb-4">
              <div
                className="font-mono text-[9px] uppercase tracking-[0.22em] mb-2"
                style={{ color: "var(--marginalia)" }}
              >
                Reason
              </div>
              <Markdown
                source={reasonBody || state_change.reason || ""}
                useLiveResolver={false}
              />
            </div>
          )}

          {/* Undo row */}
          <div className="flex items-baseline gap-4 pt-2">
            <button
              type="button"
              disabled={!undoEligible}
              onClick={() => {
                // Phase I scope: undo wire is a follow-up. The audit record
                // already carries the undo_recipe; ctrl-api just needs a
                // generic endpoint (existing /api/v1/steward/undo is
                // steward-specific). Surface the limitation honestly.
                window.alert(
                  "Undo for non-Steward state changes is not yet wired. " +
                    "The audit record carries the recipe; the endpoint ships " +
                    "as a Phase J follow-up. Manually revert via /vault for now.",
                );
              }}
              className="btn-instruction"
              style={{
                fontSize: 14,
                color: undoEligible ? "var(--brass)" : "var(--marginalia)",
                borderBottomColor: undoEligible ? "var(--brass)" : "transparent",
              }}
              title={
                undoEligible
                  ? "Revert this state change (Phase I — placeholder)"
                  : expiresAtRaw
                    ? `Undo window expired ${new Date(expiresAtRaw).toLocaleDateString()}`
                    : "Undo not available (shadow mode or no undo recipe)"
              }
            >
              Undo
            </button>
            {mode === "shadow" && (
              <span
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                Shadow — no state was mutated
              </span>
            )}
            {auditPath && (
              <Link
                to={`/vault?slug=${encodeURIComponent(auditPath.replace(/\.md$/, ""))}`}
                className="font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ color: "var(--marginalia)" }}
              >
                View audit record →
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function fmtDiffValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") {
    const s = v.trim();
    return s.length > 400 ? s.slice(0, 397) + "…" : s;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
