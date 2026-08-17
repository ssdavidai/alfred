// instinctOpsCore — pure, testable helpers for the /instincts surface.
//
// Extracted so the slug-derivation, observation-endpoint path, and row-prose
// logic can be unit-tested independently of Wasp's server scaffold.

/** State-store endpoint for observations (demoted type, §5.1).
 * Observations live in alfred-state.db, NOT in vault/observation/.
 * The vault directory holds 0 files on live tenants; all 5,900+ records
 * are in state.db.observation. */
export const OBSERVATION_PATH = "/api/v1/state/observations";

/**
 * Derive the API slug from a vault path string.
 *
 *   instinct/foo-bar.md   → foo-bar
 *   foo-bar.md            → foo-bar
 *   foo-bar               → foo-bar
 *   instinct/foo.bar.baz  → foo.bar.baz   (mid-string dots preserved)
 */
export function deriveInstinctSlug(path: string): string {
  const base = String(path).split("/").pop() ?? path;
  // Only strip a trailing ".md" — do not touch dots elsewhere in the name.
  return base.replace(/\.md$/, "");
}

/**
 * Extract display prose from a state DB observation row or a legacy vault
 * record.  Returns "" (empty string — never "—") when no text is present,
 * so callers can suppress the row entirely instead of rendering a stray bullet.
 *
 * State DB shape:  o.summary  (TEXT NOT NULL in schema)
 * Legacy vault shape: o.frontmatter.fact
 */
export function observationProseFromRow(o: unknown): string {
  if (!o || typeof o !== "object") return "";
  const row = o as Record<string, unknown>;
  // State DB: summary is the canonical text field.
  const summary = String(row.summary ?? "").trim();
  if (summary) return summary;
  // Legacy vault-record fallback: fact written by extract_observation_from_decision.
  const fm = (typeof row.frontmatter === "object" && row.frontmatter !== null
    ? row.frontmatter
    : {}) as Record<string, unknown>;
  const fact = String(fm.fact ?? "").trim();
  if (fact) return fact;
  return "";
}
