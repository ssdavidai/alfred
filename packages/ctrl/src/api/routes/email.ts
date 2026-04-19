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

import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";

const AGENTMAIL_API = "https://api.agentmail.to/v0";
const FALLBACK_FILE = "/mnt/encrypted/alfred/.agentmail-credentials.json";

interface AgentMailCreds {
  inbox_id: string;
  inbox_address: string;
  api_key: string;
}

function getCreds(): AgentMailCreds {
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
  throw new ValidationError(
    "AgentMail is not configured on this tenant. Set AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID in /opt/alfred/compose/.env.",
  );
}

async function am(
  creds: AgentMailCreds,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${creds.api_key}`,
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
  // Quick health check — confirms tenant has AgentMail wired up.
  addRoute("GET", "/api/v1/email/status", async ({ res }) => {
    try {
      const creds = getCreds();
      sendJson(res, 200, {
        configured: true,
        inbox_id: creds.inbox_id,
        inbox_address: creds.inbox_address,
      });
    } catch {
      sendJson(res, 200, { configured: false });
    }
  });

  // Send a new message (new thread).
  // Body: { to, subject, text, html?, cc?, bcc?, reply_to?, labels?, attachments? }
  // attachments: Array<{content: base64, filename?, content_type?}>
  addRoute("POST", "/api/v1/email/send", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const to = stringArray(b.to);
    if (!to || to.length === 0) throw new ValidationError("`to` is required");
    if (typeof b.subject !== "string" || !b.subject)
      throw new ValidationError("`subject` is required");
    if (typeof b.text !== "string" || !b.text)
      throw new ValidationError("`text` is required");

    const creds = getCreds();
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
  addRoute("POST", "/api/v1/email/reply", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.message_id !== "string" || !b.message_id)
      throw new ValidationError("`message_id` is required");
    if (typeof b.text !== "string" || !b.text)
      throw new ValidationError("`text` is required");

    const creds = getCreds();
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
  addRoute("POST", "/api/v1/email/forward", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.message_id !== "string" || !b.message_id)
      throw new ValidationError("`message_id` is required");
    const to = stringArray(b.to);
    if (!to || to.length === 0) throw new ValidationError("`to` is required");

    const creds = getCreds();
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
  addRoute("GET", "/api/v1/email/message/:message_id", async ({ res, params }) => {
    const messageId = decodeURIComponent(params["message_id"] ?? "");
    if (!messageId) throw new ValidationError("message_id required");
    const creds = getCreds();
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
  addRoute("GET", "/api/v1/email/thread/:thread_id", async ({ res, params }) => {
    const threadId = decodeURIComponent(params["thread_id"] ?? "");
    if (!threadId) throw new ValidationError("thread_id required");
    const creds = getCreds();
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
  addRoute(
    "GET",
    "/api/v1/email/attachment/:message_id/:attachment_id",
    async ({ req, res, params }) => {
      void req;
      const creds = getCreds();
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
