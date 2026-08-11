// Matter/task narrative provenance classifier (#543, extends #318 pattern).
// Rules: (1) "unknown" never renders as "fresh" — absent narrative ≠ current.
//        (2) observed_at is the as_of value verbatim — never now() or generated_at.

export interface NarrativeProvenance {
  source: "nightly_narrative" | null;
  observed_at: string | null;   // as_of verbatim — never the request timestamp
  freshness: "fresh" | "stale" | "unknown";
}

/** Age threshold beyond which a narrative is stale. NightlyNarrativeWorkflow
 *  runs ~every 24 h; 36 h buffer covers delayed runs. */
export const NARRATIVE_STALE_HOURS = 36;

/** Classify the narrative provenance from a matter/task `as_of` frontmatter field.
 *  @param nowMs  Injectable for deterministic tests; defaults to Date.now(). */
export function classifyNarrativeProvenance(
  asOf: string | null | undefined,
  nowMs: number = Date.now(),
): NarrativeProvenance {
  if (!asOf || !asOf.trim()) {
    return { source: null, observed_at: null, freshness: "unknown" };
  }
  const observedMs = Date.parse(asOf.trim());
  if (!Number.isFinite(observedMs) || Number.isNaN(observedMs)) {
    return { source: null, observed_at: null, freshness: "unknown" };
  }
  const ageHours = (nowMs - observedMs) / (1_000 * 60 * 60);
  return {
    source: "nightly_narrative",
    observed_at: asOf.trim(),
    freshness: ageHours < NARRATIVE_STALE_HOURS ? "fresh" : "stale",
  };
}
