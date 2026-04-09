import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { dockerExec } from "../helpers.js";
import { VAULT_PATH } from "./vault.js";
import { lookupChoreActions, type ChoreActionSpec } from "./chore_manifest_data.js";

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

  // Trigger — fires the chore workflow once outside its normal schedule.
  // Uses `temporal schedule trigger` which dispatches an immediate run
  // with the schedule's current input parameters. The Temporal server
  // returns the new workflow execution id which we surface to the caller.
  addRoute("POST", "/api/v1/chores/:slug/trigger", async ({ res, params }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    if (!readChoreFile(slug)) throw new NotFoundError(`chore ${slug} not found`);

    try {
      await dockerExec("temporal", [
        "temporal",
        "schedule",
        "trigger",
        "--schedule-id",
        `chore-${slug}`,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Failed to trigger chore-${slug}: ${message.slice(0, 200)}`,
      );
    }

    sendJson(res, 200, {
      slug,
      triggered_at: new Date().toISOString(),
      message: `Chore ${slug} fired manually — check Workflows tab for execution status`,
    });
  });

  // GET /api/v1/chores/:slug/source
  //
  // Reads the generated Python workflow file from /alfred-data/user-chores/
  // for a generated chore. Returns the raw source plus a structured view
  // of the activity calls it makes (extracted via regex, not AST — we
  // can't parse Python from Node without bringing in a dep).
  //
  // The UI uses this to render the actual code the user can inspect,
  // plus a dependency list showing which chore_actions the workflow
  // depends on. That lets the user verify the chore isn't hallucinating
  // about data sources that don't exist.
  //
  // Returns 404 if:
  //   - the chore record doesn't exist
  //   - the chore isn't marked as generated
  //   - the expected .py file isn't in /alfred-data/user-chores/
  addRoute("GET", "/api/v1/chores/:slug/source", async ({ res, params }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    const record = readChoreFile(slug);
    if (!record) throw new NotFoundError(`chore ${slug} not found`);

    const fm = record.frontmatter;
    const isGenerated = fm.generated === true || fm.generated === "true";
    if (!isGenerated) {
      sendJson(res, 200, {
        slug,
        generated: false,
        message: "This is a standard-library chore. Source lives in packages/learn/src/workflows/chores/ in the alfred-platform repo.",
        template: String(fm.template ?? ""),
        source: null,
        imported_activities: [],
        activity_calls: [],
      });
      return;
    }

    // The module_name in frontmatter is the filename stem
    const moduleName = String(fm.template ?? slug.replace(/-/g, "_"));
    const sourcePath = `/mnt/encrypted/alfred/user-chores/${moduleName}.py`;

    let source: string;
    try {
      source = fs.readFileSync(sourcePath, "utf-8");
    } catch {
      sendJson(res, 404, {
        slug,
        generated: true,
        template: moduleName,
        source: null,
        error: `Source file not found at ${sourcePath}`,
        imported_activities: [],
        activity_calls: [],
      });
      return;
    }

    // Extract `from src.activities.chore_actions import (name1, name2, ...)` — the
    // activities the workflow is allowed to call
    const importBlockRe = /from\s+src\.activities\.chore_actions\s+import\s*\(([^)]+)\)/;
    const importMatch = source.match(importBlockRe);
    const importedActivities: string[] = [];
    if (importMatch) {
      for (const raw of importMatch[1].split(",")) {
        const name = raw.trim().replace(/\s+as\s+\w+$/, "");
        if (/^[a-z_][a-z0-9_]*$/i.test(name)) {
          importedActivities.push(name);
        }
      }
    } else {
      // Single-line form: `from src.activities.chore_actions import name1, name2`
      const singleLine = /from\s+src\.activities\.chore_actions\s+import\s+([^\n]+)/;
      const match = source.match(singleLine);
      if (match) {
        for (const raw of match[1].split(",")) {
          const name = raw.trim().replace(/\s+as\s+\w+$/, "");
          if (/^[a-z_][a-z0-9_]*$/i.test(name)) {
            importedActivities.push(name);
          }
        }
      }
    }

    // Extract `workflow.execute_activity(name, ...)` calls. For each call
    // we return the activity name + the line number + the argument expression
    // as a short snippet. This gives the UI enough to show "at line 47 the
    // workflow calls fetch_financial_events(['stripe.com', 'polar.sh'], 7)".
    const callRe = /workflow\.execute_activity\s*\(\s*([a-z_][a-z0-9_]*)/gi;
    const activityCalls: Array<{ name: string; line: number; snippet: string }> = [];
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matches = line.matchAll(callRe);
      for (const m of matches) {
        const name = m[1];
        // Capture a few lines of context starting from this line — usually the
        // args span 3-6 lines (name, args=[...], start_to_close_timeout, retry_policy)
        const snippetLines = lines.slice(i, Math.min(i + 6, lines.length));
        const snippet = snippetLines.join("\n").slice(0, 400);
        activityCalls.push({ name, line: i + 1, snippet });
      }
    }

    // Look up each imported activity in the manifest and run a data-readiness
    // check for each one. This is the anti-hallucination check — if a chore
    // imports fetch_financial_events but the vault has zero event records
    // tagged with the matter domains the chore cares about, the user sees
    // "no events to scan" instead of silently running and reporting 0 anomalies.
    const { found: manifestEntries, unknown: unknownActivities } =
      lookupChoreActions(importedActivities);

    // Per-activity data readiness probe. Each entry reports whether the data
    // source has any content at all (non-empty check, not a full validation).
    const dataReadiness = manifestEntries.map((spec: ChoreActionSpec) => {
      const checks: Array<{
        kind: string;
        resource: string;
        status: "ok" | "empty" | "missing" | "untested";
        detail: string;
      }> = [];
      for (const read of spec.reads) {
        if (read.kind === "vault" && read.check_path) {
          const absPath = path.join(VAULT_PATH, read.check_path.replace(/^vault\//, ""));
          try {
            if (!fs.existsSync(absPath)) {
              checks.push({
                kind: read.kind,
                resource: read.resource,
                status: "missing",
                detail: `Directory ${absPath} does not exist`,
              });
              continue;
            }
            const entries = fs.readdirSync(absPath).filter((n) => n.endsWith(".md"));
            if (entries.length === 0) {
              checks.push({
                kind: read.kind,
                resource: read.resource,
                status: "empty",
                detail: `${absPath} has 0 records — the activity will return empty results every run`,
              });
            } else {
              checks.push({
                kind: read.kind,
                resource: read.resource,
                status: "ok",
                detail: `${entries.length} records available`,
              });
            }
          } catch (err) {
            checks.push({
              kind: read.kind,
              resource: read.resource,
              status: "missing",
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        } else if (read.kind === "snapshot") {
          checks.push({
            kind: read.kind,
            resource: read.resource,
            status: "ok",
            detail: "Snapshot reads are safe on first run (returns empty dict)",
          });
        } else {
          checks.push({
            kind: read.kind,
            resource: read.resource,
            status: "untested",
            detail: "Not checked by this probe",
          });
        }
      }
      return {
        activity: spec.name,
        description: spec.description,
        reads: spec.reads,
        writes: spec.writes,
        llm: spec.llm,
        required_data: spec.required_data,
        readiness_checks: checks,
      };
    });

    sendJson(res, 200, {
      slug,
      generated: true,
      template: moduleName,
      workflow_class_name: String(fm.workflow_class_name ?? ""),
      source,
      source_size_bytes: source.length,
      source_line_count: lines.length,
      imported_activities: importedActivities,
      activity_calls: activityCalls,
      manifest: dataReadiness,
      unknown_activities: unknownActivities,
    });
  });
}
