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
import { registerCodexAuthRoutes } from "./hermes_codex_auth.js";

// ---------------------------------------------------------------------------
// Per-MCP-server live tool catalogue cache (issue #185).
//
// For `mcp_servers.<name>.tools.include` ABSENT (mode='all'), config.yaml has
// no list of names — Hermes passes through whatever the running MCP server
// advertises. The only authoritative source is the running process. Hermes'
// HTTP API has no introspection route (probed live: /v1/tools, /v1/mcp,
// /v1/mcp_servers all 404), so we shell out to `hermes mcp test <server>`,
// which connects to the server, lists its tools with descriptions, and exits
// in ~250-300ms per server. Result is text — parsed into the structured
// {name, description} shape callers expect.
//
// Cached for 30s per server. A Hermes restart blows the catalogue but we
// don't need to coordinate with the restart lifecycle — the next request
// after the TTL just re-fetches. A 30s window is short enough that a
// dispositions flip (which triggers a debounced restart) is reflected on
// the user's next refresh.
// ---------------------------------------------------------------------------
interface DiscoveredMcpTool {
  name: string;
  description: string;
}
interface McpToolsCacheEntry {
  tools: DiscoveredMcpTool[];
  fetchedAt: number;
  /** True if the `hermes mcp test` invocation failed; we still cache for a
   *  short window so a misconfigured server doesn't spam docker exec on
   *  every /tools refresh. */
  failed: boolean;
}
const MCP_TOOLS_CACHE = new Map<string, McpToolsCacheEntry>();
const MCP_TOOLS_CACHE_TTL_MS = 30_000;
const MCP_TOOLS_FAILED_TTL_MS = 5_000;

/**
 * Parse the text output of `hermes mcp test <server>` into a list of
 * {name, description} pairs. The CLI prints a header (Testing/Transport/
 * Auth/Connected/Tools discovered), a blank line, then one tool per line:
 *
 *     <name>                                  <description-truncated-to-~60ch>
 *
 * Names start at column ≥4, are word-character identifiers; description
 * is whatever follows the run of ≥2 spaces. Truncation is the CLI's, not
 * ours — we don't try to recover the full description. (Once Hermes grows
 * a JSON output flag we can switch.)
 */
function parseHermesMcpTestOutput(stdout: string): DiscoveredMcpTool[] {
  const out: DiscoveredMcpTool[] = [];
  for (const line of stdout.split("\n")) {
    // Skip header rows + empty rows + status markers (✓ / ✗).
    if (!line.trim()) continue;
    if (/^\s*(Testing|Transport|Auth|Available)\b/.test(line)) continue;
    if (/^\s*[✓✗]/.test(line)) continue;
    // Tool rows: ≥4 leading spaces, identifier, then ≥2 spaces, then prose.
    const m = line.match(/^\s{4,}([A-Za-z_][\w-]*)\s{2,}(.*\S)\s*$/);
    if (!m) continue;
    out.push({ name: m[1], description: m[2] });
  }
  return out;
}

/**
 * Discover the live tool catalogue advertised by one MCP server.
 *
 * Calls `hermes mcp test <server>` inside the hermes container. Cached for
 * MCP_TOOLS_CACHE_TTL_MS so repeat hits on the /tools route within a session
 * don't pay the ~300ms exec cost N times. Returns [] on any failure (server
 * unknown, container missing, parse mismatch) — the caller falls back to
 * whatever shape it had before.
 *
 * @param server  MCP-server name as it appears in config.yaml.mcp_servers
 *                (e.g. 'alfred', 'execute', 'plane', 'files').
 */
async function discoverMcpToolsAdvertised(
  server: string,
): Promise<DiscoveredMcpTool[]> {
  const cached = MCP_TOOLS_CACHE.get(server);
  const now = Date.now();
  if (cached) {
    const ttl = cached.failed ? MCP_TOOLS_FAILED_TTL_MS : MCP_TOOLS_CACHE_TTL_MS;
    if (now - cached.fetchedAt < ttl) return cached.tools;
  }
  try {
    const stdout = await dockerExec(HERMES_CONTAINER, [
      ...HERMES_CMD,
      "mcp",
      "test",
      server,
    ]);
    const tools = parseHermesMcpTestOutput(stdout);
    MCP_TOOLS_CACHE.set(server, { tools, fetchedAt: now, failed: tools.length === 0 });
    return tools;
  } catch {
    MCP_TOOLS_CACHE.set(server, { tools: [], fetchedAt: now, failed: true });
    return [];
  }
}

/** Reset the per-server cache. Test-only. */
export function _resetMcpToolsCacheForTest(): void {
  MCP_TOOLS_CACHE.clear();
}

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
  // Register each handler under the canonical /api/v1/hermes/* prefix AND the
  // legacy /api/v1/openclaw/* alias (C7). The alias was retired in Phase 2
  // (issue #25), but ~7 callers still hit it — the MCP `alfred.ts` tools and
  // learn `briefing.py:1711` — and 404 without it. Registering the same handler
  // reference under both prefixes makes the alias a genuine thin forward (no
  // divergent copy): both routes dispatch to the identical closure.
  const dual = (
    method: string,
    suffix: string,
    handler: Parameters<typeof addRoute>[2],
  ) => {
    addRoute(method, `/api/v1/hermes/${suffix}`, handler);
    addRoute(method, `/api/v1/openclaw/${suffix}`, handler);
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
    // Per-server inclusion metadata — used by the /tools UI's disposition
    // panel so it can render "23 tools (whitelisted)" vs "all tools (count
    // not surfaced)" vs "none — delegated" without lying.
    const mcpServerInclusion: Array<{
      server: string;
      // 'whitelist' — config.yaml has tools.include with explicit names; we
      //   know the exact catalogue and surface it in mcp_tools below.
      // 'all'       — no tools.include set; Hermes passes through whatever
      //   the spawned MCP server advertises. We can't enumerate without
      //   asking the running process, so we report the count as unknown.
      // 'none'      — tools.include is an empty array (the DELEGATED shape
      //   from PR #178). The server still runs for the workers profile but
      //   main's LLM sees nothing.
      mode: "whitelist" | "all" | "none";
      tool_count: number | null;
    }> = [];

    // Partition servers by mode first so the `all` branch can fan out the
    // `hermes mcp test` calls in parallel — sequentially we'd pay
    // N × ~300ms; in parallel the wall-clock is whichever server is slowest.
    const allModeServers: string[] = [];
    for (const server of mcpServers) {
      const serverCfg = mcpSection?.[server] ?? {};
      const includeRaw = serverCfg?.tools?.include;
      const isExplicitList = Array.isArray(includeRaw);
      const known = MCP_SERVER_TOOLS[server];

      if (isExplicitList && includeRaw.length === 0) {
        mcpServerInclusion.push({ server, mode: "none", tool_count: 0 });
        continue;
      }
      if (isExplicitList) {
        // Whitelist — the LLM sees exactly these names every turn. Surface
        // them straight from config.yaml. The runtime's full advertised
        // catalogue may be a superset (e.g. `sure` whitelists 23 of 95) but
        // showing the superset would be MORE dishonest than the whitelist.
        const count = includeRaw.length;
        mcpServerInclusion.push({ server, mode: "whitelist", tool_count: count });
        for (const name of includeRaw as unknown[]) {
          if (typeof name !== "string") continue;
          const desc =
            known?.find((t) => t.name === name)?.description ??
            "(tool advertised by the MCP server; description not catalogued in ctrl-api)";
          mcpTools.push({
            name,
            server,
            description: desc,
            prime_only:
              known?.find((t) => t.name === name)?.prime_only ?? false,
          });
        }
        continue;
      }
      // No include list at all → mode='all'. Schedule a live discovery call
      // and fill in mode/count below once they resolve.
      allModeServers.push(server);
    }

    // Fan out the `hermes mcp test` calls for `all`-mode servers (issue #185).
    // Each is cached in MCP_TOOLS_CACHE; cold path is ~300ms per server,
    // warm path is a Map lookup. The N servers run concurrently so the
    // wall-clock for the cold path is ~max, not ~sum.
    const allModeResults = await Promise.all(
      allModeServers.map(async (server) => ({
        server,
        tools: await discoverMcpToolsAdvertised(server),
      })),
    );

    for (const { server, tools: discovered } of allModeResults) {
      const known = MCP_SERVER_TOOLS[server];
      if (discovered.length > 0) {
        mcpServerInclusion.push({
          server,
          mode: "all",
          tool_count: discovered.length,
        });
        for (const t of discovered) {
          // Description fallback: live description wins; the curated
          // MCP_SERVER_TOOLS map is description-only fallback, not the
          // source of truth for which tools exist.
          const curated = known?.find((k) => k.name === t.name);
          if (curated?.prime_only && !primeEnabled) continue;
          mcpTools.push({
            name: t.name,
            server,
            description: t.description || curated?.description || "",
            prime_only: curated?.prime_only ?? false,
          });
        }
      } else if (known) {
        // Discovery failed (parse mismatch, container missing, …) but we
        // do have curated descriptions for this server — fall back to the
        // pre-#185 behaviour so the page degrades cleanly instead of
        // pretending the server is empty.
        mcpServerInclusion.push({
          server,
          mode: "all",
          tool_count: null,
        });
        for (const t of known) {
          if (t.prime_only && !primeEnabled) continue;
          mcpTools.push({
            name: t.name,
            server,
            description: t.description,
            prime_only: t.prime_only,
          });
        }
      } else {
        // Discovery failed AND no curated fallback — surface the row
        // honestly. The UI renders "all tools" + the fallback copy.
        mcpServerInclusion.push({
          server,
          mode: "all",
          tool_count: null,
        });
      }
    }
    mcpTools.sort((a, b) => a.name.localeCompare(b.name));
    mcpServerInclusion.sort((a, b) => a.server.localeCompare(b.server));

    sendJson(res, 200, {
      builtin_tools: builtinTools,
      mcp_tools: mcpTools,
      mcp_servers: mcpServers,
      mcp_server_inclusion: mcpServerInclusion,
      prime_enabled: primeEnabled,
    });
  });

  // ─── 6th-MCP-server routes (#256 — hermes-mcp): runs / models / cron ───
  //
  // The voice agent (OpenAI Realtime via voice-bridge) gets a 6th MCP server
  // — `hermes` — that surfaces the runtime itself: schedule reminders,
  // delegate background work, list active runs, inspect models. The other 5
  // MCP servers act on Sir's world; this one acts on Alfred-the-runtime.
  //
  // Two transports under the hood:
  //   * HTTP — runs / models. Calls hermes:18789 (main) or :18790 (workers).
  //     API key is profile-scoped, read from /hermes-state/profiles/<p>/.env
  //     at call time (no caching — a hermes rebuild rotates the key without
  //     bouncing ctrl-api).
  //   * docker exec — cron. Hermes' /v1/* HTTP API doesn't expose cron;
  //     the `hermes cron {list,create,remove}` CLI is the contract surface.
  //
  // Auth at the ingress is the same AAS_API_KEY bearer the rest of
  // /api/v1/* requires; mcp-server proxies through here exactly like the
  // alfred / sure / plane / vaultwarden / execute MCP apps do.
  // See packages/mcp-server/src/tools/hermes.ts for the tool defs and
  // packages/hermes/workspace-template/skills/alfred-hermes-operations/
  // SKILL.md for the agent-facing contract.

  type Profile = "main" | "workers";
  const HERMES_MAIN_API_URL =
    process.env.HERMES_GATEWAY_URL ?? "http://hermes:18789";
  const HERMES_WORKERS_API_URL =
    process.env.HERMES_WORKERS_GATEWAY_URL ?? "http://hermes:18790";

  function parseProfile(raw: unknown, fallback: Profile): Profile {
    return raw === "main" || raw === "workers" ? raw : fallback;
  }
  function profileBaseUrl(p: Profile): string {
    return p === "workers" ? HERMES_WORKERS_API_URL : HERMES_MAIN_API_URL;
  }

  /** Read API_SERVER_KEY for the given Hermes profile out of its .env. */
  function readHermesApiKey(p: Profile): string | null {
    const envPath = `${HERMES_CONFIG_DIR}/${p}/.env`;
    let raw: string;
    try {
      raw = fs.readFileSync(envPath, "utf-8");
    } catch {
      return null;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      if (trimmed.slice(0, eq).trim() === "API_SERVER_KEY") {
        return trimmed.slice(eq + 1).trim();
      }
    }
    return null;
  }

  async function hermesHttp(
    profile: Profile,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    const key = readHermesApiKey(profile);
    if (!key) {
      return {
        status: 500,
        data: {
          error: "HERMES_KEY_MISSING",
          detail: `Hermes API key not found at ${HERMES_CONFIG_DIR}/${profile}/.env — has hermes-init run?`,
        },
      };
    }
    const url = `${profileBaseUrl(profile)}${path}`;
    const init: RequestInit & { signal: AbortSignal } = {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    };
    if (body !== undefined && method === "POST") {
      init.body = JSON.stringify(body);
    }
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err: any) {
      return {
        status: 502,
        data: {
          error: "HERMES_UNREACHABLE",
          detail: `${url}: ${err?.message ?? String(err)}`,
        },
      };
    }
    const text = await resp.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: resp.status, data };
  }

  function tryJsonParse(text: string): {
    json?: unknown;
    raw?: string;
  } {
    const trimmed = text.trim();
    if (!trimmed) return { json: null };
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return { json: JSON.parse(trimmed) };
      } catch {
        /* fall through to raw */
      }
    }
    return { raw: text };
  }

  // GET /api/v1/hermes/models?profile=main|workers
  // Returns the OpenAI-API `/v1/models` shape (Hermes treats profiles as
  // "models" for compat with OpenAI SDKs).
  addRoute("GET", "/api/v1/hermes/models", async ({ res, query }) => {
    const profile = parseProfile(query.get("profile"), "main");
    const out = await hermesHttp(profile, "GET", "/v1/models");
    sendJson(res, out.status, out.data ?? {});
  });

  // POST /api/v1/hermes/runs
  //   body: { prompt, profile?, model?, return_via?, session_id? }
  // Forwards to Hermes `POST /v1/runs`. `return_via:{channel,chat_id?}` gets
  // appended to the prompt as a trailing instruction so the run knows where
  // to deliver its result (Hermes' API has no native parameter for this).
  addRoute("POST", "/api/v1/hermes/runs", async ({ res, body }) => {
    const b = (body as Record<string, unknown>) || {};
    const prompt = b.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      sendJson(res, 400, { error: "prompt (string) is required" });
      return;
    }
    const profile = parseProfile(b.profile, "workers");
    const model = typeof b.model === "string" ? b.model : undefined;
    const sessionId =
      typeof b.session_id === "string" ? b.session_id : undefined;

    let finalPrompt = prompt.trim();
    const rv = b.return_via;
    if (rv && typeof rv === "object" && !Array.isArray(rv)) {
      const ch = (rv as any).channel;
      const cid = (rv as any).chat_id;
      if (typeof ch === "string" && ch) {
        const where = typeof cid === "string" && cid ? `${ch}:${cid}` : ch;
        finalPrompt =
          `${finalPrompt}\n\nWhen complete, deliver the result via the ${where} channel.`;
      }
    }

    const hermesBody: Record<string, unknown> = { input: finalPrompt };
    if (model) hermesBody.model = model;
    if (sessionId) hermesBody.session_id = sessionId;

    const out = await hermesHttp(profile, "POST", "/v1/runs", hermesBody);
    const payload =
      out.data && typeof out.data === "object"
        ? (out.data as Record<string, unknown>)
        : {};
    sendJson(res, out.status, { profile, ...payload });
  });

  // POST /api/v1/hermes/runs/:id/stop?profile=
  addRoute(
    "POST",
    "/api/v1/hermes/runs/:id/stop",
    async ({ res, params, query }) => {
      const profile = parseProfile(query.get("profile"), "workers");
      const out = await hermesHttp(
        profile,
        "POST",
        `/v1/runs/${encodeURIComponent(params.id)}/stop`,
      );
      sendJson(res, out.status, out.data ?? {});
    },
  );

  // GET /api/v1/hermes/cron?profile=main
  addRoute("GET", "/api/v1/hermes/cron", async ({ res, query }) => {
    const profile = parseProfile(query.get("profile"), "main");
    const stdout = await dockerExec(HERMES_CONTAINER, [
      ...HERMES_CMD,
      "--profile",
      profile,
      "cron",
      "list",
    ]);
    const parsed = tryJsonParse(stdout);
    sendJson(res, 200, { profile, ...parsed });
  });

  // POST /api/v1/hermes/cron
  //   body: { prompt, when, channel?, chat_id?, profile? }
  //   `when` is ISO-8601 OR a 5-field cron expression — Hermes accepts both.
  addRoute("POST", "/api/v1/hermes/cron", async ({ res, body }) => {
    const b = (body as Record<string, unknown>) || {};
    const prompt = b.prompt;
    const when = b.when;
    if (typeof prompt !== "string" || !prompt.trim()) {
      sendJson(res, 400, { error: "prompt (string) is required" });
      return;
    }
    if (typeof when !== "string" || !when.trim()) {
      sendJson(res, 400, {
        error:
          "when (string — ISO-8601 timestamp or cron expression) is required",
      });
      return;
    }
    const profile = parseProfile(b.profile, "main");
    const channel = typeof b.channel === "string" ? b.channel : undefined;
    const chatId = typeof b.chat_id === "string" ? b.chat_id : undefined;

    // Mark the prompt so a fired job knows the delivery target. Hermes
    // cron forwards the prompt verbatim to the profile's run pipeline;
    // the gateway adapters then route on the [scheduled→…] marker.
    const finalPrompt = channel
      ? `${prompt.trim()}\n\n[scheduled→${channel}${chatId ? `:${chatId}` : ""}]`
      : prompt.trim();

    const args = [
      ...HERMES_CMD,
      "--profile",
      profile,
      "cron",
      "create",
      "--when",
      when,
      "--prompt",
      finalPrompt,
    ];
    if (channel) args.push("--channel", channel);
    if (chatId) args.push("--chat-id", chatId);

    const stdout = await dockerExec(HERMES_CONTAINER, args);
    const parsed = tryJsonParse(stdout);
    sendJson(res, 201, {
      profile,
      when,
      channel: channel ?? null,
      ...parsed,
    });
  });

  // DELETE /api/v1/hermes/cron/:id?profile=main
  addRoute(
    "DELETE",
    "/api/v1/hermes/cron/:id",
    async ({ res, params, query }) => {
      const profile = parseProfile(query.get("profile"), "main");
      const stdout = await dockerExec(HERMES_CONTAINER, [
        ...HERMES_CMD,
        "--profile",
        profile,
        "cron",
        "remove",
        params.id,
      ]);
      sendJson(res, 200, { profile, ok: true, output: stdout.trim() });
    },
  );

  // ── Codex OAuth ceremony from the dashboard (#300) ────────────────────────
  registerCodexAuthRoutes();
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
