import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerExec, OPENCLAW_CMD } from "../helpers.js";

const DEVICE_CMD = [...OPENCLAW_CMD, "devices"];

export function registerDeviceRoutes(): void {
  // List devices
  addRoute("GET", "/api/v1/devices", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...DEVICE_CMD, "list", "--json"]);
    sendJson(res, 200, JSON.parse(stdout));
  });

  // Approve device
  addRoute("POST", "/api/v1/devices/:requestId/approve", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = [...DEVICE_CMD, "approve", params.requestId];
    if (b?.latest) args.push("--latest");
    const stdout = await dockerExec("openclaw", args);
    sendJson(res, 200, { message: stdout.trim() || "Device approved" });
  });

  // Reject device
  addRoute("POST", "/api/v1/devices/:requestId/reject", async ({ res, params }) => {
    const stdout = await dockerExec("openclaw", [...DEVICE_CMD, "reject", params.requestId]);
    sendJson(res, 200, { message: stdout.trim() || "Device rejected" });
  });

  // Remove device
  addRoute("DELETE", "/api/v1/devices/:deviceId", async ({ res, params }) => {
    const stdout = await dockerExec("openclaw", [...DEVICE_CMD, "remove", params.deviceId]);
    sendJson(res, 200, { message: stdout.trim() || "Device removed" });
  });

  // Clear all devices
  addRoute("POST", "/api/v1/devices/clear", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = [...DEVICE_CMD, "clear"];
    if (b?.pending_only) args.push("--pending-only");
    const stdout = await dockerExec("openclaw", args);
    sendJson(res, 200, { message: stdout.trim() || "Devices cleared" });
  });

  // Rotate device token
  addRoute("POST", "/api/v1/devices/:deviceId/rotate", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.role !== "string") {
      throw new ValidationError("role is required");
    }
    const args = [...DEVICE_CMD, "rotate", params.deviceId, "--role", b.role as string];
    if (b.scope) args.push("--scope", b.scope as string);
    const stdout = await dockerExec("openclaw", args);
    sendJson(res, 200, { message: stdout.trim() || "Token rotated" });
  });

  // Revoke device access
  addRoute("POST", "/api/v1/devices/:deviceId/revoke", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.role !== "string") {
      throw new ValidationError("role is required");
    }
    const stdout = await dockerExec("openclaw", [...DEVICE_CMD, "revoke", params.deviceId, "--role", b.role as string]);
    sendJson(res, 200, { message: stdout.trim() || "Access revoked" });
  });
}
