// ============================================================================
// The promotion contract — alfred-black's hard storage rule.
//
//   "A record exists in the vault only if the principal has a reason to read
//    or edit it. Everything else is SQLite."
//
// (PLAN.md Part I. Also stated in the repo-root CLAUDE.md.)
//
// The vault (Store 1, markdown) holds exactly ~12 canonical record types. Any
// other record type is DEMOTED:
//   * audit-class actions  → alfred-state.db `audit` table
//   * signals / observations / patterns → alfred-state.db `signal` / `observation`
//   * raw stream events    → ingest.db `stream_event`
//
// ctrl-api is the sole vault writer. Every vault write route MUST call
// `assertCanonicalVaultPath` before touching the filesystem, so a non-canonical
// record can never be written as markdown.
// ============================================================================

// PromotionContractError extends ApiError so ctrl-api's handleError maps it
// straight to a 422 with a structured body.
import { ApiError } from "../api/errors.js";

/**
 * The 12 canonical vault record types. Each is a top-level directory under
 * VAULT_PATH; a record lives at `<type>/<slug>.md` (state transitions may move
 * it into a `<type>/_closed/` subdirectory — still canonical).
 */
export const CANONICAL_RECORD_TYPES = [
  "matter",
  "task",
  "note",
  "person",
  "org",
  "place",
  "asset",
  "chore",
  "instinct",
  "decision",
  "briefing",
  "daybook",
] as const;

export type CanonicalRecordType = (typeof CANONICAL_RECORD_TYPES)[number];

const CANONICAL_SET = new Set<string>(CANONICAL_RECORD_TYPES);

/**
 * Top-level vault paths that are allowed but are NOT record-type directories:
 * the soul/rules singletons and the template directory the seed scaffolds.
 */
export const CANONICAL_TOP_LEVEL_FILES = new Set<string>(["SOUL.md", "RULES.md"]);
// Directories ctrl-api itself manages that are NOT principal-authored record
// types but are still legitimate vault writes:
//   _templates/       — the seed scaffolds these.
//   needs_attention/  — the Desk "please decide" queue. ctrl-api OWNS this
//     directory: it lists it (GET /api/v1/admin/needs-attention), reads each
//     card off the filesystem, and exposes done/dispatch/skip handlers for it
//     (routes/attention.ts). The signal router writes a card here when a
//     signal needs a human decision. The promotion contract's long-term
//     intent is to move these into state.db as routed signals (storage epic
//     cutover #28), but the entire READ + Desk-UI path is still built around
//     vault markdown — so until that cutover lands, blocking the WRITE just
//     breaks the Desk (a routed signal could never surface). Allowing
//     ctrl-api's own managed dir is the coherent interim posture. (#78)
export const CANONICAL_NON_RECORD_DIRS = new Set<string>([
  "_templates",
  "needs_attention",
]);

/**
 * Demoted types and where each one now lives. Surfaced in error messages so a
 * caller that tries to write a demoted type gets told the correct store.
 */
export const DEMOTED_TYPES: Record<string, string> = {
  // → alfred-state.db `audit`
  "signal-action": "alfred-state.db audit table (POST /api/v1/state/audit)",
  "steward-action": "alfred-state.db audit table (POST /api/v1/state/audit)",
  "desk-action": "alfred-state.db audit table (POST /api/v1/state/audit)",
  "state-change": "alfred-state.db audit table (POST /api/v1/state/audit)",
  "needs_attention_action": "alfred-state.db audit table (POST /api/v1/state/audit)",
  event: "alfred-state.db audit table (POST /api/v1/state/audit)",
  // → alfred-state.db `signal` / `observation`
  signal: "alfred-state.db signal table (POST /api/v1/state/signals)",
  observation: "alfred-state.db observation table (POST /api/v1/state/observations)",
  pattern_proposal: "alfred-state.db observation table (kind=pattern_proposal)",
  decision_pattern: "alfred-state.db observation table (kind=pattern_proposal)",
  synthesis: "alfred-state.db observation table (kind=synthesis)",
  contradiction: "alfred-state.db observation table (kind=contradiction)",
  assumption: "alfred-state.db observation table (kind=assumption)",
  constraint: "alfred-state.db observation table (kind=constraint)",
  // NOTE: `needs_attention` is intentionally NOT demoted here — it is an
  // allowed ctrl-api-managed dir (see CANONICAL_NON_RECORD_DIRS above). The
  // state.db migration of the Desk queue is storage-epic cutover #28; until
  // the READ path moves, the card must be writable as vault markdown. (#78)
  // → ingest.db
  stream_event: "ingest.db stream_event table (POST /api/v1/ingest/events)",
  streams: "ingest.db stream_event table (POST /api/v1/ingest/events)",
};

export class PromotionContractError extends ApiError {
  readonly recordType: string;
  readonly destination: string | null;
  constructor(recordType: string, destination: string | null) {
    super(
      422,
      "PROMOTION_CONTRACT_VIOLATION",
      destination
        ? `Record type "${recordType}" is not a canonical vault type — ` +
            `it is demoted by the promotion contract. Write it to: ${destination}.`
        : `Record type "${recordType}" is not a canonical vault type. ` +
            `Allowed: ${CANONICAL_RECORD_TYPES.join(", ")}.`,
      { recordType, destination },
    );
    this.name = "PromotionContractError";
    this.recordType = recordType;
    this.destination = destination;
  }
}

/** Normalise a vault path to forward slashes and strip a leading "./". */
function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Extract the record-type segment from a vault-relative path.
 *   "matter/acme.md"          → "matter"
 *   "matter/_closed/acme.md"  → "matter"
 *   "SOUL.md"                 → "SOUL.md"
 */
export function recordTypeOf(vaultRelPath: string): string {
  const norm = normalize(vaultRelPath);
  if (!norm.includes("/")) return norm;
  return norm.split("/")[0];
}

export function isCanonicalRecordType(t: string): t is CanonicalRecordType {
  return CANONICAL_SET.has(t);
}

/**
 * Enforce the promotion contract for a vault write. Throws
 * PromotionContractError if `vaultRelPath` is not a canonical record type.
 *
 * Call this from every ctrl-api route that creates / edits / moves a vault
 * markdown file, BEFORE touching the filesystem.
 */
export function assertCanonicalVaultPath(vaultRelPath: string): CanonicalRecordType {
  const norm = normalize(vaultRelPath);

  // Path-traversal guard — defence in depth; route handlers also guard.
  if (norm.includes("..")) {
    throw new PromotionContractError(norm, null);
  }

  // Top-level singletons (SOUL.md, RULES.md) are allowed as-is.
  if (!norm.includes("/")) {
    if (CANONICAL_TOP_LEVEL_FILES.has(norm)) {
      // Not a record-type dir; return a harmless sentinel by treating it as
      // canonical. Callers that need the type should check separately.
      return "note";
    }
    throw new PromotionContractError(norm, DEMOTED_TYPES[norm] ?? null);
  }

  const type = norm.split("/")[0];

  if (CANONICAL_NON_RECORD_DIRS.has(type)) {
    // _templates/* — the seed scaffolds these; allowed.
    return "note";
  }

  if (!CANONICAL_SET.has(type)) {
    throw new PromotionContractError(type, DEMOTED_TYPES[type] ?? null);
  }
  return type as CanonicalRecordType;
}

/** Non-throwing variant — returns true if the path is a writable canonical path. */
export function isCanonicalVaultPath(vaultRelPath: string): boolean {
  try {
    assertCanonicalVaultPath(vaultRelPath);
    return true;
  } catch {
    return false;
  }
}
