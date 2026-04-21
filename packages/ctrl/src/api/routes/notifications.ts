import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

// The ctrl-api container mounts /mnt/encrypted/alfred at the same path
// (NOT remapped to /alfred-data like alfred-learn does — see
// packages/ctrl/src/templates/docker-compose.yaml.njk and PR #463). Read the
// env var the compose template already sets, and fall back to both common
// paths for older tenants where the env wasn't in the compose template yet.
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://openclaw:18789";
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

export function registerNotificationRoutes(): void {
  // POST /api/v1/notifications — send a notification through OpenClaw gateway
  addRoute("POST", "/api/v1/notifications", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;

    if (!b || typeof b.message !== "string") {
      throw new ValidationError("message is required");
    }

    const message = b.message as string;
    const urgency = typeof b.urgency === "string" ? b.urgency : "normal";
    const rawSessionId = typeof b.session_id === "string" ? b.session_id : "main";
    const agentId = typeof b.agent_id === "string" ? b.agent_id : "main";

    // sessions_send accepts `sessionKey` (full `agent:<agent>:<session>` form)
    // or `label`. Plain `session_id` → `agent:<agentId>:<session_id>` is the
    // shape the gateway actually stores for openclaw-hosted sessions. If the
    // caller already passed a fully-qualified key (starts with `agent:`), use
    // it verbatim.
    const sessionKey = rawSessionId.startsWith("agent:")
      ? rawSessionId
      : `agent:${agentId}:${rawSessionId}`;

    const token = getGatewayToken();
    if (!token) {
      throw new ValidationError("Gateway token not available");
    }

    try {
      // Call OpenClaw gateway to send notification
      const response = await fetch(`${OPENCLAW_GATEWAY_URL}/tools/invoke`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tool: "sessions_send",
          args: {
            sessionKey: sessionKey,
            message: message,
            urgency: urgency,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gateway request failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      sendJson(res, 200, { status: "sent", data });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { status: "error", error: errorMessage });
    }
  });
}
