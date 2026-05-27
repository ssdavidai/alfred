/**
 * /verify — view-state decision for the "Confirm what Alfred has learned"
 * page.
 *
 * The original page had two display branches, gated only by a local
 * `seeded` flag that flipped to true the first time the backend returned
 * a non-empty `key_identity_facts` list. When the backend completed the
 * pipeline with ZERO key identity facts — the usual cause is an
 * extract_facts_opus degrade (a 402 credit dip, a per-chunk timeout, or
 * a sparse inbox) — `seeded` stayed false forever and the page sat on
 * "A moment — Alfred is sorting his observations." The principal had no
 * way past the screen.
 *
 * This module makes the decision explicit. The page now has THREE
 * top-level view states:
 *
 *   "waiting"    The backend is still working on facts. Show the calm
 *                "Alfred is sorting his observations" line and poll.
 *   "list"       The backend produced one or more facts. Render the
 *                normal confirm/edit/discard list.
 *   "empty"      The backend reached or passed the verification gate
 *                AND returned zero key identity facts. Show an
 *                Alfred-voiced acknowledgement and a way to continue
 *                (submits empty corrections → the workflow advances
 *                into the brief stage).
 *
 * "Settled" means the workflow's facts stage has run to completion (or
 * to degrade) and the result is in onboard.json. The backend tells us
 * this via the `stage` field on `getOnboardingProgress`: anything at
 * `awaiting_verification` or later is past the facts stage. Before
 * `awaiting_verification`, an empty key_identity_facts list is just a
 * "the LLM hasn't landed yet" signal, and we keep waiting.
 */

export type VerifyViewState = "waiting" | "list" | "empty";

/**
 * Stages at which `extract_facts_opus` has already run — successfully
 * or to a degrade. Past these points an empty key_identity_facts list
 * is the FINAL answer, not a still-loading signal.
 *
 * Includes every stage the OnboardingPipelineWorkflow can persist after
 * the awaiting_verification gate: the brief stage runs as a separate
 * workflow triggered by /onboarding/corrections, and the post-brief
 * stages (packs, chores, done) may persist on the second workflow.
 * Treating all of them as settled keeps `/verify` honest no matter
 * which workflow the principal lands on. See
 * packages/learn/src/workflows/onboarding_pipeline.py STAGE_ORDER.
 */
export const FACTS_SETTLED_STAGES: ReadonlySet<string> = new Set([
  "awaiting_verification",
  "brief",
  "packs",
  "chores",
  "done",
]);

export interface VerifyViewInputs {
  /** The current onboarding stage from getOnboardingProgress. May be
   *  undefined on the very first paint before the query resolves. */
  stage: string | undefined;
  /** The key_identity_facts array length the backend returned. */
  factsCount: number;
}

/**
 * Pick the view state for /verify. Pure of React state; the hydration
 * flag (`seeded`) is layered on top of this in the page itself so the
 * facts list never re-shuffles mid-edit. The page consults this on
 * every render to decide between the three top-level branches.
 */
export function verifyViewState(inputs: VerifyViewInputs): VerifyViewState {
  const { stage, factsCount } = inputs;

  if (factsCount > 0) return "list";

  // No facts. Decide based on stage.
  if (stage && FACTS_SETTLED_STAGES.has(stage)) return "empty";

  // The backend has not yet reached the verification gate. Keep waiting.
  return "waiting";
}
