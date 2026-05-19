// ============================================================================
// Hermes runtime routes (formerly openclaw.ts).
//
// alfred-black replaces the two-container OpenClaw split with a single
// `hermes` container running two profiles (`main` :18789, `workers` :18790).
// Each profile's Hermes API server binds its canonical port directly — the
// hermes-shim that used to front it was retired in issue #40.
//
// Routes are registered under `/api/v1/hermes/*` only. The Phase-1
// `/api/v1/openclaw/*` alias has been retired (issue #25); every caller
// (dashboard, MCP) uses the canonical `/api/v1/hermes/*` prefix.
//
// Health/status: Hermes is OpenAI-style — `GET /health` over HTTP.
// Restart: `docker compose restart hermes`.
// ============================================================================

import fs from "node:fs";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";
import { dockerExec, dockerComposeCmd, HERMES_CMD, HERMES_CONTAINER } from "../helpers.js";

// Hermes resolves all profile state under HERMES_HOME (default /opt/data in
// the runtime container — see packages/hermes/Dockerfile). Each profile lives
// at ${HERMES_HOME}/profiles/<profile>/config.yaml. ctrl-api reads the `main`
// profile config READ-ONLY to derive the dashboard's tool inventory; it never
// writes it — runtime config changes go through native `hermes` CLI commands
// (`hermes config set`, `hermes tools`). The legacy HERMES_CONFIG_DIR override
// is still honoured for deployments that pin a custom path.
const HERMES_HOME = process.env.HERMES_HOME ?? "/opt/data";
const HERMES_CONFIG_DIR = process.env.HERMES_CONFIG_DIR ?? `${HERMES_HOME}/profiles`;
const HERMES_MAIN_CONFIG = `${HERMES_CONFIG_DIR}/main/config.yaml`;
// The Hermes `main` API server binds `:18789`; `GET /health` is its
// liveness probe.
const HERMES_HEALTH_URL =
  process.env.HERMES_GATEWAY_URL ?? "http://hermes:18789";
const HEALTH_PROBE_TIMEOUT_MS = 1500;

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
  // Register each handler under the canonical /api/v1/hermes/* prefix.
  // The Phase-1 /api/v1/openclaw/* alias was retired in Phase 2 (issue #25).
  const dual = (
    method: string,
    suffix: string,
    handler: Parameters<typeof addRoute>[2],
  ) => {
    addRoute(method, `/api/v1/hermes/${suffix}`, handler);
  };

  // ── Gateway health ────────────────────────────────────────────
  // Hermes exposes `GET /health` (OpenAI-style) on its canonical port, so a
  // plain HTTP GET is the canonical probe.
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
  // Fast, poll-friendly liveness signal for the dashboard.
  //
  // Composio tool access (composio_execute) is served by the always-on
  // `execute` MCP server — connecting/disconnecting an app no longer touches
  // any Hermes config and never triggers a gateway restart. The dashboard's
  // ReconfiguringBanner therefore never fires from this route; the
  // `last_config_touch_at` / `restart_expected_until` fields are retained as
  // permanent nulls only so the web `getOpenclawReadiness` shape is stable.
  dual("GET", "ready", async ({ res }) => {
    let ready = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS);
      const resp = await fetch(`${HERMES_HEALTH_URL}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      ready = resp.ok;
    } catch { /* probe failed — not ready */ }

    sendJson(res, 200, {
      ready,
      last_config_touch_at: null,
      restart_expected_until: null,
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
  // workers `openclaw.json` agent list to read. The native Hermes gateway
  // session index (`sessions.json`, see hermes-sessions.ts) is the source.
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
  // GET .../allowed-tools — built-in + MCP tool inventory (READ-ONLY).
  //
  // The dashboard's /tools page renders this. It is a thin read of the
  // Hermes `main` profile config.yaml — the file Hermes itself owns:
  //
  //   • built-in tools  ← the `platform_toolsets.cli` toolset list (the
  //                        Hermes-native replacement for the OpenClaw
  //                        `gateway.tools.allow` array). These are toolset
  //                        keys (web, file, …), not individual tool names.
  //   • MCP servers     ← the `mcp_servers` map keys.
  //
  // ctrl-api never writes this config — `hermes config set` / `hermes tools`
  // are the native write path. Composio is NOT modelled here: it is a single
  // `composio_execute` MCP tool, surfaced per-connection by the
  // /integrations/:id/capabilities endpoint, not a per-action allow-list.
  // ═════════════════════════════════════════════════════════════
  dual("GET", "allowed-tools", async ({ res }) => {
    const cfg = readHermesConfig(HERMES_MAIN_CONFIG);

    // Built-in capability surface: the `main` profile's CLI platform
    // toolsets. Older configs used `tools.enabled` / `gateway.tools.allow`;
    // tolerate them so the route degrades cleanly on a not-yet-migrated VM.
    const allow: string[] =
      (Array.isArray(cfg?.platform_toolsets?.cli) && cfg.platform_toolsets.cli) ||
      (Array.isArray(cfg?.tools?.enabled) && cfg.tools.enabled) ||
      (Array.isArray(cfg?.gateway?.tools?.allow) && cfg.gateway.tools.allow) ||
      [];

    const mcpSection = cfg?.mcp_servers ?? cfg?.mcp?.servers ?? {};
    const mcpServers: string[] =
      mcpSection && typeof mcpSection === "object" ? Object.keys(mcpSection) : [];

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
      name: "vault_search",
      description:
        "Semantic (meaning-based) vault search backed by the state.db sqlite-vec embedding store — the Hermes-native QMD-recall replacement.",
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

// Short human-readable descriptions for the Hermes built-in toolset keys that
// appear in `platform_toolsets`. These are toolset *groups* (the unit Hermes'
// own `hermes tools` CLI enables/disables), not individual tool names. The
// `hermes-*` keys are the bundled per-platform toolsets; the bare keys are the
// granular built-in toolsets the `workers` profile composes from.
const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
  "hermes-cli": "Full built-in toolset for the CLI surface (terminal, file, web, skills, …).",
  "hermes-telegram": "Built-in toolset for the Telegram channel.",
  "hermes-slack": "Built-in toolset for the Slack channel.",
  "hermes-discord": "Built-in toolset for the Discord channel.",
  "hermes-whatsapp": "Built-in toolset for the WhatsApp channel.",
  "hermes-signal": "Built-in toolset for the Signal channel.",
  terminal: "Run shell commands in the agent workspace.",
  file: "Read, write, patch, and search files in the workspace.",
  web: "Search the web and fetch URL contents.",
  vision: "Inspect images and visual media.",
  skills: "Load and run installed Hermes skills.",
  todo: "Maintain the agent's task list within a run.",
};
