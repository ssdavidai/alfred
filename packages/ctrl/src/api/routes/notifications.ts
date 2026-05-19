import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { resolveDeliveryTarget } from "../hermes-sessions.js";

const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/mnt/encrypted/openclaw/openclaw.json";

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
  // POST /api/v1/notifications — agent-initiated channel notification to Sir.
  // Used by `notify_principal` (MCP) and any platform code pushing to Sir.
  //
  // Body: {
  //   message:  string (required)          — the text Sir sees
  //   channel?: "slack" | "telegram" | …   — defaults to tenant's primary
  //   to?:      channel-specific recipient — auto-resolved if omitted
  //   urgency?: "low" | "normal" | "high"  — passthrough to channel adapter
  // }
  //
  // DELIVERY STATUS — the outbound channel-send path is currently a no-op.
  // Under OpenClaw this hit the gateway's `message` tool; the OpenClaw→Hermes
  // swap routed it through the hermes-shim's `/tools/invoke` `message`
  // handler, which was a no-op acknowledgement from day one (Phase 1) — it
  // never actually pushed to a channel. Issue #40 retired the shim entirely;
  // the Hermes `/v1` API exposes `/v1/runs` + `/v1/responses` but no native
  // outbound channel-send endpoint, so there is nothing to repoint onto.
  //
  // Rather than call the now-deleted `/tools/invoke` endpoint (which would
  // 404), ctrl-api owns the no-op explicitly: it still validates the request
  // and resolves the recipient (so callers see the same shape and the same
  // 424 on an unresolvable recipient), logs the intended delivery, and
  // returns `delivered: false`. Wiring real outbound delivery onto a
  // `main`-profile Hermes run is a separate piece of work, tracked apart
  // from the shim retirement.
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

    // No-op acknowledgement — channel delivery is not wired post-shim-retire.
    // Log the intended delivery so the gap is visible in tenant logs.
    console.warn(
      `[notifications] outbound delivery is a no-op — channel=${channel} to=${to} urgency=${urgency} message=${JSON.stringify(message.slice(0, 200))}`,
    );
    sendJson(res, 200, {
      status: "acknowledged",
      delivered: false,
      noop: true,
      channel,
      to,
      reason:
        "outbound channel delivery is not wired — the hermes-shim `message` no-op was retired in issue #40 and the Hermes /v1 API has no channel-send endpoint",
    });
  });
}
