// Pure tier logic for /instincts (#447).
//
// The promotion ladder is written by Reflection (`apply_instinct_change`)
// into `frontmatter.tier`, and since #446 it is the field the signal router
// gates autonomous dispatch on. This module is the single place the web app
// reads it, so the badge cannot drift from the runtime authority again.
//
// It replaces the old `classifyStage()` derivation, which computed a stage
// from the discretion threshold + observation count and never looked at
// `tier` at all. That derivation was defensible while the gate was
// threshold-only; after #446 it actively misstated whether Alfred would act
// unattended — in both directions.
//
// Pure + dependency-free so it is unit-testable without rendering.

export type Stage = "Asking" | "Confirming" | "Acting";

export const STAGES: Stage[] = ["Asking", "Confirming", "Acting"];

/** The only tier the router permits to act unattended. Mirrors
 *  `signal_actions.AUTONOMOUS_TIER`. */
export const AUTONOMOUS_TIER: Stage = "Acting";

/**
 * Read an instinct's ladder tier, failing CLOSED to "Asking".
 *
 * Mirrors `signal_actions._instinct_tier` exactly, so the surface and the
 * gate agree at the edges too: anything missing, non-string, or outside the
 * ladder degrades to the least-autonomy tier. The legacy nested
 * `execution.tier` integer / `execution.requires_approval` pair is
 * deliberately NOT consulted — it disagreed with the ladder on live data,
 * and the weaker of two conflicting fields must not win.
 */
export function readTier(instinct: any): Stage {
  const raw = instinct?.frontmatter?.tier ?? instinct?.tier;
  if (typeof raw !== "string") return "Asking";
  const trimmed = raw.trim();
  if (!trimmed) return "Asking";
  const normalized =
    trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  return (STAGES as string[]).includes(normalized)
    ? (normalized as Stage)
    : "Asking";
}

/** Whether the router may dispatch this instinct without Sir in the loop. */
export function actsUnattended(instinct: any): boolean {
  return readTier(instinct) === AUTONOMOUS_TIER;
}

/**
 * Plain-language statement of what the tier means for autonomy.
 *
 * This is a safety surface: it must say what Alfred will actually *do*,
 * not how confident he feels. Asking and Confirming differ in what the
 * card says, not in whether he may act alone.
 */
export function autonomyStatement(stage: Stage): string {
  switch (stage) {
    case "Acting":
      return "I may handle this without asking you.";
    case "Confirming":
      return "I'll bring this to you to confirm before acting.";
    default:
      return "I'll bring this to you and ask how to proceed.";
  }
}

/** Short badge caption sitting under the tier name. */
export function tierCaption(stage: Stage): string {
  switch (stage) {
    case "Acting":
      return "Acts on your behalf";
    case "Confirming":
      return "Waits for your confirmation";
    default:
      return "Waits for your guidance";
  }
}

// --- progress toward the next tier -------------------------------------
//
// The discretion bar still exists and still gates *within* `Acting`, but it
// no longer names the stage. It is shown as evidence accumulating toward
// the next promotion, which is Reflection's decision — not a threshold
// crossing the UI can predict.

/** The obs-count discretion bar (mirrors `discretion.get_discretion_threshold`). */
export function discretionThreshold(matchCount: number): number {
  if (matchCount < 5) return 0.95;
  if (matchCount < 10) return 0.9;
  if (matchCount < 20) return 0.85;
  if (matchCount < 50) return 0.8;
  return 0.75;
}

/**
 * The effective bar: an explicit `discretion_threshold` may only RAISE it.
 * Mirrors `discretion.effective_threshold` (#445/#446).
 */
export function effectiveThreshold(instinct: any, matchCount: number): number {
  const earned = discretionThreshold(matchCount);
  const raw =
    instinct?.frontmatter?.discretion_threshold ??
    instinct?.discretion_threshold;
  if (raw === null || raw === undefined) return earned;
  const f = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  if (!Number.isFinite(f) || f < 0) return earned;
  return Math.max(earned, Math.min(f, 1));
}

/** The next rung, or null when already at the top. */
export function nextTier(stage: Stage): Stage | null {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

// --- pending Acting promotion (#452 / #459) ------------------------------------
// `pending_promotion: Acting` is NOT the tier — the instinct stays at its
// current rung until Sir approves via `resolve_instinct_promotion` (Lane I).

/** Whether this instinct has a pending promotion to Acting (#459).
 *  CRITICAL: true does NOT mean the instinct is Acting — readTier disagrees. */
export function hasPendingPromotion(instinct: any): boolean {
  const raw =
    instinct?.frontmatter?.pending_promotion ?? instinct?.pending_promotion;
  return typeof raw === "string" && raw.trim() === "Acting";
}

/** The tier the instinct is being promoted FROM. Fails closed to "Asking". */
export function pendingPromotionFrom(instinct: any): Stage {
  const raw =
    instinct?.frontmatter?.pending_promotion_from ??
    instinct?.pending_promotion_from;
  if (typeof raw !== "string") return "Asking";
  const trimmed = raw.trim();
  const normalized =
    trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  return (STAGES as string[]).includes(normalized)
    ? (normalized as Stage)
    : "Asking";
}

/**
 * How the evidence line should read. Promotion is Reflection-driven, so
 * this deliberately promises nothing about when it will happen.
 */
export function progressNote(stage: Stage, matchCount: number): string {
  const n = Math.max(0, Math.trunc(matchCount));
  const obs = `${n} observation${n === 1 ? "" : "s"}`;
  const next = nextTier(stage);
  return next === null
    ? `${obs} recorded. This is the highest tier.`
    : `${obs} recorded. Alfred proposes ${next} when the pattern holds.`;
}
