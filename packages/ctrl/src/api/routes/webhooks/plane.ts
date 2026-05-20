// Plane → Steward webhook receiver (#838 Phase 2 — Layer 1 immediate
// signal fan-out for the Steward perception loop).
//
// `POST /api/v1/webhooks/plane/steward`
//
//   Headers: `X-Plane-Signature: <hex>` or `sha256=<hex>` — HMAC-SHA-256 of
//            the raw body using the secret in `PLANE_WEBHOOK_STEWARD_SECRET`.
//   Body:    Plane webhook event JSON (`{event, action, data: {...}}`).
//
// On a verified event, the route appends a single `steward signal` record
// to `/alfred-data/streams/steward-signals.jsonl`. Steward's existing
// 30-min Layer 3 catch-all picks the signal up on the next periodic tick
// per RFC #832 §3 — Phase 2 does NOT wire the immediate-fire path
// (that's Phase 5 territory). Recording the signal at receipt time is
// what matters: the Layer 1 capability is "Steward sees the event within
// seconds of Plane firing it" not "Steward acts within seconds".
//
// We deliberately do NOT mutate vault state, do NOT spawn a workflow, and
// do NOT reach back into Plane. The endpoint is pure ingest.
//
// SECURITY: the route is public (the SaaS Caddy proxy strips auth before
// passing to ctrl-api) — HMAC over the raw body is the only authentication.
// We register the path in `server.ts`'s `isPublic` whitelist AND in the
// `isRawBody` whitelist so the request pipeline hands us the exact bytes
// Plane signed.
//
// SEPARATE FROM EXISTING `/api/v1/plane/webhook`: that handler feeds
// PlaneReverseSyncWorkflow (issue → vault patches). The Steward path is a
// parallel emission — the same Plane events power TWO consumers without
// either consumer having to coordinate with the other.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../../server.js";
import { sendJson, ApiError, AuthError, ValidationError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Steward signal stream — append-only JSONL
// ---------------------------------------------------------------------------

const STEWARD_SIGNALS_FILE = "/alfred-data/streams/steward-signals.jsonl";

/** Append a single signal record. Best-effort — failures are surfaced to
 * the caller via 500 since Plane will retry on non-2xx, and a permanent
 * disk-write failure deserves operator attention. */
function appendStewardSignal(record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(STEWARD_SIGNALS_FILE), { recursive: true });
  fs.appendFileSync(STEWARD_SIGNALS_FILE, JSON.stringify(record) + "\n");
}

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

function parseSignatureHeader(header: string | string[] | undefined): Buffer | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  // Accept either "sha256=<hex>" or a bare hex string. Mirrors the
  // existing /api/v1/plane/webhook handler in routes/plane.ts.
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
// Plane event → signal-kind mapper
// ---------------------------------------------------------------------------

/** Translate the (event, action) pair on the Plane payload into the
 * canonical signal kind we use in steward-signals.jsonl. Returns
 * `plane:<event>:<action>` for every variant — Phase 5 will use the
 * exact pair to score relevance, so we keep the granularity here.
 *
 * Falls back to `plane:event` when action is missing so we never lose
 * a signal due to a Plane API surface change.
 */
function deriveSignalKind(event: string, action: string): string {
  const e = (event || "").trim() || "unknown";
  const a = (action || "").trim();
  if (!a) return `plane:${e}`;
  return `plane:${e}:${a}`;
}

// ---------------------------------------------------------------------------
// Plane issue → vault task path resolver
// ---------------------------------------------------------------------------

/** Pull a Plane issue id out of the webhook payload. Plane wraps the
 * actual issue object in `data` for issue events, but `comment.created`
 * / `comment.updated` events nest the issue id under `data.issue` (or
 * `data.issue_id` in older builds). We try both paths.
 *
 * Returns the issue UUID as a string, or "" when unrecoverable.
 */
function extractIssueId(event: string, data: Record<string, unknown>): string {
  if (!data) return "";
  if (event.startsWith("issue")) {
    const direct = data.id;
    if (typeof direct === "string" && direct) return direct;
    if (typeof direct === "number") return String(direct);
  }
  if (event.startsWith("comment") || event.startsWith("issue_comment")) {
    const issueRaw = data.issue ?? data.issue_id;
    if (typeof issueRaw === "string" && issueRaw) return issueRaw;
    if (typeof issueRaw === "number") return String(issueRaw);
    // Some Plane builds put the issue id under data.issue_detail.id
    const detail = (data.issue_detail ?? data.issue) as
      | Record<string, unknown>
      | undefined;
    if (detail && typeof detail === "object") {
      const did = (detail as Record<string, unknown>).id;
      if (typeof did === "string" && did) return did;
      if (typeof did === "number") return String(did);
    }
  }
  // Fallback for unknown event shapes: try direct id then nested issue.
  const fallback = data.id ?? (data as Record<string, unknown>).issue_id;
  if (typeof fallback === "string" && fallback) return fallback;
  if (typeof fallback === "number") return String(fallback);
  return "";
}

/** Lookup the vault task path for a given Plane issue id by scanning
 * the vault's task records. The forward-sync (`PlaneSyncWorkflow`) and
 * reverse-sync (`PlaneReverseSyncWorkflow`) both maintain a
 * `plane_issue_id` (or `external_id`) field on each task — we read
 * those frontmatters from the vault filesystem directly here because
 * (a) ctrl-api owns the vault on-disk and (b) we need a synchronous
 * answer at webhook time.
 *
 * Returns `null` when no matching task is found — Steward then drops
 * the signal cleanly (this is the "Plane issue Alfred has never seen"
 * case, e.g. comments on inbox-project triage issues).
 *
 * O(N) over task/* records but reads only frontmatter via a fast
 * regex shortcut; cheap enough at webhook frequency.
 */
function lookupTaskPathByPlaneIssue(plane_issue_id: string): string | null {
  if (!plane_issue_id) return null;
  // VAULT_PATH defaults to /vault — the vault_data volume mount on the
  // merged single-VM stack. The old deploy-template /mnt/encrypted/vault
  // path is NOT mounted in ctrl-api, so reading it threw ENOENT and every
  // Plane→Steward webhook was silently dropped as no_vault_task.
  const vaultRoot = process.env.VAULT_PATH ?? "/vault";
  const taskDir = path.join(vaultRoot, "task");
  let entries: string[];
  try {
    entries = fs.readdirSync(taskDir);
  } catch {
    return null;
  }
  // Compile a single match — values may appear in either `plane_issue_id`
  // (forward-sync write path) or `external_id: plane:<id>` (reverse-sync
  // create path). We accept both since the webhook can fire either way.
  const idEsc = plane_issue_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matchRe = new RegExp(
    `^(?:plane_issue_id|external_id):\\s*['"]?(?:plane:)?${idEsc}['"]?\\s*$`,
    "m",
  );
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const full = path.join(taskDir, entry);
    let content: string;
    try {
      content = fs.readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    // Quick reject: skip files without the issue id substring entirely.
    if (!content.includes(plane_issue_id)) continue;
    // Constrain the regex to the frontmatter block to avoid false
    // positives in body text.
    const fmEnd = content.startsWith("---") ? content.indexOf("\n---", 3) : -1;
    const fm = fmEnd > 0 ? content.slice(4, fmEnd) : content;
    if (matchRe.test(fm)) {
      return `task/${entry}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Author / note rendering — used to populate signal.note
// ---------------------------------------------------------------------------

function renderNote(event: string, action: string, data: Record<string, unknown>): string {
  const author = (() => {
    if (!data) return "";
    // Comment events: actor_detail.display_name / first_name / email
    const ad = (data.actor_detail ?? data.created_by_detail) as
      | Record<string, unknown>
      | undefined;
    if (ad && typeof ad === "object") {
      const dn = (ad as Record<string, unknown>).display_name;
      if (typeof dn === "string" && dn) return dn;
      const fn = (ad as Record<string, unknown>).first_name;
      if (typeof fn === "string" && fn) return fn;
      const em = (ad as Record<string, unknown>).email;
      if (typeof em === "string" && em) return em;
    }
    // Issue events: assigned_to_detail / created_by_detail
    return "";
  })();

  if (event.startsWith("comment") || event.startsWith("issue_comment")) {
    let text = "";
    if (typeof data.comment_stripped === "string" && data.comment_stripped) {
      text = data.comment_stripped;
    } else if (typeof data.comment_html === "string" && data.comment_html) {
      // Cheap HTML strip — webhook signal notes are advisory, not authoritative.
      text = data.comment_html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    if (text.length > 200) text = text.slice(0, 200) + "…";
    const who = author ? `Plane comment by ${author}` : "Plane comment";
    return text ? `${who}: ${text}` : who;
  }

  if (event.startsWith("issue")) {
    if (action === "updated" || action === "state_transition") {
      const stateRaw = (data.state_detail ?? data.state) as
        | Record<string, unknown>
        | string
        | undefined;
      let stateName = "";
      if (typeof stateRaw === "object" && stateRaw !== null) {
        const sn = (stateRaw as Record<string, unknown>).name;
        if (typeof sn === "string") stateName = sn;
      }
      const name = typeof data.name === "string" ? data.name : "";
      const parts: string[] = ["Plane issue updated"];
      if (name) parts.push(`"${name}"`);
      if (stateName) parts.push(`state=${stateName}`);
      return parts.join(" ");
    }
    if (action === "created") {
      const name = typeof data.name === "string" ? data.name : "";
      return name ? `Plane issue created: ${name}` : "Plane issue created";
    }
    if (action === "deleted") {
      return "Plane issue deleted";
    }
  }

  return `Plane ${event} ${action}`.trim();
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPlaneStewardWebhookRoute(): void {
  // POST /api/v1/webhooks/plane/steward
  //
  // PUBLIC route — HMAC-over-raw-body is the auth. Server pipeline must
  // pass `body` as a Node Buffer (configured in server.ts via the
  // `isRawBody` whitelist).
  addRoute("POST", "/api/v1/webhooks/plane/steward", async ({ req, res, body }) => {
    const secret = process.env.PLANE_WEBHOOK_STEWARD_SECRET;
    if (!secret) {
      console.error(
        "[webhooks.plane.steward] PLANE_WEBHOOK_STEWARD_SECRET is not configured — refusing all webhooks",
      );
      throw new ApiError(
        500,
        "CONFIG_ERROR",
        "PLANE_WEBHOOK_STEWARD_SECRET is not configured",
      );
    }

    if (!Buffer.isBuffer(body)) {
      throw new ValidationError("Raw body not available");
    }
    const rawBody: Buffer = body;

    // Verify HMAC.
    const sigHeader = req.headers["x-plane-signature"];
    const sigBuf = parseSignatureHeader(sigHeader);
    if (!sigBuf) {
      console.warn(
        "webhooks.plane.steward.invalid_signature reason=missing_header",
      );
      throw new AuthError("Missing or malformed X-Plane-Signature header");
    }
    if (!verifySignature(rawBody, sigBuf, secret)) {
      console.warn(
        "webhooks.plane.steward.invalid_signature reason=mismatch",
      );
      throw new AuthError("Invalid signature");
    }

    // Parse JSON body (post-HMAC so any parse error we report is about
    // the payload, not the signature).
    let payload: Record<string, unknown>;
    try {
      const text = rawBody.toString("utf-8");
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new ValidationError("Invalid JSON body");
    }

    const event =
      typeof payload.event === "string" ? (payload.event as string) : "unknown";
    const action =
      typeof payload.action === "string" ? (payload.action as string) : "";
    const data =
      typeof payload.data === "object" && payload.data !== null
        ? (payload.data as Record<string, unknown>)
        : {};

    const issueId = extractIssueId(event, data);
    if (!issueId) {
      // Plane fired something we don't have an issue id for (project
      // events, etc.). Acknowledge so Plane stops retrying.
      console.log(
        `webhooks.plane.steward.skipped reason=no_issue_id event=${event} action=${action}`,
      );
      sendJson(res, 200, { ok: true, skipped: true, reason: "no_issue_id" });
      return;
    }

    const taskPath = lookupTaskPathByPlaneIssue(issueId);
    if (!taskPath) {
      // No mirror task — common for Plane issues created in the inbox
      // project before the reverse-sync runs, or for issues whose
      // mirror has been archived. Acknowledge cleanly.
      console.log(
        `webhooks.plane.steward.no_task issue=${issueId} event=${event} action=${action}`,
      );
      sendJson(res, 200, { ok: true, skipped: true, reason: "no_vault_task" });
      return;
    }

    const kind = deriveSignalKind(event, action);
    const note = renderNote(event, action, data);
    const record = {
      id: `evt_${crypto.randomUUID()}`,
      ts: new Date().toISOString(),
      kind,
      task_path: taskPath,
      ref: `plane:${issueId}`,
      note,
      raw: payload,
    };

    try {
      appendStewardSignal(record);
    } catch (err) {
      console.error(
        `[webhooks.plane.steward] failed to append signal: ${(err as Error).message}`,
      );
      throw new ApiError(500, "WRITE_FAILED", "Failed to write signal stream");
    }

    console.log(
      `webhooks.plane.steward.recorded kind=${kind} issue=${issueId} task=${taskPath}`,
    );
    sendJson(res, 200, {
      ok: true,
      kind,
      task_path: taskPath,
      ref: `plane:${issueId}`,
    });
  });
}
