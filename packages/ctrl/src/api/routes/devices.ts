// ============================================================================
// Device routes — Hermes DM-pairing / command-approval.
//
// SEMANTIC SHIFT (PLAN.md Part F, issue #15): OpenClaw's "devices" were
// per-device gateway tokens. Hermes' equivalent surface is DM-pairing +
// command-approval — a channel/DM is paired with the principal, and
// privileged commands require approval. The /devices dashboard page is
// flagged for a semantic update (Phase 3).
//
// These routes proxy `hermes devices …` against the `main` profile. If a
// pinned Hermes build does not expose a `devices` subcommand, the dockerExec
// call surfaces a clear non-zero-exit error to the caller rather than
// silently succeeding — the dashboard then shows the runtime's own message.
// ============================================================================

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerExec, HERMES_CMD, HERMES_CONTAINER } from "../helpers.js";

// Hermes DM-pairing / command-approval CLI surface (was the OpenClaw
// `devices` subcommand). Runs against the user-facing `main` profile.
const DEVICE_CMD = [...HERMES_CMD, "-p", "main", "devices"];

export function registerDeviceRoutes(): void {
  // List paired devices / DM pairings.
  addRoute("GET", "/api/v1/devices", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...DEVICE_CMD, "list", "--json"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Approve a pairing / command-approval request.
  addRoute("POST", "/api/v1/devices/:requestId/approve", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = [...DEVICE_CMD, "approve", params.requestId];
    if (b?.latest) args.push("--latest");
    const stdout = await dockerExec(HERMES_CONTAINER, args);
    sendJson(res, 200, { message: stdout.trim() || "Pairing approved" });
  });

  // Reject a pairing / command-approval request.
  addRoute("POST", "/api/v1/devices/:requestId/reject", async ({ res, params }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...DEVICE_CMD, "reject", params.requestId]);
    sendJson(res, 200, { message: stdout.trim() || "Pairing rejected" });
  });

  // Remove a paired device.
  addRoute("DELETE", "/api/v1/devices/:deviceId", async ({ res, params }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...DEVICE_CMD, "remove", params.deviceId]);
    sendJson(res, 200, { message: stdout.trim() || "Device removed" });
  });

  // Clear all pairings.
  addRoute("POST", "/api/v1/devices/clear", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = [...DEVICE_CMD, "clear"];
    if (b?.pending_only) args.push("--pending-only");
    const stdout = await dockerExec(HERMES_CONTAINER, args);
    sendJson(res, 200, { message: stdout.trim() || "Pairings cleared" });
  });

  // Rotate a device token.
  addRoute("POST", "/api/v1/devices/:deviceId/rotate", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.role !== "string") {
      throw new ValidationError("role is required");
    }
    const args = [...DEVICE_CMD, "rotate", params.deviceId, "--role", b.role as string];
    if (b.scope) args.push("--scope", b.scope as string);
    const stdout = await dockerExec(HERMES_CONTAINER, args);
    sendJson(res, 200, { message: stdout.trim() || "Token rotated" });
  });

  // Revoke a device's access.
  addRoute("POST", "/api/v1/devices/:deviceId/revoke", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.role !== "string") {
      throw new ValidationError("role is required");
    }
    const stdout = await dockerExec(HERMES_CONTAINER, [
      ...DEVICE_CMD,
      "revoke",
      params.deviceId,
      "--role",
      b.role as string,
    ]);
    sendJson(res, 200, { message: stdout.trim() || "Access revoked" });
  });
}
