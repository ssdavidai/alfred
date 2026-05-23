/**
 * Pure helper for composing the on-wire vault/RULES.md content the
 * `/household` Save handler hands to `createVaultRecord`. ctrl-api
 * persists `content` verbatim, so the page must send a complete
 * markdown file (frontmatter + body), not body alone — stripping the
 * frontmatter would lose `type: note`, `subtype: standing_rules`,
 * `created`, `created_by` and the C-OB2 contract on the next read.
 * Extracted from HouseholdPage so it can be unit-tested without React.
 */

/** Compose `frontmatter + body` into a complete on-wire vault note. */
export function composeRulesFile(
  frontmatter: Record<string, unknown> | null | undefined,
  body: string,
): string {
  const fm: Record<string, unknown> = { ...(frontmatter ?? {}) };
  if (!fm.type) fm.type = "note";
  if (!fm.subtype) fm.subtype = "standing_rules";
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(`${k}: ${serialiseScalar(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n") + body;
}

/** Minimal YAML-scalar emitter — quote anything with YAML-special
 *  punctuation; pass simple identifiers / single-word statuses through. */
function serialiseScalar(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === "string") {
    if (/[:#\n"']/.test(v)) return JSON.stringify(v);
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
