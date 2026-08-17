// MCP-client wiring for the voice agent.
//
// Voice-bridge runs OpenAI Realtime, but the agent's tool surface mirrors
// Hermes-main's: the same five MCP servers (alfred, sure, plane, vaultwarden,
// execute) that Hermes connects to over stdio. On voice we reach them over
// HTTP — the docker-internal URL `http://mcp-server:8787/<app>/mcp`, with
// `Authorization: Bearer ${MCP_APPROVAL_SECRET}` via the bypass added in
// PR #44/#45.
//
// On voice-bridge boot:
//   * connect one MCP client per server (best-effort — one server being
//     down must not stop voice from working)
//   * tools/list each connected server → cache the union under
//     `<server>__<tool>` prefixed names so OpenAI Realtime can address
//     them unambiguously
//
// Per call:
//   * the tool catalog is read out of the cache and merged into
//     session.update tools
//   * tool dispatches whose name starts with `<server>__` are routed here;
//     everything else stays on the legacy `self` / `composio_execute` path
//
// On disconnect / error: the cache entry stays usable; the client tries
// to reconnect lazily on next dispatch. The MCP SDK's StreamableHTTP
// transport handles request-level retries; we don't add another loop.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "./config.js";

// 6 built-in servers: the original 5 (Sir's world) + hermes (the runtime
// itself — added 2026-05-26 so the voice agent can schedule reminders +
// delegate background work, not just act on the vault/finances/etc.).
// All 6 live under MCP_SERVER_URL (the per-tenant mcp-server container)
// at `<base>/<app>/mcp` and authenticate with MCP_APPROVAL_SECRET.
const APPS = ["alfred", "sure", "plane", "vaultwarden", "execute", "hermes"] as const;

/** Separator we use to prefix MCP tool names. Two underscores so it never
 *  collides with an actual tool name (MCP tools use single-underscore /
 *  kebab-case). Also legal in OpenAI Realtime's function-name grammar. */
const PREFIX_SEP = "__";

/** One MCP server target — built-in or external. Lower-case ASCII names
 *  only (any other characters get sanitised on parse below). */
interface McpTarget {
  name: string;
  url: string;
  /** Bearer token. Empty for unauth endpoints; defaults to the
   *  MCP_APPROVAL_SECRET for built-in servers. */
  bearer: string;
}

interface McpToolDef {
  serverName: string;
  originalName: string;
  /** `<server>__<tool>` — what OpenAI Realtime sees and the dispatcher matches on. */
  prefixedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const clients = new Map<string, Client>();
const toolCatalog: McpToolDef[] = [];

/** Parse MCP_EXTERNAL_SERVERS env var (see config.ts comment for format).
 *  Returns the same McpTarget shape connectOne consumes. Per-tenant
 *  external servers — e.g. `cdsk=https://joe.ngrok.pizza/mcp/mcp` for
 *  the Contractor's Desk on Joe's tenant.
 *
 *  Why a flat env var rather than a config file: this is set per-tenant
 *  via docker-compose.override.yaml on the host (the durable seam for
 *  tenant-specific patches that survives docker compose pull), so a
 *  string env var is the right granularity. */
function parseExternalServers(raw: string): McpTarget[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry): McpTarget | null => {
      // Form: `name=url` or `name=url=bearer`. Split on the FIRST `=` for
      // the name, then on the LAST `=` after the URL for the optional
      // bearer. URLs contain no `=` in practice; if a query-string `?k=v`
      // appears, the LAST-`=` heuristic still works because the bearer
      // (when set) is plain alphanumeric/hex.
      const eq1 = entry.indexOf("=");
      if (eq1 < 0) return null;
      const name = entry.slice(0, eq1).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      const rest = entry.slice(eq1 + 1).trim();
      if (!name || !rest) return null;
      // If `rest` contains `=` AFTER the URL scheme, treat the trailing
      // segment as the bearer. Conservative: require an https:// prefix
      // and split only when there's a non-URL-shaped suffix after a `=`.
      const tail = rest.lastIndexOf("=");
      if (tail > 0 && !rest.slice(tail + 1).includes("/")) {
        return { name, url: rest.slice(0, tail), bearer: rest.slice(tail + 1) };
      }
      return { name, url: rest, bearer: "" };
    })
    .filter((t): t is McpTarget => !!t);
}

async function connectOne(target: McpTarget): Promise<void> {
  const url = new URL(target.url);
  const headers: Record<string, string> = {};
  if (target.bearer) {
    headers.Authorization = `Bearer ${target.bearer}`;
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  const client = new Client(
    { name: "alfred-voice-bridge", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
  } catch (err) {
    console.warn(
      `[mcp] connect ${target.name} failed (continuing without it):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  let listed;
  try {
    listed = await client.listTools();
  } catch (err) {
    console.warn(
      `[mcp] tools/list ${target.name} failed (continuing without it):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  for (const tool of listed.tools ?? []) {
    toolCatalog.push({
      serverName: target.name,
      originalName: tool.name,
      prefixedName: `${target.name}${PREFIX_SEP}${tool.name}`,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    });
  }
  clients.set(target.name, client);
  console.log(`[mcp] connected ${target.name}: ${(listed.tools ?? []).length} tools`);
}

/**
 * Connect to every MCP server in parallel. Always resolves; per-server
 * failures are logged and the agent runs with whatever subset came up.
 * Idempotent — repeated calls just re-list tools.
 */
export async function connectAllMcp(): Promise<void> {
  // Reset state so reconnects don't double-count.
  toolCatalog.length = 0;
  const baseUrl = config.mcpServerUrl.replace(/\/+$/, "");
  const builtIn: McpTarget[] = APPS.map((app) => ({
    name: app,
    url: `${baseUrl}/${app}/mcp`,
    bearer: config.mcpApprovalSecret,
  }));
  const external = parseExternalServers(config.mcpExternalServers);
  await Promise.allSettled([...builtIn, ...external].map(connectOne));
  console.log(
    `[mcp] catalog: ${toolCatalog.length} tools across ` +
      `${clients.size} servers (${[...clients.keys()].join(", ") || "none"})`,
  );
}

/**
 * OpenAI Realtime function-tool defs for every MCP tool, ready to be
 * concatenated with the existing SELF_TOOL / COMPOSIO_EXECUTE_TOOL list
 * inside session.update.
 */
export function getMcpToolDefs(): Array<Record<string, unknown>> {
  return toolCatalog.map((t) => ({
    type: "function",
    name: t.prefixedName,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

/**
 * Dispatcher for an OpenAI Realtime function call whose name matches a
 * `<server>__<tool>` shape. Returns a ToolResult-style shape so the
 * voice-call dispatcher can hand it to serializeToolResult unchanged.
 */
export async function dispatchMcp(
  prefixedName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const def = toolCatalog.find((t) => t.prefixedName === prefixedName);
  if (!def) {
    return { ok: false, error: `unknown MCP tool: ${prefixedName}` };
  }
  const client = clients.get(def.serverName);
  if (!client) {
    return {
      ok: false,
      error: `MCP server '${def.serverName}' not connected (was the bypass-token rejected at boot?)`,
    };
  }
  try {
    const result = await client.callTool({
      name: def.originalName,
      arguments: args,
    });
    return { ok: true, data: result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Used by voice-call.ts to detect that a tool name belongs to MCP.
 *  Matches the prefix shape `<server>__<tool>` against any server we
 *  actually connected to (built-in or external) — using the live
 *  catalog rather than a hardcoded APPS list so external servers from
 *  MCP_EXTERNAL_SERVERS route correctly. */
export function isMcpToolName(name: string): boolean {
  if (!name.includes(PREFIX_SEP)) return false;
  return toolCatalog.some((t) => t.prefixedName === name);
}

// ── Voice-essential allowlist ────────────────────────────────────────────────
//
// OpenAI Realtime (`gpt-realtime` / `gpt-realtime-2`) has a documented
// `session.instructions + tools` ceiling of ~16,384 tokens — voice-specific,
// does NOT scale with the 128K context window. The pre-curation catalog was
// 157 MCP tools across 6 servers ≈ 35,990 tokens, plus a 17 KB persona =
// ~40,585 tokens of session prefix — about 2.5× the ceiling, almost certainly
// silently truncated by OpenAI. The model then "saw" a partial tool surface
// at inference time and fell back to "service unavailable" deflection without
// invoking the tool (postmortem of CA2795e1ddda6bd26fa2420bef84b6fa30 confirms:
// of 44 dispatches, only ~10 distinct tools used; 4 of 6 servers — sure / plane
// / vaultwarden / execute — never touched).
//
// This curated set targets ~5K tokens of tools so the whole session prefix
// stays comfortably under 16,384. Keep it lean. Anything that has no plausible
// reason to be invoked on a phone call belongs OUT of this list. The model
// retains the `self` and `composio_execute` catch-alls (set in tools.ts) for
// long-tail surfaces — and `self` can hit any ctrl-api endpoint, so dropping
// e.g. `alfred__list_state_changes` from this list does NOT make that
// functionality unreachable.
//
// Discovery memory: "voice-bridge h2+h4 compound fix" — see commit message.
const VOICE_ALLOWED_MCP_TOOLS = new Set<string>([
  // alfred — the principal's own surface; most voice use lives here
  "alfred__list_vault_by_type",
  "alfred__search_vault",
  "alfred__get_vault_record",
  "alfred__create_vault_record",
  "alfred__update_vault_record",
  "alfred__list_briefings",
  "alfred__get_briefing",
  "alfred__list_decisions",
  "alfred__list_pending_decisions",
  "alfred__notify_principal",
  "alfred__spawn_alfred_task",
  "alfred__list_in_flight_agents",
  "alfred__list_workflows",
  "alfred__start_workflow",
  "alfred__signal_workflow",
  // hermes — schedule + delegate from a call
  "hermes__run",
  "hermes__schedule_prompt",
  "hermes__list_scheduled",
  "hermes__cancel_scheduled",
  // execute — list connections (read-only diagnostic); composio_execute
  // itself is shipped as a static top-level tool (tools.ts COMPOSIO_EXECUTE_TOOL)
  // so it's not duplicated here.
  "execute__list_connections",
]);

/**
 * Voice-essential MCP tool defs for the OpenAI Realtime `session.update`
 * tools payload. Filters the live `toolCatalog` against the
 * `VOICE_ALLOWED_MCP_TOOLS` allowlist. Returned in the same `function`-tool
 * shape `getMcpToolDefs()` uses; same dispatch path (`dispatchMcp` via
 * `isMcpToolName`).
 *
 * External servers wired via `MCP_EXTERNAL_SERVERS` (e.g. a client tenant's
 * `cdsk` Contractor's Desk) are passed through unfiltered — voice surfaces a
 * tenant-specific external server in full, because the tenant chose to wire
 * it specifically for voice use cases. Built-in servers (the 6 standard apps)
 * are subject to the allowlist.
 */
export function getVoiceMcpToolDefs(): Array<Record<string, unknown>> {
  const builtInApps = new Set<string>(APPS as readonly string[]);
  return toolCatalog
    .filter((t) => {
      if (!builtInApps.has(t.serverName)) return true; // external — passthrough
      return VOICE_ALLOWED_MCP_TOOLS.has(t.prefixedName);
    })
    .map((t) => ({
      type: "function",
      name: t.prefixedName,
      description: t.description,
      parameters: t.inputSchema,
    }));
}
