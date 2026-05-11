// DeskPage — the canonical home (#855).
//
// Three sections, one screen:
//   1. Decision queue — merge of getNeedsAttention + getPendingApprovals +
//      getRecentJudgments. Top entry is the featured stage; rest live in
//      "Also in queue".
//   2. Backstage — local-only "Do" tray for items the principal wants to
//      handle himself. Lives in component state; survives navigation but
//      not full reload.
//   3. The Record — merged ledger of getActivityFeed + getRecentStewardActions
//      sorted by timestamp. Reversible entries get an Undo button wired to
//      undoStewardAction.
//
// Empty state is the redesign's voice exactly: "Your desk is clear. I'll
// let you know when something arrives."
//
// Action mapping (per spec):
//   needs_attention  → Delegate=dispatch, Defer=skip, Delete=done, Do=local tray
//   approval         → Delegate=approveAction(instructions), Defer=skip-as-noop,
//                      Delete=rejectAction, Do=local tray
//   judgment         → tray-only — these are passive observations, no actions
//                      back on the source record beyond local triage.
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  useQuery,
  getNeedsAttention,
  getPendingApprovals,
  getRecentJudgments,
  getActivityFeed,
  getRecentStewardActions,
  getMatterDetail,
  resolveNeedsAttentionDispatch,
  resolveNeedsAttentionSkip,
  resolveNeedsAttentionDone,
  approveAction,
  rejectAction,
  undoStewardAction,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Seal } from "../client/components/ab/Seal";
import { PageOverture } from "../client/components/ab/PageOverture";
import { fadeUp, stagger } from "../client/lib/motion";

// --------------------------------------------------------------------------
// Decision row — unified shape across the three source queries.
// --------------------------------------------------------------------------

type Source = "needs_attention" | "approval" | "judgment";
type Action = "delegate" | "defer";

interface Decision {
  id: string;        // stable client key
  source: Source;
  recordId: string;  // server-side id (filename stem or vault path)
  headline: string;
  why: string;
  arrived: string;   // ISO or relative
  conf?: number;
  // RFC #884 — when the source record's frontmatter carries a back-reference
  // to a matter, surface the matter id so the featured card can render a
  // contextual callout. Stored as the bare matter id (e.g. "smythson-invoice")
  // — the wikilink / vault-path prefix is stripped.
  matterRef?: string | null;
}

/** Extract a matter id from a frontmatter value. Accepts wikilinks
 *  (`[[matter/foo]]`), bare paths (`matter/foo.md`), or just the stem
 *  (`foo`). Returns null if nothing usable is present. */
function extractMatterId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // [[matter/foo]] or [[matter/foo|alias]] → matter/foo
  const wiki = s.match(/^\[\[\s*([^|\]]+?)\s*(?:\|[^\]]*)?\]\]$/);
  const stripped = (wiki ? wiki[1] : s)
    .replace(/^matter\//, "")
    .replace(/\.md$/, "")
    .trim();
  return stripped || null;
}

function fmtArrived(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  // Strip trailing seconds + Z, keep "MMM dd HH:mm"
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function shortenPath(p: string): string {
  // event/2026/05/10/foo.md → foo
  const stem = p.replace(/\.md$/, "").split("/").pop() ?? p;
  return stem;
}

// --------------------------------------------------------------------------
// Audit row — unified shape across activity + steward actions.
// --------------------------------------------------------------------------

interface AuditRow {
  key: string;
  at: string;       // for sort
  atDisplay: string;
  act: string;
  actionId?: string; // steward action id, when reversible
  reversible: boolean;
}

// --------------------------------------------------------------------------
// Page
// --------------------------------------------------------------------------

export default function DeskPage() {
  const { data: needs } = useQuery(getNeedsAttention);
  const { data: approvals } = useQuery(getPendingApprovals);
  const { data: judgments } = useQuery(getRecentJudgments);
  const { data: activity } = useQuery(getActivityFeed);
  const { data: steward } = useQuery(getRecentStewardActions);

  // Local UI state.
  const [handled, setHandled] = useState<string[]>([]);
  const [tray, setTray] = useState<{ id: string; headline: string }[]>([]);
  const [open, setOpen] = useState<{ id: string; mode: Action } | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);

  const decisions: Decision[] = useMemo(() => {
    const out: Decision[] = [];
    const na = Array.isArray(needs?.records) ? needs?.records : [];
    for (const r of na ?? []) {
      const fm = (r?.frontmatter ?? {}) as Record<string, unknown>;
      const status = String(fm.status ?? "pending");
      if (status !== "pending") continue;
      const id = String(r?.id ?? "");
      if (!id) continue;
      out.push({
        id: `na:${id}`,
        source: "needs_attention",
        recordId: id,
        headline: String(fm.headline ?? fm.subject ?? fm.summary ?? id),
        why: String(fm.decision_reason ?? fm.reason ?? r?.body ?? ""),
        arrived: String(fm.created ?? ""),
        conf: typeof fm.confidence === "number" ? fm.confidence : undefined,
        matterRef: extractMatterId(fm.matter ?? fm.parent_matter),
      });
    }
    const apps = Array.isArray(approvals?.results)
      ? approvals?.results
      : Array.isArray(approvals)
        ? approvals
        : [];
    for (const r of apps ?? []) {
      const fm = (r?.frontmatter ?? {}) as Record<string, unknown>;
      const path = String(r?.path ?? r?.id ?? "");
      if (!path) continue;
      out.push({
        id: `ap:${path}`,
        source: "approval",
        recordId: path,
        headline: String(
          fm.headline ?? fm.summary ?? fm.action ?? r?.name ?? shortenPath(path),
        ),
        why: String(fm.reason ?? fm.description ?? r?.body_preview ?? ""),
        arrived: String(fm.created ?? ""),
        matterRef: extractMatterId(fm.matter ?? fm.parent_matter),
      });
    }
    const ju = Array.isArray(judgments?.results) ? judgments?.results : [];
    for (const r of ju ?? []) {
      const fm = (r?.frontmatter ?? {}) as Record<string, unknown>;
      const path = String(r?.path ?? "");
      if (!path) continue;
      // Only surface judgments that explicitly request attention.
      const status = String(fm.status ?? "");
      if (status && status !== "pending" && status !== "open") continue;
      out.push({
        id: `ju:${path}`,
        source: "judgment",
        recordId: path,
        headline: String(fm.observation ?? fm.summary ?? r?.name ?? shortenPath(path)),
        why: String(fm.reflection ?? fm.reasoning ?? r?.body_preview ?? ""),
        arrived: String(fm.created ?? ""),
        matterRef: extractMatterId(fm.matter ?? fm.parent_matter),
      });
    }
    // Newest first.
    out.sort((a, b) => (a.arrived < b.arrived ? 1 : a.arrived > b.arrived ? -1 : 0));
    return out;
  }, [needs, approvals, judgments]);

  const ledger: AuditRow[] = useMemo(() => {
    const out: AuditRow[] = [];
    const acts = Array.isArray(activity?.results)
      ? activity?.results
      : Array.isArray(activity?.events)
        ? activity?.events
        : Array.isArray(activity)
          ? activity
          : [];
    for (const a of acts ?? []) {
      const at = String(a?.created_at ?? a?.timestamp ?? a?.created ?? "");
      const act = String(
        a?.summary ??
          a?.title ??
          a?.message ??
          a?.event_type ??
          a?.kind ??
          "Activity",
      );
      out.push({
        key: `act:${a?.id ?? at}:${act}`,
        at,
        atDisplay: fmtArrived(at),
        act,
        reversible: false,
      });
    }
    const sw = Array.isArray(steward?.actions)
      ? steward?.actions
      : Array.isArray(steward?.results)
        ? steward?.results
        : Array.isArray(steward)
          ? steward
          : [];
    for (const s of sw ?? []) {
      const at = String(s?.timestamp ?? s?.created ?? s?.created_at ?? "");
      const actionId = String(s?.id ?? s?.action_id ?? "");
      const reversible =
        Boolean(s?.is_reversible ?? s?.reversible ?? false) &&
        !s?.reversed_at &&
        Boolean(actionId);
      out.push({
        key: `sw:${actionId || at}`,
        at,
        atDisplay: fmtArrived(at),
        act: String(
          s?.summary ?? s?.decision ?? s?.target ?? s?.action ?? "Steward action",
        ),
        actionId: actionId || undefined,
        reversible,
      });
    }
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return out.slice(0, 80);
  }, [activity, steward]);

  // ------------------------------------------------------------------------
  // Action dispatch — maps the UI's four buttons to the right tenant op.
  // ------------------------------------------------------------------------

  const remaining = decisions.filter((d) => !handled.includes(d.id));
  const top = remaining[0];
  const rest = remaining.slice(1);

  function markHandled(id: string) {
    setHandled((h) => [...h, id]);
    setOpen(null);
    setDraft("");
    setPending(null);
  }

  async function onDelegate(d: Decision, instructions: string) {
    setPending(d.id);
    try {
      if (d.source === "needs_attention") {
        await resolveNeedsAttentionDispatch({ id: d.recordId, note: instructions });
      } else if (d.source === "approval") {
        await approveAction({ path: d.recordId });
      } else {
        // judgment — no server-side handoff yet, just close it.
      }
      markHandled(d.id);
    } catch (e) {
      console.error("delegate failed", e);
      setPending(null);
    }
  }

  async function onDefer(d: Decision, when: string) {
    setPending(d.id);
    try {
      if (d.source === "needs_attention") {
        await resolveNeedsAttentionSkip({ id: d.recordId, note: when });
      }
      // Approvals + judgments: defer is local-only — clear the row from the
      // queue and let it re-appear on next refresh if still pending.
      markHandled(d.id);
    } catch (e) {
      console.error("defer failed", e);
      setPending(null);
    }
  }

  async function onDelete(d: Decision) {
    setPending(d.id);
    try {
      if (d.source === "needs_attention") {
        await resolveNeedsAttentionDone({ id: d.recordId });
      } else if (d.source === "approval") {
        await rejectAction({ path: d.recordId });
      }
      markHandled(d.id);
    } catch (e) {
      console.error("delete failed", e);
      setPending(null);
    }
  }

  function onDo(d: Decision) {
    setTray((t) =>
      t.find((x) => x.id === d.id) ? t : [...t, { id: d.id, headline: d.headline }],
    );
    markHandled(d.id);
  }

  function removeTray(id: string) {
    setTray((t) => t.filter((x) => x.id !== id));
  }

  async function onUndo(actionId: string) {
    setUndoing(actionId);
    try {
      await undoStewardAction({ actionId });
    } catch (e) {
      console.error("undo failed", e);
    } finally {
      setUndoing(null);
    }
  }

  return (
    <Frame>
      <section className="mx-auto max-w-[1180px] px-8 py-16">
        <PageOverture
          eyebrow="The Desk"
          title={<>Today<span style={{ fontStyle: "italic", fontWeight: 400 }}>.</span></>}
          meta={new Date().toLocaleDateString(undefined, {
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric",
          })}
        />

        {/* Featured decision */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.0, duration: 0.6 }}
          className="mb-24 mx-auto max-w-[760px]"
        >
          {top ? (
            <DecisionCard
              key={top.id}
              d={top}
              featured
              busy={pending === top.id}
              open={open?.id === top.id ? open.mode : null}
              draft={draft}
              setDraft={setDraft}
              onOpen={(mode) => { setOpen({ id: top.id, mode }); setDraft(""); }}
              onCancel={() => { setOpen(null); setDraft(""); }}
              onSubmit={(mode) =>
                mode === "delegate" ? onDelegate(top, draft) : onDefer(top, draft)
              }
              onDelete={() => onDelete(top)}
              onDo={() => onDo(top)}
            />
          ) : (
            <h2
              className="font-display tracking-[-0.02em] leading-[1.04]"
              style={{ fontSize: "clamp(28px, 3.4vw, 44px)" }}
            >
              Your desk is clear.{" "}
              <span style={{ color: "var(--marginalia)", fontStyle: "italic" }}>
                I'll let you know when something arrives.
              </span>
            </h2>
          )}
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-10%" }}
          variants={stagger(0.05, 0.08)}
        >
          {rest.length > 0 && (
            <motion.div variants={fadeUp} className="mb-20">
              <SectionHead title="Also in the queue" />
              <div className="space-y-4">
                {rest.map((d) => (
                  <DecisionCard
                    key={d.id}
                    d={d}
                    busy={pending === d.id}
                    open={open?.id === d.id ? open.mode : null}
                    draft={draft}
                    setDraft={setDraft}
                    onOpen={(mode) => { setOpen({ id: d.id, mode }); setDraft(""); }}
                    onCancel={() => { setOpen(null); setDraft(""); }}
                    onSubmit={(mode) =>
                      mode === "delegate" ? onDelegate(d, draft) : onDefer(d, draft)
                    }
                    onDelete={() => onDelete(d)}
                    onDo={() => onDo(d)}
                  />
                ))}
              </div>
            </motion.div>
          )}

          {tray.length > 0 && (
            <motion.div variants={fadeUp} className="mb-20">
              <SectionHead title="Backstage" sub="Yours to do" />
              <ul>
                {tray.map((t) => (
                  <li
                    key={t.id}
                    className="grid grid-cols-[1fr_auto] gap-4 py-3 border-b border-rule items-baseline"
                  >
                    <span className="font-body text-[16px]">{t.headline}</span>
                    <button onClick={() => removeTray(t.id)} className="btn-link">
                      Done
                    </button>
                  </li>
                ))}
              </ul>
            </motion.div>
          )}

          <motion.div variants={fadeUp}>
            <SectionHead title="The Record" sub="Activity ledger" />
            {ledger.length === 0 ? (
              <p
                className="font-body italic text-[15px]"
                style={{ color: "var(--marginalia)" }}
              >
                Nothing has happened yet today.
              </p>
            ) : (
              <ul className="font-mono text-[12px] tabular">
                {ledger.map((a) => (
                  <li
                    key={a.key}
                    className="grid grid-cols-[140px_1fr_80px] gap-3 py-3 border-b border-rule items-baseline"
                  >
                    <span style={{ color: "var(--marginalia)" }}>{a.atDisplay}</span>
                    <span
                      className="font-body text-[15px]"
                      style={{ color: "var(--ink)" }}
                    >
                      {a.act}
                    </span>
                    {a.reversible && a.actionId ? (
                      <button
                        onClick={() => a.actionId && onUndo(a.actionId)}
                        disabled={undoing === a.actionId}
                        className="btn-link text-right"
                        style={{ marginRight: 0 }}
                      >
                        {undoing === a.actionId ? "…" : "Undo"}
                      </button>
                    ) : (
                      <span
                        className="text-right uppercase tracking-[0.22em] text-[10px]"
                        style={{ color: "var(--marginalia)" }}
                      >
                        permanent
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        </motion.div>
      </section>
      <Seal />
    </Frame>
  );
}

function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="border-b border-rule pb-3 mb-6 flex items-baseline justify-between">
      <h2
        className="font-mono uppercase smallcaps"
        style={{ fontSize: 14, letterSpacing: "0.22em", color: "var(--ink)" }}
      >
        {title}
      </h2>
      {sub && (
        <span
          className="font-mono text-[10px] uppercase tracking-[0.28em]"
          style={{ color: "var(--marginalia)" }}
        >
          {sub}
        </span>
      )}
    </div>
  );
}

function DecisionCard({
  d, featured = false, busy, open, draft, setDraft,
  onOpen, onCancel, onSubmit, onDelete, onDo,
}: {
  d: Decision;
  featured?: boolean;
  busy: boolean;
  open: Action | null;
  draft: string;
  setDraft: (v: string) => void;
  onOpen: (m: Action) => void;
  onCancel: () => void;
  onSubmit: (m: Action) => void;
  onDelete: () => void;
  onDo: () => void;
}) {
  const arrived = fmtArrived(d.arrived);
  const labelKicker = featured ? "For your decision" : null;

  const Buttons = (
    <div
      className="mt-10 flex flex-wrap items-baseline"
      style={{ gap: "0 28px" }}
    >
      <button onClick={() => onOpen("delegate")} className="btn-instruction" disabled={busy}>Delegate</button>
      <span style={{ color: "var(--marginalia)" }}>·</span>
      <button onClick={() => onOpen("defer")} className="btn-instruction" disabled={busy}>Defer</button>
      <span style={{ color: "var(--marginalia)" }}>·</span>
      <button onClick={onDelete} className="btn-instruction" disabled={busy}>Delete</button>
      <span style={{ color: "var(--marginalia)" }}>·</span>
      <button onClick={onDo} className="btn-instruction" disabled={busy}>Do</button>
    </div>
  );

  const Form: ReactNode = open && (
    <div className="mt-8 border-t border-rule pt-5">
      <label
        className="block font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
        style={{ color: "var(--brass)" }}
      >
        {open === "delegate" ? "Instructions for me" : "When shall I resurface this?"}
      </label>
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={
          open === "delegate"
            ? "Settle it, then file the receipt under May expenses…"
            : "Tomorrow morning, or after the Carter meeting…"
        }
        className="w-full bg-transparent border border-rule p-3 font-body text-[16px] outline-none"
        style={{ minHeight: 96 }}
      />
      <div className="mt-4 flex gap-4 items-baseline">
        <button
          onClick={() => onSubmit(open)}
          className="btn-brass"
          style={{ fontSize: "1rem" }}
          disabled={busy}
        >
          {busy ? "…" : open === "delegate" ? "Hand it to Alfred" : "Defer"}
        </button>
        <button onClick={onCancel} className="btn-link" disabled={busy}>Cancel</button>
      </div>
    </div>
  );

  if (featured) {
    return (
      <article className="relative pl-8">
        <motion.div
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ delay: 1.2, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          style={{
            position: "absolute",
            left: 0, top: 0, bottom: 0,
            width: 1,
            background: "var(--brass)",
            boxShadow: "0 0 6px color-mix(in oklab, var(--brass) 40%, transparent)",
            originY: 0,
          }}
        />
        {labelKicker && (
          <div
            className="font-mono text-[10px] uppercase tracking-[0.32em] mb-5"
            style={{ color: "var(--brass)" }}
          >
            {labelKicker}
          </div>
        )}
        <h2
          className="font-display tracking-[-0.02em] leading-[1.02]"
          style={{ fontSize: "clamp(40px, 5vw, 64px)" }}
        >
          {d.headline}
        </h2>
        {d.why && (
          <p
            className="font-body mt-6 max-w-[60ch] leading-[1.6]"
            style={{ color: "var(--ink)", fontSize: 18 }}
          >
            {d.why}
          </p>
        )}
        {d.matterRef && <MatterContextCallout matterId={d.matterRef} />}
        {Buttons}
        {Form}
        {arrived && (
          <div
            className="mt-10 font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--marginalia)" }}
          >
            arrived {arrived}
          </div>
        )}
      </article>
    );
  }

  return (
    <article className="border border-rule p-6 card-hover">
      <h2
        className="font-display tracking-[-0.02em] leading-[1.05]"
        style={{ fontSize: 22 }}
      >
        {d.headline}
      </h2>
      {d.why && (
        <p
          className="font-body mt-3 max-w-[68ch] leading-[1.55]"
          style={{ color: "var(--marginalia)", fontSize: 15 }}
        >
          {d.why}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-baseline" style={{ gap: "0 22px" }}>
        <button onClick={() => onOpen("delegate")} className="btn-instruction" style={{ fontSize: 20 }} disabled={busy}>Delegate</button>
        <span style={{ color: "var(--marginalia)" }}>·</span>
        <button onClick={() => onOpen("defer")} className="btn-instruction" style={{ fontSize: 20 }} disabled={busy}>Defer</button>
        <span style={{ color: "var(--marginalia)" }}>·</span>
        <button onClick={onDelete} className="btn-instruction" style={{ fontSize: 20 }} disabled={busy}>Delete</button>
        <span style={{ color: "var(--marginalia)" }}>·</span>
        <button onClick={onDo} className="btn-instruction" style={{ fontSize: 20 }} disabled={busy}>Do</button>
      </div>
      {open && (
        <div className="mt-4 border-t border-rule pt-4">
          <label
            className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
            style={{ color: "var(--brass)" }}
          >
            {open === "delegate" ? "Instructions for me" : "When shall I resurface this?"}
          </label>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full bg-transparent border border-rule p-3 font-body text-[15px] outline-none"
            style={{ minHeight: 80 }}
          />
          <div className="mt-3 flex gap-3 items-baseline">
            <button
              onClick={() => onSubmit(open)}
              className="btn-brass"
              style={{ fontSize: "1rem" }}
              disabled={busy}
            >
              {busy ? "…" : open === "delegate" ? "Hand it to Alfred" : "Defer"}
            </button>
            <button onClick={onCancel} className="btn-link" disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
      {arrived && (
        <div
          className="mt-3 font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--marginalia)" }}
        >
          arrived {arrived}
        </div>
      )}
    </article>
  );
}

// RFC #884 — Matter-context callout for the featured decision card. Fetches
// the matter's living-narrative via getMatterDetail and renders a small
// "FROM MATTER" block: the matter name (linked to /matters/:id) plus the
// first sentence of current_state. Suspends gracefully — if the matter
// isn't found or current_state isn't set yet, nothing renders.
function MatterContextCallout({ matterId }: { matterId: string }) {
  const { data, error } = useQuery(
    getMatterDetail,
    { id: matterId },
    { enabled: Boolean(matterId), retry: false },
  );
  const matter = data?.matter ?? null;
  if (error || !matter) return null;
  const name = String(matter.name ?? matterId);
  const currentState =
    matter.current_state === null || matter.current_state === undefined
      ? ""
      : String(matter.current_state);
  // First sentence — split on .!? followed by whitespace, fall back to full
  // text if no sentence boundary is found.
  const firstSentence = (() => {
    if (!currentState.trim()) return "";
    const m = currentState.match(/^[\s\S]*?[.!?](?=\s|$)/);
    return (m ? m[0] : currentState).trim();
  })();
  return (
    <div className="mt-8 max-w-[64ch]">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
        style={{ color: "var(--brass)" }}
      >
        From matter
      </div>
      <Link
        to={`/matters/${encodeURIComponent(matterId)}`}
        className="font-display italic"
        style={{ fontSize: 16, color: "var(--ink)" }}
      >
        {name}
      </Link>
      {firstSentence && (
        <p
          className="font-body italic mt-1"
          style={{ fontSize: 15, color: "var(--marginalia)" }}
        >
          {firstSentence}
        </p>
      )}
    </div>
  );
}
