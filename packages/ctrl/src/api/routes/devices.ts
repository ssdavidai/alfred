// ============================================================================
// Pairing routes — Hermes-native DM pairing.
//
// HISTORY (issue #42). The old "devices" surface was an OpenClaw-era
// reinvention: per-device gateway tokens with rotate/revoke-by-role/remove
// operations. The migration shim then proxied a `hermes devices` subcommand
// that does NOT exist in Hermes. Hermes' real equivalent is **DM pairing**:
// when an unknown messaging account DMs the gateway it gets a one-hour
// pairing code, and the owner approves that code from the CLI.
//
// This file is now a thin, honest proxy over the native `hermes pairing`
// CLI surface (see hermes-agent.nousresearch.com/docs — User Guide ▸
// Security / Messaging):
//
//   hermes pairing list                       — pending + approved users
//   hermes pairing approve <platform> <code>  — approve a pairing code
//   hermes pairing revoke  <platform> <user>  — revoke a user's access
//   hermes pairing clear-pending              — drop all pending codes
//
// Native pairing has NO JSON output, NO request-id surface, and NO token
// rotation — so the bespoke `reject`, `remove`, `rotate` and role-scoped
// `revoke` endpoints are gone. They mapped to nothing real. Command
// approval is now Hermes-native (`approvals.mode` in hermes-config.yaml.njk)
// and is not an HTTP surface at all.
//
// Routes run against the user-facing `main` profile — the only profile with
// messaging channels enabled.
// ============================================================================

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerExec, HERMES_CMD, HERMES_CONTAINER } from "../helpers.js";

// Hermes-native DM-pairing CLI surface, run against the `main` profile.
const PAIRING_CMD = [...HERMES_CMD, "-p", "main", "pairing"];

export function registerDeviceRoutes(): void {
  // List pending pairing codes + approved users. Native `pairing list` emits
  // human-readable text (no --json), so the response is the raw CLI output —
  // the dashboard renders it as a read-only status surface.
  addRoute("GET", "/api/v1/devices", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...PAIRING_CMD, "list"]);
    sendJson(res, 200, { raw: stdout.trim() });
  });

  // Approve a pending pairing code. Native CLI is `pairing approve
  // <platform> <code>` — both are required and there is no "latest" flag.
  addRoute("POST", "/api/v1/devices/approve", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.platform !== "string" || !b.platform) {
      throw new ValidationError("platform is required (e.g. telegram, slack)");
    }
    if (typeof b.code !== "string" || !b.code) {
      throw new ValidationError("code is required (the 8-char pairing code)");
    }
    const stdout = await dockerExec(HERMES_CONTAINER, [
      ...PAIRING_CMD,
      "approve",
      b.platform,
      b.code,
    ]);
    sendJson(res, 200, { message: stdout.trim() || "Pairing approved" });
  });

  // Revoke an approved user's channel access. Native CLI is `pairing revoke
  // <platform> <user-id>`.
  addRoute("POST", "/api/v1/devices/revoke", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.platform !== "string" || !b.platform) {
      throw new ValidationError("platform is required (e.g. telegram, slack)");
    }
    if (typeof b.userId !== "string" || !b.userId) {
      throw new ValidationError("userId is required (the platform user id)");
    }
    const stdout = await dockerExec(HERMES_CONTAINER, [
      ...PAIRING_CMD,
      "revoke",
      b.platform,
      b.userId,
    ]);
    sendJson(res, 200, { message: stdout.trim() || "Access revoked" });
  });

  // Clear all pending pairing codes.
  addRoute("POST", "/api/v1/devices/clear-pending", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [
      ...PAIRING_CMD,
      "clear-pending",
    ]);
    sendJson(res, 200, { message: stdout.trim() || "Pending codes cleared" });
  });
}
