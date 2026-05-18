import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

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

// Resolve Sir's recipient id on a given channel by asking the gateway's
// sessions_list for the most-recent session bound to that channel. We
// extract `deliveryContext.to` — e.g. `user:U08UGBQL5J5` on Slack or a
// chat id on Telegram. Fails soft: returns undefined if nothing found.
async function resolveRecipient(channel: string, token: string): Promise<string | undefined> {
  try {
    const resp = await fetch(`${OPENCLAW_GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "sessions_list", args: {} }),
    });
    if (!resp.ok) return undefined;
    const envelope = await resp.json() as { result?: { content?: Array<{ type: string; text?: string }> } };
    const content = envelope?.result?.content ?? [];
    for (const item of content) {
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      const payload = JSON.parse(item.text) as { sessions?: Array<Record<string, any>> };
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      // For Telegram, chat_ids are POSITIVE for DMs and NEGATIVE for
      // groups/supergroups. "Notify the principal" means the principal
      // directly — never broadcast into a group just because that group
      // happened to be the most recently active session. Prefer DM
      // sessions; fall back to group only if no DM is on record. See
      // 2026-05-13 trace: plex delegate landed in a group because a
      // shared group's updatedAt was newer than Sir's DM.
      const isTelegramDm = (s: Record<string, any>): boolean => {
        if (channel !== "telegram") return true; // no-op outside Telegram
        const to = String(s?.deliveryContext?.to ?? "");
        const id = to.startsWith("telegram:") ? to.slice("telegram:".length) : to;
        return !id.startsWith("-");
      };
      const allMatching = sessions
        .filter((s) => (s?.channel ?? "") === channel && s?.deliveryContext?.to)
        .sort((a, b) => Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0));
      const dmFirst = [
        ...allMatching.filter(isTelegramDm),
        ...allMatching.filter((s) => !isTelegramDm(s)),
      ];
      const top = dmFirst[0];
      if (top?.deliveryContext?.to) {
        const raw = String(top.deliveryContext.to);
        // openclaw stores slack recipients as "user:U08UGBQL5J5" — the
        // `message.send` tool wants the bare id. Strip the `user:` prefix.
        return raw.startsWith("user:") ? raw.slice("user:".length) : raw;
      }
    }
  } catch {
    // fall through
  }
  return undefined;
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
      : await resolveRecipient(channel, token);

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
