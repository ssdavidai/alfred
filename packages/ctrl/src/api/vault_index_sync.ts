// vault_index_sync.ts
//
// STORE-P1-3: write-through synchronisation between ctrl-api vault
// mutations and the `vault_index` SQLite table (migration 002).
//
// The P1-2 indexer scans the vault once on boot and populates one row
// per record. Once boot is past, every ctrl-api write that touches a
// `.md` file under VAULT_PATH must call back into this module so the
// row stays in lockstep with the on-disk file. Otherwise the index
// drifts and list endpoints (P1-4) return stale results.
//
// Design rules:
//   * Same UPSERT shape (`INSERT OR REPLACE`) the indexer uses, same
//     column derivation. Idempotent: replay a sync with the same
//     inputs and the row is unchanged.
//   * mtime_ns is read with `{ bigint: true }` — `vault_index.mtime_ns`
//     holds unix nanoseconds (~1.78e18, well above MAX_SAFE_INTEGER),
//     and any SELECT that touches it must `setReadBigInts(true)` or
//     node:sqlite throws RangeError.
//   * Skip rule mirrors the indexer: `_migrated*` top-level dirs are
//     migration backups, not live records. Don't index them.
//   * No throws. Sync failures must not break the HTTP request — the
//     reconciler (P1-5) is the fail-safe. Callers MAY wrap in their
//     own try/catch for defence-in-depth; this module also catches
//     internally and logs.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openStateDb } from "../db/state.js";

// ---------------------------------------------------------------------------
// Constants. Kept in sync with vault_indexer.ts.
// ---------------------------------------------------------------------------

// `_migrated*` is matched as a prefix because historical sweeps dropped
// directories like `_migrated_2025_03` next to live records. Same rule
// the boot-time indexer uses.
const IGNORE_PREFIXES = ["_migrated"];

// Top-level dirs that the indexer drops on the floor as noise rather
// than indexing. Kept in sync with vault_indexer.ts's
// INDEXER_EXTRA_IGNORE_DIRS + vault.ts's IGNORE_DIRS so we don't index
// anything the read side won't surface.
const INDEXER_SKIP_TOP_DIRS = new Set<string>([
  "_archive",
  "_rescue",
  "__pycache__",
  "node_modules",
  "_templates",
  "_bases",
  "_docs",
  ".obsidian",
  "view",
  "dashboard",
]);

const BODY_FIRST_N = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRelPath(relPath: string): string {
  // walkMd-style normalisation: forward slashes, no leading separator.
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function shouldSkipRelPath(rel: string): boolean {
  const top = rel.split("/")[0] ?? "";
  if (!top) return true;
  if (INDEXER_SKIP_TOP_DIRS.has(top)) return true;
  for (const prefix of IGNORE_PREFIXES) {
    if (top.startsWith(prefix)) return true;
  }
  return false;
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function deriveRecordId(
  fm: Record<string, unknown>,
  stem: string,
  recordType: string,
): string {
  const fmId = strOrNull(fm["id"]);
  if (fmId) return fmId;
  return `${recordType}/${stem}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SyncVaultIndexOpts {
  /** Caller-provided db handle. Defaults to the process-wide singleton
   *  via openStateDb(); pass an explicit handle in tests. */
  db?: DatabaseSync;
  /** Vault root the relPath is taken against. Defaults to VAULT_PATH
   *  in routes/vault.ts (passed in explicitly to avoid an import cycle). */
  vaultPath: string;
  /** Path relative to vaultPath, e.g. `matter/foo.md`. */
  relPath: string;
  /** Parsed frontmatter dict from the file the caller just wrote. */
  frontmatter: Record<string, unknown>;
  /** Body text (everything after the closing `---`). Used for body_first_n. */
  body: string;
}

/**
 * UPSERT a single row into vault_index, derived from the same inputs the
 * caller just wrote to disk. Idempotent; silently no-ops if the write
 * target is under a `_migrated*` directory or another indexer-skipped
 * top-level dir. Never throws — logs on failure and returns.
 */
export function syncVaultIndexRow(opts: SyncVaultIndexOpts): void {
  try {
    const rel = normalizeRelPath(opts.relPath);
    if (!rel) return;
    if (shouldSkipRelPath(rel)) return;

    const topDir = rel.split("/")[0] ?? "";
    if (!topDir) return;
    const recordType = topDir;

    const stem = path.basename(rel, ".md");
    if (!stem) return;

    const fm = opts.frontmatter ?? {};
    const recordId = deriveRecordId(fm, stem, recordType);
    const state = strOrNull(fm["state"]);
    const parentMatter = strOrNull(fm["parent_matter"]);

    // Re-read mtime from disk to match what the indexer would observe.
    // We can't accept the timestamp from the caller — they wrote the
    // file just now and the kernel may apply its own millisecond
    // resolution; trust the filesystem.
    const full = path.join(opts.vaultPath, rel);
    let mtimeNs: bigint;
    try {
      const st = fs.statSync(full, { bigint: true });
      mtimeNs = st.mtimeNs;
    } catch (err) {
      // File vanished mid-sync (concurrent delete, broken write).
      // Don't insert a stale row — let the reconciler clean up.
      console.warn(
        `[vault_index_sync] stat failed for ${rel}: ${(err as Error).message}`,
      );
      return;
    }

    let frontmatterJson: string;
    try {
      frontmatterJson = JSON.stringify(fm);
    } catch {
      frontmatterJson = "{}";
    }

    const bodyFirstN =
      !opts.body || opts.body.length === 0
        ? null
        : opts.body.slice(0, BODY_FIRST_N);

    const db = opts.db ?? openStateDb();
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO vault_index
         (record_id, record_type, path, mtime_ns, state, parent_matter, frontmatter, body_first_n)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      recordId,
      recordType,
      rel,
      mtimeNs,
      state,
      parentMatter,
      frontmatterJson,
      bodyFirstN,
    );
  } catch (err) {
    // Never propagate. The reconciler (P1-5) owns drift remediation.
    console.warn(
      `[vault_index_sync] upsert failed path=${opts.relPath} err=${(err as Error).message}`,
    );
  }
}

/**
 * Remove the row whose `path` column equals `relPath`. Idempotent — a
 * missing row is fine. Silent on error.
 */
export function deleteVaultIndexRow(
  db: DatabaseSync | undefined,
  relPath: string,
): void {
  try {
    const rel = normalizeRelPath(relPath);
    if (!rel) return;
    const handle = db ?? openStateDb();
    handle.prepare("DELETE FROM vault_index WHERE path = ?").run(rel);
  } catch (err) {
    console.warn(
      `[vault_index_sync] delete failed path=${relPath} err=${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Convenience: parse-and-sync from raw file content.
//
// Several callers in ctrl-api only have the raw "---\n<yaml>\n---\n<body>"
// blob (e.g. the routes that read-modify-write a file). They can call
// this instead of duplicating the frontmatter parsing logic.
// ---------------------------------------------------------------------------

export function syncVaultIndexFromContent(opts: {
  db?: DatabaseSync;
  vaultPath: string;
  relPath: string;
  content: string;
}): void {
  const { fm, body } = parseFrontmatterLoose(opts.content);
  syncVaultIndexRow({
    db: opts.db,
    vaultPath: opts.vaultPath,
    relPath: opts.relPath,
    frontmatter: fm,
    body,
  });
}

// Minimal frontmatter splitter — does NOT pull in js-yaml to avoid an
// import cycle. The frontmatter parsing here is intentionally loose:
// the row's `frontmatter` column stores JSON of the resulting dict and
// the indexer's own parser handles richer YAML on the boot scan, so
// this conservative parser is only used by callers that don't already
// have a parsed dict in hand.
function parseFrontmatterLoose(content: string): {
  fm: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { fm: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { fm: {}, body: content };
  }
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const fm: Record<string, unknown> = {};
  for (const rawLine of yamlBlock.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    // Only parse simple `key: value` lines. Anything nested falls
    // through — the indexer's full YAML parser will catch up on its
    // next reconcile pass. The two columns we MUST get right are
    // `state` and `parent_matter`, which are always top-level scalars.
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val: string = m[2].trim();
    // Strip surrounding quotes.
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (val === "null" || val === "~") {
      fm[key] = "";
    } else {
      fm[key] = val;
    }
  }
  return { fm, body };
}
