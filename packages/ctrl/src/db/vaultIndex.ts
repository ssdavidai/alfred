// ============================================================================
// vault_index — the state.db read-index over Store 1 (the markdown vault).
//
// ctrl-api is the SOLE vault writer (PLAN.md Part I), so it can keep this
// index exact by updating it on every write. That makes index drift
// structurally impossible — there is no fanotify watcher, no race.
//
// A boot-time reconciler still does one full vault walk to catch out-of-band
// edits: a human editing markdown directly in Obsidian, or a restore from
// backup. After boot, the per-write hooks keep it current.
//
// Usage:
//   * indexVaultWrite(relPath)        — call after create / edit / move-in.
//   * removeFromVaultIndex(relPath)   — call after delete / move-out.
//   * reconcileVaultIndex()           — call once at ctrl-api boot.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { getStateDb } from "./state.js";
import {
  recordTypeOf,
  isCanonicalRecordType,
  CANONICAL_RECORD_TYPES,
} from "./promotionContract.js";

const VAULT_PATH = process.env.VAULT_PATH ?? "/vault";

// Directories that are NOT vault content. THE single source of truth — the
// reconciler (this module) and the list/walk endpoints (api/routes/vault.ts,
// which re-exports this) MUST agree on what is vault content, or a file under
// e.g. `inbox/` is served by the API yet never indexed (or vice-versa). This
// set is the union the two formerly-divergent copies needed; vault.ts imports
// it rather than defining its own.
export const IGNORE_DIRS = new Set([
  "_templates",
  "_bases",
  "_docs",
  ".obsidian",
  ".git",
  "view",
  "dashboard",
  "inbox",
]);
const BODY_PREVIEW_CHARS = 500;

interface ParsedRecord {
  record_type: string;
  title: string | null;
  status: string | null;
  as_of: string | null;
  frontmatter_json: string;
  body_preview: string;
}

/** Parse a vault markdown file into the columns vault_index stores. */
function parseRecord(relPath: string, raw: string): ParsedRecord {
  let fm: Record<string, unknown> = {};
  let body = raw;
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (m) {
    try {
      const parsed = yaml.load(m[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fm = parsed as Record<string, unknown>;
      }
    } catch (err) {
      // A malformed-YAML record is indexed with EMPTY frontmatter, which
      // makes it invisible to every index-backed reader — it does not 404,
      // it simply never appears. Live on home: 42 decision records written
      // by an external tool carry an unquoted `name:` containing ": "
      // (e.g. `name: Build approval needed: GH #298`), so js-yaml throws
      // "mapping values are not allowed here" and they vanish from
      // GET /api/v1/decisions entirely — DecisionRouter has never seen
      // them, and #369's retire cannot reach what it cannot list.
      //
      // Still non-fatal (one bad record must not fail the whole index
      // rebuild), but NEVER silent again: this is the only signal that a
      // record has fallen out of the system.
      console.warn(
        `[vault-index] frontmatter parse failed for ${relPath} — indexing ` +
          `with EMPTY frontmatter, record will be invisible to filtered ` +
          `reads: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
      );
    }
    body = m[2] ?? "";
  }
  const type = recordTypeOf(relPath);
  const titleRaw = fm.title ?? fm.name ?? fm.headline;
  // `status` is the indexed lifecycle column. Most record types carry a
  // `status` frontmatter field; `decision/` records carry `state` instead —
  // index whichever is present so status filters work uniformly.
  const statusRaw = fm.status ?? fm.state;
  return {
    record_type: type,
    title: typeof titleRaw === "string" ? titleRaw : null,
    status: typeof statusRaw === "string" ? statusRaw : null,
    as_of: typeof fm.as_of === "string" ? fm.as_of : null,
    frontmatter_json: JSON.stringify(fm),
    body_preview: body.trim().slice(0, BODY_PREVIEW_CHARS),
  };
}

/**
 * Upsert one vault record into vault_index. Call this after every successful
 * vault create / edit / move-in. Best-effort: a failure is logged but never
 * propagates to the API caller (a stale index row is recoverable by the
 * boot reconciler).
 */
export function indexVaultWrite(relPath: string): void {
  try {
    const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const full = path.join(VAULT_PATH, norm);
    let stat: fs.Stats;
    let raw: string;
    try {
      stat = fs.statSync(full);
      raw = fs.readFileSync(full, "utf-8");
    } catch {
      // File not present (e.g. a move whose source no longer exists).
      removeFromVaultIndex(norm);
      return;
    }
    const parsed = parseRecord(norm, raw);
    const db = getStateDb();
    db.prepare(
      `INSERT INTO vault_index
         (path, record_type, title, status, as_of, frontmatter_json,
          body_preview, size_bytes, mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         record_type      = excluded.record_type,
         title            = excluded.title,
         status           = excluded.status,
         as_of            = excluded.as_of,
         frontmatter_json = excluded.frontmatter_json,
         body_preview     = excluded.body_preview,
         size_bytes       = excluded.size_bytes,
         mtime            = excluded.mtime,
         indexed_at       = datetime('now')`,
    ).run(
      norm,
      parsed.record_type,
      parsed.title,
      parsed.status,
      parsed.as_of,
      parsed.frontmatter_json,
      parsed.body_preview,
      stat.size,
      stat.mtime.toISOString(),
    );
  } catch (err) {
    console.error(`[vault_index] indexVaultWrite(${relPath}) failed: ${err}`);
  }
}

/** Remove a record from vault_index. Call after delete / move-out. */
export function removeFromVaultIndex(relPath: string): void {
  try {
    const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    getStateDb().prepare("DELETE FROM vault_index WHERE path = ?").run(norm);
  } catch (err) {
    console.error(`[vault_index] removeFromVaultIndex(${relPath}) failed: ${err}`);
  }
}

/** Recursively collect canonical *.md paths under the vault. */
function walkVault(dir: string, base: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      out.push(...walkVault(path.join(dir, e.name), base));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(path.relative(base, path.join(dir, e.name)).replace(/\\/g, "/"));
    }
  }
  return out;
}

export interface ReconcileResult {
  scanned: number;
  upserted: number;
  removed: number;
  skipped_non_canonical: number;
}

/**
 * Boot-time reconciler. Walks the vault once and makes vault_index match the
 * filesystem exactly: upsert every canonical record, delete index rows whose
 * file is gone. Catches out-of-band edits made while ctrl-api was down.
 */
export function reconcileVaultIndex(): ReconcileResult {
  const db = getStateDb();
  const result: ReconcileResult = {
    scanned: 0,
    upserted: 0,
    removed: 0,
    skipped_non_canonical: 0,
  };

  // Top-level singletons + per-type directories only.
  const onDisk = new Set<string>();
  for (const rel of walkVault(VAULT_PATH, VAULT_PATH)) {
    result.scanned++;
    const type = recordTypeOf(rel);
    // Only the 12 canonical record types are indexed. SOUL.md / RULES.md are
    // singletons, not records — skip them.
    if (!isCanonicalRecordType(type)) {
      result.skipped_non_canonical++;
      continue;
    }
    onDisk.add(rel);
    indexVaultWrite(rel);
    result.upserted++;
  }

  // Delete index rows whose file no longer exists.
  const indexed = db
    .prepare("SELECT path FROM vault_index")
    .all() as Array<{ path: string }>;
  for (const row of indexed) {
    if (!onDisk.has(row.path)) {
      db.prepare("DELETE FROM vault_index WHERE path = ?").run(row.path);
      result.removed++;
    }
  }

  console.log(
    `[vault_index] reconciled: scanned=${result.scanned} ` +
      `upserted=${result.upserted} removed=${result.removed} ` +
      `skipped=${result.skipped_non_canonical}`,
  );
  return result;
}

export { CANONICAL_RECORD_TYPES };
