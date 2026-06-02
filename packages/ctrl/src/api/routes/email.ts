// Outbound email — proxies the tenant's inbox-scoped AgentMail API key.
//
// Exposed at /api/v1/email/* and reachable by the main agent via the MCP
// `self` tool (see packages/openclaw/workspace-template/docs/TOOLS.md).
//
// Tenant credentials come from AGENTMAIL_API_KEY + AGENTMAIL_INBOX_ID in
// the container env, with a JSON fallback at
// /mnt/encrypted/alfred/.agentmail-credentials.json (mirrors the Composio
// dual-source pattern from #428).

import fs from "node:fs";
import path from "node:path";

import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { resolveProfileEnvPath } from "../../db/agentProfiles.js";

const AGENTMAIL_API = "https://api.agentmail.to/v0";
const FALLBACK_FILE =
  path.join(process.env.ALFRED_DATA_DIR ?? "/alfred-data", ".agentmail-credentials.json");

// Inbound mail: AgentMail → SaaS receiver (/webhooks/agentmail, see
// agentmailReceiver.ts) → this tenant's /api/v1/channels/email/inbound.
// SAAS_HOST mirrors the streams.ts convention for SaaS-routed webhooks.
const SAAS_HOST = (process.env.SAAS_HOST ?? "https://alfred.black").replace(/\/$/, "");
const AGENTMAIL_WEBHOOK_URL = `${SAAS_HOST}/webhooks/agentmail`;

interface AgentMailCreds {
  inbox_id: string;
  inbox_address: string;
  api_key: string;
}

// Persist the inbox-scoped credential to the JSON fallback getCreds() reads.
// This is the same credential-store path the env-driven config falls back to,
// so a provision makes the inbox usable without an .env edit + restart, and a
// re-provision overwrites cleanly (idempotent / self-refreshing).
function writeCreds(creds: AgentMailCreds): void {
  fs.mkdirSync(path.dirname(FALLBACK_FILE), { recursive: true });
  fs.writeFileSync(FALLBACK_FILE, JSON.stringify(creds, null, 2), "utf-8");
}

// Make sure inbound mail for this inbox reaches the SaaS receiver. Returns
// true if a webhook to AGENTMAIL_WEBHOOK_URL exists (already present or newly
// created), false otherwise. Never throws — provisioning succeeds regardless,
// since the shared-pod webhook configured at SaaS bootstrap is the primary
// delivery path; this is a per-inbox belt-and-braces.
async function ensureInboundWebhook(creds: AgentMailCreds): Promise<boolean> {
  try {
    const existing = await amWithKey(creds.api_key, "GET", "/webhooks");
    if (existing.status >= 200 && existing.status < 300) {
      const hooks = Array.isArray(existing.body?.webhooks)
        ? existing.body.webhooks
        : [];
      const match = hooks.some((h: any) => h?.url === AGENTMAIL_WEBHOOK_URL);
      if (match) return true;
    }
    const created = await amWithKey(creds.api_key, "POST", "/webhooks", {
      url: AGENTMAIL_WEBHOOK_URL,
      event_types: ["message.received"],
      inbox_ids: [creds.inbox_id],
    });
    return created.status >= 200 && created.status < 300;
  } catch {
    return false;
  }
}

// Read per-profile AgentMail creds from /hermes-state/profiles/<slug>/.env.
// Returns null when the .env is missing or has no AGENTMAIL_INBOX_ID. Used
// by getCreds() when a `?profile=<slug>` query is present on the outbound
// routes — Lane Vb2 per-profile email.
function readProfileCreds(slug: string): AgentMailCreds | null {
  let envPath: string;
  try {
    envPath = resolveProfileEnvPath(slug);
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf-8");
  } catch {
    return null;
  }
  const map: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.replace(/^﻿/, "").trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    map[k] = v;
  }
  const apiKey = (map.AGENTMAIL_API_KEY || "").trim();
  const inboxId = (map.AGENTMAIL_INBOX_ID || "").trim();
  const address = (map.AGENTMAIL_INBOX_ADDRESS || "").trim();
  if (!apiKey || !inboxId) return null;
  return { api_key: apiKey, inbox_id: inboxId, inbox_address: address };
}

function getCreds(profileSlug?: string | null): AgentMailCreds {
  // Lane Vb2: when an explicit profile is supplied, read its per-profile
  // .env first. Fall back to the legacy env/file path so existing callers
  // (the alfred-email-channel skill, the SaaS provision route) still work.
  if (profileSlug && profileSlug.trim()) {
    const slug = profileSlug.trim();
    const perProfile = readProfileCreds(slug);
    if (perProfile) return perProfile;
    // Explicit profile but no per-profile inbox → don't silently fall back
    // to main's creds (that would send Sentinel's reply with main's "from").
    if (slug !== "main") {
      throw new ValidationError(
        `profile '${slug}' has no AgentMail inbox provisioned — call POST /api/v1/channels/email/provision?profile=${slug} first`,
      );
    }
  }
  const envKey = (process.env.AGENTMAIL_API_KEY || "").trim();
  const envInboxId = (process.env.AGENTMAIL_INBOX_ID || "").trim();
  const envAddress = (process.env.AGENTMAIL_INBOX_ADDRESS || "").trim();
  if (envKey && envInboxId) {
    return { api_key: envKey, inbox_id: envInboxId, inbox_address: envAddress };
  }
  try {
    if (fs.existsSync(FALLBACK_FILE)) {
      const raw = fs.readFileSync(FALLBACK_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.api_key && parsed?.inbox_id) {
        return {
          api_key: parsed.api_key,
          inbox_id: parsed.inbox_id,
          inbox_address: parsed.inbox_address || "",
        };
      }
    }
  } catch {
    /* fallthrough */
  }
  // Main profile may have its inbox in /hermes-state/profiles/main/.env too
  // (Lane Vb2 provisioning persists there). Try as a last resort.
  if (!profileSlug || profileSlug === "main") {
    const mainProfile = readProfileCreds("main");
    if (mainProfile) return mainProfile;
  }
  throw new ValidationError(
    "AgentMail is not configured on this tenant. Set AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID in /opt/alfred/compose/.env, or call POST /api/v1/channels/email/provision?profile=<slug>.",
  );
}

async function amWithKey(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${AGENTMAIL_API}${path}`, init);
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

function am(
  creds: AgentMailCreds,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return amWithKey(creds.api_key, method, path, body);
}

function assertOk(
  res: { status: number; body: any },
  message: string,
): void {
  if (res.status < 200 || res.status >= 300) {
    throw new ValidationError(
      `${message} (status=${res.status}): ${JSON.stringify(res.body)}`,
    );
  }
}

function stringArray(v: unknown): string[] | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new ValidationError("expected string or array of strings");
}

export function registerEmailRoutes(): void {
  // Health check. Contract C14: { configured, inbox_address: string|null }.
  // The web card branches on `configured`; inbox_address is always present
  // (null when unconfigured) so the consumer never reads undefined.
  addRoute("GET", "/api/v1/email/status", async ({ res }) => {
    try {
      const creds = getCreds();
      sendJson(res, 200, { configured: true, inbox_id: creds.inbox_id, inbox_address: creds.inbox_address || null });
    } catch {
      sendJson(res, 200, { configured: false, inbox_address: null });
    }
  });

  // Provision/re-provision the AgentMail inbox from a bare API key. Contract
  // C14: POST {api_key} → 200 {configured, inbox_address, inbox_id,
  // webhook_registered} / 4xx {error, code}. Validate the key by listing
  // inboxes, persist the credential to the fallback getCreds() reads (so
  // send/reply work with no .env edit), ensure the inbound webhook. Idempotent
  // — a second call overwrites the creds and re-uses the webhook.
  addRoute("POST", "/api/v1/email/provision", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const apiKey = typeof b.api_key === "string" ? b.api_key.trim() : "";
    if (!apiKey) return sendJson(res, 400, { error: "`api_key` is required", code: "missing_api_key" });

    let listed: { status: number; body: any };
    try {
      listed = await amWithKey(apiKey, "GET", "/inboxes");
    } catch (err: any) {
      return sendJson(res, 502, { error: `AgentMail unreachable: ${err?.message ?? String(err)}`, code: "agentmail_unreachable" });
    }
    if (listed.status === 401 || listed.status === 403) {
      return sendJson(res, 400, { error: "AgentMail rejected the API key (unauthorized).", code: "invalid_api_key" });
    }
    if (listed.status < 200 || listed.status >= 300) {
      return sendJson(res, 400, { error: `AgentMail inbox lookup failed (status=${listed.status})`, code: "inbox_lookup_failed" });
    }

    const inbox = (Array.isArray(listed.body?.inboxes) ? listed.body.inboxes : [])[0];
    if (!inbox?.inbox_id || !inbox?.email) {
      return sendJson(res, 400, { error: "This AgentMail key has no inbox. Mint an inbox-scoped key and try again.", code: "no_inbox" });
    }

    const creds: AgentMailCreds = { api_key: apiKey, inbox_id: inbox.inbox_id, inbox_address: inbox.email };
    try {
      writeCreds(creds);
    } catch (err: any) {
      return sendJson(res, 500, { error: `failed to persist credentials: ${err?.message ?? String(err)}`, code: "persist_failed" });
    }

    // Best-effort — provisioning still succeeds if the key can't manage
    // webhooks (the shared-pod webhook from SaaS bootstrap also delivers).
    const webhook_registered = await ensureInboundWebhook(creds);
    sendJson(res, 200, { configured: true, inbox_address: creds.inbox_address, inbox_id: creds.inbox_id, webhook_registered });
  });

  // Send a new message (new thread).
  // Body: { to, subject, text, html?, cc?, bcc?, reply_to?, labels?, attachments? }
  // attachments: Array<{content: base64, filename?, content_type?}>
  // Query: ?profile=<slug> — Lane Vb2; sends with the profile's inbox creds.
  addRoute("POST", "/api/v1/email/send", async ({ res, body, query }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const to = stringArray(b.to);
    if (!to || to.length === 0) throw new ValidationError("`to` is required");
    if (typeof b.subject !== "string" || !b.subject)
      throw new ValidationError("`subject` is required");
    if (typeof b.text !== "string" || !b.text)
      throw new ValidationError("`text` is required");

    const creds = getCreds(query.get("profile"));
    const payload: Record<string, unknown> = { to, subject: b.subject, text: b.text };
    if (typeof b.html === "string") payload.html = b.html;
    const cc = stringArray(b.cc);
    if (cc) payload.cc = cc;
    const bcc = stringArray(b.bcc);
    if (bcc) payload.bcc = bcc;
    if (typeof b.reply_to === "string") payload.reply_to = b.reply_to;
    const labels = stringArray(b.labels);
    if (labels) payload.labels = labels;
    if (Array.isArray(b.attachments)) payload.attachments = b.attachments;

    const r = await am(creds, "POST", `/inboxes/${creds.inbox_id}/messages/send`, payload);
    assertOk(r, "send failed");
    sendJson(res, 200, r.body);
  });

  // Reply to a message (same thread).
  // Body: { message_id, text, html?, reply_all?: boolean, attachments? }
  // Query: ?profile=<slug> — Lane Vb2.
  addRoute("POST", "/api/v1/email/reply", async ({ res, body, query }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.message_id !== "string" || !b.message_id)
      throw new ValidationError("`message_id` is required");
    if (typeof b.text !== "string" || !b.text)
      throw new ValidationError("`text` is required");

    const creds = getCreds(query.get("profile"));
    const payload: Record<string, unknown> = { text: b.text };
    if (typeof b.html === "string") payload.html = b.html;
    if (Array.isArray(b.attachments)) payload.attachments = b.attachments;

    // AgentMail has separate endpoints for reply vs reply-all.
    const endpoint = b.reply_all === true ? "reply-all" : "reply";
    const path = `/inboxes/${creds.inbox_id}/messages/${encodeURIComponent(b.message_id)}/${endpoint}`;
    const r = await am(creds, "POST", path, payload);
    assertOk(r, `${endpoint} failed`);
    sendJson(res, 200, r.body);
  });

  // Forward a message.
  // Body: { message_id, to, subject?, text?, html?, attachments? }
  // Query: ?profile=<slug> — Lane Vb2.
  addRoute("POST", "/api/v1/email/forward", async ({ res, body, query }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.message_id !== "string" || !b.message_id)
      throw new ValidationError("`message_id` is required");
    const to = stringArray(b.to);
    if (!to || to.length === 0) throw new ValidationError("`to` is required");

    const creds = getCreds(query.get("profile"));
    const payload: Record<string, unknown> = { to };
    if (typeof b.subject === "string") payload.subject = b.subject;
    if (typeof b.text === "string") payload.text = b.text;
    if (typeof b.html === "string") payload.html = b.html;
    if (Array.isArray(b.attachments)) payload.attachments = b.attachments;

    const r = await am(
      creds,
      "POST",
      `/inboxes/${creds.inbox_id}/messages/${encodeURIComponent(b.message_id)}/forward`,
      payload,
    );
    assertOk(r, "forward failed");
    sendJson(res, 200, r.body);
  });

  // Fetch a single message — used by the channel handler to pull full
  // body when the webhook payload was >1MB and text/html were stripped.
  // Query: ?profile=<slug> — Lane Vb2.
  addRoute("GET", "/api/v1/email/message/:message_id", async ({ res, params, query }) => {
    const messageId = decodeURIComponent(params["message_id"] ?? "");
    if (!messageId) throw new ValidationError("message_id required");
    const creds = getCreds(query.get("profile"));
    const r = await am(
      creds,
      "GET",
      `/inboxes/${creds.inbox_id}/messages/${encodeURIComponent(messageId)}`,
    );
    if (r.status === 404) throw new NotFoundError(`message ${messageId} not found`);
    assertOk(r, "message fetch failed");
    sendJson(res, 200, r.body);
  });

  // Fetch a full thread — Alfred uses this to assemble context before
  // composing replies.
  // Query: ?profile=<slug> — Lane Vb2.
  addRoute("GET", "/api/v1/email/thread/:thread_id", async ({ res, params, query }) => {
    const threadId = decodeURIComponent(params["thread_id"] ?? "");
    if (!threadId) throw new ValidationError("thread_id required");
    const creds = getCreds(query.get("profile"));
    const r = await am(
      creds,
      "GET",
      `/inboxes/${creds.inbox_id}/threads/${encodeURIComponent(threadId)}`,
    );
    if (r.status === 404) throw new NotFoundError(`thread ${threadId} not found`);
    assertOk(r, "thread fetch failed");
    sendJson(res, 200, r.body);
  });

  // Download an attachment by id.
  // Query: ?profile=<slug> — Lane Vb2.
  addRoute(
    "GET",
    "/api/v1/email/attachment/:message_id/:attachment_id",
    async ({ req, res, params, query }) => {
      void req;
      const creds = getCreds(query.get("profile"));
      const messageId = decodeURIComponent(params["message_id"] ?? "");
      const attachmentId = decodeURIComponent(params["attachment_id"] ?? "");
      if (!messageId || !attachmentId)
        throw new ValidationError("message_id and attachment_id required");
      const r = await am(
        creds,
        "GET",
        `/inboxes/${creds.inbox_id}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      );
      if (r.status === 404) throw new NotFoundError("attachment not found");
      assertOk(r, "attachment fetch failed");
      sendJson(res, 200, r.body);
    },
  );
}
