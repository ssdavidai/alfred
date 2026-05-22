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
 *
 * The ingest path is registered in server.ts's `isPublic` whitelist; the
 * other three CRUD routes go through the normal AAS_API_KEY auth path.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";

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

interface WebhookFrontmatter {
  type: "webhook_endpoint";
  token: string;
  label: string;
  created_at: string;
  event_count: number;
  last_event_at: string | null;
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
  });
  fs.writeFileSync(recordPath(fm.token), body, "utf-8");
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
    });
    sendJson(res, 201, {
      id: `webhook:${token}`,
      token,
      label,
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
  // ---------------------------------------------------------------------------
  addRoute("POST", "/api/v1/webhooks/in/:token", async ({ res, body, params }) => {
    const token = params.token || "";
    if (!isValidToken(token)) throw new NotFoundError("webhook not found");
    const fm = readWebhookRecord(token);
    if (!fm) throw new NotFoundError("webhook not found");

    ensureDirs();
    const now = new Date();
    const iso = now.toISOString();
    const ts = iso.replace(/[:.]/g, "-");
    const shortUuid = crypto.randomBytes(4).toString("hex");

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

    // Bump counters on the webhook_endpoint record. Best-effort — a failure
    // here MUST NOT lose the stream_event we just wrote, so we swallow.
    try {
      writeWebhookRecord({
        ...fm,
        event_count: (fm.event_count || 0) + 1,
        last_event_at: iso,
      });
    } catch { /* ignore */ }

    sendJson(res, 202, { status: "accepted" });
  });
}
