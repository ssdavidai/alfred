import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError, ConflictError } from "../errors.js";
import { dockerExec, dockerComposeCmd } from "../helpers.js";
import { VAULT_PATH } from "./vault.js";
import { CHORE_ACTION_MANIFEST, lookupChoreActions, type ChoreActionSpec } from "./chore_manifest_data.js";

const USER_CHORES_DIR = "/mnt/encrypted/alfred/user-chores";
const VALIDATE_STAGING_DIR = "/mnt/encrypted/alfred/.chore-validate";
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const WORKFLOW_CLASS_RE = /^[A-Z][a-zA-Z0-9]*Workflow$/;

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

// YAML-safe single-quoted scalar. Doubles any single quotes inside.
function yamlScalarQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Validate Python source by delegating to alfred-learn's dynamic-loader validator.
// Keeps runtime + generation on exactly one validation implementation.
//
// We stage the source on the shared /mnt/encrypted/alfred mount (not inside
// USER_CHORES_DIR, because files under user-chores are picked up by the
// dynamic loader on worker startup — we don't want half-written candidates
// to get staged accidentally).
async function validateChorePython(source: string): Promise<{ ok: boolean; violations: string[] }> {
  fs.mkdirSync(VALIDATE_STAGING_DIR, { recursive: true });
  const tmpName = `validate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.py`;
  const hostPath = path.join(VALIDATE_STAGING_DIR, tmpName);
  const containerPath = `/alfred-data/.chore-validate/${tmpName}`;
  fs.writeFileSync(hostPath, source, "utf-8");
  const script =
    "import json,sys\n" +
    "from src.workflows.chores._dynamic_loader import validate_template_source\n" +
    `src=open(${JSON.stringify(containerPath)}).read()\n` +
    "r=validate_template_source(src)\n" +
    'print(json.dumps({"ok":r.ok,"violations":list(r.violations)}))\n';
  try {
    const out = await dockerExec("alfred-learn", ["python3", "-c", script]);
    const trimmed = out.trim();
    const parsed = JSON.parse(trimmed) as { ok: boolean; violations: string[] };
    return parsed;
  } finally {
    try { fs.unlinkSync(hostPath); } catch { /* ignore */ }
  }
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

  // List every activity that generated chore templates are allowed to import
  // from `src.activities.chore_actions`. Use this before authoring a chore's
  // Python source to confirm the activity names + understand what data each
  // one reads/writes.
  addRoute("GET", "/api/v1/chore-actions", async ({ res }) => {
    const entries = Object.values(CHORE_ACTION_MANIFEST);
    sendJson(res, 200, {
      actions: entries,
      count: entries.length,
    });
  });

  // Create a chore end-to-end: write the generated Python workflow source, the
  // vault `chore/` record, and a Temporal schedule — in that order, with rollback
  // on partial failure. Called by Alfred via the `self` MCP when the user asks
  // him to set up a recurring automation (or when he proposes one unprompted).
  //
  // Body:
  //   slug                    kebab-case, unique, becomes `chore/<slug>.md`
  //   workflow_class_name     PascalCase, must be `class <name>` in python_source
  //   python_source           full .py source (< 100KB), validated by the same
  //                           static checker the dynamic loader runs at startup
  //   schedule                cron expression (5-field)
  //   name?                   human-friendly name (defaults to title-cased slug)
  //   user_facing_description?
  //   params?                 extra workflow input; `chore_slug` is always added
  //   tags?                   string list
  //   overlap_policy?         default "Skip"
  //   task_queue?             default "alfred-learn"
  //   restart_worker?         default true — trigger alfred-learn restart so
  //                           dynamic_loader picks up the new template immediately
  //
  // Returns 201 with `slug`, `module`, `source_path`, `vault_path`, `schedule_id`,
  // `workflow_class_name`, `cron`, `restart_triggered`, `restart_error?`.
  addRoute("POST", "/api/v1/chores", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b !== "object") throw new ValidationError("body is required");

    const slug = String(b.slug ?? "").trim();
    const workflowClass = String(b.workflow_class_name ?? "").trim();
    const pythonSource = typeof b.python_source === "string" ? b.python_source : "";
    const cron = String(b.schedule ?? "").trim();

    if (!SLUG_RE.test(slug)) {
      throw new ValidationError("slug must be lowercase kebab-case (a-z, 0-9, hyphens)");
    }
    if (!WORKFLOW_CLASS_RE.test(workflowClass)) {
      throw new ValidationError("workflow_class_name must be PascalCase ending in 'Workflow'");
    }
    if (!pythonSource) {
      throw new ValidationError("python_source is required");
    }
    if (!cron) {
      throw new ValidationError("schedule (cron expression) is required");
    }
    if (!pythonSource.includes(`class ${workflowClass}`)) {
      throw new ValidationError(
        `python_source must declare 'class ${workflowClass}' (the workflow_class_name)`,
      );
    }

    const name = String(b.name ?? slug.replace(/-/g, " ")).trim() || slug;
    const description = String(b.user_facing_description ?? "").trim();
    const paramsInput =
      b.params && typeof b.params === "object" && !Array.isArray(b.params)
        ? (b.params as Record<string, unknown>)
        : {};
    const tags = Array.isArray(b.tags)
      ? (b.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const overlapPolicy = String(b.overlap_policy ?? "Skip");
    const taskQueue = String(b.task_queue ?? "alfred-learn");
    const restartWorker = b.restart_worker !== false;

    const module = slug.replace(/-/g, "_");
    const sourcePath = path.join(USER_CHORES_DIR, `${module}.py`);
    const vaultPath = path.join(CHORE_DIR, `${slug}.md`);
    const scheduleId = `chore-${slug}`;

    if (fs.existsSync(sourcePath)) {
      throw new ConflictError(`chore source already exists at ${sourcePath}`);
    }
    if (fs.existsSync(vaultPath)) {
      throw new ConflictError(`chore vault record already exists at ${vaultPath}`);
    }

    const validation = await validateChorePython(pythonSource);
    if (!validation.ok) {
      throw new ValidationError("python_source failed static validation", {
        violations: validation.violations,
      });
    }

    // Combine caller params with the required chore_slug envelope so the
    // template workflow always receives it as input.
    const workflowInput = { chore_slug: slug, ...paramsInput };
    const paramsJson = JSON.stringify(workflowInput);
    const now = new Date().toISOString();
    const tagsInline = tags.length
      ? `[${tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ")}]`
      : "[]";
    const recordLines = [
      "---",
      `created: '${now}'`,
      "created_by: self",
      "generated: true",
      "last_result: ''",
      "last_run: ''",
      `name: ${yamlScalarQuote(name)}`,
      `params: ${yamlScalarQuote(paramsJson)}`,
      "quarantine: false",
      "quarantine_remaining: 0",
      `schedule: ${yamlScalarQuote(cron)}`,
      `schedule_id: ${scheduleId}`,
      "status: active",
      `tags: ${tagsInline}`,
      `template: ${module}`,
      "type: chore",
      `user_facing_description: ${yamlScalarQuote(description)}`,
      `workflow_class_name: ${workflowClass}`,
      "---",
      "",
      `# ${name}`,
      "",
      description || "Generated chore.",
      "",
      "> **Generated chore.** Created via `POST /api/v1/chores` (self MCP).",
      "",
    ];

    fs.mkdirSync(USER_CHORES_DIR, { recursive: true });
    fs.writeFileSync(sourcePath, pythonSource, "utf-8");

    fs.mkdirSync(CHORE_DIR, { recursive: true });
    fs.writeFileSync(vaultPath, recordLines.join("\n"), "utf-8");

    try {
      await dockerExec("temporal", [
        "temporal", "schedule", "create",
        "--schedule-id", scheduleId,
        "--type", workflowClass,
        "--task-queue", taskQueue,
        "--cron", cron,
        "--overlap-policy", overlapPolicy,
        "--input", JSON.stringify(workflowInput),
      ]);
    } catch (err) {
      // Best-effort rollback — leave the operator in a clean state if the
      // schedule create fails. The Python source and vault record are both
      // inert until a schedule fires them, so removing them is safe.
      try { fs.unlinkSync(sourcePath); } catch { /* ignore */ }
      try { fs.unlinkSync(vaultPath); } catch { /* ignore */ }
      throw err;
    }

    let restartTriggered = false;
    let restartError: string | undefined;
    if (restartWorker) {
      try {
        await dockerComposeCmd(["restart", "alfred-learn"]);
        restartTriggered = true;
      } catch (err) {
        restartError = err instanceof Error ? err.message : String(err);
      }
    }

    sendJson(res, 201, {
      slug,
      module,
      source_path: sourcePath,
      vault_path: vaultPath,
      schedule_id: scheduleId,
      workflow_class_name: workflowClass,
      cron,
      restart_triggered: restartTriggered,
      restart_error: restartError,
      message: restartTriggered
        ? `Chore '${slug}' created; alfred-learn restarted to load the new template.`
        : `Chore '${slug}' created. Trigger alfred-learn restart via POST /api/v1/admin/restart-learn before the first run.`,
    });
  });

  // Patch an existing chore IN PLACE. Edits any combination of:
  //   python_source  — replaces the `.py` workflow. Re-validated same as
  //                    POST. workflow_class_name must still match the
  //                    body (or the existing vault record's
  //                    workflow_class_name if unchanged).
  //   schedule       — new cron expression; rewrites the Temporal
  //                    schedule in place (delete + create, input
  //                    preserved).
  //   params         — replaces the `params` JSON in the vault
  //                    frontmatter; combined with {chore_slug}
  //                    envelope same as POST.
  //   name, user_facing_description, tags — cosmetic fields on the
  //                    vault record.
  //   workflow_class_name — changed only if python_source is also
  //                    passed and contains `class <new>`; updates
  //                    both the vault record and the Temporal
  //                    schedule `--type`.
  //
  // Preserves: slug, created timestamp, schedule_id, run log body
  // (everything after the frontmatter block), quarantine state,
  // last_run / last_result.
  //
  // Atomic-ish: validates all inputs before touching disk. On Temporal
  // schedule rewrite failure, restores the prior `.py` file (kept in a
  // tmp location during the swap).
  //
  // Returns 200 with the new shape of the chore (same fields as POST).
  addRoute("PATCH", "/api/v1/chores/:slug", async ({ res, params, body }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    if (!SLUG_RE.test(slug)) {
      throw new ValidationError("slug must be lowercase kebab-case");
    }
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b !== "object") throw new ValidationError("body is required");

    const existing = readChoreFile(slug);
    if (!existing) throw new NotFoundError(`chore ${slug} not found`);
    if ((existing.frontmatter.type ?? "") !== "chore") {
      throw new NotFoundError(`chore ${slug} not found`);
    }
    const fm = existing.frontmatter;
    const module = String(fm.template ?? slug.replace(/-/g, "_"));
    const sourcePath = path.join(USER_CHORES_DIR, `${module}.py`);
    const vaultPath = path.join(CHORE_DIR, `${slug}.md`);
    const scheduleId = String(fm.schedule_id ?? `chore-${slug}`);

    // What's being changed?
    const newSource = typeof b.python_source === "string" ? (b.python_source as string) : null;
    const newCron = typeof b.schedule === "string" && (b.schedule as string).trim()
      ? (b.schedule as string).trim()
      : null;
    const newWorkflowClass = typeof b.workflow_class_name === "string" && (b.workflow_class_name as string).trim()
      ? (b.workflow_class_name as string).trim()
      : null;
    const newParams = b.params && typeof b.params === "object" && !Array.isArray(b.params)
      ? (b.params as Record<string, unknown>)
      : null;
    const newName = typeof b.name === "string" ? (b.name as string).trim() : null;
    const newDesc = typeof b.user_facing_description === "string" ? (b.user_facing_description as string).trim() : null;
    const newTags = Array.isArray(b.tags)
      ? (b.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : null;
    const taskQueue = String(b.task_queue ?? "alfred-learn");
    const overlapPolicy = String(b.overlap_policy ?? "Skip");
    const restartWorker = b.restart_worker !== false && newSource !== null;

    if (!newSource && !newCron && !newWorkflowClass && !newParams && newName === null && newDesc === null && !newTags) {
      throw new ValidationError(
        "no patchable fields provided — supply at least one of: python_source, schedule, workflow_class_name, params, name, user_facing_description, tags",
      );
    }

    const effectiveWorkflowClass = newWorkflowClass || String(fm.workflow_class_name ?? "");
    if (!WORKFLOW_CLASS_RE.test(effectiveWorkflowClass)) {
      throw new ValidationError(
        "workflow_class_name must be PascalCase ending in 'Workflow'",
      );
    }
    if (newSource) {
      if (!newSource.includes(`class ${effectiveWorkflowClass}`)) {
        throw new ValidationError(
          `python_source must declare 'class ${effectiveWorkflowClass}'`,
        );
      }
      const validation = await validateChorePython(newSource);
      if (!validation.ok) {
        throw new ValidationError("python_source failed static validation", {
          violations: validation.violations,
        });
      }
    }

    // Resolved fields — what the record will look like after the patch.
    const resolvedName = newName !== null && newName.length > 0
      ? newName
      : String(fm.name ?? slug);
    const resolvedDesc = newDesc !== null
      ? newDesc
      : String(fm.user_facing_description ?? "");
    const resolvedCron = newCron ?? String(fm.schedule ?? "");
    const resolvedTags = newTags ?? (() => {
      // Re-parse existing tags from the stored frontmatter string. readChoreFile
      // stores tags as a single string like "[foo, bar]" or "[]". Pull them out
      // loosely — good enough for a patch echo; the vault body rewrite below
      // always canonicalises into tagsInline form.
      const raw = String(fm.tags ?? "").trim();
      if (!raw || raw === "[]") return [];
      const inner = raw.replace(/^\[|\]$/g, "").trim();
      if (!inner) return [];
      return inner.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    })();

    // Preserve existing params (stored as JSON string in frontmatter) unless overridden.
    let existingParams: Record<string, unknown> = {};
    if (typeof fm.params === "string" && (fm.params as string).trim().startsWith("{")) {
      try {
        existingParams = JSON.parse(fm.params as string);
      } catch {
        // leave empty
      }
    }
    const resolvedParamsJson = newParams !== null
      ? JSON.stringify({ chore_slug: slug, ...newParams })
      : JSON.stringify({ chore_slug: slug, ...existingParams });

    // Swap the .py file if source changed (keep a backup for rollback).
    let sourceBackup: string | null = null;
    if (newSource) {
      if (fs.existsSync(sourcePath)) {
        sourceBackup = fs.readFileSync(sourcePath, "utf-8");
      }
      fs.mkdirSync(USER_CHORES_DIR, { recursive: true });
      fs.writeFileSync(sourcePath, newSource, "utf-8");
    }

    // Rewrite the vault record's frontmatter while preserving the body.
    const tagsInline = resolvedTags.length
      ? `[${resolvedTags.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ")}]`
      : "[]";
    const updatedAt = new Date().toISOString();
    const fmLines: string[] = [
      "---",
      `created: ${typeof fm.created === "string" ? fm.created : `'${updatedAt}'`}`,
      `created_by: ${fm.created_by ?? "self"}`,
      "generated: true",
      `last_result: ${yamlScalarQuote(String(fm.last_result ?? ""))}`,
      `last_run: ${yamlScalarQuote(String(fm.last_run ?? ""))}`,
      `name: ${yamlScalarQuote(resolvedName)}`,
      `params: ${yamlScalarQuote(resolvedParamsJson)}`,
      `quarantine: ${fm.quarantine === true || fm.quarantine === "true" ? "true" : "false"}`,
      `quarantine_remaining: ${fm.quarantine_remaining ?? 0}`,
      `schedule: ${yamlScalarQuote(resolvedCron)}`,
      `schedule_id: ${scheduleId}`,
      `status: ${String(fm.status ?? "active")}`,
      `tags: ${tagsInline}`,
      `template: ${module}`,
      "type: chore",
      `updated: '${updatedAt}'`,
      `user_facing_description: ${yamlScalarQuote(resolvedDesc)}`,
      `workflow_class_name: ${effectiveWorkflowClass}`,
      "---",
      "",
    ];
    const newRecord = fmLines.join("\n") + existing.body.replace(/^\s*#[^\n]*\n?/, `# ${resolvedName}\n`);
    const vaultBackup = fs.readFileSync(vaultPath, "utf-8");
    fs.writeFileSync(vaultPath, newRecord, "utf-8");

    // Rewrite the Temporal schedule if cron or workflow_class changed.
    const scheduleChanged = newCron !== null || newWorkflowClass !== null;
    if (scheduleChanged) {
      try {
        // Best-effort describe to get existing input; fall back to {chore_slug: <slug>}
        // plus existingParams if describe fails.
        let preservedInput: Record<string, unknown> = { chore_slug: slug, ...existingParams };
        if (newParams !== null) {
          preservedInput = { chore_slug: slug, ...newParams };
        }

        // Delete + recreate (Temporal CLI has no update-cron verb).
        try {
          await dockerExec("temporal", [
            "temporal", "schedule", "delete",
            "--schedule-id", scheduleId,
          ]);
        } catch {
          // if delete fails the create below will also fail — surface that
        }
        await dockerExec("temporal", [
          "temporal", "schedule", "create",
          "--schedule-id", scheduleId,
          "--type", effectiveWorkflowClass,
          "--task-queue", taskQueue,
          "--cron", resolvedCron,
          "--overlap-policy", overlapPolicy,
          "--input", JSON.stringify(preservedInput),
        ]);
      } catch (err) {
        // Rollback: restore .py source and vault record.
        if (newSource && sourceBackup !== null) {
          try { fs.writeFileSync(sourcePath, sourceBackup, "utf-8"); } catch { /* ignore */ }
        }
        try { fs.writeFileSync(vaultPath, vaultBackup, "utf-8"); } catch { /* ignore */ }
        throw err;
      }
    }

    let restartTriggered = false;
    let restartError: string | undefined;
    if (restartWorker) {
      try {
        await dockerComposeCmd(["restart", "alfred-learn"]);
        restartTriggered = true;
      } catch (err) {
        restartError = err instanceof Error ? err.message : String(err);
      }
    }

    sendJson(res, 200, {
      slug,
      module,
      source_path: sourcePath,
      vault_path: vaultPath,
      schedule_id: scheduleId,
      workflow_class_name: effectiveWorkflowClass,
      cron: resolvedCron,
      restart_triggered: restartTriggered,
      restart_error: restartError,
      changes: {
        python_source: newSource !== null,
        schedule: newCron !== null,
        workflow_class_name: newWorkflowClass !== null,
        params: newParams !== null,
        name: newName !== null,
        user_facing_description: newDesc !== null,
        tags: newTags !== null,
      },
      message: restartTriggered
        ? `Chore '${slug}' patched; alfred-learn restarted to reload.`
        : newSource
          ? `Chore '${slug}' patched. Source changed — trigger alfred-learn restart via POST /api/v1/admin/restart-learn before next run.`
          : `Chore '${slug}' patched.`,
    });
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
    //
    // The regex runs against the FULL source (not per-line) because the
    // generated templates put the activity name on the line after
    // `workflow.execute_activity(`, like:
    //
    //   ctx = await workflow.execute_activity(
    //       load_chore_context,
    //       args=[...],
    //   )
    //
    // We use the `s` (dotAll) flag so `\s*` reliably spans newlines.
    const callRe = /workflow\.execute_activity\s*\(\s*([a-z_][a-z0-9_]*)/gis;
    const activityCalls: Array<{ name: string; line: number; snippet: string }> = [];
    const lines = source.split("\n");
    // Precompute cumulative char offsets so we can map match.index → line number
    const lineOffsets: number[] = [];
    let runningOffset = 0;
    for (const line of lines) {
      lineOffsets.push(runningOffset);
      runningOffset += line.length + 1; // +1 for the stripped \n
    }
    const findLineFromOffset = (offset: number): number => {
      // Binary search over lineOffsets
      let lo = 0;
      let hi = lineOffsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineOffsets[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1; // 1-based line number
    };
    for (const match of source.matchAll(callRe)) {
      const name = match[1];
      const idx = match.index ?? 0;
      const lineNum = findLineFromOffset(idx);
      // Capture a few lines of context starting from the line containing
      // `workflow.execute_activity(` — usually the args span 3-6 lines
      // (name, args=[...], start_to_close_timeout, retry_policy).
      const startLineIdx = lineNum - 1;
      const snippetLines = lines.slice(startLineIdx, Math.min(startLineIdx + 6, lines.length));
      const snippet = snippetLines.join("\n").slice(0, 400);
      activityCalls.push({ name, line: lineNum, snippet });
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
