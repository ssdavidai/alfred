// State-field allowlists for the state-mutation contract (#889).
//
// Per spec §2 and §4: a "state field" is a frontmatter key whose change
// requires audit provenance — every write must flow through
// POST /api/v1/state-changes and produce a `state_change` timeline
// entry plus an `event/state-change-*` audit record.
//
// These allowlists are consumed by:
//   * routes/stateChanges.ts — POST handler rejects `fields` containing
//     keys outside the target's allowlist.
//   * routes/vault.ts — legacy PATCH endpoint inspects body for any
//     state-field touch and dispatches on STATE_CHANGE_ENFORCEMENT
//     (warn|reject).

export type StateFieldTarget = "matter" | "task";

export const MATTER_STATE_FIELDS: readonly string[] = [
  "current_state",
  "as_of",
  "status",
  "surface_class",
  "last_briefing_at",
];

export const TASK_STATE_FIELDS: readonly string[] = [
  "current_state",
  "as_of",
  "status",
  "outcome",
  "pending_confirmation",
  "last_steward_outcome",
];

export function stateFieldsFor(target: StateFieldTarget): readonly string[] {
  return target === "matter" ? MATTER_STATE_FIELDS : TASK_STATE_FIELDS;
}

/** Classify a vault path as a state-mutation target, or null if it isn't one. */
export function classifyTarget(relPath: string): StateFieldTarget | null {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("matter/") && normalized.endsWith(".md")) return "matter";
  if (normalized.startsWith("task/") && normalized.endsWith(".md")) return "task";
  return null;
}

/** Intersection of a candidate field set with the target's state-field allowlist. */
export function pickStateFields(target: StateFieldTarget, fields: Iterable<string>): string[] {
  const allow = new Set(stateFieldsFor(target));
  const hits: string[] = [];
  for (const f of fields) {
    if (allow.has(f)) hits.push(f);
  }
  return hits;
}
