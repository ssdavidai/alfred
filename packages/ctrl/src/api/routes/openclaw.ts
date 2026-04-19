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
  // GET /api/v1/openclaw/allowed-tools — the built-in + MCP tool inventory
  //
  // Returns the two tool surfaces that live outside of Composio:
  //
  //   builtin_tools[] — openclaw gateway tools registered in
  //                     `gateway.tools.allow`, excluding Composio action
  //                     slugs (those belong to per-app capabilities, not
  //                     the global allowlist). Includes sessions_*,
  //                     web_search, web_fetch, composio_execute.
  //
  //   mcp_tools[]     — the actual tool names exposed by each MCP server
  //                     under `mcp.servers`, not the server keys. We have
  //                     a small known-servers table (alfred-ctrl → self,
  //                     tenant, ask_alfred) so we don't need to probe the
  //                     MCP server at list time. `prime` flag indicates
  //                     whether tenant/ask_alfred are exposed (gated on
  //                     ALFRED_PRIME=true + CROSS_TENANT_PEERS).
  //
  // Composio app actions are NOT in this response — the SaaS Tools page
  // fans out per-connection to /api/v1/integrations/:id/capabilities for
  // the displayName + description metadata Composio provides.
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

    // Strip Composio action slugs from the allowlist — they're per-app
    // tools, described separately via the capabilities endpoint.
    const builtinTools = allow
      .filter((name) => !/^[A-Z][A-Z0-9]+(_[A-Z0-9]+)+$/.test(name))
      .map((name) => ({
        name,
        description: BUILTIN_TOOL_DESCRIPTIONS[name] ?? null,
      }));
    builtinTools.sort((a, b) => a.name.localeCompare(b.name));

    // MCP tools — known-servers table keyed by server name. Prime tools
    // only ship when the env flag is set (they're gated in ctrl-server.mjs).
    const primeEnabled = process.env.ALFRED_PRIME === "true";
    const mcpTools: Array<{ name: string; server: string; description: string; prime_only: boolean }> = [];
    for (const server of mcpServers) {
      const known = MCP_SERVER_TOOLS[server];
      if (!known) continue;
      for (const t of known) {
        if (t.prime_only && !primeEnabled) continue;
        mcpTools.push({ name: t.name, server, description: t.description, prime_only: t.prime_only });
      }
    }
    mcpTools.sort((a, b) => a.name.localeCompare(b.name));

    sendJson(res, 200, {
      builtin_tools: builtinTools,
      mcp_tools: mcpTools,
      mcp_servers: mcpServers,
      prime_enabled: primeEnabled,
    });
  });
}

// -----------------------------------------------------------------------------
// Known MCP servers → tool names. Update this table when a new MCP server is
// added to the tenant workspace. Keeping it static here is cheaper and more
// reliable than probing the MCP server on every list request.
// -----------------------------------------------------------------------------
const MCP_SERVER_TOOLS: Record<string, Array<{ name: string; description: string; prime_only: boolean }>> = {
  "alfred-ctrl": [
    {
      name: "self",
      description:
        "Call this tenant's ctrl-api. Alfred's primary way to read the vault, manage streams, create chores, etc.",
      prime_only: false,
    },
    {
      name: "tenant",
      description:
        "Call a peer tenant's ctrl-api over Tailscale. Alfred Prime only — lets David operate on Miguel/Rapali/other tenants.",
      prime_only: true,
    },
    {
      name: "ask_alfred",
      description:
        "Hand a prompt to a peer tenant's Alfred and get their reasoned reply. Alfred Prime only.",
      prime_only: true,
    },
  ],
};

// Short human-readable descriptions for the built-in gateway tools. These
// ship with openclaw — we hardcode the stable core set here since the tenant
// has no other metadata source for them.
const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
  web_search: "Search the web via the configured search provider.",
  web_fetch: "Fetch a URL and return the cleaned text contents.",
  composio_execute:
    "Dispatch any Composio action (Gmail, Slack, Notion, …) on a connected account.",
  ctrl_composio_execute:
    "(legacy dispatch name, superseded by composio_execute — kept for in-flight sessions)",
  sessions_list: "List active openclaw sessions on this tenant.",
  sessions_spawn: "Spawn a new openclaw session / subagent.",
  sessions_send: "Send a message to a running openclaw session.",
  sessions_history: "Read the message history of an openclaw session.",
  sessions_delete: "Delete an openclaw session.",
};
