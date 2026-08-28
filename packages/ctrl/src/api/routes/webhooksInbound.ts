/**
 * Inbound custom webhooks — the "Custom Webhook" synthetic integration.
 *
 * Each webhook is a tiny vault record (`/mnt/encrypted/vault/webhook_endpoint/<token>.md`)
 * with frontmatter recording the token, a human label, creation timestamp and
 * a running event_count. POSTing arbitrary JSON to the public ingest URL
 * lands as a `stream_event` vault record so alfred-learn's EventProcessor
 * picks it up via the normal curator path — no special-casing in the
 * pipeline, just one more source_type.
 *
 * Routes:
 *   - POST   /api/v1/webhooks/inbound          — create a token + record
 *   - GET    /api/v1/webhooks/inbound          — list registered webhooks
 *   - DELETE /api/v1/webhooks/inbound/:id      — delete (id = bare token or "webhook:<token>")
 *   - POST   /api/v1/webhooks/in/:token        — PUBLIC ingest; emits stream_event
 *                                                 (or an alfred_journal entry when
 *                                                  the webhook's destination is
 *                                                  "journal" — see below)
 *
 * DESTINATIONS. A webhook routes to one of two places:
 *   "stream"  (default) — emits a stream_event, the normal curator path.
 *   "journal" — appends to alfred_journal instead. This exists so a surface
 *               that talks to Alfred OUTSIDE a Hermes channel (Claude Cowork
 *               via MCP, a desktop client, a script) can give Alfred
 *               continuity of that conversation. The one-alfred plugin's
 *               pre_gateway_dispatch hook already re-injects journal context
 *               on every inbound message, so a journalled Cowork exchange is
 *               remembered on the principal's next Slack/Telegram message with
 *               no plugin change. See docs/design/one-alfred.md.
 *
 *               Why a webhook token rather than exposing /api/v1/alfred-journal:
 *               ctrl-api is deliberately NOT public (Caddy proxies only a small
 *               allowlist), and the alternative — handing a laptop the master
 *               AAS_API_KEY — grants full ctrl-api access. A webhook token is
 *               scoped, per-device and revocable.
 *
 * The ingest path is registered in server.ts's `isPublic` whitelist; the
 * other three CRUD routes go through the normal AAS_API_KEY auth path.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { getIngestDb } from "../../db/ingest.js";
import { getStateDb } from "../../db/state.js";
import { appendJournal } from "../../db/alfredJournal.js";
import { ulid } from "../../db/ulid.js";

const VAULT_ROOT = process.env.VAULT_PATH ?? "/vault";
const WEBHOOK_ENDPOINT_DIR = path.join(VAULT_ROOT, "webhook_endpoint");
const STREAM_EVENT_DIR = path.join(VAULT_ROOT, "stream_event");

// Compose the fully-qualified public ingest URL for a webhook token. The
// tenant base URL is injected at provision time (TENANT_BASE_URL, e.g.
// https://<sub>.alfred.black). Without it, the create/list flows previously
// emitted a bare relative path the user couldn't actually POST to. Falls back
// to https://${DOMAIN} when only DOMAIN is set, else the relative path. (F27)
export function composeInboundWebhookUrl(token: string): string {
  const rel = `/api/v1/webhooks/in/${token}`;
  const base = process.env.TENANT_BASE_URL
    || (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : "");
  return base ? `${base.replace(/\/$/, "")}${rel}` : rel;
}

type WebhookDestination = "stream" | "journal";

interface WebhookFrontmatter {
  type: "webhook_endpoint";
  token: string;
  label: string;
  created_at: string;
  event_count: number;
  last_event_at: string | null;
  // Omitted on every webhook created before this shipped — readWebhookRecord
  // defaults it to "stream", so existing tokens keep their behaviour exactly.
  destination?: WebhookDestination;
  // Journal destination only: the channel name journal rows are written under
  // (e.g. "cowork"). Defaults to the label, slugified.
  journal_channel?: string;
}

function ensureDirs(): void {
  fs.mkdirSync(WEBHOOK_ENDPOINT_DIR, { recursive: true });
  fs.mkdirSync(STREAM_EVENT_DIR, { recursive: true });
}

function recordPath(token: string): string {
  // Token is hex-only (32 chars) — safe to interpolate.
  return path.join(WEBHOOK_ENDPOINT_DIR, `${token}.md`);
}

function isValidToken(t: string): boolean {
  return /^[0-9a-f]{8,64}$/i.test(t);
}

// Minimal YAML frontmatter for the very small + flat shapes we use. Keeps
// the import graph here free of js-yaml; the structure is constrained enough
// that a hand-rolled emitter is the smaller surface than threading the shared
// helper through.
function emitFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null) {
      lines.push(`${k}: null`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`${k}: ${v}`);
    } else {
      // Quote strings so colons / dashes in labels are unambiguous.
      const s = String(v).replace(/"/g, '\\"');
      lines.push(`${k}: "${s}"`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = content.slice(4, end);
  const out: Record<string, unknown> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val: string = line.slice(idx + 1).trim();
    if (!key) continue;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val === "null" || val === "~") { out[key] = null; continue; }
    if (val === "") { out[key] = ""; continue; }
    if (val === "true") { out[key] = true; continue; }
    if (val === "false") { out[key] = false; continue; }
    if (/^-?\d+$/.test(val)) { out[key] = parseInt(val, 10); continue; }
    if (/^-?\d+\.\d+$/.test(val)) { out[key] = parseFloat(val); continue; }
    out[key] = val;
  }
  return out;
}

function readWebhookRecord(token: string): WebhookFrontmatter | null {
  let raw: string;
  try {
    raw = fs.readFileSync(recordPath(token), "utf-8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(raw);
  return {
    type: "webhook_endpoint",
    token: String(fm.token ?? token),
    label: String(fm.label ?? "Custom Webhook"),
    created_at: String(fm.created_at ?? ""),
    event_count: typeof fm.event_count === "number" ? fm.event_count : 0,
    destination: fm.destination === "journal" ? "journal" : "stream",
    journal_channel: typeof fm.journal_channel === "string" ? fm.journal_channel : undefined,
    last_event_at: fm.last_event_at == null
      ? null
      : String(fm.last_event_at),
  };
}

function writeWebhookRecord(fm: WebhookFrontmatter): void {
  const body = emitFrontmatter({
    type: fm.type,
    token: fm.token,
    label: fm.label,
    created_at: fm.created_at,
    event_count: fm.event_count,
    last_event_at: fm.last_event_at,
    ...(fm.destination ? { destination: fm.destination } : {}),
    ...(fm.journal_channel ? { journal_channel: fm.journal_channel } : {}),
  });
  fs.writeFileSync(recordPath(fm.token), body, "utf-8");
}

// Best-effort counter bump, shared by both destinations. Never throws: a
// bookkeeping failure must not fail an accepted delivery.
function bumpWebhookCounters(fm: WebhookFrontmatter, iso: string): void {
  try {
    writeWebhookRecord({
      ...fm,
      event_count: (fm.event_count || 0) + 1,
      last_event_at: iso,
    });
  } catch { /* ignore */ }
}

// Sanitise a token-ish identifier (filename-safe component) — used so that
// stream_event filenames stay tidy and don't leak path separators.
function safeIdent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}

export function registerInboundWebhookRoutes(): void {
  // ---------------------------------------------------------------------------
  // POST /api/v1/webhooks/inbound — create
  // ---------------------------------------------------------------------------
  addRoute("POST", "/api/v1/webhooks/inbound", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.label !== "string" || !b.label.trim()) {
      throw new ValidationError("label (non-empty string) is required");
    }
    const label = b.label.trim().slice(0, 120);

    const destRaw = typeof b.destination === "string" ? b.destination.trim() : "stream";
    if (destRaw !== "stream" && destRaw !== "journal") {
      throw new ValidationError(`destination must be "stream" or "journal" (got ${JSON.stringify(destRaw)})`);
    }
    const destination = destRaw as WebhookDestination;
    const journalChannel =
      destination === "journal"
        ? (typeof b.journal_channel === "string" && b.journal_channel.trim()
            ? b.journal_channel.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40)
            : safeIdent(label).toLowerCase())
        : undefined;

    ensureDirs();
    const token = crypto.randomBytes(16).toString("hex");
    const createdAt = new Date().toISOString();
    writeWebhookRecord({
      type: "webhook_endpoint",
      token,
      label,
      created_at: createdAt,
      event_count: 0,
      last_event_at: null,
      destination,
      journal_channel: journalChannel,
    });
    sendJson(res, 201, {
      id: `webhook:${token}`,
      token,
      label,
      destination,
      journal_channel: journalChannel ?? null,
      url: composeInboundWebhookUrl(token),
      created_at: createdAt,
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/webhooks/inbound — list
  // ---------------------------------------------------------------------------
  addRoute("GET", "/api/v1/webhooks/inbound", async ({ res }) => {
    ensureDirs();
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(WEBHOOK_ENDPOINT_DIR).filter((f) => f.endsWith(".md"));
    } catch { /* empty */ }
    const webhooks: any[] = [];
    for (const entry of entries) {
      const token = entry.replace(/\.md$/, "");
      const fm = readWebhookRecord(token);
      if (!fm) continue;
      webhooks.push({
        id: `webhook:${fm.token}`,
        token: fm.token,
        label: fm.label,
        url: composeInboundWebhookUrl(fm.token),
        created_at: fm.created_at,
        event_count: fm.event_count,
        last_event_at: fm.last_event_at,
      });
    }
    sendJson(res, 200, { webhooks });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/v1/webhooks/inbound/:id  — id = bare token or "webhook:<token>"
  // ---------------------------------------------------------------------------
  addRoute("DELETE", "/api/v1/webhooks/inbound/:id", async ({ res, params }) => {
    const raw = params.id || "";
    const token = raw.startsWith("webhook:") ? raw.slice("webhook:".length) : raw;
    if (!isValidToken(token)) throw new ValidationError("invalid webhook id");
    const file = recordPath(token);
    if (!fs.existsSync(file)) throw new NotFoundError("webhook not found");
    fs.unlinkSync(file);
    res.statusCode = 204;
    res.end();
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/webhooks/in/:token — PUBLIC ingest
  //
  // Token-authenticated by the existence of the matching webhook_endpoint
  // vault record. No additional auth header expected — the token IS the
  // authenticator.
  //
  // Write order (#465):
  //  1. ingest.db INSERT — PRIMARY, blocking. A failure here returns a
  //     retryable 5xx so the sender knows to retry. The UNIQUE(stream,
  //     external_id) constraint makes re-delivery idempotent.
  //  2. vault stream_event markdown — SECONDARY, best-effort. A failure
  //     here is logged but does NOT abort the request; ingest.db is the
  //     canonical source the pipeline consumes.
  //  3. webhook_endpoint counter bump — TERTIARY, best-effort.
  // ---------------------------------------------------------------------------
  addRoute("POST", "/api/v1/webhooks/in/:token", async ({ req, res, body, params }) => {
    const token = params.token || "";
    if (!isValidToken(token)) throw new NotFoundError("webhook not found");
    const fm = readWebhookRecord(token);
    if (!fm) throw new NotFoundError("webhook not found");

    ensureDirs();
    const now = new Date();
    const iso = now.toISOString();
    const ts = iso.replace(/[:.]/g, "-");
    const shortUuid = crypto.randomBytes(4).toString("hex");

    // ── destination: journal ─────────────────────────────────────────────
    // Continuity path (Cowork/desktop/scripts). Writes straight to
    // alfred_journal; nothing enters the signal pipeline, because a
    // conversation the principal already had is not a new inbound signal to
    // triage — it is history Alfred should simply remember.
    if ((fm.destination ?? "stream") === "journal") {
      const jb = (body ?? {}) as Record<string, unknown>;

      const direction = String(jb.direction ?? "").trim();
      if (direction !== "inbound" && direction !== "outbound") {
        throw new ValidationError(
          `direction must be "inbound" or "outbound" (got ${JSON.stringify(jb.direction)})`,
        );
      }
      const message = typeof jb.message === "string" ? jb.message : "";
      if (!message.trim()) throw new ValidationError("message (non-empty string) is required");

      // chat_id keys continuity. A caller that omits it collapses every
      // exchange into one thread, which is worse than useless, so require it.
      const chatId = typeof jb.chat_id === "string" && jb.chat_id.trim()
        ? jb.chat_id.trim().slice(0, 200)
        : "";
      if (!chatId) throw new ValidationError("chat_id (non-empty string) is required");

      const channel = fm.journal_channel || safeIdent(fm.label).toLowerCase();

      let entry;
      try {
        entry = appendJournal(getStateDb(), {
          channel,
          chat_id: chatId,
          direction: direction as "inbound" | "outbound",
          message: message.slice(0, 20000),
          source_kind: channel,
          source_ref: typeof jb.source_ref === "string" ? jb.source_ref.slice(0, 200) : null,
          hermes_session_id: null,
          hermes_profile: null,
          status: direction === "inbound" ? "received" : "delivered",
          delivery_error: null,
          metadata:
            jb.metadata && typeof jb.metadata === "object"
              ? (jb.metadata as Record<string, unknown>)
              : null,
          principal_id: typeof jb.principal_id === "string" ? jb.principal_id : null,
          // Journalled history is a record of something that already happened,
          // never a prompt Alfred should answer.
          solicited: 0,
        });
      } catch (e) {
        // Fail loudly to the caller (it retries) but never leave the webhook
        // counter half-updated.
        throw e;
      }

      bumpWebhookCounters(fm, iso);
      sendJson(res, 201, {
        ok: true,
        destination: "journal",
        channel,
        chat_id: chatId,
        journal_id: (entry as any)?.id ?? null,
      });
      return;
    }


    // Pretty-print the inbound payload as text so the curator (which scans
    // markdown bodies) sees the structured content; opaque JSON in
    // frontmatter would defeat the point.
    let payloadText: string;
    try {
      payloadText = JSON.stringify(body ?? {}, null, 2);
    } catch {
      payloadText = String(body ?? "");
    }

    const sourceType = `webhook:${fm.label}`;
    const sourceRef = `${token}:${shortUuid}`;

    // ── 1. BLOCKING: ingest.db insert (Store 4) ──────────────────────────
    // Compute a stable per-delivery idempotency key: prefer a sender-supplied
    // delivery header, fall back to a SHA-256 of token+payload so re-sends of
    // the same body dedup correctly (UNIQUE(stream, external_id) constraint).
    const deliveryHeader =
      String(req.headers["x-webhook-delivery"] ?? req.headers["x-delivery-id"] ?? "").trim() || null;
    const externalId: string = deliveryHeader
      ? `${token}:${deliveryHeader}`
      : `${token}:${crypto.createHash("sha256").update(`${token}:${payloadText}`).digest("hex").slice(0, 32)}`;

    const payloadJson = JSON.stringify({
      source_type: sourceType,
      source_ref: sourceRef,
      received_at: iso,
      payload: body ?? null,
    });

    try {
      getIngestDb()
        .prepare(
          `INSERT INTO stream_event
             (id, ts, stream, channel, external_id, kind, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), iso, "webhook", sourceType, externalId, "webhook", payloadJson);
    } catch (err) {
      // UNIQUE(stream, external_id) → re-delivery of the same event; already
      // enqueued — treat as idempotent success and return 202 normally.
      if (String(err).includes("UNIQUE")) {
        sendJson(res, 202, { status: "accepted", idempotent: true });
        return;
      }
      // Any other failure means the event never landed in ingest.db — the
      // only path the signal pipeline consumes. Surface as 5xx so the sender
      // retries rather than treating the event as successfully delivered.
      console.error(
        `[webhooks] ingest.db insert failed for ${token}/${externalId}: ${String(err).slice(0, 200)}`,
      );
      throw err;
    }

    // ── 2. BEST-EFFORT: vault markdown copy (legacy audit trail) ─────────
    // Kept for operator visibility and as a compatibility shim. A failure here
    // MUST NOT fail the request — ingest.db is now authoritative.
    try {
      const eventFm = emitFrontmatter({
        type: "stream_event",
        source_type: sourceType,
        received_at: iso,
        source_ref: sourceRef,
        processed: false,
      });
      const eventBody =
        eventFm +
        `\n# Inbound webhook payload\n\n` +
        `Label: ${fm.label}\n` +
        `Received: ${iso}\n\n` +
        "```json\n" +
        payloadText +
        "\n```\n";
      const eventFilename = `webhook-${safeIdent(token).slice(0, 12)}-${ts}-${shortUuid}.md`;
      const eventPath = path.join(STREAM_EVENT_DIR, eventFilename);
      fs.writeFileSync(eventPath, eventBody, "utf-8");
    } catch (err) {
      console.error(`[webhooks] vault markdown write failed (non-fatal): ${String(err).slice(0, 200)}`);
    }

    // ── 3. BEST-EFFORT: webhook_endpoint counter bump ────────────────────
    bumpWebhookCounters(fm, iso);

    sendJson(res, 202, { status: "accepted" });
  });
}
