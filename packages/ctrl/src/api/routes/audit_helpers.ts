// audit_helpers.ts
//
// STORE-P2-2b: in-process wrapper that lets the ctrl-api Desk-action
// handlers write into the unified `audit` table (migration 003) in
// shadow alongside the legacy `event/<kind>-*.md` markdown writes. The
// mirror of alfred-learn's `audit_writer.write_audit_safe` (see
// packages/learn/src/activities/audit_writer.py) for the writers that
// live in TypeScript instead of Python.
//
// Why this is its own module: the existing `routes/audit.ts` exposes
// `POST /api/v1/audit` for cross-language callers (alfred-learn POSTs
// to it). The Desk handlers in this same Node process don't need to
// loop back through HTTP — they call `insertAudit` directly. We isolate
// the env-gating + best-effort try/catch so call sites stay one line.
//
// Enforcement gate matches the Python side:
//
//   shadow  (default) — write BOTH the legacy markdown AND insert the
//                       audit row; swallow + log any insert error so a
//                       broken audit row never starves the primary
//                       request.
//   warn              — same as shadow but log at WARN when a legacy
//                       markdown sibling was also written. Reserved.
//   reject            — same but throw if the caller also wrote the
//                       legacy markdown sibling. Reserved.
//
// Only `shadow` is exercised today; warn/reject are scaffolded so the
// post-soak flip is one env-var flip away. Per the STORE-P2-2b epic,
// this PR does NOT flip the env.

import { openStateDb } from "../../db/state.js";
import { insertAudit } from "../../db/audit_queries.js";

export const STATE_AUDIT_ENFORCEMENT_ENV = "STATE_AUDIT_ENFORCEMENT";
const VALID_MODES = ["shadow", "warn", "reject"] as const;
export type AuditEnforcementMode = (typeof VALID_MODES)[number];

export function currentEnforcementMode(): AuditEnforcementMode {
  const raw = (process.env[STATE_AUDIT_ENFORCEMENT_ENV] || "shadow")
    .trim()
    .toLowerCase();
  if ((VALID_MODES as readonly string[]).includes(raw)) {
    return raw as AuditEnforcementMode;
  }
  console.warn(
    `[audit_helpers] unrecognised ${STATE_AUDIT_ENFORCEMENT_ENV}=${raw} — defaulting to shadow`,
  );
  return "shadow";
}

export interface EmitAuditSafeParams {
  actor: string;
  action_type: string;
  target_type: string;
  target_id: string;
  decision_origin?: string | null;
  reasoning?: string | null;
  payload: Record<string, unknown>;
  reversible?: boolean;
  // Whether the caller also wrote a legacy `event/<kind>-*.md` sibling
  // for this audit emission. Only consulted by `warn` and `reject`
  // modes; `shadow` ignores it.
  wroteLegacyMarkdown?: boolean;
}

// Insert one audit row, fire-and-forget. Errors are logged but never
// thrown to the caller in `shadow` mode — the primary mutation (the
// markdown write) has already landed and the audit row is currently
// secondary. Returns the inserted row id on success, null on failure.
export function emitAuditSafe(params: EmitAuditSafeParams): string | null {
  const mode = currentEnforcementMode();

  // Reserved-mode side effects: log/throw on the legacy markdown twin
  // before attempting the insert. We do not gate the insert on these —
  // the audit row should always land, the enforcement modes only
  // change what happens to the legacy writer.
  if (params.wroteLegacyMarkdown) {
    if (mode === "warn") {
      console.warn(
        `[audit_helpers] legacy markdown still being written alongside audit row ` +
          `(action=${params.action_type} target=${params.target_type}/${params.target_id}) ` +
          `— STATE_AUDIT_ENFORCEMENT=warn`,
      );
    } else if (mode === "reject") {
      // Final-cutover state — legacy writes must already be gone. We
      // surface this as a hard failure so the caller can be fixed.
      throw new Error(
        `STATE_AUDIT_ENFORCEMENT=reject: legacy markdown twin written for ` +
          `action=${params.action_type} target=${params.target_type}/${params.target_id}`,
      );
    }
  }

  try {
    const db = openStateDb();
    return insertAudit(db, {
      actor: params.actor,
      action_type: params.action_type,
      target_type: params.target_type,
      target_id: params.target_id,
      decision_origin: params.decision_origin ?? null,
      reasoning: params.reasoning ?? null,
      payload: JSON.stringify(params.payload),
      reversible: params.reversible ? 1 : 0,
      reversed_by: null,
    });
  } catch (err) {
    // Audit emission must never starve the primary request — log
    // loudly and let the caller continue. The legacy markdown sibling
    // is still the authoritative record during the shadow soak, so a
    // missing row is recoverable by re-running a backfill.
    console.warn(
      `[audit_helpers] emitAuditSafe FAILED action=${params.action_type} ` +
        `target=${params.target_type}/${params.target_id} err=${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return null;
  }
}
