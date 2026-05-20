import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError, ConflictError } from "../errors.js";
import { dockerExec, dockerComposeCmd } from "../helpers.js";
import { VAULT_PATH, walkMd, readRecord, IGNORE_DIRS } from "./vault.js";
import { CHORE_ACTION_MANIFEST, lookupChoreActions, type ChoreActionSpec } from "./chore_manifest_data.js";
import { nextFireTime } from "../cron.js";

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

// ---------------------------------------------------------------------------
// RFC #884 — Living Narratives detail composition for a single chore.
//
// `GET /api/v1/chores/:slug` returns the legacy `{slug, frontmatter, body}`
// shape AND a new `chore` block describing the chore's living state +
// chronological timeline of signals / signal-actions / state transitions
// targeting it. The dashboard consumes the `chore` block; existing
// callers reading slug/frontmatter/body continue to work.
//
// Chores live at `chore/<slug>.md` (type: chore). Signals may target a
// chore via `target_candidates[].path == "chore/<slug>.md"`. We also
// match `task/<slug>.md` defensively in case alfred-learn ever routes
// task-shaped completion signals at a chore-shaped target (the existing
// curator path can sometimes mistype the directory).
// ---------------------------------------------------------------------------

type ChoreTimelineKind = "signal" | "task_transition" | "action";

interface ChoreTimelineEntry {
  when: string;
  kind: ChoreTimelineKind;
  headline: string;
  path: string;
}

type ChoreState = "pending" | "in_progress" | "done" | "archived";

interface ChoreDetail {
  id: string;
  path: string;
  name: string;
  state: ChoreState;
  current_state: string | null;
  as_of: string | null;
  timeline: ChoreTimelineEntry[];
}

const CHORE_TIMELINE_CAP = 100;
const CHORE_DETAIL_TTL_MS = 60_000;
const _choreDetailCache = new Map<
  string,
  { at: number; body: { slug: string; frontmatter: Record<string, unknown>; body: string; chore: ChoreDetail } }
>();

/** Coerce a frontmatter chore/task state to one of the four canonical
 *  values. Defaults to "pending" when missing/unknown so a chore record
 *  that pre-dates the Living Narratives migration still renders. */
function normalizeChoreState(raw: unknown): ChoreState {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "in_progress" || s === "in-progress" || s === "active") return "in_progress";
  if (s === "done" || s === "completed" || s === "complete") return "done";
  if (s === "archived" || s === "paused" || s === "cancelled" || s === "canceled") return "archived";
  return "pending";
}

/** First sentence cap at `cap` chars. Falls back to first `cap` chars. */
function firstSentence(text: string, cap = 100): string {
  if (!text) return "";
  const trimmed = String(text).replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  const m = trimmed.match(/^[^.!?]*[.!?](?=\s|$)/);
  const candidate = m ? m[0] : trimmed;
  if (candidate.length <= cap) return candidate.trim();
  return candidate.slice(0, cap).trim();
}

/** Summarise an event/signal-action-*.md audit record into a timeline
 *  entry's when+headline. Returns null if the record can't be read. */
function summarizeSignalActionForChore(
  relPath: string,
): { when: string; headline: string } | null {
  const rec = readRecord(relPath);
  if (!rec) return null;
  // Signal-action audits use `timestamp`; older steward-action audits
  // use `created`. Cover both.
  const when = String(rec.fm.timestamp ?? rec.fm.created ?? rec.fm.created_at ?? "");
  let headline = "";
  if (typeof rec.fm.summary === "string" && rec.fm.summary.trim()) {
    headline = firstSentence(rec.fm.summary, 100);
  }
  if (!headline) {
    const bodyLines = rec.body.split("\n").map((l) => l.trim()).filter(Boolean);
    const proseLine = bodyLines.find((l) => !l.startsWith("#"));
    if (proseLine) {
      const cleaned = proseLine
        .replace(/^[-*]\s+/, "")
        .replace(/\*\*/g, "")
        .replace(/^_+|_+$/g, "");
      headline = firstSentence(cleaned, 100) || cleaned.slice(0, 100);
    }
    if (!headline) headline = rec.body.replace(/\s+/g, " ").trim().slice(0, 100);
  }
  return { when, headline };
}

/** Compose the timeline + Living Narratives block for a single chore.
 *  Walks the vault once for signals; bounded by TIMELINE_CAP. */
function composeChoreDetail(
  slug: string,
  fm: Record<string, unknown>,
  body: string,
): ChoreDetail {
  const choreVaultPath = `chore/${slug}.md`;
  const taskShapedPath = `task/${slug}.md`;
  const currentStateRaw = fm.current_state;
  const asOfRaw = fm.as_of;
  // Display name: frontmatter name/title, then first H1, then slug.
  let name = "";
  if (typeof fm.name === "string" && fm.name.trim()) name = fm.name.trim();
  else if (typeof fm.title === "string" && fm.title.trim()) name = fm.title.trim();
  if (!name) {
    const h1 = body.match(/^\s*#\s+(.+?)\s*$/m);
    if (h1) name = h1[1].trim();
  }
  if (!name) name = slug;

  const timeline: ChoreTimelineEntry[] = [];
  const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
  for (const relPath of files) {
    const display = relPath.replace(/\\/g, "/");
    if (!display.startsWith("signal/")) continue;
    const rec = readRecord(relPath);
    if (!rec) continue;
    if (rec.fm.type && String(rec.fm.type) !== "signal") continue;
    const candidates = rec.fm.target_candidates;
    if (!Array.isArray(candidates)) continue;
    let hit = false;
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const tp = String((c as { path?: unknown }).path ?? "");
      if (tp === choreVaultPath || tp === taskShapedPath) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    // 1. Signal entry.
    const when = String(rec.fm.created ?? rec.fm.applied_at ?? "");
    let headline = "";
    const proposal = rec.fm.action_proposal;
    if (proposal && typeof proposal === "object" && !Array.isArray(proposal)) {
      const what = (proposal as { what?: unknown }).what;
      if (typeof what === "string" && what.trim()) {
        headline = firstSentence(what, 100);
      }
    }
    if (!headline && typeof rec.fm.reasoning === "string") {
      headline = firstSentence(rec.fm.reasoning, 100);
    }
    if (!headline) headline = rec.stem;
    timeline.push({
      when,
      kind: "signal",
      headline,
      path: display,
    });
    // 2. Linked signal-action audit entry.
    const auditPath = rec.fm.audit_record_path;
    if (typeof auditPath === "string" && auditPath.trim()) {
      const summary = summarizeSignalActionForChore(auditPath.trim());
      if (summary) {
        timeline.push({
          when: summary.when,
          kind: "action",
          headline: summary.headline,
          path: auditPath.trim(),
        });
      }
    }
  }

  // 3. State-transition entry for the chore itself (if as_of is set,
  //    the steward/nightly-narrative rewrote state recently).
  const asOfStr =
    typeof asOfRaw === "string" && asOfRaw.trim() ? asOfRaw : null;
  const state = normalizeChoreState(fm.state ?? fm.status);
  if (asOfStr) {
    timeline.push({
      when: asOfStr,
      kind: "task_transition",
      headline: `Chore '${name}' → ${state}`,
      path: choreVaultPath,
    });
  }

  // Sort newest-first, cap.
  timeline.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
  const capped =
    timeline.length > CHORE_TIMELINE_CAP ? timeline.slice(0, CHORE_TIMELINE_CAP) : timeline;

  return {
    id: slug,
    path: choreVaultPath,
    name,
    state,
    current_state:
      typeof currentStateRaw === "string" && currentStateRaw.trim()
        ? currentStateRaw
        : null,
    as_of: asOfStr,
    timeline: capped,
  };
}

/**
 * Chore templates that have been promoted from per-tenant generated
 * (`/alfred-data/user-chores/<template>.py`) to platform built-ins
 * shipped inside the alfred-learn Docker image at
 * `packages/learn/src/workflows/chores/<template>.py`.
 *
 * A chore record's `generated: true` frontmatter flag is set at creation
 * time and is NOT updated when a template is promoted, so the flag is
 * not authoritative for these templates. Routes that read the .py from
 * the user-chores directory must consult this list before treating a
 * missing .py as "broken chore" — for these templates, the .py living
 * outside user-chores is the correct, healthy state.
 *
 * Source of truth: `packages/learn/src/workflows/chores/__init__.py`
 * `ALL_CHORE_TEMPLATES`. Keep this list in sync when chores get
 * promoted (or unpromoted) in that file. Comparison is on the
 * snake_case template name as written in the chore record's
 * `template:` frontmatter field.
 */
const STANDARD_LIBRARY_CHORE_TEMPLATES: ReadonlySet<string> = new Set([
  "briefing_morning",
  "briefing_evening",
  "subscription_watcher",
  "weekly_matter_digest",
]);

/**
 * Default schedule + display metadata for each standard-library chore,
 * used by `POST /api/v1/admin/chores/install-standard` when the caller
 * doesn't override. Schedules below use a tenant-local timezone supplied
 * by the schedule creator (Temporal `timeZoneName`), not UTC. Tenants are
 * expected to set their own tz at provision time; the cron strings here
 * read literally — "5am" means 5am tenant-local.
 *
 * Both briefing slots run the same BriefingWorkflow with a "morning" or
 * "evening" slot argument. See packages/learn/src/workflows/briefing.py.
 */
const STANDARD_LIBRARY_DEFAULTS: Record<
  string,
  { name: string; schedule: string; description: string; workflow_class_name: string }
> = {
  briefing_morning: {
    name: "Morning briefing",
    schedule: "0 5 * * *",
    workflow_class_name: "BriefingWorkflow",
    description:
      "Every morning at 5am, your butler walks in with the coffee and brings you up to speed. Reads last night's digest, checks what changed across your active matters overnight, and writes a short note led by the matters that moved.",
  },
  briefing_evening: {
    name: "Evening briefing",
    schedule: "0 17 * * *",
    workflow_class_name: "BriefingWorkflow",
    description:
      "End of day wrap at 5pm. Reads this morning's brief, checks what actually happened today versus what we expected, and writes the hand-off note for tomorrow's brief. Closes the daily loop.",
  },
  subscription_watcher: {
    name: "Subscription watcher",
    schedule: "0 7 * * 5",
    workflow_class_name: "SubscriptionWatcherWorkflow",
    description:
      "Weekly review of recurring charges across all payment domains. Surfaces failed payments, unexpected price increases, and zombie subscriptions. Silent on quiet weeks.",
  },
  weekly_matter_digest: {
    name: "Weekly matter digest",
    schedule: "0 16 * * 0",
    workflow_class_name: "WeeklyMatterDigestWorkflow",
    description:
      "Weekly synthesis across all active matters. One paragraph per matter that had movement, plus what's still open and what next week should be ready for.",
  },
};

const STANDARD_LIBRARY_BUILTIN_PATH = (template: string): string =>
  `packages/learn/src/workflows/chores/${template}.py`;

interface ChoreSummary {
  slug: string;
  name: string;
  status: string;
  template: string;
  schedule: string;
  schedule_id: string;
  last_run: string | null;
  next_run_at: string | null;
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
  // GET /api/v1/cron/preview?expr=<cron>&count=N
  //
  // STATE-MUTATION Phase I (#897) — Schedule editor next-5-fires preview.
  // Parses a 5-field cron expression and returns the next N firing times
  // (default 5, capped at 50) computed via the same `nextFireTime` walker
  // the chore-list endpoint uses to derive `next_run_at`. All times UTC ISO.
  // Returns 400 on parse failure with the validation error message so the
  // editor can surface "Invalid cron expression" inline.
  addRoute("GET", "/api/v1/cron/preview", async ({ res, query }) => {
    const expr = query.get("expr");
    if (typeof expr !== "string" || !expr.trim()) {
      throw new ValidationError("expr query parameter is required");
    }
    const countRaw = query.get("count");
    const count = Math.min(
      Math.max(1, parseInt(countRaw ?? "5", 10) || 5),
      50,
    );
    const fires: string[] = [];
    let cursor = new Date();
    for (let i = 0; i < count; i++) {
      const next = nextFireTime(expr, cursor);
      if (!next) {
        if (i === 0) {
          throw new ValidationError(`Invalid cron expression: ${expr}`);
        }
        break;
      }
      fires.push(next.toISOString());
      cursor = next;
    }
    sendJson(res, 200, { fires, expr, count });
  });

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
    const now = new Date();
    const chores: ChoreSummary[] = [];
    for (const file of files) {
      const slug = file.slice(0, -3);
      const parsed = readChoreFile(slug);
      if (!parsed) continue;
      const fm = parsed.frontmatter;
      if ((fm.type ?? "") !== "chore") continue;
      const schedule = (fm.schedule as string) ?? "";
      const status = (fm.status as string) ?? "active";
      // Paused/completed chores have no upcoming fire — leave null.
      let nextRunAt: string | null = null;
      if (status === "active" && schedule) {
        const next = nextFireTime(schedule, now);
        nextRunAt = next ? next.toISOString() : null;
      }
      chores.push({
        slug,
        name: (fm.name as string) ?? slug,
        status,
        template: (fm.template as string) ?? "",
        schedule,
        schedule_id: (fm.schedule_id as string) ?? `chore-${slug}`,
        last_run: (fm.last_run as string) || null,
        next_run_at: nextRunAt,
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
    // Phase 2 chore metadata. All optional — the LLM-generation path
    // emits these alongside the python_source so the principal-facing
    // detail page can render Capabilities + What+Why without re-parsing
    // the source on every read.
    const displayName = String(b.display_name ?? name).trim();
    const displayBody = String(b.display_body ?? description).trim();
    const category = String(b.category ?? "").trim().toLowerCase();
    const activitiesUsed = Array.isArray(b.activities_used)
      ? (b.activities_used as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    const toolsUsed = Array.isArray(b.tools_used)
      ? (b.tools_used as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    const usesLlm = Boolean(b.uses_llm);
    const llmAgentId = String(b.llm_agent_id ?? "").trim();
    const vaultWrites = Array.isArray(b.vault_writes)
      ? (b.vault_writes as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    const vaultReads = Array.isArray(b.vault_reads)
      ? (b.vault_reads as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
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
    const activitiesInline = activitiesUsed.length
      ? `[${activitiesUsed.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ")}]`
      : "[]";
    const toolsInline = toolsUsed.length
      ? `[${toolsUsed.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ")}]`
      : "[]";
    const vaultWritesInline = vaultWrites.length
      ? `[${vaultWrites.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ")}]`
      : "[]";
    const vaultReadsInline = vaultReads.length
      ? `[${vaultReads.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ")}]`
      : "[]";

    const recordLines = [
      "---",
      "activities_used: " + activitiesInline,
      ...(category ? [`category: ${yamlScalarQuote(category)}`] : []),
      `created: '${now}'`,
      "created_by: self",
      ...(displayBody ? [`display_body: ${yamlScalarQuote(displayBody)}`] : []),
      ...(displayName && displayName !== name
        ? [`display_name: ${yamlScalarQuote(displayName)}`]
        : []),
      "generated: true",
      "last_result: ''",
      "last_run: ''",
      ...(usesLlm && llmAgentId
        ? [`llm_agent_id: ${yamlScalarQuote(llmAgentId)}`]
        : []),
      `name: ${yamlScalarQuote(name)}`,
      `params: ${yamlScalarQuote(paramsJson)}`,
      "quarantine: false",
      "quarantine_remaining: 0",
      `schedule: ${yamlScalarQuote(cron)}`,
      `schedule_id: ${scheduleId}`,
      "status: active",
      `tags: ${tagsInline}`,
      `template: ${module}`,
      "tools_used: " + toolsInline,
      "type: chore",
      `user_facing_description: ${yamlScalarQuote(description)}`,
      `uses_llm: ${usesLlm ? "true" : "false"}`,
      "vault_reads: " + vaultReadsInline,
      "vault_writes: " + vaultWritesInline,
      `workflow_class_name: ${workflowClass}`,
      "---",
      "",
      `# ${name}`,
      "",
      displayBody || description || "Generated chore.",
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

  // Get one chore's details (frontmatter + body) PLUS the RFC #884
  // Living Narratives block:
  //   chore: { id, path, name, state, current_state, as_of, timeline }
  //
  // The legacy `{slug, frontmatter, body}` fields stay at the top level
  // so existing callers keep working. New consumers should read `chore`.
  // Response cached in-memory for 60s, keyed by slug — same TTL +
  // Map<string, {at, body}> pattern as /api/v1/vault/index (#873) and
  // /api/v1/matters/:id (#884).
  addRoute("GET", "/api/v1/chores/:slug", async ({ res, params }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    const now = Date.now();
    const cached = _choreDetailCache.get(slug);
    if (cached && now - cached.at < CHORE_DETAIL_TTL_MS) {
      sendJson(res, 200, cached.body);
      return;
    }
    const parsed = readChoreFile(slug);
    if (!parsed) throw new NotFoundError(`chore ${slug} not found`);
    if ((parsed.frontmatter.type ?? "") !== "chore") {
      throw new NotFoundError(`chore ${slug} not found`);
    }
    const chore = composeChoreDetail(slug, parsed.frontmatter, parsed.body);
    // Derive next_run_at from the cron expression on the fm so the
    // detail page can show "next run in 14h" without round-tripping to
    // Temporal. Paused/completed chores return null.
    const schedule = String(parsed.frontmatter.schedule ?? "").trim();
    const status = String(parsed.frontmatter.status ?? "active");
    let nextRunAt: string | null = null;
    if (status === "active" && schedule) {
      const next = nextFireTime(schedule, new Date());
      nextRunAt = next ? next.toISOString() : null;
    }
    const body = {
      slug,
      frontmatter: { ...parsed.frontmatter, next_run_at: nextRunAt },
      body: parsed.body,
      chore,
    };
    _choreDetailCache.set(slug, { at: now, body });
    sendJson(res, 200, body);
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

  // Delete — full teardown: Temporal schedule + any running workflow runs +
  // vault record .md file + user-chore .py template (and .bak siblings).
  // Each step is best-effort so partial-state cleanups still converge. The
  // response reports each component so callers (and agents) can't misread
  // a partial success as a complete delete.
  addRoute("DELETE", "/api/v1/chores/:slug", async ({ res, params }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    const choreFile = readChoreFile(slug);
    if (!choreFile) throw new NotFoundError(`chore ${slug} not found`);
    const templateName = String(choreFile.frontmatter["template"] ?? "").trim();

    // 1. Schedule
    let scheduleDeleted = false;
    try {
      await dockerExec("temporal", [
        "temporal", "schedule", "delete",
        "--schedule-id", `chore-${slug}`,
      ]);
      scheduleDeleted = true;
    } catch { /* swallow — likely already gone */ }

    // 2. Any running workflow runs spawned by the schedule. Schedule-spawned
    // runs use the workflow id pattern `chore-<slug>-<timestamp>`. Terminate
    // anything that's still Open.
    let workflowsTerminated = 0;
    try {
      const listOut = await dockerExec("temporal", [
        "temporal", "workflow", "list",
        "--query", `WorkflowId STARTS_WITH "chore-${slug}-" AND ExecutionStatus="Running"`,
        "--output", "json",
      ]);
      const runs = listOut
        .trim().split("\n").filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((r): r is { execution: { workflowId: string } } => !!r?.execution?.workflowId);
      for (const r of runs) {
        try {
          await dockerExec("temporal", [
            "temporal", "workflow", "terminate",
            "--workflow-id", r.execution.workflowId,
            "--reason", `chore ${slug} deleted via API`,
          ]);
          workflowsTerminated += 1;
        } catch { /* swallow */ }
      }
    } catch { /* swallow — list failure shouldn't block the rest */ }

    // 3. Vault record file
    let vaultRecordDeleted = false;
    try {
      const fp = path.join(CHORE_DIR, `${slug}.md`);
      fs.unlinkSync(fp);
      vaultRecordDeleted = true;
    } catch { /* swallow */ }

    // 4. User-chore template (.py + any .bak siblings written by chore_authoring)
    let templateDeleted = false;
    if (templateName && /^[a-z0-9_]+$/.test(templateName) && fs.existsSync(USER_CHORES_DIR)) {
      try {
        const fp = path.join(USER_CHORES_DIR, `${templateName}.py`);
        if (fs.existsSync(fp)) { fs.unlinkSync(fp); templateDeleted = true; }
        for (const entry of fs.readdirSync(USER_CHORES_DIR)) {
          if (entry.startsWith(`${templateName}.py.bak`)) {
            try { fs.unlinkSync(path.join(USER_CHORES_DIR, entry)); } catch { /* swallow */ }
          }
        }
      } catch { /* swallow */ }
    }

    sendJson(res, 200, {
      slug,
      deleted: vaultRecordDeleted,
      schedule_deleted: scheduleDeleted,
      workflows_terminated: workflowsTerminated,
      vault_record_deleted: vaultRecordDeleted,
      template_deleted: templateDeleted,
    });
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
  // GET /api/v1/chores/:slug/runs — paginated run history.
  //
  // Reads `/alfred-data/chore-run-history.jsonl`, filters by slug,
  // sorts newest-first. The JSONL is written by record_chore_run
  // (packages/learn/src/workflows/chores/_base.py:179) every time a
  // chore fires — that's the canonical run history. No separate vault
  // record_type, no backfill needed (already populated from real
  // executions).
  //
  // Query params:
  //   limit  default 25, max 200
  //   offset default 0
  // Returns: { runs: [{timestamp, result_summary, was_dry_run, age_seconds}], total }
  addRoute("GET", "/api/v1/chores/:slug/runs", async ({ res, params, query }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    // Make sure the chore exists so we don't silently return an empty
    // history for a typo'd slug.
    if (!readChoreFile(slug)) {
      throw new NotFoundError(`chore ${slug} not found`);
    }
    const limit = Math.min(
      Math.max(1, parseInt(query.get("limit") ?? "25", 10) || 25),
      200,
    );
    const offset = Math.max(0, parseInt(query.get("offset") ?? "0", 10) || 0);

    // PATH NOTE: ctrl-api container does NOT remap /mnt/encrypted/alfred to
    // /alfred-data (unlike alfred-learn). Read directly from the shared host
    // path so we see the file alfred-learn's record_chore_run wrote.
    const historyPath = "/mnt/encrypted/alfred/chore-run-history.jsonl";
    interface RunEntry {
      timestamp: string;     // ISO 8601 UTC — record_chore_run writes epoch seconds; we convert here
      result_summary: string;
      was_dry_run: boolean;
      age_seconds: number;
    }
    const raw0: Array<{
      tsEpoch: number;
      result_summary: string;
      was_dry_run: boolean;
    }> = [];
    let raw = "";
    try {
      raw = fs.readFileSync(historyPath, "utf-8");
    } catch {
      // File doesn't exist yet — first run hasn't happened. Empty history is
      // a valid state; return [].
      sendJson(res, 200, { runs: [], total: 0 });
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.chore_slug !== slug) continue;
        const ts = typeof entry.timestamp === "number" ? entry.timestamp : 0;
        raw0.push({
          tsEpoch: ts,
          result_summary: String(entry.result_summary ?? ""),
          was_dry_run: Boolean(entry.was_dry_run),
        });
      } catch {
        // Skip malformed lines — best-effort parse.
      }
    }
    // Newest first
    raw0.sort((a, b) => b.tsEpoch - a.tsEpoch);
    const total = raw0.length;
    const nowEpoch = Date.now() / 1000;
    const page: RunEntry[] = raw0.slice(offset, offset + limit).map((r) => ({
      timestamp: new Date(r.tsEpoch * 1000).toISOString(),
      result_summary: r.result_summary,
      was_dry_run: r.was_dry_run,
      age_seconds: Math.max(0, Math.round(nowEpoch - r.tsEpoch)),
    }));
    sendJson(res, 200, { runs: page, total });
  });

  addRoute("GET", "/api/v1/chores/:slug/source", async ({ res, params }) => {
    const slug = params?.slug;
    if (!slug) throw new ValidationError("slug is required");
    const record = readChoreFile(slug);
    if (!record) throw new NotFoundError(`chore ${slug} not found`);

    const fm = record.frontmatter;
    const moduleName = String(fm.template ?? slug.replace(/-/g, "_"));
    const isStandardLibrary = STANDARD_LIBRARY_CHORE_TEMPLATES.has(moduleName);
    const flagSaysGenerated = fm.generated === true || fm.generated === "true";

    // Standard-library chores ALWAYS take the built-in branch, even if the
    // chore record's frontmatter still carries `generated: true`. The flag
    // is set at creation time and isn't updated when a template gets
    // promoted to the standard library. The template name is the
    // authoritative signal.
    if (isStandardLibrary || !flagSaysGenerated) {
      sendJson(res, 200, {
        slug,
        generated: false,
        tier: isStandardLibrary ? "standard-library" : "unknown",
        template: moduleName,
        builtin_path: isStandardLibrary
          ? STANDARD_LIBRARY_BUILTIN_PATH(moduleName)
          : null,
        message: isStandardLibrary
          ? `Standard-library chore. The Python workflow ships inside the alfred-learn Docker image at ${STANDARD_LIBRARY_BUILTIN_PATH(moduleName)} in the alfred-platform repo. There is no per-tenant .py file for this chore — that's the correct, healthy state.`
          : "This is a standard-library chore. Source lives in packages/learn/src/workflows/chores/ in the alfred-platform repo.",
        source: null,
        imported_activities: [],
        activity_calls: [],
      });
      return;
    }

    // Generated chores: the .py lives in /alfred-data/user-chores/<template>.py
    const sourcePath = `/mnt/encrypted/alfred/user-chores/${moduleName}.py`;

    let source: string;
    try {
      source = fs.readFileSync(sourcePath, "utf-8");
    } catch {
      sendJson(res, 404, {
        slug,
        generated: true,
        tier: "generated-orphaned",
        template: moduleName,
        source: null,
        error: `Source file not found at ${sourcePath}`,
        hint: `The chore record claims generated:true but the .py is missing. Either the file was deleted, or the template was promoted to the standard library and this list (chores.ts: STANDARD_LIBRARY_CHORE_TEMPLATES) is out of date. Check Temporal: 'self → /api/v1/schedules/chore-${slug}' will show ActionCounts; the chore body's '## Run log' section will show recent runs. If both show recent activity, the chore is running fine via a built-in workflow class — add the template name to STANDARD_LIBRARY_CHORE_TEMPLATES and the chore record's generated flag should be flipped to false via /api/v1/admin/chores/refresh-tier.`,
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
      tier: "generated",
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

  // POST /api/v1/admin/chores/refresh-tier
  //
  // Sweep every chore record on this tenant and flip `generated:` from
  // `true` to `false` for any chore whose template is in the
  // STANDARD_LIBRARY_CHORE_TEMPLATES set above. Idempotent — running it
  // twice on a fresh tenant is a no-op. Used by the v2 promotion
  // migration; also safe to run any time a new template gets promoted.
  //
  // Returns the per-record result so the caller can see exactly what
  // changed (and what didn't, in case a record was already correct).
  addRoute("POST", "/api/v1/admin/chores/refresh-tier", async ({ res }) => {
    if (!fs.existsSync(CHORE_DIR)) {
      sendJson(res, 200, { changed: 0, results: [] });
      return;
    }
    const results: Array<{
      slug: string;
      template: string;
      tier: "standard-library" | "generated" | "no-template";
      action: "flipped-to-builtin" | "already-correct" | "skipped";
      detail?: string;
    }> = [];
    let changed = 0;
    for (const entry of fs.readdirSync(CHORE_DIR)) {
      if (!entry.endsWith(".md")) continue;
      const slug = entry.slice(0, -3);
      const record = readChoreFile(slug);
      if (!record) continue;
      const fm = record.frontmatter;
      const template = String(fm.template ?? "").trim();
      const isStandardLibrary =
        template !== "" && STANDARD_LIBRARY_CHORE_TEMPLATES.has(template);
      const flagSaysGenerated = fm.generated === true || fm.generated === "true";

      if (template === "") {
        results.push({ slug, template: "", tier: "no-template", action: "skipped", detail: "template field empty" });
        continue;
      }
      if (!isStandardLibrary) {
        results.push({
          slug,
          template,
          tier: "generated",
          action: "skipped",
          detail: "not in STANDARD_LIBRARY_CHORE_TEMPLATES",
        });
        continue;
      }
      if (!flagSaysGenerated) {
        results.push({ slug, template, tier: "standard-library", action: "already-correct" });
        continue;
      }
      // Flip generated: true → false in frontmatter, leave body alone.
      const fp = path.join(CHORE_DIR, `${slug}.md`);
      const content = fs.readFileSync(fp, "utf-8");
      const end = content.indexOf("\n---", 3);
      if (end === -1) {
        results.push({ slug, template, tier: "standard-library", action: "skipped", detail: "no closing frontmatter delimiter" });
        continue;
      }
      const fmBlock = content.slice(0, end);
      const rest = content.slice(end);
      const updated = fmBlock.replace(/^generated:\s*.*$/m, "generated: false");
      if (updated === fmBlock) {
        results.push({ slug, template, tier: "standard-library", action: "skipped", detail: "frontmatter has no `generated:` line to replace" });
        continue;
      }
      fs.writeFileSync(fp, updated + rest, "utf-8");
      changed += 1;
      results.push({ slug, template, tier: "standard-library", action: "flipped-to-builtin" });
    }
    sendJson(res, 200, { changed, results });
  });

  // POST /api/v1/admin/chores/install-standard
  //
  // Install one of the platform's standard-library chores on this tenant.
  // Creates the chore vault record (with `generated: false, tier: standard-library`)
  // and the Temporal schedule. Idempotent — if the chore already exists,
  // updates the schedule + frontmatter to match the requested values.
  //
  // Body: {
  //   template: "briefing_evening",               // required, must be in STANDARD_LIBRARY_CHORE_TEMPLATES
  //   schedule?: "0 17 * * *",                    // override default; falls back to STANDARD_LIBRARY_DEFAULTS
  //   name?: "Evening briefing",                  // override default
  //   user_facing_description?: "...",            // override default
  //   params?: {channel: "slack:default"}         // merged with {chore_slug} envelope
  // }
  //
  // Used by the platform deploy script to roll out new standard-library
  // chores to existing tenants, and by the operator to install a chore
  // that an old tenant didn't get during onboarding.
  addRoute("POST", "/api/v1/admin/chores/install-standard", async ({ res, body }) => {
    const b = (body as Record<string, unknown> | undefined) ?? {};
    const template = String(b.template ?? "").trim();
    if (!template) throw new ValidationError("body.template (string) required");
    if (!STANDARD_LIBRARY_CHORE_TEMPLATES.has(template)) {
      throw new ValidationError(
        `template '${template}' is not in STANDARD_LIBRARY_CHORE_TEMPLATES. Available: ${Array.from(STANDARD_LIBRARY_CHORE_TEMPLATES).join(", ")}`,
      );
    }
    const defaults = STANDARD_LIBRARY_DEFAULTS[template];
    if (!defaults) {
      throw new ValidationError(
        `template '${template}' has no entry in STANDARD_LIBRARY_DEFAULTS — needs to be added before this endpoint can install it`,
      );
    }

    const slug = template.replace(/_/g, "-");
    const cron = String(b.schedule ?? defaults.schedule).trim();
    const name = String(b.name ?? defaults.name);
    const description = String(b.user_facing_description ?? defaults.description);
    const paramsInput = (b.params as Record<string, unknown>) ?? {};
    const workflowInput = { chore_slug: slug, ...paramsInput };
    const paramsJson = JSON.stringify(workflowInput);
    const scheduleId = `chore-${slug}`;
    const vaultPath = path.join(CHORE_DIR, `${slug}.md`);
    const now = new Date().toISOString();

    // Idempotency: if a chore record already exists, this is a re-install.
    // Replace the schedule (delete + create) and overwrite the frontmatter
    // so the values converge to what was requested. Preserve the body.
    const existing = readChoreFile(slug);
    let action: "created" | "updated" = existing ? "updated" : "created";

    // Schedule: delete-then-create is the only path that lets us change cron.
    try {
      await dockerExec("temporal", [
        "temporal", "schedule", "delete",
        "--schedule-id", scheduleId,
      ]);
    } catch { /* swallow — likely doesn't exist */ }
    try {
      await dockerExec("temporal", [
        "temporal", "schedule", "create",
        "--schedule-id", scheduleId,
        "--type", defaults.workflow_class_name,
        "--task-queue", "alfred-learn",
        "--cron", cron,
        "--overlap-policy", "Skip",
        "--input", JSON.stringify(workflowInput),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`schedule create failed: ${msg.slice(0, 300)}`);
    }

    // Vault record: write fresh frontmatter + a default body if creating;
    // preserve body if updating.
    const recordLines = [
      "---",
      `created: '${existing ? (existing.frontmatter.created ?? now) : now}'`,
      "created_by: admin-install-standard",
      "generated: false",
      "last_result: ''",
      "last_run: ''",
      `name: ${yamlScalarQuote(name)}`,
      `params: ${yamlScalarQuote(paramsJson)}`,
      "quarantine: false",
      "quarantine_remaining: 0",
      `schedule: ${yamlScalarQuote(cron)}`,
      `schedule_id: ${scheduleId}`,
      "status: active",
      "tags: []",
      `template: ${template}`,
      "type: chore",
      `user_facing_description: ${yamlScalarQuote(description)}`,
      `workflow_class_name: ${defaults.workflow_class_name}`,
      "---",
      "",
    ];
    const bodyText = existing && existing.body
      ? existing.body
      : [
          `# ${name}`,
          "",
          description,
          "",
          "> **Standard-library chore.** Installed via `POST /api/v1/admin/chores/install-standard`. The Python workflow lives inside the alfred-learn image at `packages/learn/src/workflows/chores/" + template + ".py` — there is no per-tenant .py file for this chore.",
          "",
        ].join("\n");

    fs.mkdirSync(CHORE_DIR, { recursive: true });
    fs.writeFileSync(vaultPath, recordLines.join("\n") + bodyText, "utf-8");

    sendJson(res, 200, {
      slug,
      template,
      tier: "standard-library",
      schedule_id: scheduleId,
      schedule: cron,
      action,
      builtin_path: STANDARD_LIBRARY_BUILTIN_PATH(template),
    });
  });
}
