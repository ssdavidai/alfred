import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { dockerExec } from "../helpers.js";
import { VAULT_PATH } from "./vault.js";

/**
 * Chore lifecycle routes.
 *
 * Chores are per-user recurring automations backed by:
 *   1. A vault record at chore/<slug>.md (type: chore)
 *   2. A Temporal schedule named chore-<slug> that fires the template
 *      workflow with `{chore_slug}` as input
 *
 * These routes wrap both sides so the SaaS dashboard (and any CLI caller)
 * can list / pause / resume / delete a chore without talking to Temporal
 * directly.
 *
 * Schedule id convention: "chore-<slug>" — matches what
 * assign_initial_chores writes in learn.
 */

const CHORE_DIR = path.join(VAULT_PATH, "chore");

interface ChoreSummary {
  slug: string;
  name: string;
  status: string;
  template: string;
  schedule: string;
  schedule_id: string;
  last_run: string | null;
}

function readChoreFile(slug: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const fp = path.join(CHORE_DIR, `${slug}.md`);
  if (!fs.existsSync(fp)) return null;
  const content = fs.readFileSync(fp, "utf-8");
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: content };
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");

  // Minimal flat parser — matches the style in vault.ts so the two stay
  // consistent. We only need top-level scalars here (status, template,
  // schedule, schedule_id, name, last_run).
  const fm: Record<string, unknown> = {};
  for (const rawLine of yamlBlock.split("\n")) {
    const m = rawLine.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
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
  return { frontmatter: fm, body };
}

function writeChoreStatus(slug: string, status: string): boolean {
  const fp = path.join(CHORE_DIR, `${slug}.md`);
  if (!fs.existsSync(fp)) return false;
  const content = fs.readFileSync(fp, "utf-8");
  // Replace the status line inside the frontmatter block. Bounded scan so
  // we never accidentally touch the body.
  const end = content.indexOf("\n---", 3);
  if (end === -1) return false;
  const fmBlock = content.slice(0, end);
  const rest = content.slice(end);
  const updated = fmBlock.replace(/^status:\s*.*$/m, `status: ${status}`);
  fs.writeFileSync(fp, updated + rest, "utf-8");
  return true;
}

export function registerChoreRoutes(): void {
  // List all chores
  addRoute("GET", "/api/v1/chores", async ({ res }) => {
    if (!fs.existsSync(CHORE_DIR)) {
      sendJson(res, 200, { chores: [], count: 0 });
      return;
    }
    const files = fs
      .readdirSync(CHORE_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
    const chores: ChoreSummary[] = [];
    for (const file of files) {
      const slug = file.slice(0, -3);
      const parsed = readChoreFile(slug);
      if (!parsed) continue;
      const fm = parsed.frontmatter;
      if ((fm.type ?? "") !== "chore") continue;
      chores.push({
        slug,
        name: (fm.name as string) ?? slug,
        status: (fm.status as string) ?? "active",
        template: (fm.template as string) ?? "",
        schedule: (fm.schedule as string) ?? "",
        schedule_id: (fm.schedule_id as string) ?? `chore-${slug}`,
        last_run: (fm.last_run as string) || null,
      });
    }
    sendJson(res, 200, { chores, count: chores.length });
  });

  // Get one chore's details (frontmatter + body)
  addRoute("GET", "/api/v1/chores/:slug", async ({ res, params }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    const parsed = readChoreFile(slug);
    if (!parsed) throw new NotFoundError(`chore ${slug} not found`);
    if ((parsed.frontmatter.type ?? "") !== "chore") {
      throw new NotFoundError(`chore ${slug} not found`);
    }
    sendJson(res, 200, {
      slug,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  });

  // Pause — sets status=paused and pauses the Temporal schedule
  addRoute("POST", "/api/v1/chores/:slug/pause", async ({ res, params }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    if (!readChoreFile(slug)) throw new NotFoundError(`chore ${slug} not found`);

    await dockerExec("temporal", [
      "temporal",
      "schedule",
      "toggle",
      "--schedule-id",
      `chore-${slug}`,
      "--pause",
      "--reason",
      "paused via /api/v1/chores/:slug/pause",
    ]);
    writeChoreStatus(slug, "paused");
    sendJson(res, 200, { slug, status: "paused" });
  });

  // Resume — sets status=active and unpauses the Temporal schedule
  addRoute("POST", "/api/v1/chores/:slug/resume", async ({ res, params }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    if (!readChoreFile(slug)) throw new NotFoundError(`chore ${slug} not found`);

    await dockerExec("temporal", [
      "temporal",
      "schedule",
      "toggle",
      "--schedule-id",
      `chore-${slug}`,
      "--unpause",
      "--reason",
      "resumed via /api/v1/chores/:slug/resume",
    ]);
    writeChoreStatus(slug, "active");
    sendJson(res, 200, { slug, status: "active" });
  });

  // Delete — removes the Temporal schedule and marks the vault record completed
  addRoute("DELETE", "/api/v1/chores/:slug", async ({ res, params }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    if (!readChoreFile(slug)) throw new NotFoundError(`chore ${slug} not found`);

    // Best-effort schedule delete — if it's already gone we still mark the
    // vault record completed so the state converges.
    try {
      await dockerExec("temporal", [
        "temporal",
        "schedule",
        "delete",
        "--schedule-id",
        `chore-${slug}`,
      ]);
    } catch {
      // Swallow — the record cleanup below is the source of truth.
    }
    writeChoreStatus(slug, "completed");
    sendJson(res, 200, { slug, status: "completed" });
  });
}
