import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson, ApiError, AuthError, ValidationError } from "../errors.js";
import { dockerExec } from "../helpers.js";
import { emitStreamEvent } from "./streams.js";

// ---------------------------------------------------------------------------
// Persistent dedupe tail
//
// In-memory LRU dies on restart, so we also persist seen delivery UUIDs to
// /alfred-data/.plane-deliveries (one per line). On first webhook hit after
// a restart, we hydrate the LRU from the tail of that file. The file itself
// is rotated once it exceeds ROTATE_AT lines — we keep the newest KEEP_AT
// lines.
// ---------------------------------------------------------------------------

const DELIVERIES_FILE = "/alfred-data/.plane-deliveries";
const LRU_MAX = 1000;
const HYDRATE_FROM_TAIL = 1000;
const ROTATE_AT = 10_000;
const KEEP_AT = 5000;

/**
 * FIFO-evicting bounded Set. Using a plain `Set` preserves insertion order,
 * which is what we need for FIFO eviction.
 */
class BoundedSet {
  private set = new Set<string>();
  constructor(private max: number) {}

  has(key: string): boolean {
    return this.set.has(key);
  }

  add(key: string): void {
    if (this.set.has(key)) return;
    this.set.add(key);
    while (this.set.size > this.max) {
      // Remove oldest entry (first inserted)
      const oldest = this.set.values().next().value;
      if (oldest === undefined) break;
      this.set.delete(oldest);
    }
  }

  size(): number {
    return this.set.size;
  }
}

const seenDeliveries = new BoundedSet(LRU_MAX);
let hydrated = false;

function hydrateLruFromDisk(): void {
  if (hydrated) return;
  hydrated = true; // flip first so a failed hydrate doesn't retry forever
  try {
    if (!fs.existsSync(DELIVERIES_FILE)) return;
    const content = fs.readFileSync(DELIVERIES_FILE, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-HYDRATE_FROM_TAIL);
    for (const line of tail) {
      seenDeliveries.add(line.trim());
    }
    console.log(
      `[plane.webhook] hydrated ${tail.length} delivery IDs from ${DELIVERIES_FILE}`,
    );
  } catch (err) {
    console.warn(
      `[plane.webhook] failed to hydrate dedupe file: ${(err as Error).message}`,
    );
  }
}

function appendDeliveryToDisk(deliveryId: string): void {
  try {
    fs.mkdirSync(path.dirname(DELIVERIES_FILE), { recursive: true });
    fs.appendFileSync(DELIVERIES_FILE, deliveryId + "\n");
    // Cheap rotation check: only stat periodically; still O(1) in the common path.
    // We stat every time — it's a single syscall and cheap enough.
    const stat = fs.statSync(DELIVERIES_FILE);
    // Rough heuristic: average line ~37 bytes (36 UUID + \n). Trigger rotation
    // once the file grows past ROTATE_AT * ~40 bytes.
    if (stat.size > ROTATE_AT * 40) {
      const content = fs.readFileSync(DELIVERIES_FILE, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length > ROTATE_AT) {
        const keep = lines.slice(-KEEP_AT);
        fs.writeFileSync(DELIVERIES_FILE, keep.join("\n") + "\n");
        console.log(
          `[plane.webhook] rotated dedupe file: kept last ${keep.length} of ${lines.length} entries`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[plane.webhook] failed to persist delivery id: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Self-comments ledger (#536 B8 echo defence)
//
// When Alfred posts a comment via ``POST /api/v1/plane/comment`` we record
// the returned comment id in a FIFO-bounded ledger so the Plane trigger
// detector (``plane_alfred_triggers.py``) can suppress the webhook that
// will fire for Alfred's own comment.
//
// File shape matches the Python side exactly: a JSON array of string
// comment ids, capped at 500 entries (oldest evicted first). Writes are
// atomic (tmp + rename) so concurrent writes from multiple inflight
// comment posts don't corrupt the file.
//
// PATH NOTE: the ctrl-api container does NOT remap /mnt/encrypted/alfred
// to /alfred-data (unlike alfred-learn). Writing to /alfred-data/state/...
// from ctrl-api would land in the container's overlay FS and never reach
// the shared bind mount that plane_alfred_triggers reads from. Using the
// host path /mnt/encrypted/alfred/... makes the file land at
// /alfred-data/state/plane_self_comments.json inside the alfred-learn
// container (where the Python trigger loader looks for it).
// ---------------------------------------------------------------------------

const SELF_COMMENTS_FILE = "/mnt/encrypted/alfred/state/plane_self_comments.json";
const SELF_COMMENTS_CAP = 500;

function appendSelfCommentId(commentId: string): void {
  if (!commentId) return;
  try {
    fs.mkdirSync(path.dirname(SELF_COMMENTS_FILE), { recursive: true });

    let ledger: string[] = [];
    if (fs.existsSync(SELF_COMMENTS_FILE)) {
      try {
        const raw = fs.readFileSync(SELF_COMMENTS_FILE, "utf-8");
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          ledger = parsed.filter(
            (x): x is string => typeof x === "string" || typeof x === "number",
          ).map((x) => String(x));
        } else if (
          parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as any).comments)
        ) {
          // Backwards-compat with the {"comments": [...]} shape the
          // Python loader also accepts.
          ledger = (parsed as any).comments
            .filter(
              (x: unknown): x is string =>
                typeof x === "string" || typeof x === "number",
            )
            .map((x: string | number) => String(x));
        }
      } catch {
        // Corrupt ledger — start fresh rather than fail the write.
        ledger = [];
      }
    }

    ledger.push(commentId);
    if (ledger.length > SELF_COMMENTS_CAP) {
      ledger = ledger.slice(-SELF_COMMENTS_CAP);
    }

    const tmp = SELF_COMMENTS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(ledger));
    fs.renameSync(tmp, SELF_COMMENTS_FILE);
  } catch (err) {
    // Ledger write is best-effort — a failure here is logged but
    // doesn't fail the comment post. Worst case: Alfred's own comment
    // fires a webhook and the ``author_id == alfred_user_id`` check in
    // ``plane_alfred_triggers`` is the second line of defence.
    console.warn(
      `[plane.comment] failed to append self-comment id ${commentId}: ${(err as Error).message}`,
    );
  }
}

// Minimal HTML escape — enough for wrapping untrusted plain text in a
// <p>. Not a substitute for a real sanitiser (Plane stores raw html);
// callers passing structured text_html are responsible for that input.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Minimal HTML → text for deriving ``comment_stripped`` when the
// caller only supplied ``text_html``. Strips tags and decodes the
// handful of entities we care about. Not a full HTML parser; Plane
// itself normalises the stripped form on save.
function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function parseSignatureHeader(header: string | string[] | undefined): Buffer | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  // Accept either "sha256=<hex>" or a bare hex string (some setups strip the prefix)
  const hex = value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0) return null;
  try {
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

function verifySignature(rawBody: Buffer, signature: Buffer, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(expected, signature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Nudge workflow trigger (#574)
//
// Event-triggered forward-sync. Called fire-and-forget from vault write
// handlers (see ``routes/vault.ts``) immediately after a successful
// PATCH / POST / DELETE on ``matter/*`` or ``task/*``. Drops the vault
// → Plane latency from ~15 s (cron) to ~1–3 s.
//
// All failures are swallowed and logged. The cron forward-sync
// (``PlaneSyncWorkflow``, every 15 s) is the safety net — the nudge is
// pure optimisation.
// ---------------------------------------------------------------------------

const NUDGE_TASK_QUEUE = "alfred-learn";
const NUDGE_WORKFLOW_TYPE = "PlaneSyncNudgeWorkflow";

export type PlaneNudgeRecordType = "matter" | "task";

/** Allowed chars in a vault slug — same safety net the Python activity uses. */
const NUDGE_SLUG_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/**
 * Fire the nudge workflow for a single vault record. Fire-and-forget: the
 * returned promise resolves once ``temporal workflow start`` has been
 * dispatched; the workflow itself runs asynchronously in alfred-learn.
 *
 * Errors never throw — they are logged so the caller (a vault write
 * handler) can ignore the result entirely. If Temporal is unreachable
 * (e.g. tenant startup race) the cron forward-sync picks the record
 * up on its next tick.
 */
export async function triggerPlaneSyncNudge(
  recordType: PlaneNudgeRecordType,
  slug: string,
): Promise<{ scheduled: boolean; workflow_id?: string; reason?: string }> {
  // Feature-gate identical to the Python-side check. Avoids spawning
  // no-op workflows on tenants that don't run Plane.
  if ((process.env.PLANE_SYNC_ENABLED ?? "").toLowerCase() !== "true") {
    return { scheduled: false, reason: "PLANE_SYNC_ENABLED_off" };
  }

  if (recordType !== "matter" && recordType !== "task") {
    console.warn(`[plane.nudge] skip: invalid record_type=${recordType}`);
    return { scheduled: false, reason: "invalid_record_type" };
  }

  if (!slug || !NUDGE_SLUG_RE.test(slug)) {
    console.warn(`[plane.nudge] skip: invalid slug=${slug}`);
    return { scheduled: false, reason: "invalid_slug" };
  }

  // Workflow ID must be unique-enough to avoid collisions across rapid
  // back-to-back writes to the same record. Include type + slug +
  // millisecond timestamp + 8 hex chars of randomness. Temporal's
  // default ID-reuse policy (ALLOW_DUPLICATE) lets closed workflows
  // with the same ID be re-run, but back-to-back nudges within the
  // same millisecond would collide — the random suffix guarantees
  // uniqueness without requiring a stateful counter.
  const nonce = crypto.randomBytes(4).toString("hex");
  const workflowId = `plane-nudge-${recordType}-${slug}-${Date.now()}-${nonce}`;

  const args = [
    "temporal",
    "workflow",
    "start",
    "--type",
    NUDGE_WORKFLOW_TYPE,
    "--task-queue",
    NUDGE_TASK_QUEUE,
    "--workflow-id",
    workflowId,
    "--input",
    JSON.stringify({ record_type: recordType, slug }),
  ];

  try {
    await dockerExec("temporal", args);
    console.log(
      `plane.nudge.scheduled record_type=${recordType} slug=${slug} workflow_id=${workflowId}`,
    );
    return { scheduled: true, workflow_id: workflowId };
  } catch (err) {
    // Degrade gracefully — the cron forward-sync will catch the record
    // on its next 15s tick.
    console.warn(
      `[plane.nudge] failed to start workflow record_type=${recordType} slug=${slug}: ${(err as Error).message}`,
    );
    return { scheduled: false, reason: "exec_failed" };
  }
}

/**
 * Sanitize a slug out of a vault write path. Accepts:
 *   - "matter/client-x"        → "client-x"
 *   - "matter/client-x.md"     → "client-x"
 *   - "task/deploy-v2.md"      → "deploy-v2"
 * Returns null for any input that doesn't look like ``<type>/<slug>[.md]``.
 *
 * Shared between the explicit nudge endpoint handler and the automatic
 * post-vault-write trigger in ``vault.ts``.
 */
export function slugFromVaultPath(
  recordType: PlaneNudgeRecordType,
  relPath: string,
): string | null {
  if (!relPath) return null;
  const prefix = `${recordType}/`;
  let s = relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
  if (s.endsWith(".md")) s = s.slice(0, -3);
  // Reject paths with subdirectories or traversal — we only sync
  // top-level records.
  if (!s || s.includes("/") || s.includes("..")) return null;
  if (!NUDGE_SLUG_RE.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------------------
// Plane READ helpers (#629)
//
// The two GET /api/v1/plane/issues/... endpoints both need: param
// validation, env-var configured Plane client, an HTTP GET helper that
// returns either a parsed JSON body or an error envelope, and pruners
// that strip workspace/project metadata from Plane's verbose response
// before sending it back to the agent.
// ---------------------------------------------------------------------------

interface PlaneConfig {
  token: string;
  slug: string;
  base: string;
}

function requirePlaneConfig(): PlaneConfig {
  const token = process.env.PLANE_API_TOKEN;
  const slug = process.env.PLANE_WORKSPACE_SLUG;
  const baseRaw =
    process.env.PLANE_API_BASE_URL ||
    process.env.PLANE_API_URL ||
    "http://plane-api:8000";
  if (!token || !slug) {
    throw new ApiError(
      500,
      "NOT_CONFIGURED",
      "Plane not configured on this tenant (missing PLANE_API_TOKEN or PLANE_WORKSPACE_SLUG)",
    );
  }
  return { token, slug, base: baseRaw.replace(/\/+$/, "") };
}

function requirePlaneIssueParams(params: Record<string, string>): {
  projectId: string;
  issueId: string;
} {
  const projectId = (params.project_id || "").trim();
  const issueId = (params.issue_id || "").trim();
  if (!projectId || !issueId) {
    throw new ValidationError("project_id and issue_id are required");
  }
  return { projectId, issueId };
}

interface PlaneGetResult {
  ok: boolean;
  status: number;
  data: unknown;
  errorText?: string;
}

async function planeGet(url: string, token: string): Promise<PlaneGetResult> {
  return planeRequest("GET", url, token);
}

/**
 * Generic Plane HTTP helper. Used by the v2 read/write surface
 * (#629 v2): list / search / create / update issues, list cycles,
 * projects, states, labels. Returns either a parsed JSON body on 2xx
 * or `{ok: false, errorText}` so callers can map errors uniformly.
 *
 * Errors that prevent the request from being sent (DNS, connection)
 * still throw an `ApiError(502, PLANE_UNREACHABLE)` — those are
 * tenant-config bugs, not Plane-side problems.
 */
async function planeRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  token: string,
  body?: unknown,
): Promise<PlaneGetResult> {
  const headers: Record<string, string> = {
    "x-api-key": token,
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    throw new ApiError(
      502,
      "PLANE_UNREACHABLE",
      `Failed to reach Plane: ${(err as Error).message}`,
    );
  }
  if (!resp.ok) {
    const errorText = (await resp.text().catch(() => "")).slice(0, 500);
    return { ok: false, status: resp.status, data: null, errorText };
  }
  let data: unknown = null;
  try {
    const text = await resp.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    // Treat empty body / non-JSON as success-with-null. Callers
    // expecting a shape will get the empty object/array fallback in
    // the pruner.
  }
  return { ok: true, status: resp.status, data };
}

/**
 * Build a query string from a record where values are either
 * scalars, arrays, or undefined. Arrays are joined by comma —
 * Plane's REST accepts comma-separated values for multi-select
 * filters (e.g. `?priority=high,urgent`). Undefined/null/empty are
 * skipped.
 */
function buildPlaneQuery(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      const joined = v
        .filter((x) => x !== undefined && x !== null && x !== "")
        .map((x) => String(x))
        .join(",");
      if (joined) usp.set(k, joined);
    } else {
      usp.set(k, String(v));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

/**
 * Extract a list-of-objects from a Plane response that may be a bare
 * array OR a `{results: [...]}` envelope (older Plane builds). Used
 * by every list-style pruner.
 */
function unwrapList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const r = (raw as Record<string, unknown>).results;
    if (Array.isArray(r)) return r;
  }
  return [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function pruneAssignee(a: Record<string, unknown>): Record<string, unknown> {
  return {
    id: asString(a.id),
    display_name: asString(a.display_name ?? a.first_name ?? a.email),
    email: asString(a.email),
  };
}

function pruneLabel(l: Record<string, unknown>): Record<string, unknown> {
  return { id: asString(l.id), name: asString(l.name) };
}

function pruneState(s: unknown): Record<string, unknown> | null {
  if (!s) return null;
  if (typeof s === "string") return { id: s, name: "", group: "" };
  if (typeof s !== "object") return null;
  const obj = s as Record<string, unknown>;
  return {
    id: asString(obj.id),
    name: asString(obj.name),
    group: asString(obj.group),
  };
}

function pruneIssue(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const labelsRaw = Array.isArray(r.labels) ? r.labels : [];
  const assigneesRaw = Array.isArray(r.assignees) ? r.assignees : [];
  return {
    id: asString(r.id),
    name: asString(r.name),
    description_html: asString(r.description_html),
    description_stripped: asString(r.description_stripped),
    state: pruneState(r.state ?? r.state_detail ?? null),
    priority: asString(r.priority),
    labels: labelsRaw
      .map((l) =>
        typeof l === "string"
          ? { id: l, name: "" }
          : pruneLabel(l as Record<string, unknown>),
      ),
    assignees: assigneesRaw
      .map((a) =>
        typeof a === "string"
          ? { id: a, display_name: "", email: "" }
          : pruneAssignee(a as Record<string, unknown>),
      ),
    target_date: asString(r.target_date),
    external_id: asString(r.external_id),
    external_source: asString(r.external_source),
    created_at: asString(r.created_at),
    updated_at: asString(r.updated_at),
  };
}

function pruneCycle(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    id: asString(r.id),
    name: asString(r.name),
    description: asString(r.description),
    start_date: asString(r.start_date),
    end_date: asString(r.end_date),
    status: asString(r.status),
    project: asString(r.project),
    total_issues: typeof r.total_issues === "number" ? r.total_issues : 0,
    completed_issues: typeof r.completed_issues === "number" ? r.completed_issues : 0,
  };
}

function pruneProject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    id: asString(r.id),
    name: asString(r.name),
    identifier: asString(r.identifier),
    description: asString(r.description),
    archived_at: asString(r.archived_at),
  };
}

function pruneStateRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    id: asString(r.id),
    name: asString(r.name),
    group: asString(r.group),
    color: asString(r.color),
    project: asString(r.project),
    default: Boolean(r.default),
  };
}

function pruneLabelRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    id: asString(r.id),
    name: asString(r.name),
    color: asString(r.color),
    project: asString(r.project),
  };
}

interface PrunedComment {
  id: string;
  comment_stripped: string;
  comment_html: string;
  actor: { id: string; display_name: string; email: string };
  created_at: string;
  is_alfred: boolean;
}

function pruneComment(c: Record<string, unknown>, alfredUserId: string): PrunedComment {
  // Plane carries the author either as ``actor: <uuid>`` + a parallel
  // ``actor_detail: {...}`` object, or as ``created_by: <uuid>`` on
  // older deployments. We collapse both shapes into a single ``actor``.
  const actorIdRaw =
    typeof c.actor === "string"
      ? c.actor
      : typeof (c.actor as Record<string, unknown>)?.id === "string"
        ? ((c.actor as Record<string, unknown>).id as string)
        : asString(c.created_by ?? c.actor_id ?? "");
  const actorDetail =
    typeof c.actor_detail === "object" && c.actor_detail !== null
      ? (c.actor_detail as Record<string, unknown>)
      : typeof c.actor === "object" && c.actor !== null
        ? (c.actor as Record<string, unknown>)
        : {};
  return {
    id: asString(c.id),
    comment_stripped: asString(c.comment_stripped),
    comment_html: asString(c.comment_html),
    actor: {
      id: actorIdRaw,
      display_name: asString(
        actorDetail.display_name ?? actorDetail.first_name ?? actorDetail.email,
      ),
      email: asString(actorDetail.email),
    },
    created_at: asString(c.created_at),
    is_alfred: Boolean(alfredUserId) && actorIdRaw === alfredUserId,
  };
}

// ---------------------------------------------------------------------------
// Steward action helpers (#839 Phase 3)
//
// Steward fires Plane writes through these helpers — both the live cutover
// path in alfred-learn (``apply_state_change(mode="live")``) and the
// dashboard undo handler in ``routes/steward.ts``. Keeping the helpers
// here, alongside the rest of the Plane HTTP plumbing, means there's one
// owner for the comment-format / state-transition contract.
//
// Steward decisions and their Plane consequences:
//
//   ``likely_done``             → comment + transition to a state in the
//                                 ``completed`` group.
//   ``stale_archive_candidate`` → comment + set ``is_archived: true`` on
//                                 the issue (Plane has no ``archived``
//                                 state group; archival is an issue-level
//                                 boolean).
//   any other decision          → comment only, no transition.
//
// All Plane mutations go through ``planeRequest`` so a transient Plane
// outage maps to a uniform error envelope. The helpers throw an
// ``ApiError`` on Plane failure — callers are expected to record the
// partial-applied flag in the audit record (alfred-learn does this in
// ``apply_state_change``).
// ---------------------------------------------------------------------------

export interface StewardEvidenceItem {
  source?: string;
  ref?: string;
  note?: string;
}

export interface StewardActionResult {
  ok: true;
  comment_id: string | null;
  transitioned_to_state_id: string | null;
  transitioned_to_state_group: string | null;
  prior_state_id: string | null;
  prior_archived: boolean;
  archived: boolean;
}

const STEWARD_AUTO_COMMENT_PREFIX = "Auto-update by Alfred";

function formatStewardComment(
  decision: string,
  confidence: number,
  evidence: StewardEvidenceItem[],
  auditRecordPath: string,
): { html: string; stripped: string } {
  // Confidence rendered as 0..100 % so the comment reads naturally
  // alongside the decision label.
  const pct = Math.max(0, Math.min(100, Math.round(confidence * 100)));
  const evidenceLines: string[] = [];
  for (const e of evidence ?? []) {
    if (!e || typeof e !== "object") continue;
    const src = (e.source ?? "").toString().trim();
    const ref = (e.ref ?? "").toString().trim();
    const note = (e.note ?? "").toString().trim();
    let line: string;
    if (src && ref) line = `${src}:${ref}`;
    else if (src) line = src;
    else if (ref) line = ref;
    else if (note) line = note;
    else continue;
    if (note && (src || ref)) line = `${line} — ${note}`;
    evidenceLines.push(line);
  }
  const evidenceText = evidenceLines.length
    ? evidenceLines.join("; ")
    : "no signals";

  const headline =
    `${STEWARD_AUTO_COMMENT_PREFIX} (${decision}, confidence ${pct}%): ${evidenceText}`;
  const reference = auditRecordPath
    ? `See vault: ${auditRecordPath}`
    : "";

  const stripped = reference ? `${headline}\n\n${reference}` : headline;
  const html = reference
    ? `<p>${escapeHtml(headline)}</p><p><em>${escapeHtml(reference)}</em></p>`
    : `<p>${escapeHtml(headline)}</p>`;

  return { html, stripped };
}

async function fetchPlaneIssue(
  cfg: PlaneConfig,
  projectId: string,
  issueId: string,
): Promise<Record<string, unknown> | null> {
  const url =
    `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
    `/projects/${encodeURIComponent(projectId)}` +
    `/issues/${encodeURIComponent(issueId)}/`;
  const resp = await planeGet(url, cfg.token);
  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new ApiError(
      502,
      "PLANE_API_ERROR",
      resp.errorText || `Plane responded with ${resp.status}`,
    );
  }
  return (resp.data ?? null) as Record<string, unknown> | null;
}

async function listPlaneStates(
  cfg: PlaneConfig,
  projectId: string,
): Promise<Array<Record<string, unknown>>> {
  const url =
    `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
    `/projects/${encodeURIComponent(projectId)}/states/`;
  const resp = await planeGet(url, cfg.token);
  if (!resp.ok) {
    throw new ApiError(
      502,
      "PLANE_API_ERROR",
      resp.errorText || `Plane responded with ${resp.status}`,
    );
  }
  return unwrapList(resp.data) as Array<Record<string, unknown>>;
}

async function resolvePlaneStateIdForGroup(
  cfg: PlaneConfig,
  projectId: string,
  stateGroup: string,
): Promise<string | null> {
  const states = await listPlaneStates(cfg, projectId);
  for (const s of states) {
    if (typeof s.group === "string" && s.group === stateGroup) {
      const id = s.id;
      if (typeof id === "string" && id) return id;
    }
  }
  return null;
}

async function postPlaneCommentRaw(
  cfg: PlaneConfig,
  projectId: string,
  issueId: string,
  html: string,
  stripped: string,
): Promise<string | null> {
  const url =
    `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
    `/projects/${encodeURIComponent(projectId)}` +
    `/issues/${encodeURIComponent(issueId)}/comments/`;
  const resp = await planeRequest("POST", url, cfg.token, {
    comment_html: html,
    comment_stripped: stripped,
  });
  if (!resp.ok) {
    throw new ApiError(
      502,
      "PLANE_API_ERROR",
      resp.errorText || `Plane responded with ${resp.status}`,
    );
  }
  const data = (resp.data ?? {}) as Record<string, unknown>;
  const commentId =
    typeof data.id === "string"
      ? data.id
      : typeof data.id === "number"
        ? String(data.id)
        : null;
  if (commentId) appendSelfCommentId(commentId);
  return commentId;
}

async function patchPlaneIssue(
  cfg: PlaneConfig,
  projectId: string,
  issueId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const url =
    `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
    `/projects/${encodeURIComponent(projectId)}` +
    `/issues/${encodeURIComponent(issueId)}/`;
  const resp = await planeRequest("PATCH", url, cfg.token, body);
  if (!resp.ok) {
    throw new ApiError(
      502,
      "PLANE_API_ERROR",
      resp.errorText || `Plane responded with ${resp.status}`,
    );
  }
}

async function deletePlaneCommentIfPresent(
  cfg: PlaneConfig,
  projectId: string,
  issueId: string,
  commentId: string,
): Promise<void> {
  const url =
    `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
    `/projects/${encodeURIComponent(projectId)}` +
    `/issues/${encodeURIComponent(issueId)}` +
    `/comments/${encodeURIComponent(commentId)}/`;
  const resp = await planeRequest("DELETE", url, cfg.token);
  if (!resp.ok) {
    // 404 → already gone, idempotent success.
    if (resp.status === 404) return;
    throw new ApiError(
      502,
      "PLANE_API_ERROR",
      resp.errorText || `Plane responded with ${resp.status}`,
    );
  }
}

/**
 * Post a Steward auto-action to Plane: a comment formatted as
 *   "Auto-update by Alfred (<decision>, confidence X%): <evidence>"
 * plus, when the decision implies a state change, a state transition
 * (``likely_done`` → completed group) or an archival (
 * ``stale_archive_candidate`` → ``is_archived: true``).
 *
 * Captures the issue's prior state + archived flag BEFORE mutating so
 * the caller can record the values into the undo recipe. Returns
 * ``prior_state_id`` and ``prior_archived`` even when no transition
 * was performed (for forward-compat: Phase 5 may want them in the
 * audit trail even for comment-only decisions).
 *
 * Throws ``ApiError(502, PLANE_API_ERROR)`` on Plane failures.
 * Callers are responsible for marking the audit record with
 * ``partially_applied: true`` if the post succeeded but the transition
 * (or vice versa) failed mid-flight — this function performs comment
 * + transition as separate Plane requests; the second can fail after
 * the first succeeded.
 */
export async function postStewardAction(
  issueId: string,
  decision: string,
  confidence: number,
  evidence: StewardEvidenceItem[],
  auditRecordPath: string,
  projectId: string,
): Promise<StewardActionResult> {
  if (!projectId) {
    throw new ValidationError("project_id is required for postStewardAction");
  }
  if (!issueId) {
    throw new ValidationError("issue_id is required for postStewardAction");
  }
  const cfg = requirePlaneConfig();

  // Snapshot the prior state + archived flag for the undo recipe.
  const issue = await fetchPlaneIssue(cfg, projectId, issueId);
  if (!issue) {
    throw new ApiError(
      404,
      "PLANE_ISSUE_NOT_FOUND",
      `issue ${issueId} not found in project ${projectId}`,
    );
  }
  const priorStateId =
    typeof issue.state === "string"
      ? issue.state
      : issue.state && typeof issue.state === "object"
        ? asString((issue.state as Record<string, unknown>).id)
        : "";
  const priorArchived = Boolean(issue.is_archived || issue.archived_at);

  // Decide what transition to perform.
  let toStateGroup: string | null = null;
  let willArchive = false;
  if (decision === "likely_done") {
    toStateGroup = "completed";
  } else if (decision === "stale_archive_candidate") {
    willArchive = true;
  }

  // Resolve the destination state id (per-project; group→id varies).
  let toStateId: string | null = null;
  if (toStateGroup) {
    toStateId = await resolvePlaneStateIdForGroup(cfg, projectId, toStateGroup);
    if (!toStateId) {
      // Defensively skip the transition and surface the failure to
      // the caller. Comment still goes out so the audit trail in
      // Plane is honest about Alfred's intent even when the
      // transition couldn't land.
      console.warn(
        `[plane.steward_action] no state in group=${toStateGroup} for project=${projectId} — comment-only`,
      );
      toStateGroup = null;
    }
  }

  // Compose + post the comment.
  const { html, stripped } = formatStewardComment(
    decision,
    confidence,
    evidence,
    auditRecordPath,
  );
  const commentId = await postPlaneCommentRaw(
    cfg,
    projectId,
    issueId,
    html,
    stripped,
  );

  // Apply the transition / archival.
  let appliedStateId: string | null = null;
  let appliedStateGroup: string | null = null;
  let archivedNow = false;
  if (toStateId) {
    await patchPlaneIssue(cfg, projectId, issueId, { state: toStateId });
    appliedStateId = toStateId;
    appliedStateGroup = toStateGroup;
  }
  if (willArchive) {
    await patchPlaneIssue(cfg, projectId, issueId, { is_archived: true });
    archivedNow = true;
  }

  return {
    ok: true,
    comment_id: commentId,
    transitioned_to_state_id: appliedStateId,
    transitioned_to_state_group: appliedStateGroup,
    prior_state_id: priorStateId || null,
    prior_archived: priorArchived,
    archived: archivedNow,
  };
}

/**
 * Reverse a previously-posted Steward Plane action.
 *
 * Idempotent: a 404 on comment delete is treated as success (already
 * gone). State / archived restores are issued unconditionally — Plane
 * accepts a PATCH that sets a field to its current value as a no-op,
 * so re-running the revert is a safe no-op.
 *
 * Throws ``ApiError(502)`` on Plane failures other than 404 on the
 * comment delete.
 */
export async function revertStewardAction(
  issueId: string,
  commentId: string | null,
  restoreStateId: string | null,
  restoreArchived: boolean | null,
  projectId: string,
): Promise<{ ok: true; deleted_comment: boolean; restored_state: boolean; restored_archived: boolean }> {
  if (!projectId) {
    throw new ValidationError(
      "project_id is required for revertStewardAction",
    );
  }
  if (!issueId) {
    throw new ValidationError(
      "issue_id is required for revertStewardAction",
    );
  }
  const cfg = requirePlaneConfig();

  let deletedComment = false;
  if (commentId) {
    await deletePlaneCommentIfPresent(cfg, projectId, issueId, commentId);
    deletedComment = true;
  }

  let restoredState = false;
  if (restoreStateId) {
    await patchPlaneIssue(cfg, projectId, issueId, { state: restoreStateId });
    restoredState = true;
  }

  let restoredArchived = false;
  if (restoreArchived !== null) {
    await patchPlaneIssue(cfg, projectId, issueId, {
      is_archived: !!restoreArchived,
    });
    restoredArchived = true;
  }

  return {
    ok: true,
    deleted_comment: deletedComment,
    restored_state: restoredState,
    restored_archived: restoredArchived,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPlaneRoutes(): void {
  // POST /api/v1/plane/webhook
  //
  // PUBLIC route — HMAC over the raw body is the authentication. The server's
  // request pipeline passes `body` as a Node Buffer (raw bytes) for this path
  // (configured in server.ts — see `isRawBody`). Do NOT re-serialize before
  // HMAC: whitespace differences would cause a valid payload to fail.
  addRoute("POST", "/api/v1/plane/webhook", async ({ req, res, body }) => {
    const secret = process.env.PLANE_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[plane.webhook] PLANE_WEBHOOK_SECRET is not set");
      throw new ApiError(
        500,
        "CONFIG_ERROR",
        "PLANE_WEBHOOK_SECRET is not configured",
      );
    }

    if (!Buffer.isBuffer(body)) {
      throw new ValidationError("Raw body not available");
    }
    const rawBody: Buffer = body;

    // Verify HMAC signature
    const sigHeader = req.headers["x-plane-signature"];
    const sigBuf = parseSignatureHeader(sigHeader);
    if (!sigBuf) {
      console.warn("plane.webhook.invalid_signature reason=missing_header");
      throw new AuthError("Missing or malformed X-Plane-Signature header");
    }

    if (!verifySignature(rawBody, sigBuf, secret)) {
      console.warn("plane.webhook.invalid_signature reason=mismatch");
      throw new AuthError("Invalid signature");
    }

    // Lazy hydrate dedupe LRU on the first verified webhook after startup
    hydrateLruFromDisk();

    // Parse JSON body (post-HMAC, so any parse error we report is about the
    // payload shape, not the signature).
    let payload: Record<string, unknown>;
    try {
      const text = rawBody.toString("utf-8");
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new ValidationError("Invalid JSON body");
    }

    // Delivery UUID — use the header if present, otherwise fall back to a
    // content-hash key so older Plane versions (or stripped headers) still
    // dedupe correctly.
    const deliveryHeader = req.headers["x-plane-delivery"];
    const headerValue = Array.isArray(deliveryHeader)
      ? deliveryHeader[0]
      : deliveryHeader;
    const deliveryId =
      (headerValue && headerValue.trim()) ||
      `sha256:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;

    const event = typeof payload.event === "string" ? (payload.event as string) : "unknown";
    const action = typeof payload.action === "string" ? (payload.action as string) : "unknown";
    const data =
      typeof payload.data === "object" && payload.data !== null
        ? (payload.data as Record<string, unknown>)
        : {};
    const dataId =
      (typeof data.id === "string" && data.id) ||
      (typeof data.id === "number" && String(data.id)) ||
      "noid";

    console.log(
      `plane.webhook.received event=${event} action=${action} delivery=${deliveryId}`,
    );

    if (seenDeliveries.has(deliveryId)) {
      console.log(`plane.webhook.deduped delivery=${deliveryId}`);
      sendJson(res, 200, {
        ok: true,
        delivery: deliveryId,
        forwarded: false,
        deduped: true,
      });
      return;
    }

    // Mark as seen BEFORE forwarding — if the forward throws, we still treat
    // this delivery as consumed (Plane retries would be duplicates anyway, and
    // the HTTP 500 lets Plane know to retry via its own logic if it chooses).
    seenDeliveries.add(deliveryId);
    appendDeliveryToDisk(deliveryId);

    // Forward to the stream ingest pipeline as `stream_type: "plane"`.
    // In-process call — avoids the extra HTTP loop back to 127.0.0.1:3100
    // and the extra AAS_API_KEY round-trip.
    const sourceRef = `plane:${event}:${dataId}:${deliveryId}`;
    try {
      emitStreamEvent({
        stream_id: "plane",
        stream_type: "plane",
        source_ref: sourceRef,
        raw: payload,
        summary: `Plane ${event} ${action}`,
        metadata: {
          plane_event: event,
          plane_action: action,
          plane_delivery: deliveryId,
        },
      });
    } catch (err) {
      console.error(
        `[plane.webhook] stream forward failed delivery=${deliveryId}: ${(err as Error).message}`,
      );
      throw new ApiError(500, "FORWARD_FAILED", "Failed to forward event to stream");
    }

    console.log(`plane.webhook.forwarded delivery=${deliveryId}`);

    sendJson(res, 200, {
      ok: true,
      delivery: deliveryId,
      forwarded: true,
    });
  });

  // POST /api/v1/plane/comment
  //
  // Outbound comment poster for Alfred-as-a-Plane-user (#536 B8). The
  // main agent calls this via the MCP `self` tool when it wants to
  // reply to an @mention or post a progress/clarification comment on a
  // Plane issue. ctrl-api holds the ``PLANE_API_TOKEN`` + workspace
  // slug — the agent never sees the Plane PAT directly.
  //
  // On success, the returned comment id is appended to the
  // self-comments ledger at
  // ``/alfred-data/state/plane_self_comments.json`` so the trigger
  // detector (``plane_alfred_triggers``) suppresses the echo webhook.
  addRoute("POST", "/api/v1/plane/comment", async ({ body, res }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const projectId = typeof b.project_id === "string" ? b.project_id.trim() : "";
    const issueId = typeof b.issue_id === "string" ? b.issue_id.trim() : "";
    const text = typeof b.text === "string" ? b.text : "";
    const textHtml = typeof b.text_html === "string" ? b.text_html : "";

    if (!projectId || !issueId || (!text && !textHtml)) {
      throw new ValidationError(
        "project_id, issue_id, and text (or text_html) are required",
      );
    }

    const planeToken = process.env.PLANE_API_TOKEN;
    const workspaceSlug = process.env.PLANE_WORKSPACE_SLUG;
    const planeBaseRaw =
      process.env.PLANE_API_BASE_URL ||
      process.env.PLANE_API_URL ||
      "http://plane-api:8000";

    if (!planeToken || !workspaceSlug) {
      throw new ApiError(
        500,
        "NOT_CONFIGURED",
        "Plane not configured on this tenant (missing PLANE_API_TOKEN or PLANE_WORKSPACE_SLUG)",
      );
    }

    const planeBase = planeBaseRaw.replace(/\/+$/, "");

    // Plane accepts comment_html (+ optional comment_stripped). If the
    // caller supplied plain ``text``, wrap in a <p> and derive the
    // stripped form; if ``text_html`` was supplied, use it as-is and
    // derive a cheap stripped form by removing tags.
    const html = textHtml || `<p>${escapeHtml(text)}</p>`;
    const stripped = text || stripHtml(textHtml);

    const url = `${planeBase}/api/v1/workspaces/${encodeURIComponent(
      workspaceSlug,
    )}/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(
      issueId,
    )}/comments/`;

    let planeResp: Response;
    try {
      planeResp = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": planeToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          comment_html: html,
          comment_stripped: stripped,
        }),
      });
    } catch (err) {
      throw new ApiError(
        502,
        "PLANE_UNREACHABLE",
        `Failed to reach Plane at ${planeBase}: ${(err as Error).message}`,
      );
    }

    if (!planeResp.ok) {
      const errText = (await planeResp.text().catch(() => "")).slice(0, 500);
      return sendJson(res, planeResp.status, {
        error: {
          code: "PLANE_API_ERROR",
          message: errText || `Plane responded with ${planeResp.status}`,
        },
      });
    }

    let planeData: Record<string, unknown> = {};
    try {
      planeData = (await planeResp.json()) as Record<string, unknown>;
    } catch {
      // Plane occasionally returns no body on 201 with some proxies in
      // between. Treat that as success with no id — we skip the ledger
      // append but still 201 the caller.
    }

    const commentId =
      (typeof planeData.id === "string" && planeData.id) ||
      (typeof planeData.id === "number" && String(planeData.id)) ||
      "";

    if (commentId) {
      appendSelfCommentId(commentId);
    }

    sendJson(res, 201, { ok: true, comment_id: commentId || null });
  });

  // GET /api/v1/plane/issues/:project_id/:issue_id  (#629)
  //
  // Read-only issue fetch for Alfred's situational awareness. Wraps
  // Plane's REST GET .../issues/:id/ and returns a pruned shape (drop
  // workspace_detail / project_detail noise, keep the agent-relevant
  // fields). Used by the main agent to refresh its view of an issue
  // mid-conversation rather than relying solely on the spawn-time
  // bootstrap prompt (#617).
  addRoute(
    "GET",
    "/api/v1/plane/issues/:project_id/:issue_id",
    async ({ res, params }) => {
      const { projectId, issueId } = requirePlaneIssueParams(params);
      const cfg = requirePlaneConfig();
      const url = `${cfg.base}/api/v1/workspaces/${encodeURIComponent(
        cfg.slug,
      )}/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(
        issueId,
      )}/`;
      const planeResp = await planeGet(url, cfg.token);
      if (!planeResp.ok) {
        return sendJson(res, planeResp.status, {
          error: {
            code: "PLANE_API_ERROR",
            message: planeResp.errorText || `Plane responded with ${planeResp.status}`,
          },
        });
      }
      sendJson(res, 200, pruneIssue(planeResp.data));
    },
  );

  // GET /api/v1/plane/issues/:project_id/:issue_id/comments  (#629)
  //
  // Read-only comment thread fetch. Returns oldest → newest with an
  // ``is_alfred`` boolean computed from PLANE_ALFRED_USER_ID so the
  // agent can identify its own past comments without an extra lookup.
  // Plane returns comments newest-first by default, so we reverse the
  // list before returning.
  addRoute(
    "GET",
    "/api/v1/plane/issues/:project_id/:issue_id/comments",
    async ({ res, params }) => {
      const { projectId, issueId } = requirePlaneIssueParams(params);
      const cfg = requirePlaneConfig();
      const url = `${cfg.base}/api/v1/workspaces/${encodeURIComponent(
        cfg.slug,
      )}/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(
        issueId,
      )}/comments/`;
      const planeResp = await planeGet(url, cfg.token);
      if (!planeResp.ok) {
        return sendJson(res, planeResp.status, {
          error: {
            code: "PLANE_API_ERROR",
            message:
              planeResp.errorText || `Plane responded with ${planeResp.status}`,
          },
        });
      }
      // Plane may return either a bare list or {results: [...]} depending
      // on the deployed version (mirrors PlaneClient.list_issue_comments).
      const raw = planeResp.data;
      const items: unknown[] = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as Record<string, unknown>)?.results)
          ? ((raw as Record<string, unknown>).results as unknown[])
          : [];
      const alfredUserId = process.env.PLANE_ALFRED_USER_ID || "";
      const comments = items
        .map((c) => pruneComment(c as Record<string, unknown>, alfredUserId))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      sendJson(res, 200, { comments, total: comments.length });
    },
  );

  // POST /api/v1/plane/nudge
  //
  // Explicit event-triggered forward-sync (#574). Callers (the vault
  // write hook in `vault.ts`, ad-hoc scripts, operators poking the API)
  // can use this to prod Plane with a single-record sync without
  // waiting for the 15 s cron. Fire-and-forget — returns 202 Accepted
  // with the workflow_id once the start has been dispatched; actual
  // sync progress is visible via the standard workflow endpoints.
  addRoute("POST", "/api/v1/plane/nudge", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b) throw new ValidationError("Request body required");
    const recordType = b.record_type;
    const slug = b.slug;
    if (recordType !== "matter" && recordType !== "task") {
      throw new ValidationError("record_type must be 'matter' or 'task'");
    }
    if (typeof slug !== "string" || !slug.trim()) {
      throw new ValidationError("slug is required");
    }
    const outcome = await triggerPlaneSyncNudge(
      recordType as PlaneNudgeRecordType,
      slug.trim(),
    );
    sendJson(res, 202, {
      ok: outcome.scheduled,
      ...outcome,
    });
  });

  // ─── v2: list / search / create / update issues, list cycles /
  // projects / states / labels ──────────────────────────────────────
  //
  // These routes flesh out the read+write surface so the MCP layer
  // can drive Plane without bouncing through the vault. All proxy to
  // Plane's REST under the workspace slug ctrl-api holds in env.
  // Responses are pruned to the subset the MCP descriptions promise —
  // verbose workspace_detail / project_detail blocks are dropped.
  //
  // CROSS-PROJECT SEARCH NOTE (search_issues):
  //   Plane's REST issues endpoint is project-scoped: there is no
  //   `GET /workspaces/:slug/issues/`. To answer "all blocked
  //   tickets across projects" without project_ids, we fan out:
  //   discover projects via `GET /workspaces/:slug/projects/`, then
  //   call the per-project issues endpoint for each, merging
  //   results client-side. We cap the fan-out at MAX_FANOUT_PROJECTS
  //   (15) — beyond that the user MUST pass `project_ids`. The fan
  //   -out path also enforces the global `limit`/`offset` AFTER the
  //   merge, so the upstream Plane page sizes don't leak into the
  //   response shape.

  // GET /api/v1/plane/issues
  //
  // Simple paginated list of issues in ONE project. Anything fancier
  // (cross-project, state-group filters, blocked-tickets queries)
  // belongs in POST /api/v1/plane/issues/search.
  addRoute("GET", "/api/v1/plane/issues", async ({ res, query }) => {
    const cfg = requirePlaneConfig();
    const projectId = (query.get("project_id") || "").trim();
    if (!projectId) {
      throw new ValidationError("project_id query param is required");
    }
    const limit = Math.min(
      Math.max(parseInt(query.get("limit") || "50", 10) || 50, 1),
      200,
    );
    const offset = Math.max(parseInt(query.get("offset") || "0", 10) || 0, 0);
    const stateId = query.get("state_id") || undefined;
    const assigneeId = query.get("assignee_id") || undefined;
    const cycleId = query.get("cycle_id") || undefined;
    const orderBy = query.get("order_by") || undefined;

    const upstream = buildPlaneQuery({
      per_page: limit,
      cursor: offset ? `${offset}` : undefined,
      state: stateId,
      assignees: assigneeId,
      cycle: cycleId,
      order_by: orderBy,
    });
    const url =
      `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
      `/projects/${encodeURIComponent(projectId)}/issues/${upstream}`;

    const planeResp = await planeGet(url, cfg.token);
    if (!planeResp.ok) {
      return sendJson(res, planeResp.status, {
        error: {
          code: "PLANE_API_ERROR",
          message:
            planeResp.errorText || `Plane responded with ${planeResp.status}`,
        },
      });
    }
    const items = unwrapList(planeResp.data).map((i) => pruneIssue(i));
    sendJson(res, 200, { issues: items, total: items.length, limit, offset });
  });

  // POST /api/v1/plane/issues
  //
  // Create an issue in ONE project. Body fields map onto Plane's
  // create payload — required: project_id, name. Optional: state,
  // assignees, labels, priority, target_date, description_html,
  // cycle, parent.
  addRoute("POST", "/api/v1/plane/issues", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const projectId =
      typeof b.project_id === "string" ? b.project_id.trim() : "";
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!projectId || !name) {
      throw new ValidationError("project_id and name are required");
    }
    const cfg = requirePlaneConfig();

    // Whitelist the fields we forward — anything else (workspace_detail
    // etc.) is dropped to keep upstream calls predictable.
    const payload: Record<string, unknown> = { name };
    const passthrough = [
      "description_html",
      "description_stripped",
      "state",
      "priority",
      "assignees",
      "labels",
      "target_date",
      "start_date",
      "parent",
      "cycle",
      "external_id",
      "external_source",
    ];
    for (const k of passthrough) {
      if (b[k] !== undefined && b[k] !== null) payload[k] = b[k];
    }

    const url =
      `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
      `/projects/${encodeURIComponent(projectId)}/issues/`;
    const planeResp = await planeRequest("POST", url, cfg.token, payload);
    if (!planeResp.ok) {
      return sendJson(res, planeResp.status, {
        error: {
          code: "PLANE_API_ERROR",
          message:
            planeResp.errorText || `Plane responded with ${planeResp.status}`,
        },
      });
    }
    sendJson(res, 201, pruneIssue(planeResp.data));
  });

  // PATCH /api/v1/plane/issues/:project_id/:issue_id
  //
  // Update state, priority, assignees, labels, dates, name,
  // description. Body is a partial issue — anything passed through
  // overrides Plane's stored value. Empty body is a no-op (Plane
  // returns 200 with the unchanged record).
  addRoute(
    "PATCH",
    "/api/v1/plane/issues/:project_id/:issue_id",
    async ({ res, params, body }) => {
      const { projectId, issueId } = requirePlaneIssueParams(params);
      const cfg = requirePlaneConfig();
      const b = (body ?? {}) as Record<string, unknown>;
      const passthrough = [
        "name",
        "description_html",
        "description_stripped",
        "state",
        "priority",
        "assignees",
        "labels",
        "target_date",
        "start_date",
        "parent",
        "cycle",
      ];
      const payload: Record<string, unknown> = {};
      for (const k of passthrough) {
        if (b[k] !== undefined) payload[k] = b[k];
      }
      const url =
        `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
        `/projects/${encodeURIComponent(projectId)}` +
        `/issues/${encodeURIComponent(issueId)}/`;
      const planeResp = await planeRequest("PATCH", url, cfg.token, payload);
      if (!planeResp.ok) {
        return sendJson(res, planeResp.status, {
          error: {
            code: "PLANE_API_ERROR",
            message:
              planeResp.errorText || `Plane responded with ${planeResp.status}`,
          },
        });
      }
      sendJson(res, 200, pruneIssue(planeResp.data));
    },
  );

  // POST /api/v1/plane/issues/search
  //
  // Sophisticated multi-dimensional issue search. See the file
  // header CROSS-PROJECT SEARCH NOTE for the fan-out limitation.
  // Filter dimensions: project_ids, cycle_ids, state_ids,
  // state_groups (mapped client-side), assignee_ids, assigned_to_me,
  // priority, label_ids, created_after/before, target_date_*,
  // updated_after, text_search, is_blocked, order_by, limit, offset.
  //
  // Plane natively supports: state, assignees, labels, priority,
  // cycle, created_at, target_date, search (text). It does NOT have
  // a first-class "blocked" flag, so `is_blocked` is implemented as
  // a label-name match on the literal label "blocked" — agents that
  // need a more nuanced answer should call list_labels first and
  // pass the resolved label_ids directly.
  addRoute("POST", "/api/v1/plane/issues/search", async ({ res, body }) => {
    const cfg = requirePlaneConfig();
    const f = (body ?? {}) as Record<string, unknown>;

    const arrStr = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out = v
        .filter((x) => typeof x === "string" && x.length > 0)
        .map((x) => x as string);
      return out.length ? out : undefined;
    };
    const optStr = (v: unknown): string | undefined =>
      typeof v === "string" && v.length ? v : undefined;
    const optBool = (v: unknown): boolean | undefined =>
      typeof v === "boolean" ? v : undefined;
    const optNum = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;

    const STATE_GROUPS = new Set([
      "backlog",
      "unstarted",
      "started",
      "completed",
      "cancelled",
    ]);
    const PRIORITY_VALS = new Set([
      "urgent",
      "high",
      "medium",
      "low",
      "none",
    ]);

    const projectIds = arrStr(f.project_ids);
    const cycleIds = arrStr(f.cycle_ids);
    const stateIds = arrStr(f.state_ids);
    const stateGroups = (arrStr(f.state_groups) || []).filter((g) =>
      STATE_GROUPS.has(g),
    );
    let assigneeIds = arrStr(f.assignee_ids);
    if (optBool(f.assigned_to_me)) {
      const me = process.env.PLANE_ALFRED_USER_ID;
      if (me) {
        assigneeIds = assigneeIds ? [...assigneeIds, me] : [me];
      }
    }
    const priority = (arrStr(f.priority) || []).filter((p) =>
      PRIORITY_VALS.has(p),
    );
    const labelIds = arrStr(f.label_ids);
    const createdAfter = optStr(f.created_after);
    const createdBefore = optStr(f.created_before);
    const targetAfter = optStr(f.target_date_after);
    const targetBefore = optStr(f.target_date_before);
    const updatedAfter = optStr(f.updated_after);
    const textSearch = optStr(f.text_search);
    const isBlocked = optBool(f.is_blocked);
    const orderBy = optStr(f.order_by);
    const limit = Math.min(Math.max(optNum(f.limit) ?? 50, 1), 200);
    const offset = Math.max(optNum(f.offset) ?? 0, 0);

    // Resolve state_groups → state_ids client-side. We have to fetch
    // the project's states and match by `group`. Skip if the caller
    // already passed state_ids OR if no project scope (group filter
    // is meaningless workspace-wide without per-project resolution).
    let resolvedStateIds = stateIds ? [...stateIds] : undefined;
    if (!resolvedStateIds && stateGroups.length > 0) {
      // Resolve from EACH project in scope. If projectIds is empty
      // we resolve from the discovered fan-out projects below.
      // We defer the actual lookup to the fan-out loop so each
      // project gets its own state_ids set.
    }

    // Determine which projects to query.
    const MAX_FANOUT_PROJECTS = 15;
    let scopeProjects: string[];
    if (projectIds && projectIds.length > 0) {
      scopeProjects = projectIds;
    } else {
      // Fan-out discovery: list workspace projects.
      const projUrl =
        `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
        `/projects/`;
      const projResp = await planeGet(projUrl, cfg.token);
      if (!projResp.ok) {
        return sendJson(res, projResp.status, {
          error: {
            code: "PLANE_API_ERROR",
            message:
              projResp.errorText ||
              `Plane responded with ${projResp.status}`,
          },
        });
      }
      const allProjects = unwrapList(projResp.data)
        .map((p) => pruneProject(p))
        .filter((p) => !p.archived_at);
      scopeProjects = allProjects.map((p) => String(p.id)).filter(Boolean);
      if (scopeProjects.length > MAX_FANOUT_PROJECTS) {
        return sendJson(res, 400, {
          error: {
            code: "FANOUT_TOO_LARGE",
            message: `Workspace has ${scopeProjects.length} projects; pass project_ids to scope (max ${MAX_FANOUT_PROJECTS} for workspace-wide queries).`,
          },
        });
      }
    }

    // Per-project: resolve state-groups into state_ids if needed,
    // build the upstream query, fetch, accumulate.
    const merged: Record<string, unknown>[] = [];
    for (const pid of scopeProjects) {
      let projectStateIds = resolvedStateIds;
      if (!projectStateIds && stateGroups.length > 0) {
        const stUrl =
          `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
          `/projects/${encodeURIComponent(pid)}/states/`;
        const stResp = await planeGet(stUrl, cfg.token);
        if (stResp.ok) {
          const states = unwrapList(stResp.data).map((s) => pruneStateRecord(s));
          projectStateIds = states
            .filter((s) => stateGroups.includes(String(s.group)))
            .map((s) => String(s.id));
        }
      }

      // Plane's per-project issues endpoint accepts comma-separated
      // multi-value filters on state, assignees, labels, priority,
      // cycle. created_at/target_date use ISO range params.
      const upstreamParams: Record<string, unknown> = {
        per_page: Math.min(limit + offset, 200),
        order_by: orderBy,
        search: textSearch,
        state: projectStateIds,
        assignees: assigneeIds,
        labels: labelIds,
        priority: priority.length ? priority : undefined,
        cycle: cycleIds,
        // Plane accepts created_at__gte / __lte etc. for filtering.
        "created_at__gte": createdAfter,
        "created_at__lte": createdBefore,
        "target_date__gte": targetAfter,
        "target_date__lte": targetBefore,
        "updated_at__gte": updatedAfter,
      };
      const qs = buildPlaneQuery(upstreamParams);
      const url =
        `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
        `/projects/${encodeURIComponent(pid)}/issues/${qs}`;
      const issResp = await planeGet(url, cfg.token);
      if (!issResp.ok) {
        // Per-project failure: log + skip — don't fail the whole
        // search because one project errored.
        console.warn(
          `[plane.search] project ${pid} returned ${issResp.status}: ${issResp.errorText}`,
        );
        continue;
      }
      const items = unwrapList(issResp.data).map((i) => pruneIssue(i));
      for (const it of items) {
        // Tag the project for downstream callers (PATCH/get_issue
        // need both project_id and issue_id).
        it.project_id = pid;
      }
      merged.push(...items);
    }

    // Client-side filters: is_blocked (label name match), text
    // search fallback, ordering / pagination.
    let results = merged;
    if (isBlocked === true) {
      results = results.filter((it) => {
        const labels = Array.isArray(it.labels) ? it.labels : [];
        return labels.some(
          (l) =>
            typeof l === "object" &&
            l !== null &&
            String((l as Record<string, unknown>).name).toLowerCase() ===
              "blocked",
        );
      });
    } else if (isBlocked === false) {
      results = results.filter((it) => {
        const labels = Array.isArray(it.labels) ? it.labels : [];
        return !labels.some(
          (l) =>
            typeof l === "object" &&
            l !== null &&
            String((l as Record<string, unknown>).name).toLowerCase() ===
              "blocked",
        );
      });
    }

    // Apply order_by client-side over the merged list (we already
    // asked Plane to order per-project, but cross-project the merge
    // can interleave). Default: -updated_at.
    const sortKey = orderBy || "-updated_at";
    const desc = sortKey.startsWith("-");
    const field = desc ? sortKey.slice(1) : sortKey;
    results.sort((a, b) => {
      const av = String((a as Record<string, unknown>)[field] ?? "");
      const bv = String((b as Record<string, unknown>)[field] ?? "");
      if (av === bv) return 0;
      return desc ? (av < bv ? 1 : -1) : av < bv ? -1 : 1;
    });

    const total = results.length;
    const page = results.slice(offset, offset + limit);
    sendJson(res, 200, {
      issues: page,
      total,
      limit,
      offset,
      scope: {
        projects_searched: scopeProjects.length,
        cross_project: scopeProjects.length > 1,
        is_blocked_via_label_match: typeof isBlocked === "boolean",
      },
    });
  });

  // GET /api/v1/plane/cycles?project_id=...
  addRoute("GET", "/api/v1/plane/cycles", async ({ res, query }) => {
    const cfg = requirePlaneConfig();
    const projectId = (query.get("project_id") || "").trim();
    if (!projectId) {
      throw new ValidationError("project_id query param is required");
    }
    const url =
      `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
      `/projects/${encodeURIComponent(projectId)}/cycles/`;
    const planeResp = await planeGet(url, cfg.token);
    if (!planeResp.ok) {
      return sendJson(res, planeResp.status, {
        error: {
          code: "PLANE_API_ERROR",
          message:
            planeResp.errorText || `Plane responded with ${planeResp.status}`,
        },
      });
    }
    const cycles = unwrapList(planeResp.data).map((c) => pruneCycle(c));
    sendJson(res, 200, { cycles, total: cycles.length });
  });

  // GET /api/v1/plane/projects
  addRoute("GET", "/api/v1/plane/projects", async ({ res }) => {
    const cfg = requirePlaneConfig();
    const url = `${cfg.base}/api/v1/workspaces/${encodeURIComponent(
      cfg.slug,
    )}/projects/`;
    const planeResp = await planeGet(url, cfg.token);
    if (!planeResp.ok) {
      return sendJson(res, planeResp.status, {
        error: {
          code: "PLANE_API_ERROR",
          message:
            planeResp.errorText || `Plane responded with ${planeResp.status}`,
        },
      });
    }
    const projects = unwrapList(planeResp.data).map((p) => pruneProject(p));
    sendJson(res, 200, { projects, total: projects.length });
  });

  // GET /api/v1/plane/states?project_id=...
  addRoute("GET", "/api/v1/plane/states", async ({ res, query }) => {
    const cfg = requirePlaneConfig();
    const projectId = (query.get("project_id") || "").trim();
    if (!projectId) {
      throw new ValidationError("project_id query param is required");
    }
    const url =
      `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
      `/projects/${encodeURIComponent(projectId)}/states/`;
    const planeResp = await planeGet(url, cfg.token);
    if (!planeResp.ok) {
      return sendJson(res, planeResp.status, {
        error: {
          code: "PLANE_API_ERROR",
          message:
            planeResp.errorText || `Plane responded with ${planeResp.status}`,
        },
      });
    }
    const states = unwrapList(planeResp.data).map((s) => pruneStateRecord(s));
    sendJson(res, 200, { states, total: states.length });
  });

  // GET /api/v1/plane/labels?project_id=...
  addRoute("GET", "/api/v1/plane/labels", async ({ res, query }) => {
    const cfg = requirePlaneConfig();
    const projectId = (query.get("project_id") || "").trim();
    if (!projectId) {
      throw new ValidationError("project_id query param is required");
    }
    const url =
      `${cfg.base}/api/v1/workspaces/${encodeURIComponent(cfg.slug)}` +
      `/projects/${encodeURIComponent(projectId)}/labels/`;
    const planeResp = await planeGet(url, cfg.token);
    if (!planeResp.ok) {
      return sendJson(res, planeResp.status, {
        error: {
          code: "PLANE_API_ERROR",
          message:
            planeResp.errorText || `Plane responded with ${planeResp.status}`,
        },
      });
    }
    const labels = unwrapList(planeResp.data).map((l) => pruneLabelRecord(l));
    sendJson(res, 200, { labels, total: labels.length });
  });

  // POST /api/v1/plane/steward-action  (#839 Phase 3)
  //
  // Internal endpoint used by alfred-learn's ``apply_state_change``
  // (live mode) to post a Steward auto-comment + state transition.
  // Body shape::
  //
  //   {
  //     "project_id": "<uuid>",
  //     "issue_id":   "<uuid>",
  //     "decision":   "likely_done" | "stale_archive_candidate" | ...,
  //     "confidence": 0.0..1.0,
  //     "evidence":   [{ "source", "ref", "note" }, ...],
  //     "audit_record_path": "event/steward-action-<ts>-<slug>.md"
  //   }
  //
  // Returns the StewardActionResult shape from postStewardAction —
  // comment_id, transitioned_to_state_id, prior_state_id,
  // prior_archived, etc — so the audit record can record the prior
  // values into its undo_recipe.plane_revert.
  addRoute("POST", "/api/v1/plane/steward-action", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const projectId =
      typeof b.project_id === "string" ? b.project_id.trim() : "";
    const issueId =
      typeof b.issue_id === "string" ? b.issue_id.trim() : "";
    const decision =
      typeof b.decision === "string" ? b.decision.trim() : "";
    const confidenceRaw = b.confidence;
    let confidence = 0;
    if (typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)) {
      confidence = confidenceRaw;
    } else if (typeof confidenceRaw === "string" && confidenceRaw.trim()) {
      const n = Number.parseFloat(confidenceRaw);
      if (Number.isFinite(n)) confidence = n;
    }
    const auditRecordPath =
      typeof b.audit_record_path === "string"
        ? b.audit_record_path.trim()
        : "";
    const evidenceRaw = Array.isArray(b.evidence) ? b.evidence : [];
    const evidence: StewardEvidenceItem[] = evidenceRaw
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({
        source: typeof e.source === "string" ? e.source : undefined,
        ref: typeof e.ref === "string" ? e.ref : undefined,
        note: typeof e.note === "string" ? e.note : undefined,
      }));

    if (!projectId || !issueId || !decision) {
      throw new ValidationError(
        "project_id, issue_id, and decision are required",
      );
    }

    const result = await postStewardAction(
      issueId,
      decision,
      confidence,
      evidence,
      auditRecordPath,
      projectId,
    );
    sendJson(res, 200, result);
  });

  // POST /api/v1/plane/steward-action/revert  (#839 Phase 3)
  //
  // Internal endpoint used by the dashboard undo handler to reverse a
  // previously-posted Steward Plane action. Body shape mirrors the
  // ``undo_recipe.plane_revert`` block::
  //
  //   {
  //     "project_id":        "<uuid>",
  //     "issue_id":          "<uuid>",
  //     "delete_comment_id": "<uuid> | null",
  //     "restore_state_id":  "<uuid> | null",
  //     "restore_archived":  bool | null
  //   }
  addRoute(
    "POST",
    "/api/v1/plane/steward-action/revert",
    async ({ res, body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const projectId =
        typeof b.project_id === "string" ? b.project_id.trim() : "";
      const issueId =
        typeof b.issue_id === "string" ? b.issue_id.trim() : "";
      const deleteCommentId =
        typeof b.delete_comment_id === "string" && b.delete_comment_id.trim()
          ? b.delete_comment_id.trim()
          : null;
      const restoreStateId =
        typeof b.restore_state_id === "string" && b.restore_state_id.trim()
          ? b.restore_state_id.trim()
          : null;
      const restoreArchived =
        typeof b.restore_archived === "boolean" ? b.restore_archived : null;

      if (!projectId || !issueId) {
        throw new ValidationError("project_id and issue_id are required");
      }

      const result = await revertStewardAction(
        issueId,
        deleteCommentId,
        restoreStateId,
        restoreArchived,
        projectId,
      );
      sendJson(res, 200, result);
    },
  );
}
