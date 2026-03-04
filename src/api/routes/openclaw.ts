import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";
import { dockerExec, dockerComposeCmd, OPENCLAW_CMD } from "../helpers.js";

export function registerOpenClawRoutes(): void {
  // Gateway health
  addRoute("GET", "/api/v1/openclaw/health", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "gateway", "health"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Gateway status
  addRoute("GET", "/api/v1/openclaw/status", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "gateway", "status"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Restart openclaw container
  addRoute("POST", "/api/v1/openclaw/restart", async ({ res }) => {
    await dockerComposeCmd(["restart", "openclaw"]);
    sendJson(res, 200, { message: "OpenClaw container restarted" });
  });

  // Skills
  addRoute("GET", "/api/v1/openclaw/skills", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "skills"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Sessions
  addRoute("GET", "/api/v1/openclaw/sessions", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "sessions"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Agents
  addRoute("GET", "/api/v1/openclaw/agents", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "agents"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Cron
  addRoute("GET", "/api/v1/openclaw/cron", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "cron"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Plugins
  addRoute("GET", "/api/v1/openclaw/plugins", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "plugins"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Hooks
  addRoute("GET", "/api/v1/openclaw/hooks", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "hooks"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Secrets (masked)
  addRoute("GET", "/api/v1/openclaw/secrets", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "secrets"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Doctor
  addRoute("POST", "/api/v1/openclaw/doctor", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "doctor"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Security audit
  addRoute("GET", "/api/v1/openclaw/security", async ({ res }) => {
    const stdout = await dockerExec("openclaw", [...OPENCLAW_CMD, "security"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // Memory search
  addRoute("GET", "/api/v1/openclaw/memory", async ({ res, query }) => {
    const args = [...OPENCLAW_CMD, "memory"];
    const q = query.get("query");
    if (q) args.push(q);
    const stdout = await dockerExec("openclaw", args);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });
}
