// Email channel inbound handler.
//
// alfred-black ingress shape (post-SaaS-retirement):
//
//   AgentMail (their cloud, alfred@agent.szabostuban.com)
//      |  POST https://home.alfred.black/api/v1/channels/email/inbound?token=<SECRET>
//      v
//   Caddy apex (@public_webhooks matcher)
//      |  reverse_proxy ctrl-api:3100
//      v
//   ctrl-api  ← this handler
//      |  POST /v1/runs (Hermes main profile)
//      v
//   Hermes  → alfred-email-channel skill → reply via /api/v1/email/reply
//
// Auth: AgentMail does not sign its webhooks (no header documented), so we
// gate on a shared-secret `?token=` baked into the URL configured in the
// AgentMail console. The path itself is marked public in server.ts so the
// master AAS_API_KEY isn't required.
//
// Filters (matched against Hermes' native email adapter behaviour):
//   - drop emails from noreply@ / mailer-daemon@ / no-reply@ / bounce@
//   - drop Auto-Submitted (RFC 3834), Precedence: bulk|list|junk,
//     List-Unsubscribe — RFC-flagged automated mail
//   - drop self-loops (from == AGENTMAIL_INBOX_ADDRESS)
//
// Fire-and-forget: we respond 202 immediately and let the run proceed in
// the background. Failures to start are logged.
//
// Phase 2: calls Hermes `POST /v1/runs` natively against the Hermes API
// server's canonical port (the hermes-shim was retired in issue #40). The
// OpenClaw `sessions_spawn` `/tools/invoke` contract is retired.

import fs from "node:fs";

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import {
  resolveProfileContextForChannel,
  type ProfileChannelContext,
} from "../../db/agentProfiles.js";

const HERMES_GATEWAY_URL =
  process.env.HERMES_GATEWAY_URL ||
  process.env.OPENCLAW_GATEWAY_URL ||
  "http://hermes:18789";
const HERMES_HOST =
  (() => {
    try {
      return new URL(HERMES_GATEWAY_URL).hostname;
    } catch {
      return "hermes";
    }
  })();
const HERMES_PROTOCOL =
  (() => {
    try {
      return new URL(HERMES_GATEWAY_URL).protocol;
    } catch {
      return "http:";
    }
  })();
const GATEWAY_TOKEN_FILE =
  process.env.OPENCLAW_GATEWAY_TOKEN_FILE || "/alfred-data/.gateway-token";

/**
 * Resolve the Hermes token for a target profile. Precedence:
 *   1. The profile's API_SERVER_KEY read from /hermes-state/profiles/<slug>/.env
 *      (Lane IV — the only place Hermes' /v1 actually validates).
 *   2. HERMES_API_KEY / OPENCLAW_GATEWAY_TOKEN env (legacy main-only fallback).
 *   3. The gateway-token file (back-compat with openclaw-era deployments).
 */
function gatewayTokenFor(ctx: ProfileChannelContext): string {
  if (ctx.api_server_key) return ctx.api_server_key;
  const envToken = (
    process.env.HERMES_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN || ""
  ).trim();
  if (envToken) return envToken;
  try {
    return fs.readFileSync(GATEWAY_TOKEN_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

function hermesBaseUrlFor(ctx: ProfileChannelContext): string {
  return `${HERMES_PROTOCOL}//${HERMES_HOST}:${ctx.api_server_port}`;
}

/**
 * Resolve the target profile for an inbound email. The channel identity is
 * the principal-facing recipient address (the first entry in the AgentMail
 * `to` array — that's the inbox the email was actually delivered to). If
 * `to` is empty, falls back to the default email binding.
 */
function resolveEmailContext(message: any): ProfileChannelContext {
  const to = Array.isArray(message?.to) ? message.to : [];
  const identity =
    (typeof to[0] === "string" && to[0].trim().toLowerCase()) || null;
  return resolveProfileContextForChannel(getStateDb(), "email", identity);
}

function buildChannelPrompt(message: any): string {
  const from = Array.isArray(message?.from_) ? message.from_[0] : "";
  const to = Array.isArray(message?.to) ? message.to : [];
  const cc = Array.isArray(message?.cc) ? message.cc : [];
  const subject = typeof message?.subject === "string" ? message.subject : "";
  const bodyText =
    (typeof message?.text === "string" && message.text) ||
    (typeof message?.preview === "string" && message.preview) ||
    "";
  const threadId = message?.thread_id ?? "";
  const messageId = message?.message_id ?? "";
  const hasAttachments = Array.isArray(message?.attachments) && message.attachments.length > 0;

  // The prompt is intentionally light — the heavy reasoning lives in the
  // `alfred-email-channel` skill, which the agent auto-loads from workspace.
  return [
    "You are handling a NEW inbound email on the email channel.",
    "The sender is on the authorized-senders list, so treat this as a",
    "conversational channel event (like a Slack DM), not a stream event.",
    "",
    "Follow the `alfred-email-channel/SKILL.md` in your workspace for the",
    "decision policy (reply vs reply-all vs forward vs execute vs no-action).",
    "",
    "### Envelope",
    `From:       ${from}`,
    `To:         ${to.join(", ")}`,
    `Cc:         ${cc.join(", ")}`,
    `Subject:    ${subject}`,
    `Thread:     ${threadId}`,
    `Message-Id: ${messageId}`,
    hasAttachments
      ? `Attachments: ${message.attachments.length} file(s) — fetch via self({endpoint: "/api/v1/email/attachment/${messageId}/<aid>"})`
      : "Attachments: none",
    "",
    "### Body (full, including quoted history)",
    "```",
    bodyText,
    "```",
    "",
    "### What to do",
    "1. Read the body including quoted history — the full thread is",
    `   available via self({endpoint: "/api/v1/email/thread/${threadId}"}).`,
    "2. Search the vault for related matters/people before composing any",
    "   reply: self({endpoint: \"/api/v1/vault/search\", query: {q: \"...\"}}).",
    "3. Decide action per the skill. If you reply, use",
    `   self({endpoint: "/api/v1/email/reply", method: "POST", body: {`,
    `     message_id: "${messageId}", text: "...", reply_all: false|true`,
    "   }}).",
    "4. Do NOT send follow-up emails unless the user asked for them.",
    "",
    "When finished, emit a single final message summarizing what you did",
    "(one paragraph). Do not quote this prompt back in your final message.",
  ].join("\n");
}

// Match RFC 2822 local-parts (case-insensitive) that indicate an automated
// sender — Hermes' native email adapter drops these silently. The address
// is parsed by `extractLocalPart`, so we match on local-part alone.
const AUTOMATED_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "mailer-daemon",
  "mailerdaemon",
  "postmaster",
  "bounce",
  "bounces",
  "notification",
  "notifications",
]);

function extractLocalPart(addr: string): string {
  // Accept either `user@host` or `Display Name <user@host>` shapes.
  const m = addr.match(/<([^>]+)>/);
  const email = (m ? m[1] : addr).trim().toLowerCase();
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

function isAutomatedSender(from: string): boolean {
  if (!from) return false;
  return AUTOMATED_LOCAL_PARTS.has(extractLocalPart(from));
}

function hasBulkHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers || typeof headers !== "object") return false;
  // Normalize header lookup (RFC headers are case-insensitive).
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") lower[k.toLowerCase()] = v;
  }
  // RFC 3834 Auto-Submitted: anything other than "no" means automated.
  const autoSub = (lower["auto-submitted"] || "").toLowerCase();
  if (autoSub && autoSub !== "no") return true;
  // Precedence: bulk | list | junk
  const prec = (lower["precedence"] || "").toLowerCase();
  if (prec === "bulk" || prec === "list" || prec === "junk") return true;
  // List-Unsubscribe present at all → mailing list
  if (lower["list-unsubscribe"]) return true;
  return false;
}

function isSelfLoop(from: string): boolean {
  const ourAddr = (process.env.AGENTMAIL_INBOX_ADDRESS || "").trim().toLowerCase();
  if (!ourAddr) return false;
  // Compare local-part@host of the from-address against ours.
  const m = from.match(/<([^>]+)>/);
  const fromEmail = (m ? m[1] : from).trim().toLowerCase();
  return fromEmail === ourAddr;
}

export function registerChannelsEmailRoutes(): void {
  addRoute("POST", "/api/v1/channels/email/inbound", async ({ res, body, query }) => {
    // Shared-secret token: AgentMail doesn't sign its webhooks, so the public
    // path is gated by a `?token=` query param we configure in their console.
    // When AGENTMAIL_WEBHOOK_TOKEN is unset, the endpoint reverts to internal-
    // only (refuses every call) — fail closed.
    const expected = (process.env.AGENTMAIL_WEBHOOK_TOKEN || "").trim();
    const provided = (query.get("token") || "").trim();
    if (!expected) {
      console.warn(
        "[channels-email] AGENTMAIL_WEBHOOK_TOKEN unset — rejecting inbound (fail-closed)",
      );
      sendJson(res, 403, { error: { code: "WEBHOOK_TOKEN_NOT_CONFIGURED" } });
      return;
    }
    if (!provided || provided !== expected) {
      console.warn("[channels-email] webhook token mismatch — rejecting");
      sendJson(res, 401, { error: { code: "INVALID_WEBHOOK_TOKEN" } });
      return;
    }

    const b = (body ?? {}) as {
      message?: any;
      event_id?: string;
    };
    if (!b.message || typeof b.message !== "object") {
      throw new ValidationError("`message` required");
    }

    // Resolve from-address (AgentMail emits `from_` as a single-element array).
    const fromAddr: string = Array.isArray(b.message.from_)
      ? String(b.message.from_[0] ?? "")
      : String(b.message.from ?? b.message.from_ ?? "");

    // Filter 1: automated/noreply senders. Silent drop, 202 to keep AgentMail happy.
    if (isAutomatedSender(fromAddr)) {
      console.log(`[channels-email] drop automated sender: ${fromAddr}`);
      sendJson(res, 202, { accepted: false, reason: "automated_sender" });
      return;
    }
    // Filter 2: bulk/list mail via RFC headers.
    if (hasBulkHeader(b.message.headers)) {
      console.log(`[channels-email] drop bulk/list mail from: ${fromAddr}`);
      sendJson(res, 202, { accepted: false, reason: "bulk_or_list" });
      return;
    }
    // Filter 3: self-loop (Alfred's own outbound landing back in the inbox).
    if (isSelfLoop(fromAddr)) {
      console.log(`[channels-email] drop self-loop from: ${fromAddr}`);
      sendJson(res, 202, { accepted: false, reason: "self_loop" });
      return;
    }

    // Lane IV — resolve which profile owns this recipient address.
    const profileCtx = resolveEmailContext(b.message);
    const token = gatewayTokenFor(profileCtx);
    if (!token) {
      throw new ValidationError(
        "Hermes gateway token not available — cannot start run",
      );
    }

    const prompt = buildChannelPrompt(b.message);

    // Fire-and-forget Hermes run on the resolved profile. We intentionally
    // don't await the response — the run takes tens of seconds to minutes and
    // AgentMail has a 5s webhook budget upstream. `session_id` correlates the
    // run to the email thread + profile so cross-profile replies on the same
    // thread don't accidentally collide (a Sentinel-bound recipient and a
    // main-bound recipient on different inboxes get different sessions).
    const sessionId =
      `agent:${profileCtx.slug}:email-${b.message?.thread_id ?? b.message?.message_id ?? b.event_id ?? Date.now()}`;
    const run = fetch(`${hermesBaseUrlFor(profileCtx)}/v1/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: prompt,
        session_id: sessionId,
        instructions:
          "You are the principal-facing Alfred handling an inbound email " +
          "channel event. Follow the alfred-email-channel skill.",
      }),
    }).catch((err) => {
      console.warn(
        "[channels-email] POST /v1/runs failed:",
        err instanceof Error ? err.message : String(err),
      );
    });

    // Don't await — let it run in the background.
    void run;

    sendJson(res, 202, {
      accepted: true,
      message_id: b.message?.message_id ?? null,
      profile: profileCtx.slug,
    });
  });

  // GET /resolve?to=<address> — Lane IV debug surface.
  addRoute(
    "GET",
    "/api/v1/channels/email/resolve",
    async ({ res, query }) => {
      const to = query.get("to")?.trim().toLowerCase() || null;
      const ctx = resolveProfileContextForChannel(getStateDb(), "email", to);
      sendJson(res, 200, {
        channel_kind: "email",
        channel_identity: to,
        profile: ctx.slug,
        bound_profile: ctx.bound_slug,
        cascaded: ctx.cascaded,
        api_server_port: ctx.api_server_port,
        api_server_key_present: ctx.api_server_key != null,
        profile_dir: ctx.profile_dir,
        journal_scope: ctx.journal_scope_key,
        gateway_url: hermesBaseUrlFor(ctx),
      });
    },
  );
}
