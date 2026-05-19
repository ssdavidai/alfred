import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { resolveDeliveryTarget } from "../hermes-sessions.js";

// The ctrl-api container mounts /mnt/encrypted/alfred at the same path (NOT
// remapped to /alfred-data like alfred-learn does — see
// packages/ctrl/src/templates/docker-compose.yaml.njk and PR #463). Read the
// env var the compose template already sets, and fall back to both common
// paths for older tenants where the env wasn't in the compose template yet.
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://openclaw:18789";
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/mnt/encrypted/openclaw/openclaw.json";
const GATEWAY_TOKEN_CANDIDATES = [
  process.env.OPENCLAW_GATEWAY_TOKEN_FILE,
  "/mnt/encrypted/alfred/.gateway-token",
  "/alfred-data/.gateway-token",
].filter((p): p is string => typeof p === "string" && p.length > 0);

function getGatewayToken(): string {
  for (const candidate of GATEWAY_TOKEN_CANDIDATES) {
    try {
      const value = fs.readFileSync(candidate, "utf-8").trim();
      if (value) return value;
    } catch {
      // try next candidate
    }
  }
  return "";
}

// Pick the tenant's primary outbound channel. Preference order: slack →
// telegram → webchat. Reads openclaw.json's `channels` map and returns the
// first one that's `enabled: true`. Falls back to "webchat".
function pickPrimaryChannel(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8")) as {
      channels?: Record<string, { enabled?: boolean }>;
    };
    const channels = cfg.channels ?? {};
    for (const name of ["slack", "telegram", "discord", "whatsapp", "webchat"]) {
      if (channels[name]?.enabled) return name;
    }
  } catch {
    // fall through
  }
  return "webchat";
}

// Resolve Sir's recipient id on a given channel from native Hermes session
// data: the most-recently-active gateway session bound to that channel, with
// its delivery target (`origin.chat_id`) — e.g. a Slack channel/IM id or a
// Telegram chat id. Fails soft: returns undefined if nothing found.
//
// Backed by the Hermes gateway session index (`sessions.json`, see
// hermes-sessions.ts), which replaced the retired hermes-shim `sessions_list`
// tool in issue #39. The "notify the principal directly, never a group"
// Telegram rule is preserved inside resolveDeliveryTarget — it now uses
// Hermes' own `chat_type` ("dm" vs "group") plus the chat_id-sign fallback.
// See 2026-05-13 trace: a plex delegate landed in a group because a shared
// group's updatedAt was newer than Sir's DM.
function resolveRecipient(channel: string): string | undefined {
  return resolveDeliveryTarget(channel)?.to;
}

export function registerNotificationRoutes(): void {
  // POST /api/v1/notifications — send an agent-initiated message to Sir on a
  // configured channel (Slack, Telegram, etc). Used by every chore + any
  // platform code that needs to push to Sir proactively.
  //
  // Body: {
  //   message:  string (required)          — the text Sir sees
  //   channel?: "slack" | "telegram" | …   — defaults to tenant's primary
  //   to?:      channel-specific recipient — auto-resolved if omitted
  //   urgency?: "low" | "normal" | "high"  — passthrough to channel adapter
  // }
  //
  // Delivers via openclaw's `message.send` tool, which routes through the
  // channel adapter (chat.postMessage for Slack, sendMessage for Telegram,
  // etc.). This is OPENCLAW'S OWN outbound primitive — sessions_send stores
  // replies in session state but never pushes to channels for agent-initiated
  // turns, so we don't use it here. See `openclaw-tools.js:6425` for the
  // `message` tool definition.
  addRoute("POST", "/api/v1/notifications", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;

    if (!b || typeof b.message !== "string" || !b.message.trim()) {
      throw new ValidationError("message is required");
    }

    const message = b.message as string;
    const urgency = typeof b.urgency === "string" ? b.urgency : "normal";
    const channelHint = typeof b.channel === "string" && b.channel.length > 0
      ? b.channel
      : "auto";

    const token = getGatewayToken();
    if (!token) {
      throw new ValidationError("Gateway token not available");
    }

    const channel = channelHint === "auto" ? pickPrimaryChannel() : channelHint;
    const to = typeof b.to === "string" && b.to.length > 0
      ? (b.to as string)
      : resolveRecipient(channel);

    if (!to) {
      sendJson(res, 424, {
        status: "error",
        error: `no recipient on channel=${channel} — pass body.to explicitly or have Sir send at least one inbound message first`,
      });
      return;
    }

    try {
      const response = await fetch(`${OPENCLAW_GATEWAY_URL}/tools/invoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tool: "message",
          args: {
            action: "send",
            channel,
            to,
            message,
            urgency,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gateway request failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      sendJson(res, 200, { status: "sent", channel, to, data });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { status: "error", error: errorMessage });
    }
  });
}
