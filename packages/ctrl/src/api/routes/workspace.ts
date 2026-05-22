import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";

// This route is a read/write surface for the principal's top-level workspace
// markdown — SOUL.md, MEMORY.md plus the identity/operating files (USER,
// AGENTS, TOOLS, KNOWN_CONTACTS). None of these are skills; SOUL.md and
// MEMORY.md are vault-canonical top-level singletons (see CLAUDE.md), and the
// rest are read as top-level identity files alongside them. So the whole set
// lives at the vault root. The old `/mnt/encrypted/openclaw/workspace` host
// path does not exist on the merged single-VM stack (no openclaw mount), so
// every read returned empty and every write went to a dead directory.
const WORKSPACE_DIR = process.env.VAULT_PATH ?? "/vault";
const ALLOWED_FILES = new Set(["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "TOOLS.md", "KNOWN_CONTACTS.md"]);

// Exported for the path-resolution regression test (see
// tests/skills-soul-memory-paths.test.ts).
export const RESOLVED_WORKSPACE_DIR = WORKSPACE_DIR;

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
    return fs.readFileSync(path.join(WORKSPACE_DIR, AGENTS_FILE), "utf-8");
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
    const filePath = path.join(WORKSPACE_DIR, params.filename);
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

    // Ensure workspace directory exists
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    // F13: a RULES.md write upserts the standing-rules sentinel block inside
    // AGENTS.md (preserving everything outside the markers), not a dead file.
    if (params.filename === STANDING_RULES_FILE) {
      const merged = upsertStandingRules(readAgentsFile(), b.content);
      fs.writeFileSync(path.join(WORKSPACE_DIR, AGENTS_FILE), merged, "utf-8");
      sendJson(res, 200, { filename: STANDING_RULES_FILE, message: "Standing rules saved to AGENTS.md" });
      return;
    }

    const filePath = path.join(WORKSPACE_DIR, params.filename);
    fs.writeFileSync(filePath, b.content, "utf-8");
    sendJson(res, 200, { filename: params.filename, message: "File saved" });
  });
}
