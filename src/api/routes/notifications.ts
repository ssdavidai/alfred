import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

const GATEWAY_TOKEN_FILE = "/alfred-data/.gateway-token";
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://openclaw:18789";

function getGatewayToken(): string {
  try {
    return fs.readFileSync(GATEWAY_TOKEN_FILE, "utf-8").trim();
  } catch {
    return "";
  }
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
    const sessionId = typeof b.session_id === "string" ? b.session_id : "main";

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
            sessionId: sessionId,
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
