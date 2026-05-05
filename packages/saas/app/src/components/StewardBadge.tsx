// Steward (#836 Phase 0.5) — inline badge component for the Tasks UI.
//
// Renders one of three states based on what the Steward has decided
// for a given task:
//
//   1. ``pending_confirmation`` true — Steward proposed "done" with
//      confidence < 0.6 and is waiting for Sir to confirm or dismiss.
//      Phase 0.5 ships the buttons but disables them with a tooltip;
//      the underlying confirm/dismiss endpoints land in Phase 3.
//   2. A live-mode reversible action — Steward auto-closed the task
//      and the 7-day undo window is still open. Renders an inline
//      "auto-closed by Alfred" pill + an Undo button that calls the
//      ``/api/v1/steward/undo/<action_id>`` endpoint via the SaaS
//      tenant proxy.
//   3. Shadow-mode observation — Steward evaluated the task but didn't
//      change anything. Renders a small subtle pill so Sir can see
//      Steward's footprint while we're still in the eval-harness
//      phase.
//
// When none of those apply, the component returns null and the row
// renders as it did before Phase 0.5.
import type { ReactNode } from "react";
import { useState } from "react";
import { Loader2, Bot, Eye, RotateCcw, ShieldAlert } from "lucide-react";

export interface StewardEvidenceItem {
  source?: string;
  ref?: string;
  note?: string;
}

export interface StewardOutcome {
  decision: string;
  confidence: number;
  evidence?: StewardEvidenceItem[];
  mode?: string;
}

export interface StewardRecentAction {
  path: string;
  mode: string;
  is_reversible: boolean;
  evidence?: StewardEvidenceItem[];
  decision?: string;
  confidence?: number;
  timestamp?: string;
}

export interface StewardBadgeProps {
  /** Vault path of the task this badge attaches to. */
  taskPath: string;
  /** ``last_steward_outcome`` from the task's frontmatter, if present. */
  outcome?: StewardOutcome | null;
  /** ``pending_confirmation`` flag from frontmatter. */
  pendingConfirmation?: boolean;
  /** Most recent steward audit record for this task, if any. */
  recentAction?: StewardRecentAction | null;
  /**
   * Async undo handler. Called with the audit record's vault path
   * when Sir clicks Undo. Owner is responsible for refetching the
   * task list after the action resolves.
   */
  onUndo?: (actionPath: string) => Promise<void> | void;
}

// Tooltip text shown over the disabled Confirm/Dismiss buttons in
// pending_confirmation state. Phase 3 (#839) wires up the underlying
// /api/v1/steward/confirm/:id and /dismiss/:id endpoints — until then
// the buttons are visible but inert so the UI shape is testable.
const PHASE_3_TOOLTIP = "Available in Phase 3 — Steward is still in evaluation mode";

function evidenceTooltipText(evidence?: StewardEvidenceItem[]): string {
  if (!evidence || evidence.length === 0) return "No signals recorded.";
  return evidence
    .map((e, i) => {
      const src = (e.source || "").trim();
      const ref = (e.ref || "").trim();
      const note = (e.note || "").trim();
      const head = src && ref ? `${src}:${ref}` : src || ref || `signal ${i + 1}`;
      return note ? `${head} — ${note}` : head;
    })
    .join("\n");
}

export function StewardBadge({
  taskPath,
  outcome,
  pendingConfirmation,
  recentAction,
  onUndo,
}: StewardBadgeProps): ReactNode {
  const [undoing, setUndoing] = useState(false);

  // Branch 1: pending_confirmation (low-confidence Steward proposal).
  if (pendingConfirmation) {
    const evidence = outcome?.evidence ?? recentAction?.evidence ?? [];
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-amber-400"
        data-task-path={taskPath}
        title={evidenceTooltipText(evidence)}
      >
        <ShieldAlert className="h-3 w-3" />
        <span>Steward says done</span>
        <button
          type="button"
          disabled
          title={PHASE_3_TOOLTIP}
          className="ml-1 cursor-not-allowed rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-400 opacity-50"
        >
          confirm
        </button>
        <button
          type="button"
          disabled
          title={PHASE_3_TOOLTIP}
          className="cursor-not-allowed rounded-sm border border-zinc-500/30 bg-zinc-500/10 px-1.5 py-0.5 text-zinc-400 opacity-50"
        >
          dismiss
        </button>
      </span>
    );
  }

  // Branch 2: live action with the undo window still open.
  if (recentAction && recentAction.is_reversible && recentAction.mode === "live") {
    const evidence = recentAction.evidence ?? outcome?.evidence ?? [];
    const handleUndo = async () => {
      if (!onUndo) return;
      setUndoing(true);
      try {
        await onUndo(recentAction.path);
      } finally {
        setUndoing(false);
      }
    };
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-emerald-400"
        data-task-path={taskPath}
        title={evidenceTooltipText(evidence)}
      >
        <Bot className="h-3 w-3" />
        <span>Auto-closed by Alfred</span>
        <button
          type="button"
          onClick={handleUndo}
          disabled={undoing || !onUndo}
          className="ml-1 inline-flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-emerald-200 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          title={onUndo ? "Revert this Steward action" : "Undo unavailable — no handler wired"}
        >
          {undoing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="h-3 w-3" />
          )}
          undo
        </button>
      </span>
    );
  }

  // Branch 3: shadow observation — render a subtle pill so Sir can
  // see Steward's footprint during the harness phase. We surface
  // either the explicit outcome.mode === "shadow" OR a recent action
  // record in shadow mode (whichever the caller has handy).
  const isShadowOutcome = !!(outcome && (outcome.mode ?? "shadow") === "shadow");
  const isShadowRecent = !!(recentAction && recentAction.mode === "shadow");
  if (isShadowOutcome || isShadowRecent) {
    const evidence = outcome?.evidence ?? recentAction?.evidence ?? [];
    const decision = outcome?.decision ?? recentAction?.decision ?? "observed";
    return (
      <span
        className="inline-flex items-center gap-1 rounded-sm border border-zinc-500/30 bg-zinc-500/5 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-zinc-400/80"
        data-task-path={taskPath}
        title={`Steward observed: ${decision}\n${evidenceTooltipText(evidence)}`}
      >
        <Eye className="h-2.5 w-2.5" />
        <span>Steward observed</span>
      </span>
    );
  }

  return null;
}

export default StewardBadge;
