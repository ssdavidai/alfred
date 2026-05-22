// deskLedgerCore — pure reversibility predicate for ledger rows (F51).
// Import-free (no React/Wasp) so it unit-tests under node:test.

/**
 * A ledger row is reversible iff the source record marked it so
 * (`is_reversible`/`reversible`) AND it hasn't already been reversed
 * (`reversed_at` empty) AND it carries an id to reverse against. Was hardcoded
 * `false` for decision rows, so the Undo control never appeared even though the
 * reverseDecision op already existed.
 */
export function rowReversible(
  row: { is_reversible?: unknown; reversible?: unknown; reversed_at?: unknown },
  id: string | undefined | null,
): boolean {
  const flagged = Boolean(row?.is_reversible ?? row?.reversible ?? false);
  const reversed = Boolean(row?.reversed_at);
  return flagged && !reversed && Boolean(id);
}
