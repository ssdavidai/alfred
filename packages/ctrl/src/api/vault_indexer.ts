// vault_indexer.ts
//
// STORE-P1-2: populates the `vault_index` SQLite table (migration 002)
// with one row per vault record. This is the read accelerator behind
// hot list/filter paths — once populated, no hot path needs to walk
// /mnt/encrypted/vault again.
//
// Scope of this module (Phase 1.2):
//   - Initial scan/backfill (`scanVaultAndPopulate`)
//   - Boot-time emptiness check (`vaultIndexIsEmpty`)
//
// Out of scope (later Phase 1 issues):
//   - Write-through sync from vault mutations (P1-3)
//   - List endpoint rewire onto vault_index (P1-4)
//   - Reconciler workflow + CLI (P1-5)

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import yaml from "js-yaml";

import { openStateDb } from "../db/state.js";
import {
  VAULT_PATH as DEFAULT_VAULT_PATH,
  IGNORE_DIRS as VAULT_IGNORE_DIRS,
  walkMd,
} from "./routes/vault.js";

// Extra directories the indexer must skip on top of the vault.ts list.
// These are noise that historically lives next to real vault records
// (rescue dumps, migration backups, build artefacts dropped into the
// vault mount). The vault HTTP layer never returns them either, but
// the indexer is fed a wider net so we don't have to special-case
// future cleanups.
const INDEXER_EXTRA_IGNORE_DIRS = new Set([
  "_archive",
  "_rescue",
  "__pycache__",
  "node_modules",
]);

// `_migrated*` is matched as a prefix because historical sweeps dropped
// directories like `_migrated_2025_03` next to live records.
const IGNORE_PREFIXES = ["_migrated"];

function buildIgnoreDirs(): Set<string> {
  const combined = new Set<string>(VAULT_IGNORE_DIRS);
  for (const name of INDEXER_EXTRA_IGNORE_DIRS) combined.add(name);
  return combined;
}

interface ParsedFrontmatter {
  fm: Record<string, unknown>;
  body: string;
}

// Self-contained frontmatter parser — same contract as the private
// `parseFrontmatter` in routes/vault.ts. Kept inline rather than
// exported from vault.ts to avoid bloating that module's public
// surface for a single internal caller.
function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith("---")) return { fm: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: content };
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  let fm: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(yamlBlock, { schema: yaml.DEFAULT_SCHEMA });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
      for (const k of Object.keys(fm)) {
        if (fm[k] === null) fm[k] = "";
      }
    }
  } catch {
    // Malformed YAML — match vault.ts behaviour: empty fm, keep file.
  }
  return { fm, body };
}

const BODY_FIRST_N = 500;

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
  // Frontmatter `id` wins when present (matches what the rest of the
  // stack treats as canonical), otherwise fall back to `<type>/<stem>`
  // which is stable across renames within a type.
  const fmId = strOrNull(fm["id"]);
  if (fmId) return fmId;
  return `${recordType}/${stem}`;
}

function shouldSkipRelPath(rel: string): boolean {
  // Reject any path whose first segment is a prefix-banned directory.
  const top = rel.split("/")[0] ?? "";
  for (const prefix of IGNORE_PREFIXES) {
    if (top.startsWith(prefix)) return true;
  }
  return false;
}

export function vaultIndexIsEmpty(db?: DatabaseSync): boolean {
  const handle = db ?? openStateDb();
  const row = handle
    .prepare("SELECT count(*) AS n FROM vault_index")
    .get() as { n: number } | undefined;
  return !row || Number(row.n) === 0;
}

export async function scanVaultAndPopulate(opts?: {
  vaultPath?: string;
  db?: DatabaseSync;
}): Promise<{ scanned: number; inserted: number; ms: number }> {
  const t0 = Date.now();
  const vaultPath =
    opts?.vaultPath ?? process.env.VAULT_PATH ?? DEFAULT_VAULT_PATH;
  const db = opts?.db ?? openStateDb();
  const ignoreDirs = buildIgnoreDirs();

  let scanned = 0;
  let inserted = 0;

  const files = walkMd(vaultPath, vaultPath, ignoreDirs);

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO vault_index
       (record_id, record_type, path, mtime_ns, state, parent_matter, frontmatter, body_first_n)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // One transaction wraps the entire scan. For the david tenant
  // (~88k records) this turns ~88k fsync-bound INSERTs into a single
  // WAL commit at the end, which is the difference between "boots in
  // a minute" and "boots in an hour".
  db.exec("BEGIN");
  try {
    for (const relRaw of files) {
      // walkMd already returns POSIX-style relative paths on Linux,
      // but normalise defensively so the `path` column never holds
      // backslashes and the UNIQUE(path) constraint stays stable.
      const rel = relRaw.replace(/\\/g, "/");
      if (shouldSkipRelPath(rel)) continue;

      const full = path.join(vaultPath, rel);
      let content: string;
      let mtimeNs: bigint;
      try {
        const st = fs.statSync(full, { bigint: true });
        mtimeNs = st.mtimeNs;
        content = fs.readFileSync(full, "utf-8");
      } catch {
        // File vanished mid-scan or is unreadable — skip without
        // aborting the rest of the batch.
        continue;
      }

      scanned++;

      const { fm, body } = parseFrontmatter(content);

      // Derive record_type from the top-level directory rather than
      // frontmatter. Filesystem layout is the authority — the P0-3 bug
      // was a record whose frontmatter `type` disagreed with its on-disk
      // parent directory and silently disappeared from the list view.
      const topDir = rel.split("/")[0] ?? "";
      if (!topDir) continue;
      const recordType = topDir;

      const stem = path.basename(rel, ".md");
      const recordId = deriveRecordId(fm, stem, recordType);

      const state = strOrNull(fm["state"]);
      const parentMatter = strOrNull(fm["parent_matter"]);

      let frontmatterJson: string;
      try {
        frontmatterJson = JSON.stringify(fm);
      } catch {
        // Frontmatter contained something unserialisable (cycles,
        // BigInt, etc). Fall back to an empty object so the row still
        // lands — reconciler will fix it on its next pass.
        frontmatterJson = "{}";
      }

      const bodyFirstN =
        body.length === 0 ? null : body.slice(0, BODY_FIRST_N);

      try {
        insertStmt.run(
          recordId,
          recordType,
          rel,
          mtimeNs,
          state,
          parentMatter,
          frontmatterJson,
          bodyFirstN,
        );
        inserted++;
      } catch (err) {
        // A single broken row must not poison the whole scan — log and
        // continue. The reconciler (P1-5) will own remediation.
        console.warn(
          `[vault_indexer] insert failed path=${rel} err=${(err as Error).message}`,
        );
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw err;
  }

  return { scanned, inserted, ms: Date.now() - t0 };
}
