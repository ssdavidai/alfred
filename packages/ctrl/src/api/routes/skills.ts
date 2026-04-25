// Skills CRUD — first-class API for user-authored Alfred skills.
//
// Skills live at `/mnt/encrypted/openclaw/workspace/skills/<name>/SKILL.md`
// (mirrored to `/mnt/encrypted/openclaw-workers/...` so subagents see them).
// The openclaw gateway hot-reloads the skills directory on filesystem
// change, so writes here are picked up without a process restart.
//
// Three kinds of skill coexist on disk:
//   - "platform"        — `alfred-*` (excluding `alfred-composio-*`); shipped
//                          by the init container, hash-guarded. Read-only here.
//   - "auto-generated"  — `alfred-composio-*`; written by integrations.ts on
//                          OAuth connect. Read-only here (would be overwritten
//                          on the next regenerate-skills run anyway).
//   - "user"            — anything else. Conventionally `user-<slug>` per
//                          Sir's preference. The only kind that may be
//                          created / updated / deleted via this API.
//
// See GH #638 (endpoint) + #639 (companion alfred-skill-authoring SKILL.md).

import fs from "node:fs";
import path from "node:path";

import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError, ConflictError } from "../errors.js";

// Two volume mounts on the ctrl-api container expose the openclaw and
// openclaw-workers state dirs (see docker-compose.yaml.njk:222-225).
const OPENCLAW_SKILLS_DIR = "/mnt/encrypted/openclaw/workspace/skills";
const OPENCLAW_WORKERS_SKILLS_DIR = "/mnt/encrypted/openclaw-workers/workspace/skills";

// Skill name validation. Lowercase kebab-case, 3..64 chars, must start with
// a letter, no leading/trailing dash, no double dashes. The user-* prefix
// rule is enforced separately in the create/update path.
const SKILL_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SKILL_NAME_MIN = 3;
const SKILL_NAME_MAX = 64;

// Cap content at 50 KB. SKILL.md files in the platform are 4-15 KB; this
// gives plenty of headroom for verbose user skills without letting the agent
// dump megabytes of generated prose.
const MAX_CONTENT_BYTES = 50 * 1024;

type SkillKind = "platform" | "auto-generated" | "user";

interface SkillSummary {
  name: string;
  kind: SkillKind;
  size_bytes: number;
  updated_at: string;
}

interface SkillDetail extends SkillSummary {
  content: string;
  frontmatter: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Frontmatter parser — minimal flat top-level scalar parser, matches the
// approach used in chores.ts and learning.ts so all four route files share
// the same expectations about what a SKILL.md looks like.
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string; raw: string | null } {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content, raw: null };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content, raw: null };
  }
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");

  const fm: Record<string, unknown> = {};
  for (const rawLine of yamlBlock.split("\n")) {
    // Skip indented lines (nested keys); we only care about top-level scalars
    // for validation. Skip comments and blank lines.
    if (rawLine.startsWith(" ") || rawLine.startsWith("\t")) continue;
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    const m = rawLine.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    // Strip an inline comment after the value (best-effort; doesn't try to
    // be clever about hashes inside quoted strings).
    if (!val.startsWith("'") && !val.startsWith('"')) {
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    if (val.startsWith("'") && val.endsWith("'") && val.length > 1) {
      val = val.slice(1, -1).replace(/''/g, "'");
    } else if (val.startsWith('"') && val.endsWith('"') && val.length > 1) {
      val = val.slice(1, -1);
    }
    if (val === "null" || val === "") {
      fm[m[1]] = null;
    } else {
      fm[m[1]] = val;
    }
  }
  return { frontmatter: fm, body, raw: yamlBlock };
}

// ---------------------------------------------------------------------------
// Kind classification.
//
// - `alfred-composio-*` → auto-generated (managed by integrations.ts on
//   OAuth connect; regenerate-skills can rewrite at any time).
// - `alfred-*`           → platform (shipped by init container; hash-guarded).
// - everything else      → user (conventionally `user-<slug>`).
//
// We additionally check for the `.content-hash` sentinel file the init
// container drops next to platform-shipped skills as a belt-and-braces
// signal — if a skill name looks user-ish but has a hash file, treat it
// as platform (don't let users accidentally clobber something the init
// container manages).
// ---------------------------------------------------------------------------

function classifyKind(name: string, dirPath: string): SkillKind {
  if (name.startsWith("alfred-composio-")) return "auto-generated";
  if (name.startsWith("alfred-")) return "platform";
  // Defensive: a `.content-hash` file means the init container owns this
  // skill (see entrypoint.sh step 2a/2b). Force platform classification.
  try {
    if (fs.existsSync(path.join(dirPath, ".content-hash"))) return "platform";
  } catch { /* non-fatal */ }
  return "user";
}

function validateSkillName(name: unknown): string {
  if (typeof name !== "string") {
    throw new ValidationError("`name` must be a string");
  }
  if (name.length < SKILL_NAME_MIN || name.length > SKILL_NAME_MAX) {
    throw new ValidationError(`Skill name must be ${SKILL_NAME_MIN}-${SKILL_NAME_MAX} chars`);
  }
  if (!SKILL_NAME_RE.test(name)) {
    throw new ValidationError(
      "Skill name must be lowercase kebab-case (letters, digits, single dashes; must start with a letter)",
    );
  }
  return name;
}

function requireUserPrefix(name: string): void {
  if (!name.startsWith("user-")) {
    throw new ValidationError(
      "User-authored skill names must start with `user-` (e.g. `user-onboarding-emails`). " +
        "Names beginning with `alfred-` are reserved for platform-shipped and auto-generated skills.",
    );
  }
}

function validateContentBody(content: unknown): string {
  if (typeof content !== "string") {
    throw new ValidationError("`content` must be a string");
  }
  if (content.length === 0) {
    throw new ValidationError("`content` cannot be empty");
  }
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_CONTENT_BYTES) {
    throw new ValidationError(
      `Skill content is ${bytes} bytes; max is ${MAX_CONTENT_BYTES} (50 KB)`,
    );
  }
  // Frontmatter shape — must have name + description at minimum.
  const { frontmatter, raw } = parseFrontmatter(content);
  if (raw === null) {
    throw new ValidationError(
      "Skill content must begin with a YAML frontmatter block: `---\\nname: ...\\ndescription: ...\\n---`",
    );
  }
  if (typeof frontmatter.name !== "string" || !(frontmatter.name as string).trim()) {
    throw new ValidationError("Skill frontmatter must include a non-empty `name:` field");
  }
  if (typeof frontmatter.description !== "string" || !(frontmatter.description as string).trim()) {
    throw new ValidationError("Skill frontmatter must include a non-empty `description:` field");
  }
  return content;
}

function readSkillDir(baseDir: string): SkillSummary[] {
  if (!fs.existsSync(baseDir)) return [];
  const entries: SkillSummary[] = [];
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const name = d.name;
    if (name.startsWith(".")) continue;
    const skillPath = path.join(baseDir, name);
    const filePath = path.join(skillPath, "SKILL.md");
    if (!fs.existsSync(filePath)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      continue;
    }
    entries.push({
      name,
      kind: classifyKind(name, skillPath),
      size_bytes: st.size,
      updated_at: new Date(st.mtimeMs).toISOString(),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function readSkill(name: string): SkillDetail | null {
  const skillPath = path.join(OPENCLAW_SKILLS_DIR, name);
  const filePath = path.join(skillPath, "SKILL.md");
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf-8");
  const st = fs.statSync(filePath);
  const { frontmatter } = parseFrontmatter(content);
  return {
    name,
    kind: classifyKind(name, skillPath),
    size_bytes: st.size,
    updated_at: new Date(st.mtimeMs).toISOString(),
    content,
    frontmatter,
  };
}

function writeSkillToBoth(name: string, content: string): string[] {
  const deployed: string[] = [];
  for (const baseDir of [OPENCLAW_SKILLS_DIR, OPENCLAW_WORKERS_SKILLS_DIR]) {
    const skillDir = path.join(baseDir, name);
    const filePath = path.join(skillDir, "SKILL.md");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    // Match the chown done by integrations.generateComposioSkill so the
    // openclaw container (uid 1000) can read what we just wrote. Best-effort.
    try {
      fs.chownSync(skillDir, 1000, 1000);
      fs.chownSync(filePath, 1000, 1000);
    } catch { /* tests + non-root contexts skip this */ }
    deployed.push(baseDir.includes("openclaw-workers") ? "openclaw-workers" : "openclaw");
  }
  return deployed;
}

function deleteSkillFromBoth(name: string): string[] {
  const removed: string[] = [];
  for (const baseDir of [OPENCLAW_SKILLS_DIR, OPENCLAW_WORKERS_SKILLS_DIR]) {
    const skillDir = path.join(baseDir, name);
    if (!fs.existsSync(skillDir)) continue;
    fs.rmSync(skillDir, { recursive: true, force: true });
    removed.push(baseDir.includes("openclaw-workers") ? "openclaw-workers" : "openclaw");
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerSkillsRoutes(): void {
  // GET /api/v1/skills — list every skill on disk with its kind.
  addRoute("GET", "/api/v1/skills", async ({ res }) => {
    const skills = readSkillDir(OPENCLAW_SKILLS_DIR);
    sendJson(res, 200, { skills });
  });

  // GET /api/v1/skills/:name — full content + parsed frontmatter.
  addRoute("GET", "/api/v1/skills/:name", async ({ res, params }) => {
    const name = validateSkillName(params.name);
    const skill = readSkill(name);
    if (!skill) {
      throw new NotFoundError(`Skill not found: ${name}`);
    }
    sendJson(res, 200, skill);
  });

  // POST /api/v1/skills — create a user-authored skill.
  //
  // Body: { name: "user-foo", content: "<markdown with frontmatter>" }
  //
  // Refuses if the name doesn't start with `user-` (Sir's namespace rule)
  // or if a skill with the same name already exists (collision protection;
  // use PUT to update an existing user skill).
  addRoute("POST", "/api/v1/skills", async ({ res, body }) => {
    const b = (body ?? {}) as { name?: unknown; content?: unknown };
    const name = validateSkillName(b.name);
    requireUserPrefix(name);
    const content = validateContentBody(b.content);

    // Collision check — never overwrite an existing skill via POST.
    const existingDir = path.join(OPENCLAW_SKILLS_DIR, name);
    if (fs.existsSync(path.join(existingDir, "SKILL.md"))) {
      throw new ConflictError(
        `Skill already exists: ${name}. Use PUT /api/v1/skills/${name} to update.`,
      );
    }

    const deployed = writeSkillToBoth(name, content);
    // openclaw watches the skills directory for filesystem change and
    // hot-reloads on its own — no restart trigger needed.
    sendJson(res, 201, {
      name,
      kind: "user" as SkillKind,
      deployed,
      reload_required: false,
    });
  });

  // PUT /api/v1/skills/:name — update an existing user skill.
  //
  // Refuses to update `alfred-*` (platform-protected) or
  // `alfred-composio-*` (auto-generated; would be overwritten on next
  // regenerate-skills run).
  addRoute("PUT", "/api/v1/skills/:name", async ({ res, params, body }) => {
    const name = validateSkillName(params.name);
    const b = (body ?? {}) as { content?: unknown };
    const content = validateContentBody(b.content);

    const skillDir = path.join(OPENCLAW_SKILLS_DIR, name);
    const filePath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(filePath)) {
      throw new NotFoundError(`Skill not found: ${name}`);
    }

    const kind = classifyKind(name, skillDir);
    if (kind === "platform") {
      sendJson(res, 403, {
        error: {
          code: "PLATFORM_PROTECTED",
          message: `Cannot update platform skill: ${name}. Platform-shipped skills are managed by the init container.`,
        },
      });
      return;
    }
    if (kind === "auto-generated") {
      sendJson(res, 403, {
        error: {
          code: "AUTO_GENERATED",
          message: `Cannot update auto-generated skill: ${name}. This skill is regenerated on every Composio sync.`,
        },
      });
      return;
    }

    const deployed = writeSkillToBoth(name, content);
    sendJson(res, 200, {
      name,
      kind,
      deployed,
      reload_required: false,
    });
  });

  // DELETE /api/v1/skills/:name — only allowed on user skills.
  addRoute("DELETE", "/api/v1/skills/:name", async ({ res, params }) => {
    const name = validateSkillName(params.name);
    const skillDir = path.join(OPENCLAW_SKILLS_DIR, name);
    if (!fs.existsSync(skillDir)) {
      throw new NotFoundError(`Skill not found: ${name}`);
    }

    const kind = classifyKind(name, skillDir);
    if (kind === "platform") {
      sendJson(res, 403, {
        error: {
          code: "PLATFORM_PROTECTED",
          message: `Cannot delete platform skill: ${name}.`,
        },
      });
      return;
    }
    if (kind === "auto-generated") {
      sendJson(res, 403, {
        error: {
          code: "AUTO_GENERATED",
          message: `Cannot delete auto-generated skill: ${name}. Disconnect the related Composio integration instead.`,
        },
      });
      return;
    }

    const removed = deleteSkillFromBoth(name);
    sendJson(res, 200, {
      name,
      removed,
    });
  });
}
