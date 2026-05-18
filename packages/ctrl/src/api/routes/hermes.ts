// ============================================================================
// Hermes runtime routes (formerly openclaw.ts).
//
// alfred-black replaces the two-container OpenClaw split with a single
// `hermes` container running two profiles (`main` :18789, `workers` :18790).
// The runtime is reached through the hermes-shim, which preserves the OpenClaw
// `POST /tools/invoke` contract — so most route logic here is unchanged; what
// changes is the container/command names and config paths.
//
// Routes are registered under BOTH:
//   * /api/v1/hermes/*    — the canonical prefix.
//   * /api/v1/openclaw/*  — kept as an alias for one release so existing
//                           callers (dashboard, MCP) keep working. Drop in
//                           Phase 2.
//
// Health/status: Hermes is OpenAI-style — `GET /health` over HTTP (the shim
// proxies it). Restart: `docker compose restart hermes`.
// ============================================================================

import fs from "node:fs";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";
import { dockerExec, dockerComposeCmd, HERMES_CMD, HERMES_CONTAINER } from "../helpers.js";

// Hermes per-profile config lives in the hermes_data volume, one config.yaml
// per profile. The `main` profile config doubles as the source for the
// tool-enable list and MCP server inventory the /tools dashboard reads.
const HERMES_CONFIG_DIR = process.env.HERMES_CONFIG_DIR ?? "/hermes-data";
const HERMES_MAIN_CONFIG = `${HERMES_CONFIG_DIR}/main/config.yaml`;
// The shim binds the legacy port; `GET /health` is the Hermes liveness probe.
const HERMES_HEALTH_URL =
  process.env.HERMES_GATEWAY_URL ?? "http://hermes:18789";
const HEALTH_PROBE_TIMEOUT_MS = 1500;
// How long after a config touch we still assume a hermes restart is in-flight.
const RESTART_WINDOW_MS = 60_000;

/** Load + parse a Hermes profile config.yaml. Returns {} if unreadable. */
function readHermesConfig(configPath: string): Record<string, any> {
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch {
    /* missing / unparseable — caller handles the empty case */
  }
  return {};
}

export function registerHermesRoutes(): void {
  // Register every handler under both prefixes.
  const dual = (
    method: string,
    suffix: string,
    handler: Parameters<typeof addRoute>[2],
  ) => {
    addRoute(method, `/api/v1/hermes/${suffix}`, handler);
    addRoute(method, `/api/v1/openclaw/${suffix}`, handler);
  };

  // ── Gateway health ────────────────────────────────────────────
  // Hermes exposes `GET /health` (OpenAI-style). The shim proxies it on the
  // legacy port, so a plain HTTP GET is the canonical probe.
  dual("GET", "health", async ({ res }) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS);
      const resp = await fetch(`${HERMES_HEALTH_URL}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      const text = await resp.text();
      try {
        sendJson(res, resp.ok ? 200 : 503, JSON.parse(text));
      } catch {
        sendJson(res, resp.ok ? 200 : 503, { ok: resp.ok, raw: text.trim() });
      }
    } catch (err) {
      sendJson(res, 503, { ok: false, error: String(err) });
    }
  });

  // ── Gateway readiness ─────────────────────────────────────────
  // Fast, poll-friendly signal for the dashboard to detect the restart
  // window that follows a tool-enable config change.
  dual("GET", "ready", async ({ res }) => {
    let lastTouchedAt: string | null = null;
    try {
      const cfg = readHermesConfig(HERMES_MAIN_CONFIG);
      const v = cfg?.meta?.last_touched_at ?? cfg?.meta?.lastTouchedAt;
      if (typeof v === "string" && v.length > 0) lastTouchedAt = v;
    } catch { /* treat as null */ }

    let ready = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS);
      const resp = await fetch(`${HERMES_HEALTH_URL}/health`, { signal: ctrl.signal });
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

  // ── Gateway status ────────────────────────────────────────────
  dual("GET", "status", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "gateway", "status"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // ── Restart the hermes container ──────────────────────────────
  dual("POST", "restart", async ({ res }) => {
    await dockerComposeCmd(["restart", HERMES_CONTAINER]);
    sendJson(res, 200, { message: "Hermes container restarted" });
  });

  // ── Skills ────────────────────────────────────────────────────
  dual("GET", "skills", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "skills"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // ── Sessions ──────────────────────────────────────────────────
  dual("GET", "sessions", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "sessions"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // ── Agents ────────────────────────────────────────────────────
  dual("GET", "agents", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "agents"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // GET .../agents/ephemeral — in-flight ephemeral exec-* runs.
  //
  // Under Hermes an ephemeral executor is a `POST /v1/runs` against the
  // workers profile with session_id = `exec-<hash>` — there is no longer a
  // workers `openclaw.json` agent list to read. The shim's in-memory
  // run→channel map is the source; `hermes sessions --json` surfaces it.
  // Filtered to the `exec-` prefix. Returns the structured shape briefing.py
  // and the alfred-self MCP `list_in_flight_agents` tool consume.
  dual("GET", "agents/ephemeral", async ({ res }) => {
    let runs: any[] = [];
    try {
      const stdout = await dockerExec(HERMES_CONTAINER, [
        ...HERMES_CMD,
        "-p",
        "workers",
        "sessions",
        "--json",
      ]);
      const parsed = JSON.parse(stdout);
      runs = Array.isArray(parsed) ? parsed : (parsed?.sessions ?? parsed?.runs ?? []);
    } catch {
      sendJson(res, 200, { agents: [], count: 0, last_touched_at: null });
      return;
    }
    const ephemeral = (Array.isArray(runs) ? runs : [])
      .filter((r) => {
        const id = String(r?.session_id ?? r?.id ?? "");
        return id.startsWith("exec-");
      })
      .map((r) => {
        const id = String(r?.session_id ?? r?.id ?? "");
        return {
          id,
          name: String(r?.name ?? `Ephemeral ${id}`),
          model: r?.model ?? null,
          tools_allow_count: Array.isArray(r?.tools) ? r.tools.length : null,
          started_at_hint: r?.created_at ?? null,
        };
      });
    sendJson(res, 200, {
      agents: ephemeral,
      count: ephemeral.length,
      last_touched_at: null,
    });
  });

  // ── Cron ──────────────────────────────────────────────────────
  dual("GET", "cron", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "cron"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // ── Plugins ───────────────────────────────────────────────────
  dual("GET", "plugins", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "plugins"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // ── Hooks ─────────────────────────────────────────────────────
  dual("GET", "hooks", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "hooks"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // ── Secrets (masked) ──────────────────────────────────────────
  dual("GET", "secrets", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "secrets"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // ── Doctor ────────────────────────────────────────────────────
  dual("POST", "doctor", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "doctor"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // ── Security audit ────────────────────────────────────────────
  dual("GET", "security", async ({ res }) => {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "security"]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // ── Memory search ─────────────────────────────────────────────
  dual("GET", "memory", async ({ res, query }) => {
    const args = [...HERMES_CMD, "memory"];
    const q = query.get("query");
    if (q) args.push(q);
    const stdout = await dockerExec(HERMES_CONTAINER, args);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout.trim() });
    }
  });

  // ═════════════════════════════════════════════════════════════
  // GET .../allowed-tools — built-in + MCP tool inventory.
  //
  // Returns the two tool surfaces that live outside Composio. Sourced from
  // the Hermes `main` profile config.yaml tool-enable section (was
  // `gateway.tools.allow` in openclaw.json).
  // ═════════════════════════════════════════════════════════════
  dual("GET", "allowed-tools", async ({ res }) => {
    const cfg = readHermesConfig(HERMES_MAIN_CONFIG);

    // Hermes config tool-enable section. Tolerate a few shapes so the route
    // is robust to the exact key the hermes-config template settles on.
    const allow: string[] =
      (Array.isArray(cfg?.tools?.enabled) && cfg.tools.enabled) ||
      (Array.isArray(cfg?.tools?.allow) && cfg.tools.allow) ||
      (Array.isArray(cfg?.gateway?.tools?.allow) && cfg.gateway.tools.allow) ||
      [];

    const mcpSection = cfg?.mcp?.servers ?? cfg?.mcp_servers ?? {};
    const mcpServers: string[] = mcpSection ? Object.keys(mcpSection) : [];

    // Strip Composio action slugs — described separately via the
    // per-connection capabilities endpoint.
    const builtinTools = allow
      .filter((name) => !/^[A-Z][A-Z0-9]+(_[A-Z0-9]+)+$/.test(name))
      .map((name) => ({
        name,
        description: BUILTIN_TOOL_DESCRIPTIONS[name] ?? null,
      }));
    builtinTools.sort((a, b) => a.name.localeCompare(b.name));

    const primeEnabled = process.env.ALFRED_PRIME === "true";
    const mcpTools: Array<{
      name: string;
      server: string;
      description: string;
      prime_only: boolean;
    }> = [];
    for (const server of mcpServers) {
      const known = MCP_SERVER_TOOLS[server];
      if (!known) continue;
      for (const t of known) {
        if (t.prime_only && !primeEnabled) continue;
        mcpTools.push({
          name: t.name,
          server,
          description: t.description,
          prime_only: t.prime_only,
        });
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

/** @deprecated old name — kept so server.ts keeps compiling this release. */
export const registerOpenClawRoutes = registerHermesRoutes;

// -----------------------------------------------------------------------------
// Known MCP servers → tool names. Update this table when a new MCP server is
// added to the Hermes workspace.
// -----------------------------------------------------------------------------
const MCP_SERVER_TOOLS: Record<
  string,
  Array<{ name: string; description: string; prime_only: boolean }>
> = {
  "alfred-ctrl": [
    {
      name: "self",
      description:
        "Call this instance's ctrl-api. Alfred's primary way to read the vault, manage streams, create chores, etc.",
      prime_only: false,
    },
    {
      name: "tenant",
      description:
        "Call a peer instance's ctrl-api. Alfred Prime only.",
      prime_only: true,
    },
    {
      name: "ask_alfred",
      description:
        "Hand a prompt to a peer instance's Alfred and get their reasoned reply. Alfred Prime only.",
      prime_only: true,
    },
  ],
};

// Short human-readable descriptions for the built-in gateway tools. The
// session_* tool names are the OpenClaw-contract names the hermes-shim
// re-exposes — callers and the dashboard still see them.
const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
  web_search: "Search the web via the configured search provider.",
  web_fetch: "Fetch a URL and return the cleaned text contents.",
  composio_execute:
    "Dispatch any Composio action (Gmail, Slack, Notion, …) on a connected account.",
  ctrl_composio_execute:
    "(legacy dispatch name, superseded by composio_execute — kept for in-flight sessions)",
  sessions_list: "List active sessions / runs on this instance.",
  sessions_spawn: "Spawn a new session / subagent run.",
  sessions_send: "Send a message to a running session.",
  sessions_history: "Read the message history of a session / run.",
  sessions_delete: "Delete / stop a session run.",
};
