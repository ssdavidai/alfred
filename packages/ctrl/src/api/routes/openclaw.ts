import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";
import { dockerExec, dockerComposeCmd, OPENCLAW_CMD } from "../helpers.js";

const OPENCLAW_CONFIG_PATH = "/mnt/encrypted/openclaw/openclaw.json";
const OPENCLAW_GATEWAY_URL = "http://openclaw:18789/healthz";
const HEALTHZ_PROBE_TIMEOUT_MS = 1500;
// How long after a config touch we still assume an openclaw restart is
// in-flight. Measured restart time on a fresh Composio connect was ~40s
// on a cx53 Hetzner VPS; 60s gives us comfortable headroom.
const RESTART_WINDOW_MS = 60_000;

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

  // Gateway readiness — fast, poll-friendly signal for the dashboard to
  // detect the ~40s 502 window that follows a gateway.tools.allow change.
  // Response:
  //   { ready: bool,
  //     last_config_touch_at: iso | null,
  //     restart_expected_until: iso | null }
  // `restart_expected_until` is set iff the probe is failing AND
  // `meta.lastTouchedAt` is within the last RESTART_WINDOW_MS — meaning
  // "openclaw is restarting, expect it back by this time".
  addRoute("GET", "/api/v1/openclaw/ready", async ({ res }) => {
    let lastTouchedAt: string | null = null;
    try {
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
      const cfg = JSON.parse(raw);
      const v = cfg?.meta?.lastTouchedAt;
      if (typeof v === "string" && v.length > 0) lastTouchedAt = v;
    } catch { /* file may not exist or be unparseable; treat as null */ }

    let ready = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HEALTHZ_PROBE_TIMEOUT_MS);
      const resp = await fetch(OPENCLAW_GATEWAY_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      ready = resp.ok;
    } catch { /* probe failed — not ready */ }

    let restartExpectedUntil: string | null = null;
    if (!ready && lastTouchedAt) {
      const touchMs = Date.parse(lastTouchedAt);
      if (Number.isFinite(touchMs) && Date.now() - touchMs < RESTART_WINDOW_MS) {
        restartExpectedUntil = new Date(touchMs + RESTART_WINDOW_MS).toISOString();
      }
    }

    sendJson(res, 200, {
      ready,
      last_config_touch_at: lastTouchedAt,
      restart_expected_until: restartExpectedUntil,
    });
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

  // =========================================================================
  // GET /api/v1/openclaw/allowed-tools — list every tool Alfred can invoke
  //
  // Reads the tenant's gateway.tools.allow + mcp.servers from openclaw.json
  // and classifies each entry so the SaaS Tools page can render a grouped
  // view. Classification is heuristic but deterministic:
  //   - mcp        → server names declared under mcp.servers (e.g. "self",
  //                  "tenant", "ask_alfred" for Prime)
  //   - composio   → UPPERCASE_SNAKE_CASE action slugs (GMAIL_FETCH_EMAILS)
  //                  — we also split off the toolkit prefix so the page
  //                  can group them
  //   - builtin    → everything else (sessions_*, web_search, web_fetch,
  //                  composio_execute gateway tool, ...)
  // =========================================================================
  addRoute("GET", "/api/v1/openclaw/allowed-tools", async ({ res }) => {
    let cfg: any = {};
    try {
      cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    } catch {
      // No config → nothing to return, but still succeed so the SaaS page
      // can render an "(empty)" state rather than a 500.
    }

    const allow: string[] = Array.isArray(cfg?.gateway?.tools?.allow)
      ? cfg.gateway.tools.allow
      : [];
    const mcpServers: string[] = cfg?.mcp?.servers
      ? Object.keys(cfg.mcp.servers)
      : [];
    const mcpNames = new Set<string>();
    for (const s of mcpServers) {
      // Some MCP servers declare the tool names they expose; others don't.
      // Either way, the server key itself is usually also the tool name
      // (e.g. "self"). Collect both.
      mcpNames.add(s);
      const tools = cfg.mcp.servers?.[s]?.tools;
      if (Array.isArray(tools)) {
        for (const t of tools) {
          if (typeof t === "string") mcpNames.add(t);
          else if (t && typeof t.name === "string") mcpNames.add(t.name);
        }
      }
    }

    const tools = allow.map((name: string) => {
      let group: "builtin" | "mcp" | "composio" = "builtin";
      let toolkit: string | null = null;

      if (mcpNames.has(name)) {
        group = "mcp";
      } else if (/^[A-Z][A-Z0-9]+(_[A-Z0-9]+)+$/.test(name)) {
        group = "composio";
        toolkit = name.split("_")[0].toLowerCase();
      }

      return { name, group, toolkit };
    });

    sendJson(res, 200, {
      tools,
      count: tools.length,
      mcp_servers: mcpServers,
    });
  });
}
