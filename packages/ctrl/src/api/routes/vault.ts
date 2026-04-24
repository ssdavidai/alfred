import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { dockerExec, ALFRED_CMD } from "../helpers.js";
import { emitStreamEvent } from "./streams.js";
import {
  triggerPlaneSyncNudge,
  slugFromVaultPath,
  type PlaneNudgeRecordType,
} from "./plane.js";

export const VAULT_PATH = "/mnt/encrypted/vault";
const INBOX_PATH = `${VAULT_PATH}/inbox`;
export const VAULT_ENV = { ALFRED_VAULT_PATH: "/vault" };

// ---------------------------------------------------------------------------
// Per-path write mutex (#593).
//
// ``alfred vault edit`` takes a per-file lock inside the alfred container,
// so concurrent writes to the same vault record are already serialised
// at the filesystem level — but the serialisation happens AFTER the
// `docker compose exec` fork-chain lands. Forcing same-file writes to
// queue at the ctrl-api boundary cuts the fork-storm that tripped
// pids_limit saturation under fleet load (plane_sync /
// plane_reverse_sync / hourly_enrichment all driving concurrent
// docker-exec). It also produces cleaner audit logs (no redundant
// no-op writes stacked while the file was already kernel-locked).
// ---------------------------------------------------------------------------

const _vaultPathLocks = new Map<string, Promise<unknown>>();

async function _withVaultPathLock<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = _vaultPathLocks.get(relPath) ?? Promise.resolve();
  // Swallow previous failures so one 500 doesn't poison the whole queue.
  const current = previous.then(() => fn(), () => fn());
  _vaultPathLocks.set(relPath, current);
  try {
    return await current;
  } finally {
    // Clean up only if we're still the tail; otherwise someone chained
    // behind us and the map entry is theirs to clean up.
    if (_vaultPathLocks.get(relPath) === current) {
      _vaultPathLocks.delete(relPath);
    }
  }
}

export const IGNORE_DIRS = new Set(["_templates", "_bases", "_docs", ".obsidian", "view", "dashboard"]);

const KNOWN_TYPES = [
  "person", "org", "project", "task", "event", "note", "location",
  "process", "account", "asset", "conversation", "input", "run",
  "session", "decision", "triage",
  "assumption", "constraint", "contradiction", "synthesis",
  "observation", "instinct", "reflection",
  "matter", "ledger_entry",
  "chore",
];

const STATUS_BY_TYPE: Record<string, string[]> = {
  project: ["active", "paused", "completed", "abandoned", "proposed"],
  task: ["todo", "active", "blocked", "done", "cancelled"],
  session: ["active", "paused", "finished"],
  input: ["unprocessed", "processed", "deferred"],
  person: ["active", "inactive"],
  org: ["active", "inactive"],
  location: ["active", "inactive"],
  note: ["draft", "active", "review", "final"],
  decision: ["draft", "final", "superseded", "reversed"],
  process: ["active", "proposed", "design", "deprecated"],
  run: ["active", "completed", "blocked", "cancelled"],
  account: ["active", "suspended", "closed", "pending"],
  asset: ["active", "retired", "maintenance", "disposed"],
  conversation: ["active", "waiting", "resolved", "closed", "archived"],
  assumption: ["active", "challenged", "invalidated", "confirmed"],
  constraint: ["active", "expired", "waived", "superseded"],
  contradiction: ["unresolved", "resolved", "accepted"],
  synthesis: ["draft", "active", "superseded"],
  observation: ["unprocessed", "processed", "invalid"],
  instinct: ["active", "proposed", "deprecated", "merged"],
  matter: ["active", "resolved", "abandoned"],
  ledger_entry: ["active"],
  chore: ["active", "paused", "completed"],
};

const TYPE_DIRECTORY: Record<string, string> = {
  project: "project",
  task: "task",
  person: "person",
  org: "org",
  location: "location",
  note: "note",
  decision: "decision",
  process: "process",
  run: "run",
  event: "event",
  account: "account",
  asset: "asset",
  conversation: "conversation",
  assumption: "assumption",
  constraint: "constraint",
  contradiction: "contradiction",
  synthesis: "synthesis",
  observation: "observation",
  instinct: "intuition/instincts",
  matter: "matter",
  ledger_entry: "ledger_entry",
  chore: "chore",
};

const LIST_FIELDS = [
  "tags", "aliases", "related", "relationships", "participants",
  "outputs", "depends_on", "blocked_by", "based_on", "supports",
  "challenged_by", "approved_by", "confirmed_by", "invalidated_by",
  "cluster_sources", "governed_by", "references", "project",
];

const REQUIRED_FIELDS = ["type", "created"];

const NAME_FIELD_BY_TYPE: Record<string, string> = {
  conversation: "subject",
  input: "subject",
};

// ---------------------------------------------------------------------------
// Plane forward-sync nudge hook (#574)
//
// Every successful write to a matter/* or task/* path kicks off a
// single-record forward-sync workflow so Plane reflects the change in
// 1-3 s instead of waiting up to 15 s for the cron tick.
//
// ``setImmediate`` pushes the work after the current tick so the
// response to the vault-write caller is never blocked; the nudge
// itself swallows all errors in ``triggerPlaneSyncNudge`` so a
// Temporal outage cannot leak an error back into the HTTP response
// the operator already saw.
// ---------------------------------------------------------------------------

function scheduleNudgeForPath(relPath: string): void {
  // Classify by the directory prefix — matter/* and task/* are the
  // two types that mirror into Plane. Anything else is a no-op.
  let recordType: PlaneNudgeRecordType | null = null;
  if (relPath.startsWith("matter/") || relPath.startsWith("matter\\")) {
    recordType = "matter";
  } else if (relPath.startsWith("task/") || relPath.startsWith("task\\")) {
    recordType = "task";
  }
  if (!recordType) return;

  const slug = slugFromVaultPath(recordType, relPath.replace(/\\/g, "/"));
  if (!slug) return;

  // Fire-and-forget: never await, never throw.
  setImmediate(() => {
    triggerPlaneSyncNudge(recordType, slug).catch((err: unknown) => {
      console.warn(
        `[vault.plane_nudge] unexpected throw record_type=${recordType} slug=${slug}: ${(err as Error).message}`,
      );
    });
  });
}

function scheduleNudgeForRecord(
  recordType: string | undefined,
  recordName: string | undefined,
): void {
  if (recordType !== "matter" && recordType !== "task") return;
  if (!recordName) return;
  // ``name`` on create can be either a bare slug or a prefixed/suffixed
  // path. Feed the raw value through the same resolver the write
  // handler uses so the slug extraction stays consistent.
  const slug = slugFromVaultPath(recordType, recordName);
  if (!slug) return;
  setImmediate(() => {
    triggerPlaneSyncNudge(recordType, slug).catch((err: unknown) => {
      console.warn(
        `[vault.plane_nudge] unexpected throw record_type=${recordType} slug=${slug}: ${(err as Error).message}`,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Security: path validation & resolution
// ---------------------------------------------------------------------------

/** Resolve a relative vault path to an absolute path, rejecting traversal. */
function resolveVaultPath(relPath: string): string {
  if (relPath.includes("\0")) throw new ValidationError("Invalid path");
  const normalized = path.normalize(relPath);
  if (path.isAbsolute(normalized)) throw new ValidationError("Absolute paths not allowed");
  if (normalized.startsWith("..")) throw new ValidationError("Path traversal denied");
  const full = path.resolve(VAULT_PATH, normalized);
  const base = path.resolve(VAULT_PATH);
  if (!full.startsWith(base + path.sep) && full !== base) {
    throw new ValidationError("Path traversal denied");
  }
  return full;
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser
// ---------------------------------------------------------------------------
//
// Hand-rolled regex predecessor had three cascading bugs in the last
// 48 hours:
//   - #611: plain-scalar folded continuations (multi-line unquoted
//     strings) were truncated at the first line; fix #612 patched it
//     with yet more regex.
//   - 2026-04-24 midday: `archived: ''` from the CLI layer was returned
//     as the empty string, which Python evaluated as falsy — tasks
//     lingered as "zombies" instead of archiving.
//   - 2026-04-24 evening: unquoted `archived: false` was returned as
//     the string "false" (truthy in Python) — plane_sync saw truthy,
//     silently archived 254 active Rapali tasks. Band-aided in #621
//     with `coercePlainScalar`.
//
// Every one of those failures was a consequence of reimplementing YAML
// piecemeal. The structural fix: hand parsing to a spec-conformant
// YAML 1.2 parser (js-yaml) and delete the regex machinery.
//
// Contract preserved:
//   - same signature: `parseFrontmatter(content) => { frontmatter, body }`
//   - malformed YAML returns `{ frontmatter: {}, body: content }` (total)
//   - legacy null-to-empty-string mapping preserved for back-compat
//     with downstream consumers that expect "" for missing optional
//     fields (pre-existing branch in the old parser; keeping it on
//     top-level scalars to avoid a silent contract break)

interface ParsedRecord {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(content: string): ParsedRecord {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  let fm: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(yamlBlock, { schema: yaml.DEFAULT_SCHEMA });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
      // Legacy contract: top-level `key: null` / `key: ~` / bare `key:`
      // becomes the empty string for downstream consumers that
      // historically read missing-optional fields as "".
      for (const k of Object.keys(fm)) {
        if (fm[k] === null) fm[k] = "";
      }
    }
  } catch {
    // Malformed YAML — return empty frontmatter rather than crash.
    // Historical behaviour: broken records never blocked reads.
  }
  return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// Recursive .md file walker (sync, fast)
// ---------------------------------------------------------------------------

export function walkMd(dir: string, base: string, ignoreDirs: Set<string>): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      results.push(...walkMd(path.join(dir, entry.name), base, ignoreDirs));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(path.relative(base, path.join(dir, entry.name)));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Shared read helper
// ---------------------------------------------------------------------------

export function readRecord(relPath: string): { fm: Record<string, unknown>; body: string; stem: string } | null {
  const fullPath = path.join(VAULT_PATH, relPath);
  let content: string;
  try {
    content = fs.readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
  const { frontmatter: fm, body } = parseFrontmatter(content);
  const stem = path.basename(relPath, ".md");
  return { fm, body, stem };
}

function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[\/\\:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new ValidationError("Invalid filename");
  }
  return sanitized;
}

// Extension → media category.
// Kept in sync with packages/learn/src/activities/media.py — if you add a type
// here, add it there. `.txt` is intentionally excluded so plain text uploads
// fall through to the curator/text path instead of MediaIngestionWorkflow.
const MEDIA_EXT_MAP: Record<string, "audio" | "document" | "image" | "video"> = {
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio",
  pdf: "document", doc: "document", docx: "document",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  mp4: "video", webm: "video", mov: "video",
};

const MIME_CATEGORY_MAP: Array<[RegExp, "audio" | "document" | "image" | "video"]> = [
  [/^audio\//, "audio"],
  [/^image\//, "image"],
  [/^video\//, "video"],
  [/^application\/pdf$/, "document"],
  [/^application\/(ms|vnd\.openxmlformats-officedocument|vnd\.oasis\.opendocument)/, "document"],
];

function detectMediaCategory(filename: string, mimeType?: string): "audio" | "document" | "image" | "video" | null {
  if (mimeType) {
    for (const [re, cat] of MIME_CATEGORY_MAP) {
      if (re.test(mimeType)) return cat;
    }
  }
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return null;
  const ext = filename.slice(idx + 1).toLowerCase();
  return MEDIA_EXT_MAP[ext] ?? null;
}

/**
 * If the uploaded file is media (audio/document/image/video), emit a stream
 * event with stream_type="media" so EventProcessorWorkflow will route it to
 * MediaIngestionWorkflow. Non-media files fall through to the normal inbox
 * scan / curator path.
 *
 * Returns the emitted event (with extracted file_type) or null when the file
 * is not media.
 */
function maybeEmitMediaEvent(
  filename: string,
  mimeType?: string,
): { id: string; file_type: string } | null {
  const category = detectMediaCategory(filename, mimeType);
  if (!category) return null;

  const containerPath = `/vault/inbox/${filename}`; // path as seen from the learn/alfred containers
  const event = emitStreamEvent({
    stream_id: "system-inbox",
    stream_type: "media",
    source_ref: `inbox:${filename}`,
    raw: {
      filename,
      path: path.join("inbox", filename),
      mime_type: mimeType || "",
    },
    summary: `Media upload: ${filename}`,
    metadata: {
      original_path: path.join("inbox", filename),
    },
    extra: {
      file_name: filename,
      file_path: containerPath,
      mime_type: mimeType || "",
      context: {},
    },
  });
  return { id: event.id, file_type: category };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerVaultRoutes(): void {

  // --- READ OPERATIONS: direct filesystem (fast, no docker overhead) ---

  // Vault context — returns all records grouped by type
  addRoute("GET", "/api/v1/vault/context", async ({ res }) => {
    const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
    const byType: Record<string, Array<{ path: string; name: string; status: string }>> = {};

    for (const relPath of files) {
      const rec = readRecord(relPath);
      if (!rec) continue;
      const recType = String(rec.fm.type || "");
      if (!recType) continue;

      const display = relPath.replace(/\\/g, "/").replace(/\.md$/, "");
      byType[recType] = byType[recType] || [];
      byType[recType].push({
        path: display,
        name: rec.stem,
        status: String(rec.fm.status || ""),
      });
    }
    sendJson(res, 200, {
      records_by_type: byType,
      total: Object.values(byType).reduce((s, a) => s + a.length, 0),
    });
  });

  // Vault search — glob and/or grep
  addRoute("GET", "/api/v1/vault/search", async ({ res, query }) => {
    const globPat = query.get("glob");
    const grepPat = query.get("grep");

    // Validate glob (no traversal)
    if (globPat && (globPat.includes("..") || path.isAbsolute(globPat))) {
      throw new ValidationError("Invalid glob pattern");
    }

    let files: string[];
    if (globPat) {
      // Use Node glob-style: list all md files, then match against pattern
      const all = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
      const re = globToRegex(globPat);
      files = all.filter((f) => re.test(f));
    } else {
      files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
    }

    const results: Array<{ path: string; name: string; type: string; status: string }> = [];
    for (const relPath of files) {
      if (grepPat) {
        try {
          const content = fs.readFileSync(path.join(VAULT_PATH, relPath), "utf-8");
          if (!content.toLowerCase().includes(grepPat.toLowerCase())) continue;
        } catch {
          continue;
        }
      }
      const rec = readRecord(relPath);
      if (!rec) continue;
      results.push({
        path: relPath.replace(/\\/g, "/"),
        name: String(rec.fm.name || rec.fm.subject || rec.stem),
        type: String(rec.fm.type || ""),
        status: String(rec.fm.status || ""),
      });
    }
    sendJson(res, 200, { results, count: results.length });
  });

  // Vault list by type
  // List vault records by type. Returns frontmatter + truncated body preview
  // so list views can render rich cards without N+1 detail requests.
  addRoute("GET", "/api/v1/vault/list/:type", async ({ res, params, query }) => {
    const type = params.type;
    if (!KNOWN_TYPES.includes(type)) {
      throw new ValidationError(`Unknown vault type: ${type}. Known types: ${KNOWN_TYPES.join(", ")}`);
    }

    // Optional body_preview length (default 500 chars, max 2000)
    const previewLen = Math.min(
      Math.max(0, parseInt(query.get("preview") ?? "500", 10) || 500),
      2000,
    );

    const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
    const results: Array<{
      path: string;
      name: string;
      status: string;
      frontmatter: Record<string, unknown>;
      body_preview: string;
      created: string;
    }> = [];
    for (const relPath of files) {
      const rec = readRecord(relPath);
      if (!rec) continue;
      if (rec.fm.type !== type) continue;

      // Truncate body to preview length for list rendering — the full
      // body is available via GET /api/v1/vault/records/:path
      const bodyPreview = rec.body.length > previewLen
        ? rec.body.slice(0, previewLen) + "…"
        : rec.body;

      results.push({
        path: relPath.replace(/\\/g, "/"),
        name: String(rec.fm.name || rec.fm.subject || rec.stem),
        status: String(rec.fm.status || ""),
        frontmatter: rec.fm,
        body_preview: bodyPreview,
        created: String(rec.fm.created || ""),
      });
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, { results, count: results.length });
  });

  // Read vault record
  addRoute("GET", "/api/v1/vault/records/*", async ({ res, params }) => {
    let relPath = params.path;
    resolveVaultPath(relPath); // validate traversal
    let rec = readRecord(relPath);
    // Try appending .md if the path doesn't have it
    if (!rec && !relPath.endsWith(".md")) {
      relPath = relPath + ".md";
      resolveVaultPath(relPath);
      rec = readRecord(relPath);
    }
    if (!rec) {
      sendJson(res, 404, { error: "Record not found" });
      return;
    }
    sendJson(res, 200, { path: relPath, frontmatter: rec.fm, body: rec.body });
  });

  // --- WRITE OPERATIONS: keep docker-exec for safety (scope, logging) ---

  // Create vault record
  addRoute("POST", "/api/v1/vault/records", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.type !== "string" || typeof b.name !== "string") {
      throw new ValidationError("type and name are required");
    }

    // If raw content is provided, write the file directly
    if (typeof b.content === "string") {
      const name = b.name as string;
      // name may already include type prefix and .md extension
      const filePath = name.endsWith(".md") ? name : `${b.type as string}/${name}.md`;
      const fullPath = path.resolve(VAULT_PATH, filePath);
      // Ensure parent directories exist
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, b.content, "utf-8");
      sendJson(res, 201, { path: filePath });
      scheduleNudgeForPath(filePath);
      return;
    }

    const args = [...ALFRED_CMD, "vault", "create", b.type as string, b.name as string];
    if (b.fields && typeof b.fields === "object") {
      for (const [k, v] of Object.entries(b.fields as Record<string, string>)) {
        args.push("--set", `${k}=${String(v)}`);
      }
    }

    const stdout = await dockerExec("alfred", args, VAULT_ENV);
    try {
      sendJson(res, 201, JSON.parse(stdout));
    } catch {
      sendJson(res, 201, { raw: stdout });
    }
    scheduleNudgeForRecord(b.type as string, b.name as string);
  });

  // Edit vault record
  addRoute("PATCH", "/api/v1/vault/records/*", async ({ res, params, body }) => {
    const recordPath = params.path;
    const b = body as Record<string, unknown> | undefined;
    if (!b) throw new ValidationError("Request body required");

    const args = [...ALFRED_CMD, "vault", "edit", recordPath];
    if (b.set && typeof b.set === "object") {
      for (const [k, v] of Object.entries(b.set as Record<string, string>)) {
        args.push("--set", `${k}=${String(v)}`);
      }
    }
    if (b.append && typeof b.append === "object") {
      for (const [k, v] of Object.entries(b.append as Record<string, string>)) {
        args.push("--append", `${k}=${String(v)}`);
      }
    }
    if (typeof b.body_append === "string") {
      args.push("--body-append", b.body_append as string);
    }
    // body-stdin is a flag, not an argument — would need stdin piping
    // For now, body-append handles most use cases

    // Serialise concurrent writes to the same file at the ctrl-api
    // boundary so we don't fan-out a fork-storm of `docker compose
    // exec` waiting on the in-container alfred-CLI file lock (#593).
    const stdout = await _withVaultPathLock(
      recordPath, () => dockerExec("alfred", args, VAULT_ENV),
    );

    // body_set: replace the body wholesale AFTER the CLI PATCH has
    // written any frontmatter changes. The alfred CLI has no
    // `--body-set` flag (only `--body-append`), so we do the
    // replacement at the filesystem level under the same path lock.
    // This is intentionally narrow — only the bytes after the closing
    // frontmatter `---` line are touched, frontmatter parsing is left
    // entirely to the CLI. Used by the description-backfill script to
    // clear worthless curator stub bodies like
    // `# <name>\n\nExtracted from [[event/...]].` so a freshly-written
    // `description` scalar isn't overshadowed by the stub in
    // plane_sync's description-html rendering (see
    // _body_to_description_html in plane_mapping.py).
    if (typeof b.body_set === "string") {
      await _withVaultPathLock(recordPath, async () => {
        const fullPath = path.resolve(VAULT_PATH, recordPath);
        const raw = await fs.promises.readFile(fullPath, "utf-8");
        // Find the end of the frontmatter block. `parseFrontmatter`
        // expects the first block closed by `\n---`; we mirror the same
        // heuristic so an un-frontmattered file (rare, but possible)
        // gets the body replaced wholesale.
        let rewritten: string;
        if (raw.startsWith("---")) {
          const end = raw.indexOf("\n---", 3);
          if (end === -1) {
            // Malformed frontmatter — refuse to touch the file; leave
            // a marker in the response so the caller can log.
            return;
          }
          const headerEnd = end + "\n---".length;
          // Preserve exactly one newline between `---` and body to
          // match the style the alfred CLI emits.
          rewritten = raw.slice(0, headerEnd) + "\n" + (b.body_set as string);
          if (!(b.body_set as string).endsWith("\n")) {
            rewritten += "\n";
          }
        } else {
          rewritten = b.body_set as string;
          if (!rewritten.endsWith("\n")) rewritten += "\n";
        }
        await fs.promises.writeFile(fullPath, rewritten, "utf-8");
      });
    }

    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout });
    }
    scheduleNudgeForPath(recordPath);
  });

  // Move vault record
  addRoute("POST", "/api/v1/vault/move", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.from !== "string" || typeof b.to !== "string") {
      throw new ValidationError("from and to are required");
    }

    const stdout = await dockerExec("alfred", [...ALFRED_CMD, "vault", "move", b.from as string, b.to as string], VAULT_ENV);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout });
    }
    // Nudge both endpoints of the move — if either one is a matter or
    // task Plane needs to learn about the rename.
    scheduleNudgeForPath(b.from as string);
    scheduleNudgeForPath(b.to as string);
  });

  // Delete vault record
  addRoute("DELETE", "/api/v1/vault/records/*", async ({ res, params }) => {
    const recordPath = params.path;
    const args = [...ALFRED_CMD, "vault", "delete", recordPath];

    // Serialise with any in-flight writes to this same path (#593).
    const stdout = await _withVaultPathLock(
      recordPath, () => dockerExec("alfred", args, VAULT_ENV),
    );
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout });
    }
    // A delete IS an archive as far as Plane is concerned — the nudge
    // workflow reads the vault to get the archived flag; if the file
    // is truly gone it no-ops and the cron's delete detection picks
    // the removal up on its next pass.
    scheduleNudgeForPath(recordPath);
  });

  // Promote triage → task (errand)
  addRoute("POST", "/api/v1/vault/promote-triage", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.triagePath !== "string") {
      throw new ValidationError("triagePath is required");
    }

    const triagePath = b.triagePath as string;
    const matter = typeof b.matter === "string" ? b.matter : "";
    const owner = typeof b.owner === "string" ? b.owner : "human";
    const priority = typeof b.priority === "string" ? b.priority : "normal";

    // 1. Read the triage record to get its content
    const fullTriagePath = path.resolve(VAULT_PATH, triagePath);
    let triageContent: string;
    try {
      triageContent = await fs.promises.readFile(fullTriagePath, "utf-8");
    } catch {
      throw new NotFoundError(`Triage record not found: ${triagePath}`);
    }

    // Parse frontmatter to get name and other fields
    const fmMatch = triageContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    let triageName = path.basename(triagePath, ".md");
    let triageBody = triageContent;
    if (fmMatch) {
      const fmText = fmMatch[1];
      triageBody = fmMatch[2] || "";
      const nameMatch = fmText.match(/name:\s*(.+)/);
      if (nameMatch) triageName = nameMatch[1].trim();
    }

    // 2. Create a task record from the triage content
    const taskSlug = triageName.replace(/[^a-zA-Z0-9 -]/g, "").replace(/\s+/g, "-").toLowerCase().slice(0, 80);
    const now = new Date().toISOString().slice(0, 10);
    const taskFrontmatter = [
      "---",
      "type: task",
      `name: "${triageName}"`,
      `status: queued`,
      `owner: ${owner}`,
      `priority: ${priority}`,
      matter ? `matter: "[[matter/${matter}]]"` : "",
      `source_triage: "[[${triagePath.replace(/\.md$/, "")}]]"`,
      `created: ${now}`,
      "---",
    ].filter(Boolean).join("\n");

    const taskContent = `${taskFrontmatter}\n\n# ${triageName}\n\n${triageBody.trim()}\n`;

    // Write task record
    const taskDir = path.resolve(VAULT_PATH, "task");
    await fs.promises.mkdir(taskDir, { recursive: true });
    const taskPath = `task/${taskSlug}.md`;
    const fullTaskPath = path.resolve(VAULT_PATH, taskPath);
    await fs.promises.writeFile(fullTaskPath, taskContent, "utf-8");

    // 3. Mark triage as resolved
    const resolvedArgs = [...ALFRED_CMD, "vault", "edit", triagePath, "--set", "status=resolved"];
    try {
      await dockerExec("alfred", resolvedArgs, VAULT_ENV);
    } catch {
      // Non-fatal: task was created even if triage update fails
    }

    sendJson(res, 201, {
      taskPath,
      triagePath,
      name: triageName,
      status: "promoted",
    });
  });

  // --- GRAPH: nodes + edges + agent activity ---

  addRoute("GET", "/api/v1/vault/graph", async ({ res }) => {
    const AUDIT_LOG = "/mnt/encrypted/alfred/vault_audit.log";
    const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    const LINK_FIELDS = new Set([
      "related", "relationships", "participants", "outputs", "depends_on",
      "blocked_by", "based_on", "supports", "challenged_by", "references",
      "project", "approved_by", "confirmed_by", "invalidated_by",
      "governed_by", "cluster_sources",
    ]);

    const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);

    // Build a lookup of stem → relPath for wikilink resolution
    const stemToPath: Record<string, string> = {};
    // Also allow "type/Name" format
    for (const relPath of files) {
      const stem = path.basename(relPath, ".md");
      const display = relPath.replace(/\\/g, "/");
      stemToPath[stem] = display;
      // Also index "type/Name" (without .md)
      stemToPath[display.replace(/\.md$/, "")] = display;
    }

    interface GraphNode {
      id: string;
      type: string;
      name: string;
      status: string;
    }

    interface GraphEdge {
      source: string;
      target: string;
      relation: string;
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeIds = new Set<string>();

    for (const relPath of files) {
      const rec = readRecord(relPath);
      if (!rec) continue;
      const recType = String(rec.fm.type || "");
      if (!recType) continue;

      const display = relPath.replace(/\\/g, "/");
      const nameField = NAME_FIELD_BY_TYPE[recType] || "name";
      const name = String(rec.fm[nameField] || rec.stem);

      nodes.push({
        id: display,
        type: recType,
        name,
        status: String(rec.fm.status || ""),
      });
      nodeIds.add(display);

      // Extract edges from frontmatter list fields
      for (const field of LINK_FIELDS) {
        const val = rec.fm[field];
        if (!val) continue;
        const items = Array.isArray(val) ? val : [val];
        for (const item of items) {
          const s = String(item).trim();
          // Could be a wikilink [[...]] or bare name
          const wlMatch = s.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
          const ref = wlMatch ? wlMatch[1] : s;
          // Resolve to a file path
          const target = stemToPath[ref] || stemToPath[ref.replace(/\.md$/, "")];
          if (target && target !== display) {
            edges.push({ source: display, target, relation: field });
          }
        }
      }

      // Extract wikilinks from body text
      let wlm: RegExpExecArray | null;
      WIKILINK_RE.lastIndex = 0;
      while ((wlm = WIKILINK_RE.exec(rec.body)) !== null) {
        const ref = wlm[1].trim();
        const target = stemToPath[ref] || stemToPath[ref.replace(/\.md$/, "")];
        if (target && target !== display) {
          edges.push({ source: display, target, relation: "body_link" });
        }
      }
    }

    // Filter edges to only include nodes that exist
    const validEdges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

    // Deduplicate edges (same source+target+relation)
    const edgeKeys = new Set<string>();
    const dedupedEdges: GraphEdge[] = [];
    for (const e of validEdges) {
      const key = `${e.source}|${e.target}|${e.relation}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        dedupedEdges.push(e);
      }
    }

    // Parse recent agent activity from audit log
    interface ActivityEntry {
      agent: string;
      file: string;
      action: string;
      ts: string;
    }
    const activity: ActivityEntry[] = [];
    try {
      const logContent = fs.readFileSync(AUDIT_LOG, "utf-8");
      const lines = logContent.split("\n").filter(Boolean).slice(-500);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.path || entry.file) {
            activity.push({
              agent: entry.tool || entry.scope || entry.agent || "unknown",
              file: entry.path || entry.file || "",
              action: entry.op || entry.action || entry.operation || "unknown",
              ts: entry.ts || entry.timestamp || "",
            });
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    } catch {
      // Audit log may not exist yet
    }

    sendJson(res, 200, { nodes, edges: dedupedEdges, activity });
  });

  // --- NEBULA: cluster + wikilink data for nebula visualization ---

  addRoute("GET", "/api/v1/vault/nebula-data", async ({ res }) => {
    const SURVEYOR_STATE_PATH = "/mnt/encrypted/alfred/surveyor_state.json";
    const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

    // Color mapping by record type
    const TYPE_COLORS: Record<string, string> = {
      note: "#C9A84C",
      conversation: "#C9A84C",
      task: "#FFFFFF",
      decision: "#1E4D5E",
      assumption: "#1E4D5E",
      constraint: "#1E4D5E",
      triage: "#FF6B6B",
      project: "#D4AF37",
      matter: "#D4AF37",
      observation: "#8B7532",
      instinct: "#8B7532",
      reflection: "#8B7532",
    };
    const DEFAULT_COLOR = "#858C9C";

    // 1. Walk vault for all .md files
    const NEBULA_IGNORE = new Set(["_templates", "_bases", ".obsidian", "inbox", "view"]);
    const files = walkMd(VAULT_PATH, VAULT_PATH, NEBULA_IGNORE);

    // Build a map of relPath → type (derived from directory name)
    const fileTypes: Record<string, string> = {};
    for (const relPath of files) {
      const dir = relPath.split("/")[0] || "";
      fileTypes[relPath] = dir;
    }

    // 2. Extract wikilinks from raw file content (no frontmatter parsing — fast)
    interface LinkEntry { source: string; target: string }
    const links: LinkEntry[] = [];
    const stemToPath: Record<string, string> = {};

    // Build stem lookup
    for (const relPath of files) {
      const stem = path.basename(relPath, ".md");
      stemToPath[stem] = relPath;
      // Also index "type/Name" without .md
      stemToPath[relPath.replace(/\.md$/, "")] = relPath;
    }

    const fileSet = new Set(files);
    for (const relPath of files) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(VAULT_PATH, relPath), "utf-8");
      } catch {
        continue;
      }
      let m: RegExpExecArray | null;
      WIKILINK_RE.lastIndex = 0;
      while ((m = WIKILINK_RE.exec(content)) !== null) {
        const ref = m[1].trim();
        const target = stemToPath[ref] || stemToPath[ref.replace(/\.md$/, "")];
        if (target && target !== relPath && fileSet.has(target)) {
          links.push({ source: relPath, target });
        }
      }
    }

    // Deduplicate links
    const linkKeys = new Set<string>();
    const dedupedLinks: LinkEntry[] = [];
    for (const l of links) {
      const key = `${l.source}|${l.target}`;
      if (!linkKeys.has(key)) {
        linkKeys.add(key);
        dedupedLinks.push(l);
      }
    }

    // 3. Read surveyor state for clusters
    interface SurveyorCluster { label: string[]; members: string[] }
    interface SurveyorFile { semantic_cluster_id?: string; [key: string]: unknown }
    interface SurveyorState {
      clusters?: Record<string, SurveyorCluster>;
      files?: Record<string, SurveyorFile>;
    }

    let surveyorState: SurveyorState = {};
    try {
      const raw = fs.readFileSync(SURVEYOR_STATE_PATH, "utf-8");
      surveyorState = JSON.parse(raw);
    } catch {
      // surveyor_state.json may not exist yet
    }

    const clusteredPaths = new Set<string>();
    interface ClusterEntry {
      id: string;
      label: string[];
      recordCount: number;
      color: string;
      records: string[];
    }
    const clusters: ClusterEntry[] = [];

    if (surveyorState.clusters) {
      for (const [clusterId, cluster] of Object.entries(surveyorState.clusters)) {
        const members = cluster.members || [];
        // Resolve member filenames to vault-relative paths
        const resolvedMembers: string[] = [];
        for (const member of members) {
          const resolved = stemToPath[member] || stemToPath[member.replace(/\.md$/, "")];
          if (resolved && fileSet.has(resolved)) {
            resolvedMembers.push(resolved);
            clusteredPaths.add(resolved);
          }
        }

        if (resolvedMembers.length === 0) continue;

        // Determine dominant color from record types
        const typeCounts: Record<string, number> = {};
        for (const rp of resolvedMembers) {
          const t = fileTypes[rp] || "";
          typeCounts[t] = (typeCounts[t] || 0) + 1;
        }
        let dominantType = "";
        let maxCount = 0;
        for (const [t, c] of Object.entries(typeCounts)) {
          if (c > maxCount) { dominantType = t; maxCount = c; }
        }

        clusters.push({
          id: clusterId,
          label: cluster.label || [],
          recordCount: resolvedMembers.length,
          color: TYPE_COLORS[dominantType] || DEFAULT_COLOR,
          records: resolvedMembers,
        });
      }
    }

    // 4. Build unclustered list
    const unclustered: Array<{ path: string; type: string }> = [];
    for (const relPath of files) {
      if (!clusteredPaths.has(relPath)) {
        unclustered.push({ path: relPath, type: fileTypes[relPath] || "" });
      }
    }

    // 5. Stats
    const stats = {
      totalRecords: files.length,
      totalLinks: dedupedLinks.length,
      totalClusters: clusters.length,
    };

    sendJson(res, 200, {
      clusters,
      unclustered,
      links: dedupedLinks,
      stats,
      generatedAt: new Date().toISOString(),
    });
  });

  // --- STATIC / NON-VAULT ---

  // Vault schema
  addRoute("GET", "/api/v1/vault/schema", async ({ res }) => {
    sendJson(res, 200, {
      known_types: KNOWN_TYPES,
      status_by_type: STATUS_BY_TYPE,
      list_fields: LIST_FIELDS,
      required_fields: REQUIRED_FIELDS,
      name_field_by_type: NAME_FIELD_BY_TYPE,
      type_directory: TYPE_DIRECTORY,
    });
  });

  // Upload single file to inbox
  addRoute("POST", "/api/v1/vault/inbox", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.filename !== "string" || typeof b.content !== "string") {
      throw new ValidationError("filename and content are required");
    }
    const filename = sanitizeFilename(b.filename as string);
    const filePath = path.join(INBOX_PATH, filename);
    const isBinary = b.encoding === "base64";
    if (isBinary) {
      fs.writeFileSync(filePath, Buffer.from(b.content as string, "base64"));
    } else {
      fs.writeFileSync(filePath, b.content as string, "utf-8");
    }
    const mediaEvent = maybeEmitMediaEvent(filename, typeof b.mime_type === "string" ? b.mime_type : undefined);
    sendJson(res, 201, {
      message: `Uploaded ${filename} to inbox`,
      filename,
      binary: isBinary,
      ...(mediaEvent ? { media_event_id: mediaEvent.id, media_type: mediaEvent.file_type } : {}),
    });
  });

  // Upload multiple files to inbox
  addRoute("POST", "/api/v1/vault/inbox/bulk", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || !Array.isArray(b.files)) {
      throw new ValidationError("files array is required");
    }
    const results: Array<{ filename: string; binary: boolean; media_event_id?: string; media_type?: string }> = [];
    for (const file of b.files as Array<{ filename: string; content: string; encoding?: string; mime_type?: string }>) {
      if (typeof file.filename !== "string" || typeof file.content !== "string") {
        throw new ValidationError("Each file must have filename and content");
      }
      const filename = sanitizeFilename(file.filename);
      const filePath = path.join(INBOX_PATH, filename);
      const isBinary = file.encoding === "base64";
      if (isBinary) {
        fs.writeFileSync(filePath, Buffer.from(file.content, "base64"));
      } else {
        fs.writeFileSync(filePath, file.content, "utf-8");
      }
      const mediaEvent = maybeEmitMediaEvent(filename, typeof file.mime_type === "string" ? file.mime_type : undefined);
      results.push({
        filename,
        binary: isBinary,
        ...(mediaEvent ? { media_event_id: mediaEvent.id, media_type: mediaEvent.file_type } : {}),
      });
    }
    sendJson(res, 201, {
      message: `Uploaded ${results.length} files to inbox`,
      filenames: results.map((r) => r.filename),
      files: results,
    });
  });

  // List inbox files
  addRoute("GET", "/api/v1/vault/inbox", async ({ res }) => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(INBOX_PATH).filter(f => !f.startsWith("."));
    } catch {
      // inbox dir may not exist yet
    }
    sendJson(res, 200, { files });
  });
}

// ---------------------------------------------------------------------------
// Exported helpers for combined dashboard endpoint
// ---------------------------------------------------------------------------

export function getVaultContextData(): {
  records_by_type: Record<string, Array<{ path: string; name: string; status: string }>>;
  total: number;
} {
  const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
  const byType: Record<string, Array<{ path: string; name: string; status: string }>> = {};
  for (const relPath of files) {
    const rec = readRecord(relPath);
    if (!rec) continue;
    const recType = String(rec.fm.type || "");
    if (!recType) continue;
    const display = relPath.replace(/\\/g, "/").replace(/\.md$/, "");
    byType[recType] = byType[recType] || [];
    byType[recType].push({ path: display, name: rec.stem, status: String(rec.fm.status || "") });
  }
  return {
    records_by_type: byType,
    total: Object.values(byType).reduce((s, a) => s + a.length, 0),
  };
}

export function getInboxFiles(): string[] {
  try {
    return fs.readdirSync(INBOX_PATH).filter((f: string) => !f.startsWith("."));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Simple glob-to-regex converter for vault search
// ---------------------------------------------------------------------------

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++; // skip second *
      if (glob[i + 1] === "/") i++; // skip trailing /
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}
