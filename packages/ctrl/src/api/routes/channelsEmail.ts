// Email channel inbound handler.
//
// Called by the SaaS webhook receiver at
// packages/saas/app/src/server/agentmailReceiver.ts when an inbound email
// comes from an authorized sender. We start a one-shot Hermes run with the
// email pre-loaded as the run input plus an envelope of metadata
// (from/to/cc/subject/thread_id/message_id), so the main agent can read,
// reason, and reply via /api/v1/email/reply.
//
// Fire-and-forget: we respond 202 immediately and let the run proceed in
// the background. Failures to start are logged; the message is still safe
// because the SaaS receiver also buffers a StreamEvent fallback.
//
// Phase 2: calls Hermes `POST /v1/runs` natively against the Hermes API
// server's canonical port (the hermes-shim was retired in issue #40). The
// OpenClaw `sessions_spawn` `/tools/invoke` contract is retired.

import fs from "node:fs";

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

const HERMES_GATEWAY_URL =
  process.env.HERMES_GATEWAY_URL ||
  process.env.OPENCLAW_GATEWAY_URL ||
  "http://hermes:18789";
const GATEWAY_TOKEN_FILE =
  process.env.OPENCLAW_GATEWAY_TOKEN_FILE || "/alfred-data/.gateway-token";

function getGatewayToken(): string {
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

export function registerChannelsEmailRoutes(): void {
  addRoute("POST", "/api/v1/channels/email/inbound", async ({ res, body }) => {
    const b = (body ?? {}) as { message?: any; event_id?: string };
    if (!b.message || typeof b.message !== "object") {
      throw new ValidationError("`message` required");
    }

    const token = getGatewayToken();
    if (!token) {
      throw new ValidationError(
        "Hermes gateway token not available — cannot start run",
      );
    }

    const prompt = buildChannelPrompt(b.message);

    // Fire-and-forget Hermes run on the main profile. We intentionally don't
    // await the response — the run takes tens of seconds to minutes and
    // AgentMail has a 5s webhook budget upstream (already satisfied — SaaS
    // 204'd before this point). `session_id` correlates the run to the email
    // thread so a follow-up reply on the same thread chains the conversation.
    const sessionId = `email-${b.message?.thread_id ?? b.message?.message_id ?? b.event_id ?? Date.now()}`;
    const run = fetch(`${HERMES_GATEWAY_URL}/v1/runs`, {
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

    sendJson(res, 202, { accepted: true, message_id: b.message?.message_id ?? null });
  });
}
