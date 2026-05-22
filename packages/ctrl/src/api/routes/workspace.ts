import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";

// This route is a read/write surface for the principal's top-level workspace
// markdown — SOUL.md, MEMORY.md plus the identity/operating files (USER,
// AGENTS, TOOLS, KNOWN_CONTACTS). None of these are skills.
//
// F14/C13 — destination split. Two of these files are loaded by the Hermes
// MAIN gateway, not the vault, so they must be written where the live agent
// reads them:
//   * SOUL.md  → the main profile dir (Hermes loads it from HERMES_HOME).
//   * AGENTS.md → the main profile dir (the gateway's TERMINAL_CWD). The
//     RULES.md alias upserts a `## Standing Rules` sentinel block INSIDE this
//     same profile-dir AGENTS.md.
// The main gateway runs with TERMINAL_CWD=<HERMES_CONFIG_DIR>/main and reads
// SOUL.md from that profile's HERMES_HOME, so both land at the profile root.
// Writing them to /vault (as this route used to) means the agent never sees
// onboarding-persona / standing-rules edits.
//
// The rest (MEMORY.md, USER.md, TOOLS.md, KNOWN_CONTACTS.md) are NOT
// gateway-loaded and stay vault-canonical at the vault root — moving them
// would be a regression.
const VAULT_DIR = process.env.VAULT_PATH ?? "/vault";
// Mirror the HERMES_HOME → HERMES_CONFIG_DIR resolution used by the sibling
// routes (claudeSetup.ts / phone.ts) so the profile dir is a single source of
// truth. On the live box HERMES_CONFIG_DIR=/hermes-state/profiles.
const HERMES_HOME = process.env.HERMES_HOME ?? "/opt/data";
const HERMES_PROFILES_DIR = process.env.HERMES_CONFIG_DIR ?? `${HERMES_HOME}/profiles`;
const HERMES_MAIN_PROFILE_DIR = `${HERMES_PROFILES_DIR}/main`;

// Files the Hermes MAIN gateway loads → the main profile dir; everything else
// → the vault root.
const PROFILE_DIR_FILES = new Set(["SOUL.md", "AGENTS.md"]);

/** Per-file destination resolver. SOUL.md / AGENTS.md route to the Hermes main
 *  profile dir (where the gateway reads them); all others stay at the vault
 *  root. The RULES.md alias resolves through its effective AGENTS.md target. */
function workspaceDirFor(filename: string): string {
  return PROFILE_DIR_FILES.has(filename) ? HERMES_MAIN_PROFILE_DIR : VAULT_DIR;
}

const ALLOWED_FILES = new Set(["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "TOOLS.md", "KNOWN_CONTACTS.md"]);

// Exported for the path-resolution regression test
// (tests/skills-soul-memory-paths.test.ts). This is the vault-canonical root —
// the home for the files that are NOT gateway-loaded. SOUL.md / AGENTS.md now
// resolve via workspaceDirFor() to the Hermes main profile dir instead.
export const RESOLVED_WORKSPACE_DIR = VAULT_DIR;
export const RESOLVED_HERMES_MAIN_PROFILE_DIR = HERMES_MAIN_PROFILE_DIR;

// F13 — Standing rules have no RULES.md home in Hermes (no loader); they live as
// a sentinel-delimited section INSIDE AGENTS.md (already allow-listed, the
// Hermes-native always-injected project-context file). The web standing-rules
// editor still addresses `RULES.md`; rather than reject it (the old 400) or
// write a dead file, we ALIAS RULES.md onto the AGENTS.md sentinel block. This
// resolves the web↔ctrl drift and routes the rules where the agent reads them.
const STANDING_RULES_FILE = "RULES.md";
const AGENTS_FILE = "AGENTS.md";
const SR_BEGIN = "<!-- BEGIN STANDING RULES (managed by Study › Standing rules) -->";
const SR_END = "<!-- END STANDING RULES -->";

function validateFilename(filename: string): void {
  // RULES.md is accepted as an alias (handled before this on the standing-rules
  // path), so it must not 400 here.
  if (!filename || (!ALLOWED_FILES.has(filename) && filename !== STANDING_RULES_FILE)) {
    throw new ValidationError(`Invalid workspace file: ${filename}. Allowed: ${[...ALLOWED_FILES].join(", ")}`);
  }
}

function readAgentsFile(): string {
  try {
    return fs.readFileSync(path.join(workspaceDirFor(AGENTS_FILE), AGENTS_FILE), "utf-8");
  } catch {
    return "";
  }
}

/** Extract the body between the standing-rules sentinels (markers stripped). */
function extractStandingRules(agents: string): string {
  const begin = agents.indexOf(SR_BEGIN);
  const end = agents.indexOf(SR_END);
  if (begin < 0 || end < 0 || end < begin) return "";
  return agents.slice(begin + SR_BEGIN.length, end).replace(/^\n+/, "").replace(/\n+$/, "");
}

/** Replace (or append) the standing-rules sentinel block, preserving everything
 *  outside the markers byte-for-byte. */
function upsertStandingRules(agents: string, rulesBody: string): string {
  const block = `${SR_BEGIN}\n${rulesBody.trim()}\n${SR_END}`;
  const begin = agents.indexOf(SR_BEGIN);
  const end = agents.indexOf(SR_END);
  if (begin >= 0 && end >= 0 && end > begin) {
    return agents.slice(0, begin) + block + agents.slice(end + SR_END.length);
  }
  // No existing block — append, leaving the rest of AGENTS.md untouched.
  const sep = agents && !agents.endsWith("\n") ? "\n\n" : agents ? "\n" : "";
  return `${agents}${sep}${block}\n`;
}

export function registerWorkspaceRoutes(): void {
  // Read a workspace file
  addRoute("GET", "/api/v1/admin/workspace/:filename", async ({ res, params }) => {
    validateFilename(params.filename);
    // F13: RULES.md reads the standing-rules sentinel block out of AGENTS.md.
    if (params.filename === STANDING_RULES_FILE) {
      sendJson(res, 200, {
        filename: STANDING_RULES_FILE,
        content: extractStandingRules(readAgentsFile()),
      });
      return;
    }
    const filePath = path.join(workspaceDirFor(params.filename), params.filename);
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") {
        // File doesn't exist yet — return empty content (not an error)
        sendJson(res, 200, { filename: params.filename, content: "" });
        return;
      }
      throw err;
    }
    sendJson(res, 200, { filename: params.filename, content });
  });

  // Write a workspace file
  addRoute("PUT", "/api/v1/admin/workspace/:filename", async ({ res, params, body }) => {
    validateFilename(params.filename);
    const b = body as { content?: string } | undefined;
    if (!b || typeof b.content !== "string") {
      throw new ValidationError("Request body must include 'content' (string)");
    }

    // F13: a RULES.md write upserts the standing-rules sentinel block inside
    // AGENTS.md (preserving everything outside the markers), not a dead file.
    // F14: that AGENTS.md now lives in the Hermes main profile dir.
    if (params.filename === STANDING_RULES_FILE) {
      const agentsDir = workspaceDirFor(AGENTS_FILE);
      fs.mkdirSync(agentsDir, { recursive: true });
      const merged = upsertStandingRules(readAgentsFile(), b.content);
      fs.writeFileSync(path.join(agentsDir, AGENTS_FILE), merged, "utf-8");
      sendJson(res, 200, { filename: STANDING_RULES_FILE, message: "Standing rules saved to AGENTS.md" });
      return;
    }

    // Ensure the destination directory exists (profile dir for SOUL/AGENTS,
    // vault root otherwise) so a missing dir doesn't 500.
    const destDir = workspaceDirFor(params.filename);
    fs.mkdirSync(destDir, { recursive: true });
    const filePath = path.join(destDir, params.filename);
    fs.writeFileSync(filePath, b.content, "utf-8");
    sendJson(res, 200, { filename: params.filename, message: "File saved" });
  });
}
