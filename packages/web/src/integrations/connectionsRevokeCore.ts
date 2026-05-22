// connectionsRevokeCore — pure helpers for the revoke modal (F72).
// Import-free (no React/Wasp) so it unit-tests under node:test.

export interface RevokeConn {
  id: string;
  toolkit: string;
  status?: string;
}

/**
 * Is this connection the last ACTIVE account of its toolkit? Drives the
 * consequence copy: revoking the last account removes the stream + skill + all
 * tool access; revoking one of several leaves the toolkit's skill and the
 * sibling accounts live, so the copy must not over-promise.
 *
 * Webhook rows (id `webhook:<token>`) are singletons — always "last".
 */
export function isLastAccountOfToolkit(
  target: RevokeConn,
  all: ReadonlyArray<RevokeConn>,
): boolean {
  if (target.id.startsWith("webhook:")) return true;
  const siblings = all.filter(
    (c) =>
      c.toolkit === target.toolkit &&
      c.id !== target.id &&
      String(c.status ?? "ACTIVE").toUpperCase() === "ACTIVE",
  );
  return siblings.length === 0;
}

/** Consequence copy, conditional on whether it's the last account. */
export function revokeConsequenceCopy(label: string, isLast: boolean): string {
  return isLast
    ? `Revoke ${label}? This removes the stream, skill, and all tool access.`
    : `Revoke this ${label} account? Other ${label} accounts (and the ${label} skill) stay connected.`;
}
