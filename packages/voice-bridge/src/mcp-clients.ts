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

const APPS = ["alfred", "sure", "plane", "vaultwarden", "execute"] as const;
type App = (typeof APPS)[number];

/** Separator we use to prefix MCP tool names. Two underscores so it never
 *  collides with an actual tool name (MCP tools use single-underscore /
 *  kebab-case). Also legal in OpenAI Realtime's function-name grammar. */
const PREFIX_SEP = "__";

interface McpToolDef {
  serverApp: App;
  originalName: string;
  /** `<server>__<tool>` — what OpenAI Realtime sees and the dispatcher matches on. */
  prefixedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const clients = new Map<App, Client>();
const toolCatalog: McpToolDef[] = [];

async function connectOne(app: App): Promise<void> {
  const baseUrl = config.mcpServerUrl.replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/${app}/mcp`);
  const headers: Record<string, string> = {};
  if (config.mcpApprovalSecret) {
    headers.Authorization = `Bearer ${config.mcpApprovalSecret}`;
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
      `[mcp] connect ${app} failed (continuing without it):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  let listed;
  try {
    listed = await client.listTools();
  } catch (err) {
    console.warn(
      `[mcp] tools/list ${app} failed (continuing without it):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  for (const tool of listed.tools ?? []) {
    toolCatalog.push({
      serverApp: app,
      originalName: tool.name,
      prefixedName: `${app}${PREFIX_SEP}${tool.name}`,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    });
  }
  clients.set(app, client);
  console.log(`[mcp] connected ${app}: ${(listed.tools ?? []).length} tools`);
}

/**
 * Connect to every MCP server in parallel. Always resolves; per-server
 * failures are logged and the agent runs with whatever subset came up.
 * Idempotent — repeated calls just re-list tools.
 */
export async function connectAllMcp(): Promise<void> {
  // Reset state so reconnects don't double-count.
  toolCatalog.length = 0;
  await Promise.allSettled(APPS.map(connectOne));
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
  const client = clients.get(def.serverApp);
  if (!client) {
    return {
      ok: false,
      error: `MCP server '${def.serverApp}' not connected (was the bypass-token rejected at boot?)`,
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

/** Used by voice-call.ts to detect that a tool name belongs to MCP. */
export function isMcpToolName(name: string): boolean {
  return name.includes(PREFIX_SEP) && APPS.some((a) => name.startsWith(`${a}${PREFIX_SEP}`));
}
