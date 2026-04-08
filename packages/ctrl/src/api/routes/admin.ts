import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerComposeCmd, dockerExec, execAsync, sudoExec, parseJsonLines, validateServiceName, COMPOSE_DIR, OPENCLAW_CMD } from "../helpers.js";
import { getVaultContextData, getInboxFiles, VAULT_PATH } from "./vault.js";
import { parseActivityFeed } from "../activity.js";

// Host paths for alfred-data and chore directory.
// The ctrl-api container mounts /mnt/encrypted/alfred to the SAME path
// (not to /alfred-data like alfred-learn does), so we use the host
// path directly here. See docker-compose.yaml.njk for the mount config.
const CHORE_GENERATION_AUDIT_LOG = "/mnt/encrypted/alfred/chore-generation-audit.jsonl";
const CHORE_VAULT_DIR = `${VAULT_PATH}/chore`;

const ENV_PATH = `${COMPOSE_DIR}/.env`;
const OPENCLAW_JSON_PATH = "/mnt/encrypted/openclaw/openclaw.json";

// In-memory rate limit for the chore-specific learn restart route. Prevents
// thrashing when an onboarding generates multiple templates and each tries
// to trigger a restart. The limit is intentionally process-local — restarts
// during a stuck/looping container would be visible to ops via container
// uptime anyway.
let _lastLearnRestartAtMs = 0;
const _LEARN_RESTART_MIN_INTERVAL_MS = 30_000;

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

  // Chore-specific alfred-learn restart with rate limiting.
  //
  // The chore generation pipeline (Step 4) calls this after writing a
  // generated template to /alfred-data/user-chores/ so the worker re-imports
  // its module list and picks up the new template. The rate limit prevents
  // thrashing when an onboarding generates multiple templates back-to-back
  // and each tries to trigger a restart.
  //
  // Returns:
  //   200 { ok, restarted_at, ready_after_seconds }
  //   429 { error: "rate limited", retry_after_seconds }
  //   500 { error: <docker error> }
  addRoute("POST", "/api/v1/admin/restart-learn", async ({ res }) => {
    const now = Date.now();
    const elapsed = now - _lastLearnRestartAtMs;
    if (_lastLearnRestartAtMs > 0 && elapsed < _LEARN_RESTART_MIN_INTERVAL_MS) {
      const retryAfter = Math.ceil((_LEARN_RESTART_MIN_INTERVAL_MS - elapsed) / 1000);
      sendJson(res, 429, {
        error: "rate limited",
        retry_after_seconds: retryAfter,
        message: "alfred-learn was restarted recently — wait before triggering another",
      });
      return;
    }
    _lastLearnRestartAtMs = now;

    const startedAt = new Date().toISOString();
    try {
      await dockerComposeCmd(["restart", "alfred-learn"]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: "restart failed", details: message });
      return;
    }

    // Best-effort wait for the container to be back in 'running' state.
    // Capped at 60 seconds. We don't poll healthchecks because alfred-learn
    // doesn't have one defined — Temporal heartbeats provide health visibility
    // through other channels.
    const deadline = Date.now() + 60_000;
    let readyAfterMs = 0;
    while (Date.now() < deadline) {
      try {
        const stdout = await dockerComposeCmd([
          "ps",
          "--format",
          "json",
          "alfred-learn",
        ]);
        // Each line is a JSON record. We just need to find the alfred-learn
        // entry and verify its State === "running".
        let isRunning = false;
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj.Service === "alfred-learn" && obj.State === "running") {
              isRunning = true;
              break;
            }
          } catch {
            // ignore non-JSON lines
          }
        }
        if (isRunning) {
          readyAfterMs = Date.now() - now;
          break;
        }
      } catch {
        // ignore poll errors and try again
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    sendJson(res, 200, {
      ok: true,
      restarted_at: startedAt,
      ready_after_seconds: Math.round(readyAfterMs / 1000),
    });
  });

  // --- S4-10: chore generation audit log ---
  //
  // Returns recent entries from /alfred-data/chore-generation-audit.jsonl,
  // which is written by the deploy activity (and the S4-8 generation
  // chain in the onboarding pipeline). One JSON line per deployment
  // event, containing phase/status/module_name/workflow_class_name/
  // source_hash/path/bytes/timestamp.
  //
  // Query params:
  //   limit: max number of entries to return (default 50, cap 500)
  //   since: ISO timestamp — skip entries with earlier timestamps
  //
  // Returns:
  //   200 { entries: Entry[], total_lines_scanned: number, truncated: bool }
  addRoute("GET", "/api/v1/admin/chore-generation-audit", async ({ res, query }) => {
    const AUDIT_LOG_PATH = CHORE_GENERATION_AUDIT_LOG;

    let limit = 50;
    const limitRaw = query.get("limit");
    if (limitRaw !== null) {
      if (!/^\d+$/.test(limitRaw)) {
        throw new ValidationError("limit must be a non-negative integer");
      }
      limit = Math.min(parseInt(limitRaw, 10), 500);
    }

    // Parse the since filter as a unix timestamp (seconds). The audit
    // log stores timestamps as epoch seconds via time.time() in Python.
    let sinceEpoch: number | null = null;
    const sinceRaw = query.get("since");
    if (sinceRaw) {
      const parsed = Date.parse(sinceRaw);
      if (isNaN(parsed)) {
        throw new ValidationError("since must be a valid ISO timestamp");
      }
      sinceEpoch = parsed / 1000;
    }

    if (!fs.existsSync(AUDIT_LOG_PATH)) {
      sendJson(res, 200, {
        entries: [],
        total_lines_scanned: 0,
        truncated: false,
        note: "audit log does not exist yet — no generation events recorded",
      });
      return;
    }

    // Read the whole file (it's rotated by nightly_maintenance so it
    // stays bounded). Parse each line as JSON, filter, and take the
    // last `limit` entries.
    const content = fs.readFileSync(AUDIT_LOG_PATH, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const entries: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (sinceEpoch !== null) {
          const ts = entry.timestamp;
          if (typeof ts === "number" && ts < sinceEpoch) continue;
        }
        entries.push(entry);
      } catch {
        // skip malformed lines
      }
    }

    // Return newest-first, capped at limit
    entries.reverse();
    const truncated = entries.length > limit;
    sendJson(res, 200, {
      entries: entries.slice(0, limit),
      total_lines_scanned: lines.length,
      truncated,
    });
  });

  // --- S4-10: emergency-pause-all for chores ---
  //
  // Lists every chore record in vault/chore/ and pauses its Temporal
  // schedule + flips the vault record status to "paused". Used for
  // incident response: if a recent deployment or config change causes
  // chores to misbehave, pause everything at once, investigate, and
  // resume individually.
  //
  // This route is a best-effort batch operation. Failures on individual
  // chores are collected and returned in the response — the overall
  // call still returns 200 as long as SOMETHING paused.
  //
  // Returns:
  //   200 { paused: string[], failed: {slug, error}[], total: number }
  addRoute("POST", "/api/v1/admin/chores/emergency-pause-all", async ({ res }) => {
    const CHORE_DIR = CHORE_VAULT_DIR;
    if (!fs.existsSync(CHORE_DIR)) {
      sendJson(res, 200, {
        paused: [],
        failed: [],
        total: 0,
        note: "no chore directory — nothing to pause",
      });
      return;
    }

    const files = fs
      .readdirSync(CHORE_DIR)
      .filter((name) => name.endsWith(".md"));
    const paused: string[] = [];
    const failed: Array<{ slug: string; error: string }> = [];

    for (const filename of files) {
      const slug = filename.replace(/\.md$/, "");
      try {
        // Pause the Temporal schedule (best-effort). If the schedule
        // doesn't exist we still want to flip the vault status so the
        // state converges.
        try {
          await dockerExec("temporal", [
            "temporal",
            "schedule",
            "toggle",
            "--schedule-id",
            `chore-${slug}`,
            "--pause",
            "--reason",
            "emergency-pause-all",
          ]);
        } catch (err) {
          // Don't bail — still try to flip the vault status below.
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("not found") && !msg.includes("NotFound")) {
            // Unknown schedule error — record it but continue
            failed.push({ slug, error: `schedule toggle: ${msg}` });
            continue;
          }
        }

        // Flip the vault record status to paused. Uses the same
        // in-place replace pattern as the single pause route in
        // chores.ts — safe because we only touch the status: line
        // inside the frontmatter block.
        const fp = `${CHORE_DIR}/${filename}`;
        const content = fs.readFileSync(fp, "utf-8");
        const end = content.indexOf("\n---", 3);
        if (end === -1) {
          failed.push({ slug, error: "no frontmatter terminator" });
          continue;
        }
        const fmBlock = content.slice(0, end);
        const rest = content.slice(end);
        const updated = fmBlock.replace(/^status:\s*.*$/m, "status: paused");
        fs.writeFileSync(fp, updated + rest, "utf-8");

        paused.push(slug);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push({ slug, error: msg });
      }
    }

    sendJson(res, 200, {
      paused,
      failed,
      total: files.length,
    });
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

  // Update .env (surgical patch — preserves comments, blank lines, ordering)
  addRoute("PATCH", "/api/v1/admin/config/env", async ({ res, body }) => {
    const b = body as Record<string, string | null> | undefined;
    if (!b || typeof b !== "object") throw new ValidationError("Request body must be an object of key-value pairs");

    // Prevent overwriting the API key
    if ("AAS_API_KEY" in b) throw new ValidationError("Cannot modify AAS_API_KEY via API");

    let lines: string[];
    try {
      lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
    } catch {
      lines = [];
    }

    const remaining = new Map(Object.entries(b));

    // Update or remove existing lines
    const result = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) return line;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!remaining.has(key)) return line;
      const newValue = remaining.get(key);
      remaining.delete(key);
      if (newValue === null) return null; // remove line
      return `${key}=${newValue}`;
    }).filter((line): line is string => line !== null);

    // Append any new keys not already in the file
    for (const [key, value] of remaining) {
      if (value !== null) {
        result.push(`${key}=${value}`);
      }
    }

    const content = result.join("\n");
    fs.writeFileSync(ENV_PATH, content.endsWith("\n") ? content : content + "\n", "utf-8");
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

  // --- Combined dashboard endpoint (single round-trip) ---

  addRoute("GET", "/api/v1/admin/dashboard", async ({ res }) => {
    // Run all async operations in parallel to minimise total wait time
    const [healthResult, containersResult, devicesResult] = await Promise.allSettled([
      execAsync("/opt/alfred/healthcheck.sh", []).then(r => JSON.parse(r.stdout.trim())),
      dockerComposeCmd(["ps", "--format", "json"]).then(s => parseJsonLines(s)),
      dockerExec("openclaw", [...OPENCLAW_CMD, "devices", "list", "--json"]).then(s => JSON.parse(s)),
    ]);

    // Fast synchronous reads
    const vaultRaw = getVaultContextData();
    const inboxFiles = getInboxFiles();
    let openclawCfg: unknown = {};
    try {
      openclawCfg = JSON.parse(fs.readFileSync(OPENCLAW_JSON_PATH, "utf-8"));
    } catch {
      // file may not exist yet
    }

    sendJson(res, 200, {
      health: healthResult.status === "fulfilled" ? healthResult.value : null,
      containers: containersResult.status === "fulfilled" ? containersResult.value : null,
      devices: devicesResult.status === "fulfilled" ? devicesResult.value : null,
      vault: vaultRaw,
      inbox: { files: inboxFiles },
      openclawCfg,
    });
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

  // Fix OpenClaw memory limit in docker-compose.yaml (safe, non-destructive)
  addRoute("POST", "/api/v1/admin/compose/fix-memory", async ({ res }) => {
    const fs = await import("node:fs");
    const composePath = `${COMPOSE_DIR}/docker-compose.yaml`;
    let content: string;
    try {
      content = fs.readFileSync(composePath, "utf-8");
    } catch (err) {
      sendJson(res, 500, { error: `Cannot read compose file: ${err}` });
      return;
    }

    const changes: string[] = [];

    // Fix openclaw mem_limit: 2g -> 4g
    if (content.includes("mem_limit: 2g")) {
      content = content.replace(/mem_limit: 2g/g, "mem_limit: 4g");
      changes.push("mem_limit: 2g -> 4g (all services)");
    }

    // Add NODE_OPTIONS if not in environment block for openclaw
    if (!content.includes("NODE_OPTIONS")) {
      content = content.replace(
        /- OPENCLAW_GATEWAY_TOKEN_FILE=/,
        "- NODE_OPTIONS=--max-old-space-size=3072\n      - OPENCLAW_GATEWAY_TOKEN_FILE="
      );
      changes.push("Added NODE_OPTIONS=--max-old-space-size=3072 to openclaw");
    }

    // Fix healthcheck retries
    content = content.replace(
      /retries: 10\n(\s+)start_period: 30s/g,
      "retries: 30\n$1start_period: 60s"
    );

    if (changes.length === 0) {
      sendJson(res, 200, { message: "No changes needed — compose already up to date", changes: [] });
      return;
    }

    // Write updated compose
    fs.writeFileSync(composePath, content, "utf-8");

    // Respond immediately, recreate in background
    sendJson(res, 200, { message: "Compose updated. OpenClaw recreating in background.", changes });

    dockerComposeCmd(["up", "-d", "--no-deps", "--force-recreate", "openclaw"]).catch((err) => {
      console.error("Failed to recreate openclaw after compose fix:", err);
    });
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
