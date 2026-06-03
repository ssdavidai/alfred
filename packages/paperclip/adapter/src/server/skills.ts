/**
 * Skills surface — list / sync.
 *
 * Upstream scans `~/.hermes/skills/` and surfaces the read-only result.
 * We do the same: the paperclip container mounts `hermes_data:/hermes-state:ro`
 * (see DESIGN.md "Compose changes"), so the Hermes main profile's
 * `skills/<slug>/SKILL.md` set is readable — read-only — from inside
 * paperclip. We enumerate that directory and parse each SKILL.md's YAML
 * frontmatter (`name`, `description`, `version`) into a real snapshot so
 * the Paperclip UI shows the agent's actual loaded skills instead of the
 * "skill management is delegated to Hermes" warning.
 *
 * This is exactly how Hermes itself enumerates skills (`hermes skills list`
 * walks the same dir). The gateway exposes NO HTTP skills endpoint today
 * (`GET /v1/skills`, `/skills`, `/v1/agent/skills` all 404 on a live tenant
 * — only `/health`, `/v1/models`, `/v1/responses` exist), so reading the
 * mounted directory is the available source of truth. The gateway-side
 * follow-up — an OpenAI-Responses-API extension that reports the loaded
 * skill set so the adapter doesn't depend on the bind-mount — is tracked
 * upstream (see the issue referenced in DESIGN.md "Future / out of scope").
 *
 * `mode` is `"persistent"`: Hermes loads its skills once at startup and the
 * set is stable for the profile's lifetime (not minted per run).
 *
 * Sync is still a no-op — skills are owned by Hermes' runtime and the mount
 * is read-only; pushing skills from Paperclip would silently fail. We
 * surface the read snapshot with a warning rather than pretending to write.
 */

import fs from "node:fs";
import path from "node:path";

import {
  ADAPTER_TYPE,
  DEFAULT_HERMES_CONFIG_DIR,
  DEFAULT_SKILLS_PROFILE,
  SKILLS_SUBDIR,
  type HermesProfileName,
} from "../shared/constants.js";

import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "../types/paperclip.js";

// ── frontmatter parse ─────────────────────────────────────────────────────

export interface SkillFrontmatter {
  name: string | null;
  description: string | null;
  version: string | null;
}

/**
 * Pull `name` / `description` / `version` out of a SKILL.md's YAML
 * frontmatter. Deliberately tiny — no YAML dependency. We only read
 * top-level scalar keys (the three fields above are always scalars in our
 * skills), skipping nested maps (`metadata:`, `triggers:` lists) which we
 * don't surface. Quotes around scalar values are stripped.
 *
 * Returns all-null if there's no `---`-delimited frontmatter block.
 */
export function parseSkillFrontmatter(md: string): SkillFrontmatter {
  const result: SkillFrontmatter = {
    name: null,
    description: null,
    version: null,
  };
  // Frontmatter must open on the first line.
  if (!md.startsWith("---")) return result;
  const lines = md.split("\n");
  // Find the closing fence (first `---` after line 0).
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return result;

  const unquote = (v: string): string => {
    const t = v.trim();
    if (
      (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
      (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
    ) {
      return t.slice(1, -1);
    }
    return t;
  };

  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    // Only top-level keys (no leading whitespace → not nested under a map).
    if (/^\s/.test(line)) continue;
    const eq = line.indexOf(":");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1);
    // A bare `key:` with no inline value opens a nested map/list — skip.
    if (rawValue.trim().length === 0) continue;
    const value = unquote(rawValue);
    if (value.length === 0) continue;
    if (key === "name" && result.name === null) result.name = value;
    else if (key === "description" && result.description === null) {
      result.description = value;
    } else if (key === "version" && result.version === null) {
      result.version = value;
    }
  }
  return result;
}

// ── filesystem reader (injectable for tests) ──────────────────────────────

export interface SkillsReaderDeps {
  /** Override the profile config base dir (default DEFAULT_HERMES_CONFIG_DIR). */
  configDir?: string;
  /** Which Hermes profile's skills to surface (default `main`). */
  profile?: HermesProfileName;
  /** List immediate child directory names of `dir`; throw if absent. */
  listDir?: (dir: string) => string[];
  /** Read a SKILL.md file as utf-8; throw if absent. */
  readFile?: (file: string) => string;
}

function defaultListDir(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function defaultReadFile(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

function emptySnapshot(warnings: string[]): AdapterSkillSnapshot {
  return {
    adapterType: ADAPTER_TYPE,
    supported: false,
    mode: "unsupported",
    desiredSkills: [],
    entries: [],
    warnings,
  };
}

/**
 * Build a real read-only snapshot from the mounted Hermes skills directory.
 * Returns the `unsupported` shape (with an explanatory warning) only when
 * the directory genuinely isn't reachable — i.e. the read-only mount is
 * absent — so the UI degrades to the honest "delegated to Hermes" state
 * rather than a hard error.
 */
export function makeListSkills(deps: SkillsReaderDeps = {}) {
  const profile = deps.profile ?? DEFAULT_SKILLS_PROFILE;
  const configDir =
    deps.configDir ??
    process.env.HERMES_CONFIG_DIR ??
    DEFAULT_HERMES_CONFIG_DIR;
  const listDir = deps.listDir ?? defaultListDir;
  const readFile = deps.readFile ?? defaultReadFile;

  const skillsDir = path.join(configDir, profile, SKILLS_SUBDIR);

  return async function listSkills(
    _ctx: AdapterSkillContext,
  ): Promise<AdapterSkillSnapshot> {
    let slugs: string[];
    try {
      slugs = listDir(skillsDir);
    } catch {
      return emptySnapshot([
        `Hermes skills directory not readable at ${skillsDir}. ` +
          "Bind-mount hermes_data:/hermes-state:ro into the paperclip " +
          "container so Paperclip can surface the agent's loaded skills.",
      ]);
    }

    const entries: AdapterSkillEntry[] = [];
    const warnings: string[] = [];

    for (const slug of slugs.slice().sort((a, b) => a.localeCompare(b))) {
      const skillMd = path.join(skillsDir, slug, "SKILL.md");
      let fm: SkillFrontmatter = {
        name: null,
        description: null,
        version: null,
      };
      let hasFile = true;
      try {
        fm = parseSkillFrontmatter(readFile(skillMd));
      } catch {
        hasFile = false;
      }
      if (!hasFile) {
        // A directory without a SKILL.md isn't a loaded skill — note it
        // once and skip so the snapshot only lists real skills.
        warnings.push(`Skipped ${slug}: no SKILL.md found.`);
        continue;
      }
      const runtimeName = fm.name ?? slug;
      const detailParts: string[] = [];
      if (fm.description) detailParts.push(fm.description);
      if (fm.version) detailParts.push(`v${fm.version}`);
      entries.push({
        key: slug,
        runtimeName,
        desired: false,
        managed: false,
        // Loaded by Hermes at startup and present on disk → installed.
        state: "installed",
        origin: "hermes-runtime",
        originLabel: "Hermes runtime",
        readOnly: true,
        sourcePath: skillMd,
        targetPath: skillMd,
        detail: detailParts.length > 0 ? detailParts.join(" — ") : null,
        locationLabel: `${profile} profile`,
      });
    }

    return {
      adapterType: ADAPTER_TYPE,
      supported: true,
      mode: "persistent",
      desiredSkills: [],
      entries,
      warnings,
    };
  };
}

export const listSkills = makeListSkills();

/**
 * Sync is a no-op: the skills directory is mounted read-only and skills are
 * owned by Hermes' own runtime. We re-surface the current read snapshot so
 * the UI reflects reality and never loops on a pending write.
 */
export function makeSyncSkills(deps: SkillsReaderDeps = {}) {
  const list = makeListSkills(deps);
  return async function syncSkills(
    ctx: AdapterSkillContext,
    _desiredSkills: string[],
  ): Promise<AdapterSkillSnapshot> {
    const snapshot = await list(ctx);
    return {
      ...snapshot,
      warnings: [
        ...snapshot.warnings,
        "Skill sync is read-only in HTTP mode: Hermes owns its " +
          "~/.hermes/skills/ set and the mount is read-only. Edit skills " +
          "in Hermes (the `file` tool / `hermes skills` CLI); Paperclip " +
          "surfaces the result.",
      ],
    };
  };
}

export const syncSkills = makeSyncSkills();

/**
 * Upstream's `resolveDesiredSkillNames` reads `adapter-utils`' helper. We
 * surface what Hermes has loaded but don't drive a desired-set from
 * Paperclip (Hermes owns the set), so return [] — Paperclip's "missing"
 * detector never lights up against a list it can't manage.
 */
export function resolveDesiredSkillNames(
  _config: Record<string, unknown>,
  _availableEntries: unknown[],
): string[] {
  return [];
}
