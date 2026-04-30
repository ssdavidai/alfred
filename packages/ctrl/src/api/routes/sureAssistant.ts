import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { addRoute } from "../server.js";
import { sendJson, ApiError, ValidationError } from "../errors.js";

// OpenClaw's OpenAI-compatible /v1/chat/completions endpoint silently drops
// user-supplied `role: "system"` messages and uses its own workspace-derived
// system prompt. We can't override that, but we *can* establish session
// context by injecting a synthetic user → assistant turn pair at the start of
// the first conversation — OpenClaw treats those as real conversation history
// and they persist in the session, so the agent stays primed for the rest of
// the chat. (45 skills are loaded into the catalog in compact form; the
// agent has to `read` SKILL.md files to bring details into context, hence the
// explicit nudge.)
const SURE_PRIMING_USER = `[Sure Chat Bridge] You are responding inside Sir's self-hosted Sure personal-finance app. For this entire conversation:

1. **Read \`workspace/skills/alfred-sure-operations/SKILL.md\` first** and apply it rigorously.
2. **Before answering anything about money**, call the MCP \`self\` tool with one of \`/api/v1/sure/balance_sheet\`, \`/api/v1/sure/accounts\`, \`/api/v1/sure/transactions\`, \`/api/v1/sure/categories\`, or \`/api/v1/sure/merchants\`. Never speculate from vault data alone — ground every figure in a fresh Sure API call.
3. Sir uses **HUF, EUR, USD, and GBP** simultaneously. Translate amounts to natural language with the right currency symbol (€, $, Ft, £). Name the FX assumption when totalling cross-currency. Never paste raw JSON.
4. Lead with financial framing. If Sir asks something unrelated, fall back to your other skills — but don't volunteer non-financial threads.

Acknowledge briefly and wait for Sir's first question.`;

const SURE_PRIMING_ASSISTANT = `Understood, Sir. I'll load \`alfred-sure-operations\` and lead with a fresh Sure API call for any question about your finances. Ready when you are.`;

const OPENCLAW_URL = process.env.OPENCLAW_GATEWAY_URL || "http://openclaw:18789";
const OPENCLAW_AGENT_ID = "openclaw/main";
const GATEWAY_TOKEN_FILE =
  process.env.OPENCLAW_GATEWAY_TOKEN_FILE || "/mnt/encrypted/alfred/.gateway-token";
const SELF_SYNC_URL = "http://localhost:3100/api/v1/sure/sync";

let cachedGatewayToken: string | null = null;

function readGatewayToken(): string {
  if (cachedGatewayToken) return cachedGatewayToken;
  const tok = fs.readFileSync(GATEWAY_TOKEN_FILE, "utf-8").trim();
  if (!tok) {
    throw new ApiError(
      500,
      "GATEWAY_TOKEN_MISSING",
      `OpenClaw gateway token at ${GATEWAY_TOKEN_FILE} is empty`,
    );
  }
  cachedGatewayToken = tok;
  return tok;
}

function familyIdFromUser(user: unknown): string {
  if (typeof user !== "string") return "default";
  const m = user.match(/^sure-family-(.+)$/);
  return m ? m[1] : user;
}

function fireAndForgetSync(): void {
  // Best-effort kick on the first user message of a session so the agent
  // reasons over fresh data. Failures are logged and ignored — the chat
  // proceeds either way.
  const apiKey = process.env.AAS_API_KEY || "";
  if (!apiKey) return;
  fetch(SELF_SYNC_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(2000),
  }).catch((err) => {
    console.warn(
      `[sure.assistant] sync fire-and-forget failed: ${(err as Error).message}`,
    );
  });
}

export function registerSureAssistantRoutes(): void {
  // POST /api/v1/sure/assistant
  //
  // OpenAI-compatible streaming chat completions endpoint that Sure's
  // Assistant::External::Client posts to. Wraps OpenClaw's native
  // /v1/chat/completions with:
  //   1. A platform-controlled system message biasing Alfred toward
  //      financial Q&A using the alfred-sure-operations skill.
  //   2. A per-family X-Session-Key derived from Sure's `user` body field
  //      (sure-family-<id>) so each Sure family gets a persistent OpenClaw
  //      session instead of all chats sharing the hardcoded
  //      "agent:main:main" default.
  //   3. A fire-and-forget POST to /api/v1/sure/sync on the first user
  //      message of a session so balances and transactions are fresh.
  //
  // Response is the unmodified SSE stream from OpenClaw.
  addRoute("POST", "/api/v1/sure/assistant", async ({ req, res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const messages = Array.isArray(b.messages) ? b.messages : null;
    if (!messages || messages.length === 0) {
      throw new ValidationError("messages array is required");
    }

    const familyId = familyIdFromUser(b.user);
    const sessionKey = `sure-${familyId}`;

    const userMessageCount = messages.filter(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).role === "user",
    ).length;
    if (userMessageCount === 1) {
      fireAndForgetSync();
    }

    // Only inject the priming turn pair on the FIRST user message — once
    // OpenClaw's session has the priming as past context, it sticks for the
    // life of the session. Subsequent calls forward Sure's history as-is.
    const enhancedMessages =
      userMessageCount === 1
        ? [
            { role: "user", content: SURE_PRIMING_USER },
            { role: "assistant", content: SURE_PRIMING_ASSISTANT },
            ...messages,
          ]
        : messages;

    const upstreamUrl = `${OPENCLAW_URL.replace(/\/+$/, "")}/v1/chat/completions`;
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${readGatewayToken()}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Agent-Id": OPENCLAW_AGENT_ID,
          "X-Session-Key": sessionKey,
        },
        body: JSON.stringify({
          model: OPENCLAW_AGENT_ID,
          messages: enhancedMessages,
          stream: true,
          user: typeof b.user === "string" ? b.user : undefined,
        }),
      });
    } catch (err) {
      throw new ApiError(
        502,
        "OPENCLAW_UNREACHABLE",
        `Failed to reach OpenClaw at ${upstreamUrl}: ${(err as Error).message}`,
      );
    }

    if (!upstream.ok) {
      const errText = (await upstream.text().catch(() => "")).slice(0, 500);
      sendJson(res, upstream.status, {
        error: {
          code: "OPENCLAW_API_ERROR",
          message: errText || `OpenClaw returned ${upstream.status}`,
        },
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    if (!upstream.body) {
      res.end();
      return;
    }

    // Use Readable.fromWeb + pipeline so chunks flow as Node streams (the
    // for-await pattern over a Web ReadableStream silently buffers under
    // some conditions and Sure's SSE parser sees zero bytes despite a 200).
    const nodeStream = Readable.fromWeb(
      upstream.body as Parameters<typeof Readable.fromWeb>[0],
    );
    try {
      await pipeline(nodeStream, res);
    } catch (err) {
      console.warn(
        `[sure.assistant] stream pipeline interrupted: ${(err as Error).message}`,
      );
      if (!res.writableEnded) res.end();
    }
  });
}
