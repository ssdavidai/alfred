// hermesHealthCore — pure derivation of Hermes auth health from the
// onboarding progress shape.
//
// Phase-4 ``_safe_stage_wrapper`` stamps failed Opus stages on
// ``onboard.json["degraded_stages"]`` and the pipeline reaches ``done``
// without surfacing anything to the UI. A recent, non-empty list strongly
// implies the LLM auth path is broken — this helper is the passive signal
// the banner consumes. Import-free so it unit-tests under node:test.

/** Hermes health verdict derived from a progress snapshot. */
export interface HermesHealth {
  healthy: boolean;
  degradedStages: string[];
  /** True iff a degrade timestamp is within the last hour. Stale signals
   *  do NOT fire the banner — the operator may already have re-auth'd. */
  lastDegradeWithinHour: boolean;
}

const HEALTHY: HermesHealth = {
  healthy: true,
  degradedStages: [],
  lastDegradeWithinHour: false,
};

const ONE_HOUR_MS = 60 * 60 * 1000;

// Field names we accept as the "this run started / was updated at" anchor.
// Tried in order; first parseable wins. Keeps the helper robust to small
// backend field-name churn.
const TIMESTAMP_KEYS = ["degraded_at", "updated_at", "last_updated", "started_at"] as const;

function parseIsoMillis(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * Fail-safe by design: any parse / shape oddity returns ``HEALTHY`` so the
 * banner never fires on transport hiccups or malformed payloads.
 */
export function deriveHermesHealthFromProgress(
  progress: unknown,
  now: number = Date.now(),
): HermesHealth {
  if (!progress || typeof progress !== "object") return HEALTHY;
  const p = progress as Record<string, unknown>;

  const raw = p.degraded_stages;
  if (!Array.isArray(raw) || raw.length === 0) return HEALTHY;
  const degradedStages = raw.filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (degradedStages.length === 0) return HEALTHY;

  let lastDegradeWithinHour = false;
  for (const key of TIMESTAMP_KEYS) {
    const t = parseIsoMillis(p[key]);
    if (t !== null && now - t <= ONE_HOUR_MS && now - t >= 0) {
      lastDegradeWithinHour = true;
      break;
    }
  }
  if (!lastDegradeWithinHour) return HEALTHY;

  return { healthy: false, degradedStages, lastDegradeWithinHour: true };
}
