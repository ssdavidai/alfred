// matterShapeCore — pure helpers for the matter-detail "shape" view (F54).
// Import-free (no React/Wasp) so it unit-tests under node:test without booting
// the Wasp env (same split as reconcileCore.ts / chatProxyCore.ts).

/**
 * Count bullet/numbered items under a named markdown section in a matter body
 * (e.g. "## Key people"). Deterministic; 0 when absent; stops at the next
 * heading of any level.
 */
export function countSectionItems(about: string, heading: string): number {
  if (!about) return 0;
  const lines = about.split(/\r?\n/);
  const headRe = new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "i");
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      // A heading line — entering our section, or leaving it for another.
      inSection = headRe.test(line);
      continue;
    }
    if (!inSection) continue;
    if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) count += 1;
  }
  return count;
}
