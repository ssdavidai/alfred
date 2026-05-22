// auditLedgerCore — pure helpers for the C12 audit-ledger view (F53).
// Import-free (no React/Wasp) so it unit-tests under node:test.

/**
 * Normalise the mixed-casing `action_type` (signal-action / desk_action /
 * needs_attention_action / decision) into a single display label. The SQL
 * ledger stores both hyphen and underscore conventions across writers; the UI
 * shows one casing.
 */
export function auditKindLabel(actionType: string): string {
  return (actionType || "").replace(/[_-]+/g, " ").trim().toUpperCase() || "ACTION";
}
