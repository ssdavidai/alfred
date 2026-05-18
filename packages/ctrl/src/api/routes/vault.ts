import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError, ExecError } from "../errors.js";
import { dockerExec, ALFRED_CMD } from "../helpers.js";
import { emitStreamEvent } from "./streams.js";
import {
  vaultListCache,
  invalidateAllVaultCaches,
  invalidateVaultCachesForType,
} from "../vaultCache.js";
import {
  triggerPlaneSyncNudge,
  slugFromVaultPath,
  type PlaneNudgeRecordType,
} from "./plane.js";
import {
  classifyTarget,
  stateFieldsFor,
} from "../stateFields.js";
import { openStateDb } from "../../db/state.js";
import {
  listByType as vaultIndexListByType,
  listAll as vaultIndexListAll,
  type VaultIndexRow,
} from "../../db/vault_queries.js";

// ---------------------------------------------------------------------------
// STORE-P1-4: serve list endpoints from the `vault_index` SQLite table
// instead of recursively walking /mnt/encrypted/vault. Set
// VAULT_LIST_USE_INDEX=0 to revert every rewired endpoint to the
// legacy walkMd path — that's the rollback handle.
// ---------------------------------------------------------------------------
const VAULT_LIST_USE_INDEX = process.env.VAULT_LIST_USE_INDEX !== "0";

// Indexer caps body_first_n at this many chars. Requests for a longer
// preview (?preview=) can't be served from the index losslessly, so
// they fall through to the legacy walkMd path.
const VAULT_INDEX_BODY_FIRST_N = 500;

function parseIndexFrontmatter(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through.
  }
  return {};
}

export const VAULT_PATH = "/mnt/encrypted/vault";
const INBOX_PATH = `${VAULT_PATH}/inbox`;
export const VAULT_ENV = { ALFRED_VAULT_PATH: "/vault" };

// ---------------------------------------------------------------------------
// Steward signal stream (#838 Phase 2)
//
// Every vault write — PATCH, POST (create), DELETE — appends a
// ``vault:edit`` signal record to ``/alfred-data/streams/steward-signals.jsonl``
// so the Phase 1 ``gather_signals_vault_record`` activity (and Phase 2's
// Plane / Gmail / Sure / ctrl-api stream gatherers) can fan out off a
// single append-only ledger. Best-effort: a write failure is logged but
// never propagates to the API caller — a missing signal record is recoverable
// (Steward's Layer 3 periodic catch-all picks the change up on the next tick).
// ---------------------------------------------------------------------------

const STEWARD_SIGNALS_FILE = "/alfred-data/streams/steward-signals.jsonl";

/** Emit a single ``vault:edit`` Steward signal for ``relPath``.
 *
 * Schedules the write off the current event-loop tick so the API
 * response is never blocked by disk I/O. Failures are logged but do
 * not propagate.
 */
export function emitVaultEditSignal(relPath: string, kind: "create" | "edit" | "delete" = "edit"): void {
  if (!relPath) return;
  // Every vault mutation flows through here — also the single chokepoint
  // for busting the read-side caches so the next /vault/list/<type> or
  // /admin/needs-attention call reflects the write immediately. Only
  // the same-type caches are invalidated; an alfred-learn task writeback
  // must not nuke the signal/matter/event caches the Desk reads from
  // every poll.
  const type = relPath.split("/")[0] ?? "";
  invalidateVaultCachesForType(type);
  setImmediate(() => {
    try {
      fs.mkdirSync(path.dirname(STEWARD_SIGNALS_FILE), { recursive: true });
      const record = {
        id: `evt_${crypto.randomUUID()}`,
        ts: new Date().toISOString(),
        kind: "vault:edit",
        ref: `vault:${relPath.replace(/\\/g, "/")}`,
        note: kind,
      };
      fs.appendFileSync(STEWARD_SIGNALS_FILE, JSON.stringify(record) + "\n");
    } catch (err) {
      console.warn(
        `[vault.steward_signal] failed to append vault:edit signal path=${relPath} err=${(err as Error).message}`,
      );
    }
  });
}

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

// ---------------------------------------------------------------------------
// Title-index cache (#873).
//
// Per-tenant in-memory cache for GET /api/v1/vault/index. ctrl-api runs
// one process per tenant, so the cache cardinality is 1; the Map keying
// is preserved per the contract so the route stays trivially extendable
// if a multi-tenant control-plane ctrl-api ever shares this code.
// ---------------------------------------------------------------------------
const VAULT_INDEX_TTL_MS = 60_000;
const VAULT_INDEX_CACHE_KEY = "_self";
const _vaultIndexCache = new Map<string, { at: number; body: unknown }>();

const KNOWN_TYPES = [
  "person", "org", "project", "task", "event", "note", "location",
  "process", "account", "asset", "conversation", "input", "run",
  "session", "decision", "triage",
  "assumption", "constraint", "contradiction", "synthesis",
  "observation", "instinct", "reflection",
  "matter", "ledger_entry",
  "chore",
  // Phase 6 signal-layer record types (RFC #842):
  //  - signal           : extracted from stream events; carries target +
  //                       effect + mutation/action proposal.
  //  - needs_attention  : Phase 6.4 — actions routed to Sir (low confidence
  //                       OR no matching instinct).
  //  - stream_event     : Phase 6.6 — unified replacement for event/ +
  //                       conversation/ once the migration script runs.
  //  - signal_noise_pattern : ARCH-12 — materialised when the principal
  //                       clicks Noise on /desk. signal_extract consults
  //                       these before the LLM call to filter
  //                       known-noise events at source. Missing this
  //                       allowlist entry meant both the writer and the
  //                       loader got 400 from /vault/list and /vault/records.
  //  - pattern_proposal  : OBS-3 — clustered proposals from the unified
  //                       observation pool (decisions + signals).
  //                       PatternDetectionWorkflow (OBS-4) writes
  //                       status=proposed; the principal accepts on /desk
  //                       and OBS-5's acceptor materialises an instinct.
  //                       Distinct from legacy decision_pattern/ which
  //                       extracts only from decisions.
  "signal", "needs_attention", "stream_event", "signal_noise_pattern",
  "pattern_proposal",
  // State-mutation contract (#889 spec §8.2):
  //  - briefing : morning + evening composer output. Frontmatter shape
  //               validated by alfred-learn (validators/briefing.py).
  //               ctrl-api just allowlists the type; the BriefingWorkflow
  //               writes through POST /api/v1/vault/records with the
  //               structured `content` body.
  "briefing",
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
  // pattern_proposal lifecycle (OBS-3..OBS-5):
  //  - proposed  : freshly written by PatternDetectionWorkflow,
  //                awaiting principal review on /desk
  //  - adopted   : principal clicked delegate; OBS-5 acceptor wrote
  //                the instinct (the loop closure step)
  //  - rejected  : principal clicked delete; the next detection run
  //                avoids re-proposing this rule
  //  - deferred  : principal clicked defer; will resurface later
  //  - superseded: replaced by a refined cluster in a later run
  // Status verbs match the existing decision_pattern flow so the
  // DecisionRouterWorkflow's pattern handler can stay uniform across
  // both legacy and OBS-era proposals.
  pattern_proposal: ["proposed", "adopted", "rejected", "deferred", "superseded"],
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
  pattern_proposal: "pattern_proposal",
  briefing: "briefing",
};

const LIST_FIELDS = [
  "tags", "aliases", "related", "relationships", "participants",
  "outputs", "depends_on", "blocked_by", "based_on", "supports",
  "challenged_by", "approved_by", "confirmed_by", "invalidated_by",
  "cluster_sources", "governed_by", "references", "project",
  // Steward (#835 Phase 0) — per-matter perception loop. signal_sources
  // is the only list-shaped Steward field; the rest of the Steward
  // schema is scalars (state, surface_class, ...) which don't need
  // list-parsing hints.
  "signal_sources",
];

const REQUIRED_FIELDS = ["type", "created"];

// Steward (#835 Phase 0) — frontmatter fields owned by the Steward
// state machine. Exposed via /api/v1/vault/schema so consumers (the
// alfred-learn migration scripts, dashboard, MCP) can discover them
// without hard-coding the list. Steward owns every transition; no
// other component should write these.
const STEWARD_FIELDS = [
  // State machine
  "state",                  // open | snoozed | done | archived
  "blocked_on",             // ref to blocking task/matter, or null
  "pending_confirmation",   // bool — true between low-confidence Steward
                            //        decision and human ack
  "staleness_score",        // 0..1, computed
  "surface_class",          // high | normal | none
  // Audit / cadence
  "last_steward_check_at",  // ISO timestamp
  "last_steward_outcome",   // dict — decision/evidence/confidence/undo_recipe
  "next_check_after",       // ISO timestamp — Steward's per-task cursor
  "signal_sources",         // list of {name, confidence, calibration_status}
  // Hard invariant for tasks
  "parent_matter",          // matter/<slug>.md ref; orphans → matter/inbox.md
];

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
export function resolveVaultPath(relPath: string): string {
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
  // ---------------------------------------------------------------------------
  // Vault title-index (#873)
  //
  // Lightweight enumeration of every record's display title + slug + type so
  // the SaaS Markdown renderer can resolve [[wikilinks]] without one HTTP
  // call per link. Walks the same .md set as /context, but emits only what
  // the live wikilink resolver needs:
  //
  //   { titles: [{ title, slug, type }, ...] }
  //
  // The response is cached in-memory for 60s. ctrl-api runs per-tenant so
  // the cache cardinality is effectively 1; we still key the Map (per the
  // #873 contract) so the shape can extend later if a control-plane
  // ctrl-api ever proxies multiple tenants from a single process.
  // ---------------------------------------------------------------------------
  addRoute("GET", "/api/v1/vault/index", async ({ res }) => {
    const cached = _vaultIndexCache.get(VAULT_INDEX_CACHE_KEY);
    const now = Date.now();
    if (cached && now - cached.at < VAULT_INDEX_TTL_MS) {
      sendJson(res, 200, cached.body);
      return;
    }

    const titles: Array<{ title: string; slug: string; type: string }> = [];

    if (VAULT_LIST_USE_INDEX) {
      const t0 = Date.now();
      const rows = vaultIndexListAll(openStateDb());
      for (const row of rows) {
        const slug = row.path.replace(/\\/g, "/").replace(/\.md$/, "");
        const stem = path.basename(row.path, ".md");
        const fm = parseIndexFrontmatter(row.frontmatter);
        const title = String(
          fm.title ?? fm.name ?? fm.subject ?? stem,
        );
        const type = String(fm.type ?? "");
        if (!title) continue;
        titles.push({ title, slug, type });
      }
      titles.sort((a, b) => a.title.localeCompare(b.title));
      console.log(
        "[vault.list.sql] index rows=%d titles=%d elapsed_ms=%d",
        rows.length, titles.length, Date.now() - t0,
      );
    } else {
      const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
      for (const relPath of files) {
        const rec = readRecord(relPath);
        if (!rec) continue;
        // slug = path under vault root, no .md, forward-slash normalized
        const slug = relPath.replace(/\\/g, "/").replace(/\.md$/, "");
        // Prefer frontmatter title; fall back to name/subject; then stem.
        const title = String(
          rec.fm.title ?? rec.fm.name ?? rec.fm.subject ?? rec.stem,
        );
        const type = String(rec.fm.type ?? "");
        if (!title) continue;
        titles.push({ title, slug, type });
      }
      titles.sort((a, b) => a.title.localeCompare(b.title));
    }

    const body = { titles };
    _vaultIndexCache.set(VAULT_INDEX_CACHE_KEY, { at: now, body });
    sendJson(res, 200, body);
  });

  addRoute("GET", "/api/v1/vault/context", async ({ res }) => {
    const byType: Record<string, Array<{ path: string; name: string; status: string }>> = {};

    if (VAULT_LIST_USE_INDEX) {
      const t0 = Date.now();
      const rows = vaultIndexListAll(openStateDb());
      for (const row of rows) {
        const fm = parseIndexFrontmatter(row.frontmatter);
        // Match legacy: filter on frontmatter type, not directory.
        const recType = String(fm.type || "");
        if (!recType) continue;
        const display = row.path.replace(/\\/g, "/").replace(/\.md$/, "");
        const stem = path.basename(row.path, ".md");
        byType[recType] = byType[recType] || [];
        byType[recType].push({
          path: display,
          name: stem,
          status: String(fm.status || ""),
        });
      }
      console.log(
        "[vault.list.sql] context rows=%d types=%d elapsed_ms=%d",
        rows.length, Object.keys(byType).length, Date.now() - t0,
      );
    } else {
      const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
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

    // Cap result count. Unbounded responses on a large vault hit ~2MB which
    // exceeds claude.ai's MCP transport limit and surfaces to Sir as "tool
    // failed". Default 100; max 500 — claude.ai's wider MCP envelope is
    // around 1MB, and 500 metadata records is comfortably under that.
    let limit = 100;
    const limitRaw = query.get("limit");
    if (limitRaw !== null && limitRaw !== "") {
      const n = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 500) {
        throw new ValidationError("limit must be 1..500");
      }
      limit = n;
    }

    // Refuse the unfiltered case. Without a grep or glob we'd walk every
    // file in the vault and return up to `limit` arbitrary records — slow,
    // surprising, and the LLM-callable callers (notably the alfred MCP)
    // shouldn't be doing that. Earlier this route silently accepted bad
    // params (`?q=hello` instead of `?grep=hello`) and returned the full
    // vault — surfaced as a transport-size failure on the MCP side.
    if (!globPat && !grepPat) {
      throw new ValidationError(
        "At least one of `grep` or `glob` query params is required. Got neither — refusing to walk the whole vault.",
      );
    }

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
    let truncated = false;
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
      if (results.length >= limit) {
        truncated = true;
        break;
      }
    }
    sendJson(res, 200, { results, count: results.length, truncated });
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

    const cacheKey = `${type}:${previewLen}`;

    // STORE-P1-4: serve from the SQLite vault_index when the requested
    // preview length is within the indexed body_first_n cap. The index
    // bypasses the in-memory TTL cache entirely — the SQL hit is sub-ms
    // and the index IS the cache. The legacy walkMd path is kept below
    // as the fallback so VAULT_LIST_USE_INDEX=0 reverts the rollout.
    let payload: { results: any[]; count: number };
    if (VAULT_LIST_USE_INDEX && previewLen <= VAULT_INDEX_BODY_FIRST_N) {
      const t0 = Date.now();
      const rows = vaultIndexListByType(openStateDb(), type, { sortBy: "path" });
      const results: Array<{
        path: string;
        name: string;
        status: string;
        frontmatter: Record<string, unknown>;
        body_preview: string;
        created: string;
      }> = [];
      for (const row of rows) {
        const fm = parseIndexFrontmatter(row.frontmatter);
        // Defence in depth: indexer derives record_type from the
        // top-level directory, not frontmatter. The legacy handler
        // filters on `fm.type === type` and we preserve that filter
        // so a stale row whose frontmatter disagrees doesn't leak in.
        if (fm.type !== type) continue;

        const stem = path.basename(row.path, ".md");
        const bodyRaw = row.body_first_n ?? "";
        // body_first_n is stored capped at VAULT_INDEX_BODY_FIRST_N
        // chars with no truncation marker. If we hit the cap, assume
        // it was truncated and append the legacy ellipsis so the
        // response shape is observably identical when previewLen ==
        // VAULT_INDEX_BODY_FIRST_N. previewLen < cap gets a fresh
        // slice + marker.
        let bodyPreview: string;
        if (bodyRaw.length === 0) {
          bodyPreview = "";
        } else if (bodyRaw.length > previewLen) {
          bodyPreview = bodyRaw.slice(0, previewLen) + "…";
        } else if (bodyRaw.length === VAULT_INDEX_BODY_FIRST_N) {
          bodyPreview = bodyRaw + "…";
        } else {
          bodyPreview = bodyRaw;
        }

        results.push({
          path: row.path.replace(/\\/g, "/"),
          name: String(fm.name || fm.subject || stem),
          status: String(fm.status || ""),
          frontmatter: fm,
          body_preview: bodyPreview,
          created: String(fm.created || ""),
        });
      }
      results.sort((a, b) => a.name.localeCompare(b.name));
      console.log(
        "[vault.list.sql] type=%s rows=%d results=%d elapsed_ms=%d",
        type, rows.length, results.length, Date.now() - t0,
      );
      payload = { results, count: results.length };
    } else {
      payload = await vaultListCache.get(cacheKey, () => {
        const t0 = Date.now();
        // Scope walk to /vault/<type> — david's vault has ~88k files;
        // full-vault walk takes 6–7s vs <100ms scoped.
        const files = walkMd(path.join(VAULT_PATH, type), VAULT_PATH, IGNORE_DIRS);
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
        console.log("[vault.list] type=%s files=%d results=%d elapsed_ms=%d", type, files.length, results.length, Date.now() - t0);
        return { results, count: results.length };
      });
    }
    // For instincts only: enrich each record with the live observation
    // count (decision-sourced only). signal_actions._instinct_threshold
    // reads this field to apply the obs-count discretion formula
    // instead of a flat default. Done outside the cache so the count
    // can refresh independently when observations are written.
    if (type === "instinct") {
      const { getInstinctCounts } = await import("../instinctCounts.js");
      const counts = await getInstinctCounts();
      for (const r of payload.results) {
        const live = counts.get(r.path) ?? 0;
        (r.frontmatter as Record<string, unknown>).live_observation_count = live;
      }
    }
    sendJson(res, 200, payload);
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
      emitVaultEditSignal(filePath, "create");
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
    // Best-effort: derive the canonical relPath from the type+name. The CLI's
    // sanitization pass may have produced a slightly different filename, but
    // the resulting signal is still useful — Steward consumers join by the
    // task slug, not the exact filename.
    {
      const namePart = (b.name as string).endsWith(".md")
        ? (b.name as string)
        : `${b.type as string}/${(b.name as string)}.md`;
      emitVaultEditSignal(namePart, "create");
    }
  });

  // Edit vault record
  //
  // Body shape (all optional, at least one required):
  //   set:        { key: scalar }     — stringified, routed through `alfred vault edit --set`
  //   append:     { key: scalar }     — stringified, routed through `alfred vault edit --append`
  //   body_append: string             — appended to body via `alfred vault edit --body-append`
  //   body_set:   string              — replaces body wholesale (post-CLI, under path lock)
  //   json_set:   { key: native }     — #838 Phase 2: native JSON values (lists, dicts, bools,
  //                                     numbers) merged into frontmatter via direct YAML
  //                                     read-modify-write. The CLI's `--set` flag stringifies
  //                                     everything which round-trips structured frontmatter as
  //                                     Python repr strings; `json_set` preserves shape end-to-end
  //                                     so Steward signal_sources, undo_recipe.evidence, etc.
  //                                     stay structured all the way through the PATCH cycle.
  addRoute("PATCH", "/api/v1/vault/records/*", async ({ req, res, params, body }) => {
    const recordPath = params.path;
    const b = body as Record<string, unknown> | undefined;
    if (!b) throw new ValidationError("Request body required");

    // State-mutation contract enforcement (#889 spec §5.2).
    //
    // If the target is a matter or task record AND any of the patch
    // operations would touch a declared state field, gate on
    // STATE_CHANGE_ENFORCEMENT:
    //   * unset OR `warn` (default) — log a warning, proceed.
    //   * `reject`                  — return 403 with the offending field.
    // Manual edits via the SaaS editor (Phase F) will route through
    // POST /api/v1/state-changes instead.
    const targetKind = classifyTarget(recordPath);
    if (targetKind) {
      const touched: string[] = [];
      const allow = new Set(stateFieldsFor(targetKind));
      const setMap =
        b.set && typeof b.set === "object" && !Array.isArray(b.set)
          ? (b.set as Record<string, unknown>)
          : null;
      const jsonSetMap =
        b.json_set && typeof b.json_set === "object" && !Array.isArray(b.json_set)
          ? (b.json_set as Record<string, unknown>)
          : null;
      const appendMap =
        b.append && typeof b.append === "object" && !Array.isArray(b.append)
          ? (b.append as Record<string, unknown>)
          : null;
      for (const m of [setMap, jsonSetMap, appendMap]) {
        if (!m) continue;
        for (const k of Object.keys(m)) {
          if (allow.has(k) && !touched.includes(k)) touched.push(k);
        }
      }
      if (touched.length > 0) {
        const mode = (process.env.STATE_CHANGE_ENFORCEMENT ?? "warn").toLowerCase();
        if (mode === "reject") {
          sendJson(res, 403, {
            error: {
              code: "STATE_CHANGE_REQUIRED",
              message: "state field requires POST /state-changes",
              target: recordPath,
              field: touched[0],
              fields: touched,
            },
          });
          return;
        }
        const ua = String(req.headers["user-agent"] ?? "");
        console.warn(
          `[vault.state_change_warn] direct PATCH touches state field(s) on ${recordPath} ` +
            `fields=${touched.join(",")} user-agent=${ua}`,
        );
      }
    }

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

    // Determine whether we have any CLI-shaped work to do (the alfred CLI
    // exits non-zero if no --set/--append/--body-append/--body-stdin was
    // passed). When the caller sent ONLY json_set / body_set, the CLI run
    // is skipped entirely — we still take the path lock for the YAML
    // edit below.
    const hasCliArgs =
      (b.set && typeof b.set === "object" && Object.keys(b.set as Record<string, unknown>).length > 0) ||
      (b.append && typeof b.append === "object" && Object.keys(b.append as Record<string, unknown>).length > 0) ||
      typeof b.body_append === "string";

    // Serialise concurrent writes to the same file at the ctrl-api
    // boundary so we don't fan-out a fork-storm of `docker compose
    // exec` waiting on the in-container alfred-CLI file lock (#593).
    let stdout: string = "";
    if (hasCliArgs) {
      try {
        stdout = await _withVaultPathLock(
          recordPath, () => dockerExec("alfred", args, VAULT_ENV),
        );
      } catch (err) {
        // Surface stderr + the failing argv so transient 500s on this
        // path leave a diagnosable trace (the alfred CLI writes lock
        // contention, schema errors, etc. only to stderr).
        const e = err as { stderr?: string; stdout?: string; message?: string };
        console.error(
          "[vault PATCH] dockerExec failed",
          JSON.stringify({
            recordPath,
            args: args.join(" "),
            stderr: (e.stderr ?? "").slice(0, 1000),
            stdout: (e.stdout ?? "").slice(0, 1000),
            message: e.message ?? String(err),
          }),
        );
        throw err;
      }
    }

    // json_set: structured-value frontmatter merge. Direct YAML read-modify-
    // write under the same path lock. The alfred CLI's --set flag stringifies
    // every value, which causes lists/dicts to round-trip as Python repr
    // strings (Phase 1 added a read-side json.loads/ast.literal_eval fallback
    // in alfred-learn; this is the proper write-side fix). We perform the
    // merge AFTER the CLI run so a single PATCH carrying both `set` (scalars)
    // and `json_set` (structured) lands the scalars first and the structured
    // values on top — last-writer-wins on key collisions, json_set wins by
    // design since it's the more expressive shape.
    if (b.json_set && typeof b.json_set === "object" && !Array.isArray(b.json_set)) {
      const jsonSet = b.json_set as Record<string, unknown>;
      if (Object.keys(jsonSet).length > 0) {
        // Path traversal protection — the json_set path bypasses the
        // alfred CLI which has its own scoping checks, so we enforce
        // the same boundary here before touching the filesystem.
        resolveVaultPath(recordPath);
        await _withVaultPathLock(recordPath, async () => {
          const fullPath = path.resolve(VAULT_PATH, recordPath);
          let raw: string;
          try {
            raw = await fs.promises.readFile(fullPath, "utf-8");
          } catch (err) {
            // Record doesn't exist — `json_set` requires an existing file
            // since we're merging into existing frontmatter. The CLI
            // would have failed already if the caller sent `set` too.
            throw new NotFoundError(
              `Cannot json_set on missing record: ${recordPath} (${(err as Error).message})`,
            );
          }
          // Locate the frontmatter block — same heuristic the read path uses.
          let fm: Record<string, unknown> = {};
          let body = raw;
          let hadFrontmatter = false;
          if (raw.startsWith("---")) {
            const end = raw.indexOf("\n---", 3);
            if (end !== -1) {
              const yamlBlock = raw.slice(4, end);
              body = raw.slice(end + 4).replace(/^\r?\n/, "");
              try {
                const parsed = yaml.load(yamlBlock, { schema: yaml.DEFAULT_SCHEMA });
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  fm = parsed as Record<string, unknown>;
                  hadFrontmatter = true;
                }
              } catch (err) {
                throw new ValidationError(
                  `Cannot json_set on record with malformed frontmatter: ${recordPath} (${(err as Error).message})`,
                );
              }
            }
          }
          // Merge json_set on top — values that are explicitly null delete
          // the key (matches the CLI's `--set k=` semantics that the read
          // path's null-to-empty-string contract preserves).
          for (const [k, v] of Object.entries(jsonSet)) {
            if (v === null) {
              delete fm[k];
            } else {
              fm[k] = v;
            }
          }
          // Re-emit the file. js-yaml's dump with default-flow=false +
          // lineWidth=Infinity gives us human-readable block style for
          // top-level scalars and nested structures while keeping long
          // strings on one line (matches the alfred CLI's output style).
          const newYaml = yaml.dump(fm, {
            schema: yaml.DEFAULT_SCHEMA,
            indent: 2,
            lineWidth: -1,
            noRefs: true,
            sortKeys: false,
          });
          // Strip the trailing newline yaml.dump adds so the closing `---`
          // sits on its own line without a blank gap above it.
          const newYamlClean = newYaml.endsWith("\n") ? newYaml.slice(0, -1) : newYaml;
          let bodyOut = body;
          if (!hadFrontmatter && bodyOut.length === 0) {
            // Brand-new file with just frontmatter — no body bytes.
            bodyOut = "";
          }
          const rewritten =
            "---\n" + newYamlClean + "\n---\n" +
            (bodyOut.startsWith("\n") ? bodyOut : (bodyOut ? "\n" + bodyOut : ""));
          await fs.promises.writeFile(fullPath, rewritten, "utf-8");
        });
      }
    }

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

    if (stdout) {
      try {
        sendJson(res, 200, JSON.parse(stdout));
      } catch {
        sendJson(res, 200, { raw: stdout });
      }
    } else {
      // No CLI run — only json_set and/or body_set were applied. Surface a
      // shape that mirrors the CLI's success envelope so callers don't need
      // to branch on which path executed.
      sendJson(res, 200, { ok: true, path: recordPath });
    }
    scheduleNudgeForPath(recordPath);
    emitVaultEditSignal(recordPath, "edit");
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
    emitVaultEditSignal(b.from as string, "delete");
    emitVaultEditSignal(b.to as string, "create");
  });

  // Delete vault record
  addRoute("DELETE", "/api/v1/vault/records/*", async ({ res, params }) => {
    const recordPath = params.path;
    const args = [...ALFRED_CMD, "vault", "delete", recordPath];

    let stdout: string;
    try {
      // Serialise with any in-flight writes to this same path (#593).
      stdout = await _withVaultPathLock(
        recordPath, () => dockerExec("alfred", args, VAULT_ENV),
      );
    } catch (err) {
      // The alfred CLI exits 1 with a `{"error": "File not found: ..."}`
      // payload (to stdout and/or stderr) when the target record has
      // already been removed. Idempotent re-runs of the rematerializer
      // and other consumers of `delete_record` treat 404 as success;
      // bubbling these as a generic 500 EXEC_ERROR turns clean
      // already-deleted no-ops into noisy false-failure warnings (today's
      // Omi rematerializer logged 277 such warnings on David). Inspect
      // the captured streams and downgrade the explicit not-found case
      // to a real 404 — preserving 500 for genuine exec failures
      // (permissions, malformed paths, docker-side issues, etc.).
      if (err instanceof ExecError) {
        const combined = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.toLowerCase();
        if (combined.includes("file not found")) {
          // Debug-level: this is an idempotent no-op, not a failure.
          console.debug(
            `[vault.delete] record already absent path=${recordPath} (CLI exit non-zero with "File not found")`,
          );
          sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: `Record not found: ${recordPath}` },
          });
          return;
        }
      }
      throw err;
    }
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
    emitVaultEditSignal(recordPath, "delete");
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
      // Steward (#835 Phase 0) — fields owned by the Steward state
      // machine. Consumers should treat these as Steward-write-only.
      steward_fields: STEWARD_FIELDS,
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
  const byType: Record<string, Array<{ path: string; name: string; status: string }>> = {};

  if (VAULT_LIST_USE_INDEX) {
    const t0 = Date.now();
    const rows = vaultIndexListAll(openStateDb());
    for (const row of rows) {
      const fm = parseIndexFrontmatter(row.frontmatter);
      const recType = String(fm.type || "");
      if (!recType) continue;
      const display = row.path.replace(/\\/g, "/").replace(/\.md$/, "");
      const stem = path.basename(row.path, ".md");
      byType[recType] = byType[recType] || [];
      byType[recType].push({ path: display, name: stem, status: String(fm.status || "") });
    }
    console.log(
      "[vault.list.sql] getVaultContextData rows=%d types=%d elapsed_ms=%d",
      rows.length, Object.keys(byType).length, Date.now() - t0,
    );
  } else {
    const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
    for (const relPath of files) {
      const rec = readRecord(relPath);
      if (!rec) continue;
      const recType = String(rec.fm.type || "");
      if (!recType) continue;
      const display = relPath.replace(/\\/g, "/").replace(/\.md$/, "");
      byType[recType] = byType[recType] || [];
      byType[recType].push({ path: display, name: rec.stem, status: String(rec.fm.status || "") });
    }
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
