/**
 * Phase-2 Lane III · Commit 2 — Day-1 introduction badge for /desk.
 *
 * The onboarding pipeline seeds a small set of `needs_attention` records
 * the first time a principal lands on /desk. They are marked by
 *
 *   source: "onboarding_seed"
 *   tags:   [..., "day_one", ...]
 *
 * Per C-OB3, when a card carries BOTH markers we render a subtle
 * "Day-1 introduction" pill next to the title so the principal
 * understands the item is a starter Alfred raised from their
 * onboarding analysis, not a real-world signal that just landed.
 *
 * Both fields can live top-level (newer ctrl-api payloads flatten
 * useful fields onto the root) or under `frontmatter.*` (older shape).
 * `extractDayOneMarkers` reads either; `isDayOneIntroduction` is the
 * final predicate the card uses. Pure, no React dependency.
 */

export interface DayOneMarkers {
  source: string | null;
  tags: string[];
}

/** Accept a JSON array, a comma-separated string, or undefined. */
function normaliseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
  }
  return [];
}

export function extractDayOneMarkers(record: unknown): DayOneMarkers {
  if (!record || typeof record !== "object") {
    return { source: null, tags: [] };
  }
  const r = record as Record<string, unknown>;
  const fm =
    r.frontmatter && typeof r.frontmatter === "object"
      ? (r.frontmatter as Record<string, unknown>)
      : {};

  const rawSource = r.source ?? fm.source ?? null;
  const source =
    typeof rawSource === "string" && rawSource.trim() ? rawSource.trim() : null;

  // Tags may live in either location; combine and dedupe.
  const tags = Array.from(
    new Set([...normaliseTags(r.tags), ...normaliseTags(fm.tags)]),
  );

  return { source, tags };
}

/** True iff BOTH markers are present. A card with only one is something
 *  else (an onboarding-seeded chore prompt, a real signal that happens
 *  to share the tag) and must not earn the pill. */
export function isDayOneIntroduction(markers: DayOneMarkers): boolean {
  if (markers.source !== "onboarding_seed") return false;
  return markers.tags.includes("day_one");
}
