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
  recordDeskAction,
  recordDecision,
  getRecentDecisions,
  reverseDecision,
  getMyTodos,
  completeMyTodo,
  getPatternProposals,
  getInFlightDecisions,
  getBriefings,
  getBriefing,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { Seal } from "../client/components/ab/Seal";
import { PageOverture } from "../client/components/ab/PageOverture";
import { Markdown } from "../client/components/ab/Markdown";
import { fadeUp, stagger } from "../client/lib/motion";
import { enqueueDeskAction } from "./desk-action-queue";

// --------------------------------------------------------------------------
// Decision row — unified shape across the three source queries.
// --------------------------------------------------------------------------

type Source = "needs_attention" | "approval" | "judgment" | "pattern_proposal";
// All four primary verbs now accept a note via the same inline panel.
// Noise is a separate one-tap action (no note required, no panel —
// the gesture itself is the explanation; the workflow materialises a
// signal_noise_pattern that filters future events of the same kind).
type Action = "delegate" | "defer" | "done" | "take_mine";

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
  // Freshness band stamped by DecayWatcherWorkflow — used to group the
  // queue under "Fresh / Aging / Stale" so origin-old cards drift below
  // the fold instead of clogging the active surface.
  decayBand?: "fresh" | "aging" | "stale" | null;
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

/** Decision-row verb shown in the Record ledger. Mirrors the in-flight
 *  strip's wording so a card moving from "Alfred is working" down into
 *  "The Record" keeps the same shape. */
function decisionVerb(intent: string, state: string): string {
  if (state === "scheduled") return "Scheduled";
  if (state === "executing") return "Working";
  if (state === "reversed") return "Reversed";
  switch (intent) {
    case "delegate":   return "Delegated";
    case "defer":      return "Deferred";
    case "done":       return "Done";
    case "take_mine":  return "Mine";
    case "noise":      return "Noise";
    default:           return intent || "Decided";
  }
}

/** Render a steward-action row into a human-readable line.
 *  Prefers `summary` when the steward wrote one; otherwise composes
 *  `<verb> — <target stem>` from action/decision + target_path. The
 *  `still_active` heartbeat case is filtered upstream. */
function formatStewardAct(s: any): string {
  if (typeof s?.summary === "string" && s.summary.trim()) return s.summary.trim();
  const action = String(s?.action ?? "").trim();
  const decision = String(s?.decision ?? "").trim();
  const verb = action || decision.replace(/_/g, " ") || "Steward action";
  const target = String(s?.target ?? "").trim();
  if (!target) return verb;
  // task/<uuid8>-<slug>.md → <slug>; event/2026/05/10/foo.md → foo.
  const stem = target
    .replace(/^[a-z_]+\//, "")
    .replace(/\.md$/, "")
    .replace(/^[a-f0-9]{8}-/, "")
    .replace(/^\d{4}\/\d{2}\/\d{2}\//, "");
  return `${verb} — ${stem}`;
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
  const { data: needs, isLoading: needsLoading } = useQuery(getNeedsAttention);
  const { data: approvals, isLoading: approvalsLoading } = useQuery(getPendingApprovals);
  // NB: `getRecentJudgments` is a misnamed query — it actually proxies
  // /api/v1/vault/list/observation. Observations are learning-layer
  // artifacts (what the principal *did*, distilled for the intuition
  // engine) — they are NOT actionable decisions and must not crowd /desk.
  // The Desk reads only needs_attention + approvals + pattern_proposals.
  const judgmentsLoading = false;
  // Pattern proposals — proposed standing rules extracted nightly from
  // the principal's decisions. Surfaced as cards alongside the rest of
  // the queue so adopting a rule is itself a Decision.
  const { data: patternProposals, isLoading: patternsLoading } = useQuery(
    getPatternProposals,
    { limit: 50 },
  );
  const { data: activity } = useQuery(getActivityFeed);
  const { data: steward } = useQuery(getRecentStewardActions);
  // Persistent personal queue — replaces the in-React Backstage tray.
  // The DecisionRouterWorkflow spawns to_do/<ts>.md records when the
  // principal clicks Do; this query reads them so they survive reloads.
  const { data: myTodos, refetch: refetchTodos } = useQuery(
    getMyTodos,
    { state: "open", limit: 50 },
  );
  // Recent decisions — surfaced in The Record alongside steward actions.
  // Every Desk click since the rollout writes a decision record; the
  // Undo button below reverses them.
  const { data: recentDecisions, refetch: refetchDecisions } = useQuery(
    getRecentDecisions,
    { limit: 100 },
  );
  // What Alfred is doing right now — decisions in state=open / scheduled
  // / executing. Polled ~every 10s so the principal can watch a batch
  // they just delegated move through the pipeline.
  const { data: inFlight, refetch: refetchInFlight } = useQuery(
    getInFlightDecisions,
    { limit: 50 },
    { refetchInterval: 10000, refetchIntervalInBackground: false },
  );
  // Only show the "Your desk is clear" empty-state once *all four*
  // decision-queue sources have actually resolved. Without this gate the
  // page renders "clear" for the first ~10s while queries are still in
  // flight, then snaps to a featured card — which reads as a bug.
  const queueLoading =
    needsLoading || approvalsLoading || judgmentsLoading || patternsLoading;

  // Local UI state. (No "tray" state — Backstage now reads from the
  // persisted to_do records via getMyTodos. The DecisionRouterWorkflow
  // spawns them on intent=take_mine within ~60s of a Do click; an
  // optimistic refetch right after the click closes the visible gap.)
  const [handled, setHandled] = useState<string[]>([]);
  const [open, setOpen] = useState<{ id: string; mode: Action } | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  // Ledger pagination — Sir's request: don't unspool the entire activity
  // history at once. Reveal in 20-row pages with a "Show more" cue.
  const [ledgerVisible, setLedgerVisible] = useState(20);

  // Today's brief — most recent briefing snapshot, surfaced inline on the
  // Desk so sir reads the morning letter before scanning the queue.
  const { data: latestBriefings } = useQuery(
    getBriefings,
    { limit: 1 },
    { refetchInterval: 5 * 60_000, retry: false },
  );
  const latestBriefSummary =
    latestBriefings && Array.isArray(latestBriefings.briefings) && latestBriefings.briefings.length > 0
      ? latestBriefings.briefings[0]
      : null;
  const latestBriefSlugDate = latestBriefSummary?.slug_date ?? null;
  const { data: latestBriefFull } = useQuery(
    getBriefing,
    { slugDate: latestBriefSlugDate ?? "" },
    { enabled: !!latestBriefSlugDate, retry: false },
  );
  const [briefExpanded, setBriefExpanded] = useState(false);

  const decisions: Decision[] = useMemo(() => {
    const out: Decision[] = [];
    const na = Array.isArray(needs?.records) ? needs?.records : [];
    for (const r of na ?? []) {
      // Needs-attention records expose their meaningful fields at the top
      // level of the payload (action_what, decision_reason, created,
      // target_path, target_kind, confidence, raw_quote, status, id).
      // `frontmatter` is empty on the current ctrl-api shape — read top-
      // level first and fall back to fm.* for older / future payloads.
      const fm = (r?.frontmatter ?? {}) as Record<string, unknown>;
      const status = String(r?.status ?? fm.status ?? "pending");
      if (status !== "pending") continue;
      const id = String(r?.id ?? "");
      if (!id) continue;
      // Voiced surface fields land here when the upstream signal
      // extractor produced them (in Alfred's voice, grounded in
      // SOUL.md). Prefer those; fall back to action_what / reasoning
      // for older records that predate the prompt extension.
      const voicedHeadline =
        typeof r?.display_headline === "string" && r.display_headline.trim()
          ? r.display_headline.trim()
          : "";
      const voicedBody =
        typeof r?.display_body === "string" && r.display_body.trim()
          ? r.display_body.trim()
          : "";
      const headline =
        voicedHeadline ||
        String(r?.action_what ?? fm.headline ?? fm.subject ?? fm.summary ?? id);
      const reasoning =
        typeof r?.reasoning === "string" ? r.reasoning.trim() : "";
      const rawQuote =
        typeof r?.raw_quote === "string" ? r.raw_quote.trim() : "";
      const why = voicedBody || reasoning || rawQuote || String(r?.body ?? "");
      // When target_kind === "matter", target_path *is* the matter ref.
      const matterRef =
        String(r?.target_kind ?? "") === "matter"
          ? extractMatterId(r?.target_path)
          : extractMatterId(fm.matter ?? fm.parent_matter);
      const decayBandRaw = String(r?.decay_band ?? fm.decay_band ?? "").toLowerCase();
      const decayBand =
        decayBandRaw === "fresh" || decayBandRaw === "aging" || decayBandRaw === "stale"
          ? (decayBandRaw as "fresh" | "aging" | "stale")
          : null;
      out.push({
        id: `na:${id}`,
        source: "needs_attention",
        recordId: id,
        headline,
        why,
        // "arrived" = when the underlying real-world event happened
        // (email landed, meeting was scheduled, voice note recorded).
        // The signal pipeline stamps `origin_at` for this. Falls back
        // to `created` (Alfred's clock) for records written before
        // origin_at was added. The principal cares about the event's
        // date, not Alfred's processing time — a card surfaced today
        // about an email from May 1st must show May 1st.
        arrived: String(
          r?.origin_at ?? fm.origin_at ?? r?.created ?? fm.created ?? "",
        ),
        conf: typeof r?.confidence === "number" ? r.confidence : undefined,
        matterRef,
        decayBand,
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
        arrived: String(fm.origin_at ?? fm.created ?? ""),
        matterRef: extractMatterId(fm.matter ?? fm.parent_matter),
      });
    }
    // Observations are NOT surfaced on /desk — they're internal learning
    // artifacts for the intuition engine, not decisions for the principal.
    // (See note on getRecentJudgments at the top of the component.)
    // Pattern proposals — rules Alfred has spotted in the principal's
    // recent decisions. Adopting / deferring / rejecting one is itself a
    // Decision routed through the standard cascade. Headline is the
    // proposed rule; body is the evidence + the action it would take.
    const pps = Array.isArray(patternProposals?.proposals)
      ? patternProposals?.proposals
      : [];
    for (const p of pps ?? []) {
      const path = String(p?.path ?? "");
      if (!path) continue;
      const rule = String(p?.rule ?? "").trim();
      const evidence = String(p?.evidence ?? "").trim();
      const proposedAction = String(p?.proposed_action ?? "").trim();
      const headline = rule
        ? `Rule proposal: ${rule}`
        : `Rule proposal: ${shortenPath(path)}`;
      const why = [evidence, proposedAction && `If adopted: ${proposedAction}`]
        .filter(Boolean)
        .join("\n\n");
      out.push({
        id: `pp:${path}`,
        source: "pattern_proposal",
        recordId: path,
        headline,
        why,
        arrived: String(p?.created ?? ""),
        matterRef: extractMatterId(p?.matter_ref),
      });
    }
    // Newest first.
    out.sort((a, b) => (a.arrived < b.arrived ? 1 : a.arrived > b.arrived ? -1 : 0));
    return out;
  }, [needs, approvals, patternProposals]);

  const ledger: AuditRow[] = useMemo(() => {
    const out: AuditRow[] = [];

    // Decisions — every Desk click (Delegate / Defer / Done / Do / Noise)
    // writes a decision record. The Record on /desk needs to mirror what
    // /decisions shows, so the principal's actions land where they expect.
    // Previously this ledger only read getActivityFeed (docker logs from
    // the `alfred` container — irrelevant to Desk clicks) and
    // getRecentStewardActions (event/steward-action-*.md files, written
    // only by the background steward workflow, never by /desk clicks),
    // so Sir's clicks never appeared here even though they showed on
    // /decisions. Fixed by pulling decisions into the same merged feed.
    const decs = Array.isArray(recentDecisions?.decisions)
      ? recentDecisions?.decisions
      : Array.isArray((recentDecisions as any)?.results)
        ? (recentDecisions as any)?.results
        : [];
    for (const d of decs ?? []) {
      const at = String(d?.completed_at ?? d?.created ?? "");
      if (!at) continue;
      const intent = String(d?.intent ?? "").trim();
      const state = String(d?.state ?? "").trim();
      const headline =
        String(d?.source_headline ?? "").trim() ||
        String(d?.source_record ?? "").replace(/\.md$/, "").split("/").pop() ||
        "(no headline)";
      const verb = decisionVerb(intent, state);
      const decisionId = String(d?.id ?? "");
      out.push({
        key: `dec:${decisionId || at}`,
        at,
        atDisplay: fmtArrived(at),
        act: `${verb} — ${headline}`,
        actionId: decisionId || undefined,
        // Decisions are reversible until they have an outcome, but the
        // Undo path here goes through reverseDecision, not
        // undoStewardAction — different wire. Surface as informational
        // for now; the dedicated reverse button lives on /decisions.
        reversible: false,
      });
    }

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
      // Filter out still_active steward heartbeats — the StewardWorkflow
      // emits one per task per cycle saying "I looked, nothing changed."
      // Those are audit truth but pure noise on the human's desk. We only
      // surface actions where something actually moved.
      const decision = String(s?.decision ?? "");
      const actionStr = String(s?.action ?? "");
      if (decision === "still_active" && !actionStr) continue;
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
        act: formatStewardAct(s),
        actionId: actionId || undefined,
        reversible,
      });
    }
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return out.slice(0, 80);
  }, [recentDecisions, activity, steward]);

  // ------------------------------------------------------------------------
  // Action dispatch — maps the UI's four buttons to the right tenant op.
  // ------------------------------------------------------------------------

  const remaining = decisions.filter((d) => !handled.includes(d.id));
  // The featured card is the freshest unhandled decision. We bias the top
  // slot to "fresh" so an aging card never crowns the Desk; if there are
  // no fresh decisions, the freshest aging one takes the slot.
  const remainingFresh = remaining.filter((d) => d.decayBand !== "aging" && d.decayBand !== "stale");
  const top = (remainingFresh[0] ?? remaining[0]) as Decision | undefined;
  const restAll = remaining.filter((d) => d !== top);
  const restFresh = restAll.filter((d) => d.decayBand !== "aging" && d.decayBand !== "stale");
  const restAging = restAll.filter((d) => d.decayBand === "aging");
  const restStale = restAll.filter((d) => d.decayBand === "stale");
  // Combined "Also in the queue" stays the fresh list for the main band;
  // aging + stale are rendered under their own headings below.
  const rest = restFresh;

  function markHandled(id: string) {
    setHandled((h) => [...h, id]);
    setOpen(null);
    setDraft("");
    setPending(null);
  }

  // Every Desk-card click writes:
  //
  //   1. A `decision/<ts>.md` record (the new first-class artefact —
  //      DecisionRouterWorkflow picks it up within ~60s and fans out
  //      side effects: source-record status flip, signal re-arm, to_do
  //      spawn, matter-timeline entry, outcome polling).
  //   2. A legacy `event/desk-action-*.md` (kept for backwards compat
  //      with the existing /decisions feed that reads the event/ dir).
  //
  // Both fire in parallel best-effort. A failure of either MUST NOT
  // block the source-specific call.
  async function auditDeskAction(
    d: Decision,
    action: "delegate" | "defer" | "delete" | "do" | "noise",
    note: string,
  ): Promise<void> {
    const intent =
      action === "delete"
        ? "done"
        : action === "do"
          ? "take_mine"
          : action;
    // Awaited so the caller knows the audit cycle is fully done before
    // releasing the desk-action queue to the next click. Each write is
    // best-effort — a ledger miss must not block the user — but the
    // queue gate waits on both regardless of outcome.
    await Promise.all([
      recordDecision({
        source: d.source,
        sourceRecord:
          d.source === "needs_attention"
            ? `needs_attention/${d.recordId}.md`
            : d.recordId,
        intent: intent as
          | "delegate"
          | "defer"
          | "done"
          | "take_mine"
          | "noise",
        note: note || undefined,
        matterRef: d.matterRef ? `matter/${d.matterRef}.md` : undefined,
        sourceHeadline: d.headline || undefined,
      }).catch((e) => {
        console.error("recordDecision failed", action, d.id, e);
      }),
      recordDeskAction({
        source: d.source,
        sourceId: d.recordId,
        action,
        note: note || undefined,
      }).catch((e) => {
        console.error("recordDeskAction failed", action, d.id, e);
      }),
    ]);
  }

  // Optimistic UI for all four buttons: clear the card from the queue
  // immediately, fire the audit + source-specific server calls in the
  // background. The two server calls run in parallel (they don't depend
  // on each other). On mutation failure, revert by removing the id
  // from `handled` so the card pops back into the queue. The audit call
  // already swallows its own errors (best-effort) — a transient ledger
  // miss must not block the user, and the source record's own status
  // field is the durable truth of what happened to the underlying item.
  function revertHandled(id: string): void {
    setHandled((h) => h.filter((x) => x !== id));
  }

  // Every click goes through `enqueueDeskAction` so that 10 mash-clicks
  // produce a single in-flight server cycle at a time. Optimistic UI
  // (markHandled) still runs synchronously; only the audit + source
  // mutation are serialised. See desk-action-queue.ts for rationale.
  function onDelegate(d: Decision, instructions: string): void {
    markHandled(d.id);
    enqueueDeskAction(async () => {
      await auditDeskAction(d, "delegate", instructions);
      if (d.source === "needs_attention") {
        await resolveNeedsAttentionDispatch({
          id: d.recordId,
          note: instructions,
        });
      } else if (d.source === "approval") {
        await approveAction({ path: d.recordId });
      }
    }).catch((e) => {
      console.error("delegate failed; reverting", d.id, e);
      revertHandled(d.id);
    });
  }

  function onDefer(d: Decision, when: string): void {
    markHandled(d.id);
    enqueueDeskAction(async () => {
      await auditDeskAction(d, "defer", when);
      if (d.source === "needs_attention") {
        await resolveNeedsAttentionSkip({ id: d.recordId, note: when });
      }
      // Approvals + judgments have no native defer endpoint — the audit
      // event captures intent; the underlying record stays pending.
    }).catch((e) => {
      console.error("defer failed; reverting", d.id, e);
      revertHandled(d.id);
    });
  }

  function onDelete(d: Decision, context: string): void {
    // "Done" — close the item. Optional context becomes part of the
    // observation extracted from the decision (richer learning signal).
    markHandled(d.id);
    enqueueDeskAction(async () => {
      await auditDeskAction(d, "delete", context);
      if (d.source === "needs_attention") {
        await resolveNeedsAttentionDone({
          id: d.recordId,
          note: context || undefined,
        });
      } else if (d.source === "approval") {
        await rejectAction({ path: d.recordId });
      }
    }).catch((e) => {
      console.error("done failed; reverting", d.id, e);
      revertHandled(d.id);
    });
  }

  function onDo(d: Decision, context: string): void {
    // "Do" writes a Decision (intent=take_mine) — the
    // DecisionRouterWorkflow then spawns a to_do/<ts>.md record within
    // ~60s, which surfaces in the Backstage section via getMyTodos.
    // Context becomes the to_do's note + the observation's training
    // signal. We refetch the todos list a few seconds later to close
    // the gap.
    markHandled(d.id);
    enqueueDeskAction(() => auditDeskAction(d, "do", context));
    setTimeout(() => {
      refetchTodos().catch(() => {});
    }, 5000);
  }

  function onNoise(d: Decision): void {
    // "Noise" — the principal says this category of signal should
    // never have surfaced. Synchronous flip stamps status=noise;
    // DecisionRouterWorkflow then materialises a signal_noise_pattern
    // that signal_extract consults BEFORE the LLM call on future
    // events. No note required — the gesture is the explanation.
    markHandled(d.id);
    enqueueDeskAction(() => auditDeskAction(d, "noise", ""));
    // No source-specific mutation needed — the synchronous flip in
    // ctrl-api's POST /api/v1/decisions already set the source
    // record's status to "noise", which drops it from the queue.
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

        {/* Today's brief — most recent BriefingWorkflow snapshot. Surfaces
            the letter sir would otherwise have to navigate to /briefings for.
            Hidden when no briefing exists (no fallback to legacy DailyDigest
            here — that's /brief's job). */}
        {latestBriefSummary && (
          <section className="mb-16 mx-auto max-w-[760px] border-l-2 pl-6"
                   style={{ borderColor: "var(--brass)" }}>
            <div className="flex items-baseline justify-between gap-4 mb-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em]"
                   style={{ color: "var(--brass)" }}>
                {latestBriefSummary.slot === "evening" ? "Evening Brief" : "Morning Brief"}
                {latestBriefSummary.composed_at && (
                  <span style={{ color: "var(--marginalia)", marginLeft: 12 }}>
                    {new Date(String(latestBriefSummary.composed_at)).toLocaleString(undefined, {
                      weekday: "short", day: "numeric", month: "short",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </span>
                )}
              </div>
              <Link to="/briefings"
                    className="font-mono text-[10px] uppercase tracking-[0.22em]"
                    style={{ color: "var(--brass)" }}>
                All briefings →
              </Link>
            </div>
            {latestBriefFull?.body ? (
              <div className="font-body text-[16px] leading-[1.65] max-w-[64ch]"
                   style={{
                     maxHeight: briefExpanded ? undefined : 220,
                     overflow: briefExpanded ? "visible" : "hidden",
                     position: "relative",
                   }}>
                <Markdown source={String(latestBriefFull.body)} useLiveResolver={false} />
                {!briefExpanded && (
                  <div style={{
                    position: "absolute", bottom: 0, left: 0, right: 0, height: 60,
                    background: "linear-gradient(to bottom, transparent, var(--paper))",
                    pointerEvents: "none",
                  }} />
                )}
              </div>
            ) : (
              <p className="font-body italic text-[15px]" style={{ color: "var(--marginalia)" }}>
                Brief composer didn't produce prose for this slot.{" "}
                <Link to="/briefings" style={{ color: "var(--brass)" }}>
                  View matter snapshots →
                </Link>
              </p>
            )}
            {latestBriefFull?.body && String(latestBriefFull.body).length > 400 && (
              <button onClick={() => setBriefExpanded((b) => !b)}
                      className="font-mono text-[10px] uppercase tracking-[0.22em] mt-3"
                      style={{ color: "var(--brass)" }}>
                {briefExpanded ? "Collapse ↑" : "Read in full ↓"}
              </button>
            )}
          </section>
        )}

        {/* Featured decision */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4 }}
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
              onSubmit={(mode) => {
                if (mode === "delegate") return onDelegate(top, draft);
                if (mode === "defer")    return onDefer(top, draft);
                if (mode === "done")     return onDelete(top, draft);
                if (mode === "take_mine")return onDo(top, draft);
              }}
              onNoise={() => onNoise(top)}
            />
          ) : queueLoading ? (
            <p
              className="font-body italic text-[18px]"
              style={{ color: "var(--marginalia)" }}
            >
              Reading the room…
            </p>
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
          animate="show"
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
                    onSubmit={(mode) => {
                      if (mode === "delegate") return onDelegate(d, draft);
                      if (mode === "defer")    return onDefer(d, draft);
                      if (mode === "done")     return onDelete(d, draft);
                      if (mode === "take_mine")return onDo(d, draft);
                    }}
                    onNoise={() => onNoise(d)}
                  />
                ))}
              </div>
            </motion.div>
          )}

          {restAging.length > 0 && (
            <motion.div variants={fadeUp} className="mb-20" style={{ opacity: 0.78 }}>
              <SectionHead title="Aging" sub="Past their half-life" />
              <div className="space-y-4">
                {restAging.map((d) => (
                  <DecisionCard
                    key={d.id}
                    d={d}
                    busy={pending === d.id}
                    open={open?.id === d.id ? open.mode : null}
                    draft={draft}
                    setDraft={setDraft}
                    onOpen={(mode) => { setOpen({ id: d.id, mode }); setDraft(""); }}
                    onCancel={() => { setOpen(null); setDraft(""); }}
                    onSubmit={(mode) => {
                      if (mode === "delegate") return onDelegate(d, draft);
                      if (mode === "defer")    return onDefer(d, draft);
                      if (mode === "done")     return onDelete(d, draft);
                      if (mode === "take_mine")return onDo(d, draft);
                    }}
                    onNoise={() => onNoise(d)}
                  />
                ))}
              </div>
            </motion.div>
          )}

          {restStale.length > 0 && (
            <motion.div variants={fadeUp} className="mb-20" style={{ opacity: 0.55 }}>
              <SectionHead title="Stale" sub="About to fade. Sweep or noise." />
              <div className="space-y-4">
                {restStale.map((d) => (
                  <DecisionCard
                    key={d.id}
                    d={d}
                    busy={pending === d.id}
                    open={open?.id === d.id ? open.mode : null}
                    draft={draft}
                    setDraft={setDraft}
                    onOpen={(mode) => { setOpen({ id: d.id, mode }); setDraft(""); }}
                    onCancel={() => { setOpen(null); setDraft(""); }}
                    onSubmit={(mode) => {
                      if (mode === "delegate") return onDelegate(d, draft);
                      if (mode === "defer")    return onDefer(d, draft);
                      if (mode === "done")     return onDelete(d, draft);
                      if (mode === "take_mine")return onDo(d, draft);
                    }}
                    onNoise={() => onNoise(d)}
                  />
                ))}
              </div>
            </motion.div>
          )}

          {Array.isArray((myTodos as any)?.todos) &&
            (myTodos as any).todos.length > 0 && (
              <motion.div variants={fadeUp} className="mb-20">
                <SectionHead title="Backstage" sub="Yours to do" />
                <ul>
                  {((myTodos as any).todos as any[]).map((t) => (
                    <li
                      key={t.id}
                      className="grid grid-cols-[1fr_auto] gap-4 py-3 border-b border-rule items-baseline"
                    >
                      <span className="font-body text-[16px]">
                        {String(t.headline ?? t.id)}
                      </span>
                      <button
                        onClick={() => {
                          // Optimistic: write a Decision (intent=done on
                          // a to_do source) and clear the row. The
                          // DecisionRouterWorkflow flips the to_do
                          // record to state=completed within ~60s; the
                          // direct completeMyTodo call below mutates it
                          // immediately for the impatient cache. Both
                          // server calls go through the shared queue so
                          // they don't dogpile ctrl-api alongside the
                          // bigger Delegate/Defer/Done cycles.
                          const todoPath =
                            typeof t.path === "string"
                              ? t.path
                              : `to_do/${t.id}.md`;
                          enqueueDeskAction(async () => {
                            await Promise.all([
                              recordDecision({
                                source: "to_do",
                                sourceRecord: todoPath,
                                intent: "done",
                                sourceHeadline: String(t.headline ?? ""),
                              }).catch((e) =>
                                console.error("to_do decision failed", e),
                              ),
                              completeMyTodo({ id: String(t.id) }).catch(
                                (e) =>
                                  console.error("completeMyTodo failed", e),
                              ),
                            ]);
                          }).then(() => refetchTodos().catch(() => {}));
                        }}
                        className="btn-link"
                      >
                        Done
                      </button>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )}

          <InFlightStrip
            decisions={Array.isArray(inFlight?.decisions) ? inFlight.decisions : []}
          />

          <motion.div variants={fadeUp}>
            <SectionHead
              title="Ledger"
              sub={
                ledger.length === 0
                  ? "Activity ledger"
                  : `${Math.min(ledgerVisible, ledger.length)} of ${ledger.length}`
              }
            />
            {ledger.length === 0 ? (
              <p
                className="font-body italic text-[15px]"
                style={{ color: "var(--marginalia)" }}
              >
                Nothing has happened yet today.
              </p>
            ) : (
              <>
                <ul className="font-mono text-[12px] tabular">
                  {ledger.slice(0, ledgerVisible).map((a) => (
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
                {ledger.length > ledgerVisible && (
                  <div className="pt-4 flex justify-center">
                    <button
                      onClick={() => setLedgerVisible((n) => n + 20)}
                      className="btn-link font-mono uppercase tracking-[0.22em] text-[11px]"
                    >
                      Show more — {ledger.length - ledgerVisible} remaining
                    </button>
                  </div>
                )}
              </>
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

/** Map a decision's source to the small label Sir reads next to
 *  "arrived" so it's obvious what *kind* of thing the card is. */
function sourceLabel(source: Source): string {
  if (source === "needs_attention") return "Attention Needed";
  if (source === "approval") return "Proposed Action";
  if (source === "pattern_proposal") return "Rule Proposal";
  return "Judgment Needed";
}

/** Live activity strip — "What Alfred is doing right now". Renders
 *  decisions in state=open / scheduled / executing, polled every ~10s
 *  by the parent. Hidden when there's nothing in flight so a quiet
 *  desk stays quiet. */
function InFlightStrip({ decisions }: { decisions: any[] }) {
  if (!decisions || decisions.length === 0) return null;
  return (
    <motion.div variants={fadeUp} style={{ marginTop: 24, marginBottom: 32 }}>
      <SectionHead
        title="Alfred is working"
        sub={`${decisions.length} in flight`}
      />
      <ul className="font-mono text-[12px]">
        {decisions.map((d) => {
          const state = String(d?.state ?? "open").toLowerCase();
          const intent = String(d?.intent ?? "");
          const headline =
            String(d?.source_headline ?? "").trim() ||
            String(d?.source_record ?? "").replace(/\.md$/, "").split("/").pop() ||
            "(no headline)";
          const note = String(d?.note ?? "").trim();
          const executeAt = String(d?.execute_at ?? "").trim();
          const arrived = String(d?.created ?? "");
          return (
            <li
              key={d?.id}
              className="grid grid-cols-[110px_1fr_140px] gap-3 py-3 border-b border-rule items-baseline"
            >
              <InFlightBadge state={state} />
              <div>
                <div
                  className="font-body text-[15px]"
                  style={{ color: "var(--ink)" }}
                >
                  {inFlightVerb(intent, state)} {headline}
                </div>
                {(note || executeAt) && (
                  <div
                    className="font-body italic text-[13px]"
                    style={{ color: "var(--marginalia)", marginTop: 4 }}
                  >
                    {executeAt ? `Will fire ${fmtArrived(executeAt)}` : note}
                  </div>
                )}
              </div>
              <span
                className="text-right tabular"
                style={{ color: "var(--marginalia)" }}
              >
                {fmtArrived(arrived)}
              </span>
            </li>
          );
        })}
      </ul>
    </motion.div>
  );
}

function inFlightVerb(intent: string, state: string): string {
  if (state === "scheduled") return "Scheduled to delegate:";
  if (state === "executing") {
    if (intent === "delegate") return "Delegating:";
    if (intent === "take_mine") return "Taking on:";
    return "Working on:";
  }
  // state=open — just landed, workflow hasn't picked up yet
  return "Routing:";
}

function InFlightBadge({ state }: { state: string }) {
  const palette: Record<string, { bg: string; fg: string; label: string }> = {
    open: { bg: "var(--paper-2)", fg: "var(--marginalia)", label: "ROUTING" },
    scheduled: { bg: "var(--brass-faint)", fg: "var(--brass)", label: "SCHEDULED" },
    executing: { bg: "var(--ink)", fg: "var(--paper)", label: "ACTIVE" },
  };
  const p = palette[state] ?? palette.open;
  return (
    <span
      className="font-mono text-[10px] tracking-[0.22em]"
      style={{
        background: p.bg,
        color: p.fg,
        padding: "3px 8px",
        display: "inline-block",
        textAlign: "center",
      }}
    >
      {p.label}
    </span>
  );
}

function actionLabel(a: Action): string {
  switch (a) {
    case "delegate": return "Instructions for me";
    case "defer":    return "When shall I resurface this?";
    case "done":     return "Anything noteworthy? (optional)";
    case "take_mine":return "Anything noteworthy? (optional)";
  }
}
function actionPlaceholder(a: Action): string {
  switch (a) {
    case "delegate": return "Settle it, then file the receipt under May expenses…";
    case "defer":    return "Tomorrow morning, or after the Carter meeting…";
    case "done":     return "Already replied · already paid · resolved on call…";
    case "take_mine":return "I'll send a note tonight · I'll handle in the morning…";
  }
}
function actionSubmitText(a: Action): string {
  switch (a) {
    case "delegate": return "Hand it to Alfred";
    case "defer":    return "Defer";
    case "done":     return "Mark done";
    case "take_mine":return "I'll handle it";
  }
}

function DecisionCard({
  d, featured = false, busy, open, draft, setDraft,
  onOpen, onCancel, onSubmit, onNoise,
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
  onNoise: () => void;
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
      <button onClick={() => onOpen("done")} className="btn-instruction" disabled={busy}>Done</button>
      <span style={{ color: "var(--marginalia)" }}>·</span>
      <button onClick={() => onOpen("take_mine")} className="btn-instruction" disabled={busy}>Do</button>
      <span style={{ flex: 1 }} />
      <button
        onClick={onNoise}
        className="btn-link"
        style={{ fontSize: "0.85em", color: "var(--marginalia)" }}
        disabled={busy}
        title="Don't surface things like this again"
      >
        Noise
      </button>
    </div>
  );

  const Form: ReactNode = open && (
    <div className="mt-8 border-t border-rule pt-5">
      <label
        className="block font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
        style={{ color: "var(--brass)" }}
      >
        {actionLabel(open)}
      </label>
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={actionPlaceholder(open)}
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
          {busy ? "…" : actionSubmitText(open)}
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
        <div
          className="mt-10 font-mono text-[10px] uppercase tracking-[0.28em] flex flex-wrap items-center"
          style={{ color: "var(--marginalia)", gap: "0 14px" }}
        >
          <span style={{ color: "var(--brass)" }}>{sourceLabel(d.source)}</span>
          {arrived && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>arrived {arrived}</span>
            </>
          )}
        </div>
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
        <button onClick={() => onOpen("done")} className="btn-instruction" style={{ fontSize: 20 }} disabled={busy}>Done</button>
        <span style={{ color: "var(--marginalia)" }}>·</span>
        <button onClick={() => onOpen("take_mine")} className="btn-instruction" style={{ fontSize: 20 }} disabled={busy}>Do</button>
        <span style={{ flex: 1 }} />
        <button
          onClick={onNoise}
          className="btn-link"
          style={{ fontSize: "0.8em", color: "var(--marginalia)" }}
          disabled={busy}
          title="Don't surface things like this again"
        >
          Noise
        </button>
      </div>
      {open && (
        <div className="mt-4 border-t border-rule pt-4">
          <label
            className="block font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
            style={{ color: "var(--brass)" }}
          >
            {actionLabel(open)}
          </label>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={actionPlaceholder(open)}
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
              {busy ? "…" : actionSubmitText(open)}
            </button>
            <button onClick={onCancel} className="btn-link" disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
      <div
        className="mt-3 font-mono text-[10px] uppercase tracking-[0.22em] flex flex-wrap items-center"
        style={{ color: "var(--marginalia)", gap: "0 12px" }}
      >
        <span style={{ color: "var(--brass)" }}>{sourceLabel(d.source)}</span>
        {arrived && (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>arrived {arrived}</span>
          </>
        )}
      </div>
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
