/**
 * Phase-3 Lane III · Commit 1 — pure parse/serialize helpers for the
 * structured RULES.md editor on /household. Consumes C-OB2 schema (4
 * sections: sovereignty / household / communication / decision; each
 * rule a `- <text>` bullet; empty sections omitted on serialize).
 *
 * Frontmatter is preserved by the page's update path, NOT here — these
 * helpers operate on the body string alone.
 */

export interface RulesSections {
  sovereignty: string[];
  household: string[];
  communication: string[];
  decision: string[];
}

// Canonical render order. Load-bearing — the serializer emits sections
// in this order so round-trip is stable.
export const SECTION_ORDER: ReadonlyArray<keyof RulesSections> = [
  "sovereignty", "household", "communication", "decision",
] as const;

export const SECTION_HEADING: Record<keyof RulesSections, string> = {
  sovereignty: "Personal sovereignty rules",
  household: "Household rules",
  communication: "Communication rules",
  decision: "Decision rules",
};

// Map a `## ...` heading to a section key. Tolerant of case + trailing
// punctuation so a hand-edited file doesn't break the editor.
function headingKey(raw: string): keyof RulesSections | undefined {
  const norm = raw.trim().toLowerCase().replace(/[.:]+$/, "");
  if (norm.includes("sovereign")) return "sovereignty";
  if (norm.includes("household")) return "household";
  if (norm.includes("communicat")) return "communication";
  if (norm.includes("decision")) return "decision";
  return undefined;
}

/** Parse a C-OB2 RULES.md body. Missing sections → empty arrays. Empty
 *  input → 4 empty arrays. Unknown `##` headings, non-bullet body lines,
 *  and the top-level `# ...` title are all silently ignored. */
export function parseRulesMarkdown(body: string): RulesSections {
  const out: RulesSections = {
    sovereignty: [], household: [], communication: [], decision: [],
  };
  if (!body || !body.trim()) return out;

  let cur: keyof RulesSections | undefined;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (line.startsWith("## ")) { cur = headingKey(line.slice(3)); continue; }
    if (line.startsWith("#")) { cur = undefined; continue; }
    if (!cur) continue;
    const m = /^[\-*+]\s+(.*)$/.exec(line.trim());
    if (m) {
      const text = m[1].trim();
      if (text) out[cur].push(text);
    }
  }
  return out;
}

/** Serialize the 4 typed arrays back to a C-OB2 body. Empty sections
 *  are omitted; the `# Standing Rules` title is always emitted; ends
 *  with a single trailing newline. */
export function serializeRules(sections: RulesSections): string {
  const lines: string[] = ["# Standing Rules", ""];
  let emitted = 0;
  for (const key of SECTION_ORDER) {
    const items = sections[key] ?? [];
    if (items.length === 0) continue;
    if (emitted > 0) lines.push("");
    lines.push(`## ${SECTION_HEADING[key]}`);
    for (const item of items) {
      const text = item.trim();
      if (text) lines.push(`- ${text}`);
    }
    emitted += 1;
  }
  return lines.join("\n") + "\n";
}
