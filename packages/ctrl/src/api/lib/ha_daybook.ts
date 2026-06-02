// Daybook entries for HA writes — Tier 4 audit contract (#115/#158 PR1).
//
// Sir locked YES on 2026-05-29 to "daybook entry per write" for HA
// surface mutations. This helper is the load-bearing implementation —
// every Tier 4 destructive verb that lands a change calls
// `recordHaWriteToDaybook(action, payload, decision_ref)` near the end of
// its handler so the principal has a single chronological surface for
// every change Alfred made to the home.
//
// Cheap reversible verbs (scene_create, entity_rename, addon_start,
// addon_stop, automation_create, area_create) call with `silent: true`
// and the helper no-ops — Sir doesn't want a daybook entry for "Alfred
// renamed the kitchen light", that's noise. Only writes that change
// behaviour Sir would notice (core_restart, addon_install,
// integration_add, user_create, backup_restore) record.
//
// Where it writes
// ---------------
// Daybook is one of the 12 canonical vault types (CLAUDE.md). One record
// per day at `daybook/<YYYY-MM-DD>.md`. We APPEND to the day's record
// (creating it on first call) rather than spawn a new file per HA write —
// the principal's daily reading flow stays single-file.
//
// Format
// ------
// The appended block is a small YAML/markdown chunk:
//
//     - ts: 2026-05-29T18:42:17Z
//       kind: ha_write
//       action: ha__core_restart
//       decision_ref: 01JC7K…
//       summary: HA core restarted (2025.6.1 → 2025.7.0)
//
// We don't surgery the YAML frontmatter — we append under a `## HA
// writes` section if it exists, otherwise create the section. Idempotent
// reading: the principal-facing dashboard re-renders from disk and never
// edits these blocks.

import fs from "node:fs";
import path from "node:path";

// Read VAULT_PATH directly from env rather than importing from
// routes/vault.js — that file's transitive import of every route module
// triggers a temporal-dead-zone error when this helper is reached
// during module init. The env contract is identical to vault.ts:34.
const VAULT_PATH = process.env.VAULT_PATH ?? "/vault";

const DAYBOOK_DIR = "daybook";
const HA_WRITES_SECTION = "## HA writes";

export interface HaDaybookEntry {
  /** The verb that triggered the entry (e.g. 'ha__core_restart'). */
  action: string;
  /** Free-form summary line — what changed. Required when not silent. */
  summary?: string;
  /** Desk decision id that authorised the action; NULL for non-gated verbs. */
  decision_ref?: string | null;
  /** When set, the helper no-ops (used for cheap reversible verbs). */
  silent?: boolean;
  /** Extra fields recorded as YAML — keep it small. */
  extra?: Record<string, unknown>;
}

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoTs(): string {
  return new Date().toISOString();
}

function ensureDaybookFile(dayPath: string, day: string): void {
  if (fs.existsSync(dayPath)) return;
  const dir = path.dirname(dayPath);
  fs.mkdirSync(dir, { recursive: true });
  const seed = `---
type: daybook
date: "${day}"
status: open
created: "${day}"
tags: []
---

# Daybook — ${day}

The running log for the day: notes, events, and observations the
principal jots down as the day unfolds.

${HA_WRITES_SECTION}

`;
  fs.writeFileSync(dayPath, seed, "utf-8");
}

function appendUnderSection(dayPath: string, block: string): void {
  let existing = "";
  try {
    existing = fs.readFileSync(dayPath, "utf-8");
  } catch {
    existing = "";
  }
  if (existing.includes(HA_WRITES_SECTION)) {
    // Append at end (the section already exists; the principal may have
    // hand-written notes after it — appending to EOF is the
    // least-invasive option).
    if (!existing.endsWith("\n")) existing += "\n";
    existing += block;
    fs.writeFileSync(dayPath, existing, "utf-8");
    return;
  }
  // No section yet — append section header + the block.
  if (!existing.endsWith("\n")) existing += "\n";
  existing += `\n${HA_WRITES_SECTION}\n\n${block}`;
  fs.writeFileSync(dayPath, existing, "utf-8");
}

function renderBlock(entry: HaDaybookEntry): string {
  const lines: string[] = [
    `- ts: ${isoTs()}`,
    `  kind: ha_write`,
    `  action: ${entry.action}`,
  ];
  if (entry.decision_ref) {
    lines.push(`  decision_ref: ${entry.decision_ref}`);
  }
  if (entry.summary) {
    // YAML-safe — quote any line with a colon or hash.
    const needsQuote = /[:#\n]/.test(entry.summary);
    const summary = needsQuote
      ? JSON.stringify(entry.summary)
      : entry.summary;
    lines.push(`  summary: ${summary}`);
  }
  if (entry.extra) {
    for (const [k, v] of Object.entries(entry.extra)) {
      const safeK = k.replace(/[^a-zA-Z0-9_]/g, "_");
      const safeV =
        typeof v === "string"
          ? /[:#\n]/.test(v)
            ? JSON.stringify(v)
            : v
          : JSON.stringify(v);
      lines.push(`  ${safeK}: ${safeV}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Record an HA write to the daybook. No-ops when `silent: true` is set
 * — used by cheap reversible verbs that Sir doesn't want noise on.
 *
 * Returns `{written: boolean, path: string}` so callers can include
 * the daybook ref in their response payload.
 */
export function recordHaWriteToDaybook(entry: HaDaybookEntry): {
  written: boolean;
  path: string;
} {
  const day = dayStamp();
  const dayPath = path.join(VAULT_PATH, DAYBOOK_DIR, `${day}.md`);
  const relPath = `${DAYBOOK_DIR}/${day}.md`;
  if (entry.silent) {
    return { written: false, path: relPath };
  }
  try {
    ensureDaybookFile(dayPath, day);
    const block = renderBlock(entry);
    appendUnderSection(dayPath, block);
    return { written: true, path: relPath };
  } catch (err) {
    // Daybook is best-effort — a failed write must NOT block the HA action.
    console.warn(
      "[ha_daybook] write failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { written: false, path: relPath };
  }
}

/** Test-only: read back the day's HA writes block (best-effort). */
export function _readTodaysDaybookForTests(): string {
  const day = dayStamp();
  const dayPath = path.join(VAULT_PATH, DAYBOOK_DIR, `${day}.md`);
  try {
    return fs.readFileSync(dayPath, "utf-8");
  } catch {
    return "";
  }
}
