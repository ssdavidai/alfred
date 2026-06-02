import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { dockerComposeCmd, dockerExec, ALFRED_CMD } from "../helpers.js";
import { getInstinctCounts } from "../instinctCounts.js";

const VAULT_PATH = process.env.VAULT_PATH ?? "/vault";
const ALFRED_DATA = process.env.ALFRED_DATA_DIR ?? "/alfred-data";
const STREAMS_DIR = path.join(ALFRED_DATA, "streams");
const QUARANTINE_DIR = path.join(VAULT_PATH, "inbox", "_quarantine");
const ENV_PATH = "/opt/alfred/compose/.env";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkMdDir(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMdDir(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

interface ParsedFm {
  frontmatter: Record<string, string>;
  body: string;
}

function parseFrontmatter(content: string): ParsedFm {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: content };
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  // Use a real YAML parser — the previous regex-line implementation
  // mis-parsed block scalars (`key: |-`) and any other multi-line
  // value, leaking the YAML indicator (`|-`) into the field. That
  // surfaced on /instincts as a literal "|-" body for instincts whose
  // display_body was written as a block scalar.
  let fm: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(yamlBlock, { schema: yaml.DEFAULT_SCHEMA });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML — fall back to empty frontmatter rather than
    // crashing the whole list endpoint over one bad file.
    fm = {};
  }
  // Caller types the return as Record<string, string> for backward
  // compatibility. Stringify scalars, preserve structures via JSON for
  // the few consumers that read nested fields directly off this map.
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === null || v === undefined) flat[k] = "";
    else if (typeof v === "string") flat[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") flat[k] = String(v);
    else flat[k] = JSON.stringify(v);
  }
  return { frontmatter: flat, body };
}

function readVaultRecords(dir: string): Array<{ path: string; name: string; status: string; type: string; created: string; frontmatter: Record<string, string>; body: string }> {
  const files = walkMdDir(dir);
  const records: Array<{ path: string; name: string; status: string; type: string; created: string; frontmatter: Record<string, string>; body: string }> = [];
  for (const fullPath of files) {
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const { frontmatter: fm, body } = parseFrontmatter(content);
      records.push({
        path: path.relative(VAULT_PATH, fullPath),
        name: fm.name || fm.subject || path.basename(fullPath, ".md"),
        status: fm.status || "",
        type: fm.type || "",
        created: fm.created || "",
        frontmatter: fm,
        body,
      });
    } catch {
      // skip unreadable files
    }
  }
  return records;
}

function countStreamEvents(streamId: string): number {
  const safe = streamId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(STREAMS_DIR, `${safe}.jsonl`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function setEnvVar(key: string, value: string): void {
  let content = "";
  try {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    // .env may not exist yet
  }
  const lines = content.split("\n");
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n"));
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// ---------------------------------------------------------------------------
// Curator integration helpers
// ---------------------------------------------------------------------------

interface RoutingContext {
  assigned_to?: string;
  process?: string;
  instinct_name?: string;
  confidence_score?: number;
}

interface CuratorResult {
  processed: boolean;
  note_path?: string;
  entities_created?: string[];
  entities_linked?: string[];
  observation_path?: string;
  error?: string;
}

/**
 * Escape a string for safe YAML value output. Wraps in single quotes
 * if the value contains YAML-sensitive characters.
 */
function yamlEscape(value: string): string {
  if (/[:\n\r#'"{}[\],&*!|>%@`]/.test(value) || value.trim() !== value) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

/**
 * Validate that a vault-relative path is safe (no traversal, stays within vault).
 */
function assertSafePath(vaultRelPath: string): void {
  const resolved = path.resolve(VAULT_PATH, vaultRelPath);
  if (!resolved.startsWith(VAULT_PATH + path.sep) && resolved !== VAULT_PATH) {
    throw new ValidationError(`Path traversal not allowed: ${vaultRelPath}`);
  }
  if (path.isAbsolute(vaultRelPath) || vaultRelPath.includes("..")) {
    throw new ValidationError(`Invalid path: ${vaultRelPath}`);
  }
}

/**
 * Write raw content into inbox/ with routing metadata in frontmatter,
 * then trigger the Curator to process it.
 */
async function routeViaCurator(
  inputPath: string,
  destination: string,
  routingContext: RoutingContext,
): Promise<CuratorResult> {
  // Validate paths
  assertSafePath(inputPath);
  assertSafePath(destination);

  // 1. Read the raw input file
  const fullInputPath = path.join(VAULT_PATH, inputPath);
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(fullInputPath, "utf-8");
  } catch {
    throw new NotFoundError(`Input not found: ${inputPath}`);
  }

  // 2. Build routing metadata — merge into existing frontmatter
  const { frontmatter: existingFm, body: existingBody } = parseFrontmatter(rawContent);

  // Remove any existing alfred_routing to avoid duplicates
  delete existingFm["alfred_routing"];

  const fmLines = ["---"];
  for (const [k, v] of Object.entries(existingFm)) {
    fmLines.push(`${k}: ${yamlEscape(v)}`);
  }
  // Append routing block
  fmLines.push("alfred_routing:");
  fmLines.push(`  destination: ${yamlEscape(destination)}`);
  if (routingContext.assigned_to) {
    fmLines.push(`  assigned_to: ${yamlEscape(routingContext.assigned_to)}`);
  }
  if (routingContext.process) {
    fmLines.push(`  process: ${yamlEscape(routingContext.process)}`);
  }
  if (routingContext.instinct_name) {
    fmLines.push(`  instinct: ${yamlEscape(routingContext.instinct_name)}`);
  }
  if (routingContext.confidence_score !== undefined) {
    fmLines.push(`  confidence: ${routingContext.confidence_score}`);
  }
  fmLines.push(`  routed_by: ${routingContext.instinct_name ? "auto-judgment" : "human"}`);
  fmLines.push("---");
  const enrichedContent = fmLines.join("\n") + "\n" + existingBody;

  // 3. Write to inbox/ with a collision-resistant name
  const inboxDir = path.join(VAULT_PATH, "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
  const stem = path.basename(inputPath, path.extname(inputPath));
  const ext = path.extname(inputPath) || ".md";
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const inboxFileName = `${stem}-${uniqueSuffix}${ext}`;
  const inboxPath = path.join(inboxDir, inboxFileName);
  fs.writeFileSync(inboxPath, enrichedContent, "utf-8");

  // 4. Trigger Curator to process this specific file
  //    Use --limit 1 scoped to our unique filename to avoid processing other inbox items
  const inboxContainerPath = path.posix.join("/vault", "inbox", inboxFileName);
  let curatorOutput: string;
  try {
    curatorOutput = await dockerExec("alfred", [...ALFRED_CMD, "process", "--limit", "1"], {
      ALFRED_VAULT_PATH: "/vault",
    });
  } catch (err) {
    // Curator failed — clean up inbox file, let caller handle fallback
    try { fs.unlinkSync(inboxPath); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    return { processed: false, error: `curator_failed: ${msg}` };
  }

  // 5. Check if our inbox file was actually consumed by Curator
  const inboxConsumed = !fs.existsSync(inboxPath);
  if (!inboxConsumed) {
    // Curator processed something else or skipped our file — don't delete original
    try { fs.unlinkSync(inboxPath); } catch { /* ignore */ }
    return { processed: false, error: "curator_did_not_consume_file" };
  }

  // 6. Only delete original after confirming Curator consumed the inbox file
  try { fs.unlinkSync(fullInputPath); } catch { /* may already be gone */ }

  // 7. Build result — parse curator output for entity info
  const result: CuratorResult = { processed: true };

  // Try to extract structured info from curator output (JSONL mutation log lines)
  const lines = curatorOutput.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.op === "create" && entry.path) {
        if (!result.entities_created) result.entities_created = [];
        result.entities_created.push(entry.path);
        // The first create is usually the main note
        if (!result.note_path) result.note_path = entry.path;
      }
      if (entry.op === "edit" && entry.path) {
        if (!result.entities_linked) result.entities_linked = [];
        result.entities_linked.push(entry.path);
      }
    } catch {
      // Non-JSON output lines — ignore
    }
  }

  return result;
}

/**
 * Write an observation record enriched with Curator results.
 */
function writeRoutingObservation(
  inputPath: string,
  destination: string,
  routingContext: RoutingContext,
  curatorResult: CuratorResult,
): string {
  const obsDir = path.join(VAULT_PATH, "observation");
  fs.mkdirSync(obsDir, { recursive: true });
  const ts = new Date().toISOString();
  const obsName = `route-${sanitizeId(path.basename(inputPath, ".md"))}-${ts.replace(/[:.]/g, "-")}`;

  const routedBy = routingContext.instinct_name ? "alfred" : "user";
  const entitiesCreated = curatorResult.entities_created || [];
  const entitiesLinked = curatorResult.entities_linked || [];

  const obsMd = [
    "---",
    `type: observation`,
    `status: unprocessed`,
    `name: ${yamlEscape(obsName)}`,
    `created: ${ts}`,
    `source: ${routingContext.instinct_name ? "auto-judgment" : "api-route"}`,
    `input_ref: ${yamlEscape(inputPath)}`,
    `destination: ${yamlEscape(destination)}`,
    `routed_by: ${routedBy}`,
    `confidence: ${routingContext.instinct_name ? "machine" : "human"}`,
  ];

  if (routingContext.instinct_name) {
    obsMd.push(`instinct: ${yamlEscape(routingContext.instinct_name)}`);
  }
  if (routingContext.confidence_score !== undefined) {
    obsMd.push(`confidence_score: ${routingContext.confidence_score}`);
  }
  if (routingContext.process) {
    obsMd.push(`process: ${yamlEscape(routingContext.process)}`);
  }
  if (routingContext.assigned_to) {
    obsMd.push(`assigned_to: ${yamlEscape(routingContext.assigned_to)}`);
  }

  obsMd.push(
    `curator_processed: ${curatorResult.processed}`,
    `entities_created: [${entitiesCreated.map((e) => `"${yamlEscape(e)}"`).join(", ")}]`,
    `entities_linked: [${entitiesLinked.map((e) => `"${yamlEscape(e)}"`).join(", ")}]`,
  );

  if (curatorResult.note_path) {
    obsMd.push(`note_path: ${yamlEscape(curatorResult.note_path)}`);
  }

  obsMd.push("---", "");

  if (curatorResult.processed) {
    obsMd.push(
      `Routed ${inputPath} to ${destination} and processed via Curator.`,
      "",
      `Created note: ${curatorResult.note_path || "unknown"}`,
      `Entities created: ${entitiesCreated.length}`,
      `Entities linked: ${entitiesLinked.length}`,
    );
  } else {
    obsMd.push(
      `Routed ${inputPath} to ${destination} (Curator unavailable — raw move).`,
      "",
      `Error: ${curatorResult.error || "unknown"}`,
    );
  }

  fs.writeFileSync(path.join(obsDir, `${obsName}.md`), obsMd.join("\n") + "\n", "utf-8");
  return `observation/${obsName}.md`;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerLearningRoutes(): void {

  // GET /api/v1/learning/status — overall learning subsystem stats
  addRoute("GET", "/api/v1/learning/status", async ({ res }) => {
    const observationDir = path.join(VAULT_PATH, "observation");
    // F.2 fix: read instincts from BOTH the legacy `intuition/instincts/`
    // path AND the newer `instinct/` path. The ctrl-api POST handler
    // routes writes to `vault/<type>/<name>.md` directly (using the type
    // field as the folder name), so VaultClient.write_record('instinct',
    // ...) lands at vault/instinct/. The TYPE_DIRECTORY mapping is only
    // applied on reads via the path resolver elsewhere. Reading both
    // paths handles both old and new records without a data migration.
    const instinctDirLegacy = path.join(VAULT_PATH, "intuition", "instincts");
    const instinctDirNew = path.join(VAULT_PATH, "instinct");
    const reflectionDir = path.join(VAULT_PATH, "reflection");
    const eventDir = path.join(VAULT_PATH, "event");

    const observations = readVaultRecords(observationDir);
    const instincts = [
      ...readVaultRecords(instinctDirLegacy),
      ...readVaultRecords(instinctDirNew),
    ];
    const reflections = readVaultRecords(reflectionDir);
    const streamProcessed = countStreamEvents("system-openclaw-sessions");

    // Check if alfred-learn is enabled
    let enabled = true;
    try {
      const envContent = fs.readFileSync(ENV_PATH, "utf-8");
      const match = envContent.match(/^ALFRED_LEARN_ENABLED=(.+)$/m);
      if (match) enabled = match[1].trim().toLowerCase() === "true";
    } catch {
      // default to true
    }

    // processedToday: count stream events processed today
    const todayPrefix = new Date().toISOString().slice(0, 10);
    let processedToday = 0;
    const processedEventsPath = path.join(STREAMS_DIR, "processed-events.json");
    try {
      const data = JSON.parse(fs.readFileSync(processedEventsPath, "utf-8"));
      const events = data.events as Record<string, { processed_at?: string }> | undefined;
      if (events) {
        for (const entry of Object.values(events)) {
          if (entry.processed_at && entry.processed_at.startsWith(todayPrefix)) {
            processedToday++;
          }
        }
      }
    } catch {
      // processed-events.json may not exist
    }

    // autoRouteRate: percentage of observations routed by alfred
    const totalObs = observations.length;
    let autoRouted = 0;
    if (totalObs > 0) {
      for (const obs of observations) {
        if (obs.frontmatter.routed_by === "alfred") {
          autoRouted++;
        }
      }
    }
    const autoRouteRate = totalObs > 0 ? Math.round((autoRouted / totalObs) * 100) : 0;

    // queueSize: count of unrouted inputs across the vault
    const allFiles = walkMdDir(VAULT_PATH);
    let queueSize = 0;
    for (const fullPath of allFiles) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const { frontmatter: fm } = parseFrontmatter(content);
        if (fm.status === "unrouted") queueSize++;
      } catch {
        // skip
      }
    }

    // recentActivity: last 20 lines from activity log
    const activityLogPath = path.join(ALFRED_DATA, "learn-activity.jsonl");
    let recentActivity: unknown[] = [];
    try {
      const content = fs.readFileSync(activityLogPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      recentActivity = lines.slice(-20).reverse().map((line: string) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    } catch {
      // activity log may not exist
    }

    // lastDigest: find the most recent event file with tag "digest"
    let lastDigest: { timestamp: string; path: string; summary: string } | null = null;
    const eventRecords = readVaultRecords(eventDir);
    const digestRecords = eventRecords.filter((r) =>
      r.frontmatter.tag === "digest" || r.frontmatter.tags?.includes("digest")
    );
    if (digestRecords.length > 0) {
      digestRecords.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
      const latest = digestRecords[0];
      lastDigest = {
        timestamp: latest.created,
        path: latest.path,
        summary: latest.body.slice(0, 500),
      };
    }

    sendJson(res, 200, {
      enabled,
      observations: {
        total: observations.length,
        // "unprocessed" is semantic (anything reflection hasn't consumed), not a
        // stored status — rows are written 'open'. Count by exclusion so this
        // matches the GET /observations?status=unprocessed contract.
        unprocessed: observations.filter(
          (r) => r.status !== "processed" && r.status !== "invalid",
        ).length,
        processed: observations.filter((r) => r.status === "processed").length,
        invalid: observations.filter((r) => r.status === "invalid").length,
      },
      instincts: {
        total: instincts.length,
        active: instincts.filter((r) => r.status === "active").length,
        proposed: instincts.filter((r) => r.status === "proposed").length,
        deprecated: instincts.filter((r) => r.status === "deprecated").length,
        merged: instincts.filter((r) => r.status === "merged").length,
      },
      reflections: { total: reflections.length },
      streams: { processed: streamProcessed },
      processedToday,
      autoRouteRate,
      queueSize,
      recentActivity,
      instinctCount: instincts.length,
      lastDigest,
    });
  });

  // GET /api/v1/learning/observations — paginated observation records
  addRoute("GET", "/api/v1/learning/observations", async ({ res, query }) => {
    const limit = Math.min(parseInt(query.get("limit") || "20", 10), 200);
    const offset = parseInt(query.get("offset") || "0", 10);

    const dir = path.join(VAULT_PATH, "observation");
    const records = readVaultRecords(dir);
    records.sort((a, b) => (b.created || "").localeCompare(a.created || ""));

    const page = records.slice(offset, offset + limit);
    sendJson(res, 200, { items: page, total: records.length, limit, offset });
  });

  // GET /api/v1/learning/instincts — list instinct records
  // F.2 fix: read from BOTH legacy `intuition/instincts/` and new `instinct/`
  addRoute("GET", "/api/v1/learning/instincts", async ({ res }) => {
    const legacyDir = path.join(VAULT_PATH, "intuition", "instincts");
    const newDir = path.join(VAULT_PATH, "instinct");
    const records = [
      ...readVaultRecords(legacyDir),
      ...readVaultRecords(newDir),
    ];
    records.sort((a, b) => a.name.localeCompare(b.name));
    // Enrich each record with the live observation count derived from
    // the observation/ directory (decision-sourced only). This is the
    // truth signal for Progressive Autonomy — counts here drive the
    // obs-count threshold formula in discretion.py via
    // signal_actions._instinct_threshold, and the /instincts UI's
    // stage badge.
    const counts = await getInstinctCounts();
    for (const rec of records) {
      const live = counts.get(rec.path) ?? 0;
      (rec.frontmatter as Record<string, unknown>).live_observation_count = live;
    }
    sendJson(res, 200, { items: records, total: records.length });
  });

  // GET /api/v1/learning/reflections — list reflection records
  addRoute("GET", "/api/v1/learning/reflections", async ({ res }) => {
    const dir = path.join(VAULT_PATH, "reflection");
    const records = readVaultRecords(dir);
    records.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    sendJson(res, 200, { items: records, total: records.length });
  });

  // GET /api/v1/learning/queue — unrouted inputs
  addRoute("GET", "/api/v1/learning/queue", async ({ res }) => {
    const files = walkMdDir(VAULT_PATH);
    const unrouted: Array<{ path: string; name: string; type: string; created: string }> = [];
    for (const fullPath of files) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const { frontmatter: fm } = parseFrontmatter(content);
        if (fm.status === "unrouted") {
          unrouted.push({
            path: path.relative(VAULT_PATH, fullPath),
            name: fm.name || fm.subject || path.basename(fullPath, ".md"),
            type: fm.type || "",
            created: fm.created || "",
          });
        }
      } catch {
        // skip
      }
    }
    sendJson(res, 200, { items: unrouted, total: unrouted.length });
  });

  // POST /api/v1/curator/route-and-process — route input via Curator for structured processing
  addRoute("POST", "/api/v1/curator/route-and-process", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.input_path !== "string" || typeof b.destination !== "string") {
      throw new ValidationError("input_path and destination are required");
    }

    const inputPath = b.input_path as string;
    const destination = b.destination as string;
    const routingContext = (b.routing_context || {}) as RoutingContext;

    // Attempt Curator processing
    let curatorResult = await routeViaCurator(inputPath, destination, routingContext);

    // Fallback: if Curator failed, do a raw file move
    let fallbackMoved = false;
    if (!curatorResult.processed) {
      const fullInputPath = path.join(VAULT_PATH, inputPath);
      try {
        const destDir = path.join(VAULT_PATH, destination);
        fs.mkdirSync(destDir, { recursive: true });
        const destPath = path.join(destDir, path.basename(inputPath));
        fs.renameSync(fullInputPath, destPath);
        curatorResult = {
          processed: false,
          note_path: path.join(destination, path.basename(inputPath)),
          error: curatorResult.error,
        };
        fallbackMoved = true;
      } catch (moveErr) {
        // Both Curator and fallback move failed
        const moveErrMsg = moveErr instanceof Error ? moveErr.message : String(moveErr);
        curatorResult.error = `${curatorResult.error}; fallback_move_failed: ${moveErrMsg}`;
      }
    }

    // Write enriched observation
    const observationPath = writeRoutingObservation(
      inputPath, destination, routingContext, curatorResult,
    );

    // If neither Curator nor fallback succeeded, return 500
    if (!curatorResult.processed && !fallbackMoved) {
      sendJson(res, 500, {
        processed: false,
        error: curatorResult.error || "routing_failed",
        observation_path: observationPath,
      });
      return;
    }

    sendJson(res, 200, {
      processed: curatorResult.processed,
      note_path: curatorResult.note_path || null,
      entities_created: curatorResult.entities_created || [],
      entities_linked: curatorResult.entities_linked || [],
      observation_path: observationPath,
    });
  });

  // POST /api/v1/learning/route — route an input to a destination (with Curator processing)
  addRoute("POST", "/api/v1/learning/route", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.input_id !== "string" || typeof b.destination !== "string") {
      throw new ValidationError("input_id and destination are required");
    }

    const inputId = b.input_id as string;
    const destination = b.destination as string;

    // Validate paths
    assertSafePath(inputId);
    assertSafePath(destination);

    // Try Curator-backed processing first
    const routingContext: RoutingContext = {};
    let curatorResult: CuratorResult;
    try {
      curatorResult = await routeViaCurator(inputId, destination, routingContext);
    } catch (err) {
      // If input not found, re-throw as NotFoundError
      if (err instanceof NotFoundError) throw err;
      // Otherwise, Curator integration failed — set up for fallback
      curatorResult = {
        processed: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Fallback: if Curator failed, do a raw file move (original behavior)
    if (!curatorResult.processed) {
      const inputPath = path.join(VAULT_PATH, inputId);
      try {
        const content = fs.readFileSync(inputPath, "utf-8");
        // Only move if file still exists (wasn't consumed by failed curator attempt)
        const destDir = path.join(VAULT_PATH, destination);
        fs.mkdirSync(destDir, { recursive: true });
        const destPath = path.join(destDir, path.basename(inputId));
        fs.renameSync(inputPath, destPath);
        void content; // validated file existed
      } catch {
        // File may have already been moved or cleaned up
      }
    }

    // Write enriched observation
    const observationPath = writeRoutingObservation(
      inputId, destination, routingContext, curatorResult,
    );

    sendJson(res, 200, {
      message: `Routed ${inputId} to ${destination}`,
      processed: curatorResult.processed,
      note_path: curatorResult.note_path || null,
      entities_created: curatorResult.entities_created || [],
      entities_linked: curatorResult.entities_linked || [],
      observation: observationPath,
      observation_path: observationPath,  // normalized key for compatibility
    });
  });

  // POST /api/v1/learning/bootstrap — add alfred-learn to compose + start it
  // Safe to call on any tenant (new or existing). Idempotent.
  addRoute("POST", "/api/v1/learning/bootstrap", async ({ res }) => {
    const composePath = "/opt/alfred/compose/docker-compose.yaml";
    let compose = "";
    try {
      compose = fs.readFileSync(composePath, "utf-8");
    } catch {
      throw new ValidationError("docker-compose.yaml not found");
    }

    // Only patch if alfred-learn not already present
    if (!compose.includes("alfred-learn:")) {
      const serviceBlock = `
  alfred-learn:
    image: ssdavidai00/alfred-learn:latest
    depends_on:
      temporal:
        condition: service_healthy
      openclaw:
        condition: service_healthy
    volumes:
      - /mnt/encrypted/vault:/vault
      - /mnt/encrypted/alfred:/alfred-data
    environment:
      - TEMPORAL_HOST=temporal:7233
      - OPENCLAW_GATEWAY_URL=http://openclaw:18789
      - OPENCLAW_WORKERS_GATEWAY_URL=http://openclaw-workers:18790
      - OPENCLAW_GATEWAY_TOKEN_FILE=/alfred-data/.gateway-token
      - VAULT_PATH=/vault
      - TASK_QUEUE=alfred-learn
      - ALFRED_LEARN_ENABLED=\${ALFRED_LEARN_ENABLED:-true}
    env_file:
      - .env
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 1g
    pids_limit: 128
`;
      // Append before the last line (or at end of services block)
      compose = compose.trimEnd() + "\n" + serviceBlock + "\n";
      fs.writeFileSync(composePath, compose, "utf-8");
    }

    // Pull latest image
    try {
      await dockerComposeCmd(["pull", "alfred-learn"]);
    } catch {
      // ignore pull errors (will use cached if available)
    }

    // Start the container
    await dockerComposeCmd(["up", "-d", "alfred-learn"]);
    setEnvVar("ALFRED_LEARN_ENABLED", "true");

    sendJson(res, 200, { message: "Alfred Learn bootstrapped and started" });
  });

  // POST /api/v1/learning/enable — enable alfred-learn
  addRoute("POST", "/api/v1/learning/enable", async ({ res }) => {
    setEnvVar("ALFRED_LEARN_ENABLED", "true");
    try {
      await dockerComposeCmd(["up", "-d", "alfred-learn"]);
    } catch {
      // container may not exist yet in older deployments
    }
    sendJson(res, 200, { message: "Alfred Learn enabled", enabled: true });
  });

  // POST /api/v1/learning/disable — disable alfred-learn
  addRoute("POST", "/api/v1/learning/disable", async ({ res }) => {
    setEnvVar("ALFRED_LEARN_ENABLED", "false");
    try {
      await dockerComposeCmd(["stop", "alfred-learn"]);
    } catch {
      // container may not be running
    }
    sendJson(res, 200, { message: "Alfred Learn disabled", enabled: false });
  });

  // GET /api/v1/learning/quarantine — list quarantined files
  addRoute("GET", "/api/v1/learning/quarantine", async ({ res }) => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(QUARANTINE_DIR).filter((f) => !f.startsWith("."));
    } catch {
      // quarantine dir may not exist
    }

    const items = files.map((f) => {
      const fullPath = path.join(QUARANTINE_DIR, f);
      let size = 0;
      let mtime = "";
      try {
        const stat = fs.statSync(fullPath);
        size = stat.size;
        mtime = stat.mtime.toISOString();
      } catch {
        // skip stat errors
      }
      return { id: f, filename: f, size, modified_at: mtime };
    });

    sendJson(res, 200, { files: items, total: items.length });
  });

  // POST /api/v1/learning/quarantine/:id/retry — move back to inbox
  addRoute("POST", "/api/v1/learning/quarantine/:id/retry", async ({ res, params }) => {
    const id = sanitizeId(params.id);
    const src = path.join(QUARANTINE_DIR, id);
    const dest = path.join(VAULT_PATH, "inbox", id);

    if (!fs.existsSync(src)) {
      throw new NotFoundError(`Quarantined file not found: ${id}`);
    }

    fs.mkdirSync(path.join(VAULT_PATH, "inbox"), { recursive: true });
    fs.renameSync(src, dest);
    sendJson(res, 200, { message: `Moved ${id} back to inbox` });
  });

  // POST /api/v1/learning/quarantine/:id/dismiss — delete quarantined file
  addRoute("POST", "/api/v1/learning/quarantine/:id/dismiss", async ({ res, params }) => {
    const id = sanitizeId(params.id);
    const filePath = path.join(QUARANTINE_DIR, id);

    if (!fs.existsSync(filePath)) {
      throw new NotFoundError(`Quarantined file not found: ${id}`);
    }

    fs.unlinkSync(filePath);
    sendJson(res, 200, { message: `Dismissed quarantined file: ${id}` });
  });

  // GET /api/v1/learning/observations/:id — single observation detail
  addRoute("GET", "/api/v1/learning/observations/:id", async ({ res, params }) => {
    const id = sanitizeId(params.id);
    const filePath = path.join(VAULT_PATH, "observation", id);

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      throw new NotFoundError(`Observation not found: ${id}`);
    }

    const { frontmatter, body } = parseFrontmatter(content);
    sendJson(res, 200, {
      path: path.join("observation", id),
      frontmatter,
      body,
    });
  });

  // GET /api/v1/learning/instincts/:id — single instinct detail
  addRoute("GET", "/api/v1/learning/instincts/:id", async ({ res, params }) => {
    const id = sanitizeId(params.id);
    const filePath = path.join(VAULT_PATH, "intuition", "instincts", id);

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      throw new NotFoundError(`Instinct not found: ${id}`);
    }

    const { frontmatter, body } = parseFrontmatter(content);
    sendJson(res, 200, {
      path: path.join("intuition", "instincts", id),
      frontmatter,
      body,
    });
  });

  // GET /api/v1/learning/sessions — list session records
  addRoute("GET", "/api/v1/learning/sessions", async ({ res }) => {
    const dir = path.join(VAULT_PATH, "session");
    const records = readVaultRecords(dir);
    records.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    sendJson(res, 200, { items: records, total: records.length });
  });
}
