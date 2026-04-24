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
}
