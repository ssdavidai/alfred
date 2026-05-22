// deskReconcileCore — pure reconcile logic for Desk decision clicks (F50).
// Import-free (no React/Wasp) so it unit-tests under node:test without booting
// the Wasp env (same split as reconcileCore.ts / chatProxyCore.ts).

export type DeskAction = "delegate" | "defer" | "delete" | "do" | "noise";

/** The `side_effects` object on a 2xx POST /api/v1/decisions response. */
export interface DecisionSideEffects {
  nothing_to_delegate?: boolean;
  dispatch_ok?: boolean;
  dispatch_error?: string;
  [k: string]: unknown;
}

/**
 * Decide whether a card clears from the Desk given a 2xx decision response's
 * side-effects. Delegate is the only no-op-on-2xx case: an advisory card
 * (nothing_to_delegate) or a failed dispatch (dispatch_ok:false) leaves the
 * source pending server-side, so the card must stay (failure != success).
 */
export function shouldClearCardOnSuccess(
  action: DeskAction,
  sideEffects: DecisionSideEffects | null | undefined,
): boolean {
  const fx = sideEffects ?? {};
  if (action === "delegate") {
    return fx.nothing_to_delegate !== true && fx.dispatch_ok !== false;
  }
  return true;
}
