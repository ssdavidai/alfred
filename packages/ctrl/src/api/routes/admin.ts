import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerComposeCmd, execAsync, sudoExec, parseJsonLines, validateServiceName, COMPOSE_DIR } from "../helpers.js";
import { parseActivityFeed } from "../activity.js";

const ENV_PATH = `${COMPOSE_DIR}/.env`;
const OPENCLAW_JSON_PATH = "/mnt/encrypted/openclaw/openclaw.json";

export function registerAdminRoutes(): void {
  // --- Containers ---

  // List containers
  addRoute("GET", "/api/v1/admin/containers", async ({ res }) => {
    const stdout = await dockerComposeCmd(["ps", "--format", "json"]);
    sendJson(res, 200, parseJsonLines(stdout));
  });

  // Restart container
  addRoute("POST", "/api/v1/admin/containers/:service/restart", async ({ res, params }) => {
    validateServiceName(params.service);
    await dockerComposeCmd(["restart", params.service]);
    sendJson(res, 200, { message: `Container "${params.service}" restarted` });
  });

  // Stop container
  addRoute("POST", "/api/v1/admin/containers/:service/stop", async ({ res, params }) => {
    validateServiceName(params.service);
    await dockerComposeCmd(["stop", params.service]);
    sendJson(res, 200, { message: `Container "${params.service}" stopped` });
  });

  // Start container
  addRoute("POST", "/api/v1/admin/containers/:service/start", async ({ res, params }) => {
    validateServiceName(params.service);
    await dockerComposeCmd(["start", params.service]);
    sendJson(res, 200, { message: `Container "${params.service}" started` });
  });

  // Container logs (non-streaming)
  addRoute("GET", "/api/v1/admin/containers/:service/logs", async ({ res, params, query }) => {
    validateServiceName(params.service);
    const tail = query.get("tail") ?? "100";
    if (!/^\d+$/.test(tail)) throw new ValidationError("tail must be a number");
    const stdout = await dockerComposeCmd(["logs", "--tail", tail, params.service]);
    sendJson(res, 200, { logs: stdout });
  });

  // --- Activity Feed ---

  addRoute("GET", "/api/v1/admin/activity", async ({ res, query }) => {
    const limit = parseInt(query.get("limit") ?? "50", 10);
    if (isNaN(limit) || limit < 1) throw new ValidationError("limit must be a positive number");
    // Fetch 3x more raw lines to account for noise filtering
    const rawTail = Math.min(limit * 3, 1000).toString();
    const stdout = await dockerComposeCmd(["logs", "--no-color", "--tail", rawTail, "alfred"]);
    const items = parseActivityFeed(stdout, limit);
    sendJson(res, 200, { items });
  });

  // --- Config ---

  // Read .env (filtering out AAS_API_KEY)
  addRoute("GET", "/api/v1/admin/config/env", async ({ res }) => {
    let content = "";
    try {
      content = fs.readFileSync(ENV_PATH, "utf-8");
    } catch {
      sendJson(res, 200, { env: {} });
      return;
    }
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === "AAS_API_KEY") continue; // never expose the API key
      env[key] = value;
    }
    sendJson(res, 200, { env });
  });

  // Update .env (merge keys, null deletes)
  addRoute("PATCH", "/api/v1/admin/config/env", async ({ res, body }) => {
    const b = body as Record<string, string | null> | undefined;
    if (!b || typeof b !== "object") throw new ValidationError("Request body must be an object of key-value pairs");

    // Prevent overwriting the API key
    if ("AAS_API_KEY" in b) throw new ValidationError("Cannot modify AAS_API_KEY via API");

    const existing: Record<string, string> = {};
    try {
      const content = fs.readFileSync(ENV_PATH, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        existing[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    } catch {
      // file doesn't exist yet
    }

    for (const [key, value] of Object.entries(b)) {
      if (value === null) {
        delete existing[key];
      } else {
        existing[key] = value;
      }
    }

    const lines = Object.entries(existing).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf-8");
    sendJson(res, 200, { message: "Environment updated", keys: Object.keys(b) });
  });

  // Read openclaw.json
  addRoute("GET", "/api/v1/admin/config/openclaw", async ({ res }) => {
    try {
      const content = fs.readFileSync(OPENCLAW_JSON_PATH, "utf-8");
      sendJson(res, 200, JSON.parse(content));
    } catch {
      sendJson(res, 200, {});
    }
  });

  // Update openclaw.json (deep merge)
  addRoute("PATCH", "/api/v1/admin/config/openclaw", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b !== "object") throw new ValidationError("Request body must be an object");

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(OPENCLAW_JSON_PATH, "utf-8"));
    } catch {
      // file doesn't exist yet
    }

    const merged = deepMerge(existing, b);
    fs.writeFileSync(OPENCLAW_JSON_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    sendJson(res, 200, { message: "OpenClaw config updated" });
  });

  // --- Tailscale ---

  // Tailscale status
  addRoute("GET", "/api/v1/admin/tailscale/status", async ({ res }) => {
    const stdout = await execAsync("tailscale", ["status", "--json"]).then(r => r.stdout);
    sendJson(res, 200, JSON.parse(stdout));
  });

  // Tailscale serve status
  addRoute("GET", "/api/v1/admin/tailscale/serve", async ({ res }) => {
    const stdout = await sudoExec("tailscale", ["serve", "status", "--json"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Regenerate TLS cert
  addRoute("POST", "/api/v1/admin/tailscale/cert", async ({ res }) => {
    const statusRaw = await execAsync("tailscale", ["status", "--json"]).then(r => r.stdout);
    const status = JSON.parse(statusRaw);
    const hostname = status.Self?.DNSName?.replace(/\.$/, "");
    if (!hostname) throw new ValidationError("Could not determine Tailscale hostname");
    await sudoExec("tailscale", ["cert", hostname]);
    sendJson(res, 200, { message: `Certificate regenerated for ${hostname}` });
  });

  // --- Health ---

  addRoute("GET", "/api/v1/admin/health", async ({ res }) => {
    const stdout = await execAsync("/opt/alfred/healthcheck.sh", []).then(r => r.stdout);
    try {
      sendJson(res, 200, JSON.parse(stdout.trim()));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // --- Diagnostics ---

  // Echo request headers back (to verify what actually arrives at the ctrl API)
  addRoute("GET", "/api/v1/admin/debug/headers", async ({ req, res }) => {
    sendJson(res, 200, {
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
      headers: req.headers,
      terminalReady: (globalThis as any).__terminalReady ?? "not_set",
      terminalError: (globalThis as any).__terminalError ?? null,
    });
  });

  // --- System info ---

  addRoute("GET", "/api/v1/admin/system/info", async ({ res }) => {
    const [uptimeResult, diskResult, memResult] = await Promise.all([
      execAsync("uptime", ["-p"]).then(r => r.stdout.trim()).catch(() => "unknown"),
      execAsync("df", ["-h", "/mnt/encrypted"]).then(r => r.stdout.trim()).catch(() => "unknown"),
      execAsync("free", ["-m"]).then(r => r.stdout.trim()).catch(() => "unknown"),
    ]);
    sendJson(res, 200, { uptime: uptimeResult, disk: diskResult, memory: memResult });
  });

  // --- Backups ---

  // Trigger backup (fire-and-forget)
  addRoute("POST", "/api/v1/admin/backups/trigger", async ({ res }) => {
    execAsync("sudo", ["bash", "/opt/alfred/backup.sh"], 600_000).catch((err) => {
      console.error("Backup failed:", err.message);
    });
    sendJson(res, 202, { message: "Backup triggered" });
  });

  // List backup snapshots
  addRoute("GET", "/api/v1/admin/backups/snapshots", async ({ res }) => {
    const stdout = await execAsync("bash", [
      "-c",
      "set -a && source /opt/alfred/restic.env && restic snapshots --json",
    ], 60_000).then(r => r.stdout);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // --- Temporal cluster ---

  addRoute("GET", "/api/v1/admin/temporal/cluster", async ({ res }) => {
    const stdout = await execAsync("docker", [
      "compose", "-f", `${COMPOSE_DIR}/docker-compose.yaml`,
      "exec", "-T", "temporal", "temporal", "operator", "cluster", "describe", "--output", "json",
    ]).then(r => r.stdout);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Task queue describe
  addRoute("GET", "/api/v1/admin/temporal/task-queues/:name", async ({ res, params }) => {
    const stdout = await execAsync("docker", [
      "compose", "-f", `${COMPOSE_DIR}/docker-compose.yaml`,
      "exec", "-T", "temporal", "temporal", "task-queue", "describe",
      "--task-queue", params.name, "--output", "json",
    ]).then(r => r.stdout);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      result[key] && typeof result[key] === "object" && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
