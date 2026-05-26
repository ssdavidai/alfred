// OpenAI Realtime function-tool definitions + dispatchers.
//
// We expose the same two tools the Alfred agent uses:
//   self              — proxy to THIS tenant's ctrl-api (mirrors the MCP
//                       `self` tool surfaced by the mcp-server)
//   composio_execute  — dispatch a Composio action via the tenant's
//                       /api/v1/integrations/execute endpoint
//
// Dispatch happens by plain HTTP from the bridge to the tenant's ctrl-api
// (NOT over any agent-runtime WebSocket — see README.md, issue #30), using the
// per-call AAS_API_KEY fetched at call setup.

import type { TenantContext } from "./tenant.js";

// ── Function-tool schemas (sent to OpenAI Realtime via session.update) ───────

export const SELF_TOOL = {
  type: "function" as const,
  name: "self",
  description:
    "Call THIS tenant's own ctrl-api. Use for ALL local vault / streams / learning / workflows / schedules / workers / admin operations. " +
    "See the docs/TOOLS.md reference for the endpoint catalogue. " +
    "Examples: read vault context (`/api/v1/vault/context`), list tasks (`/api/v1/vault/list/task`), create a record, search vault.",
  parameters: {
    type: "object",
    properties: {
      endpoint: {
        type: "string",
        description: "API path, e.g. /api/v1/vault/context",
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PATCH", "DELETE"],
        description: "HTTP method (default GET)",
      },
      body: {
        type: "object",
        description: "Request body for POST/PATCH/DELETE",
        additionalProperties: true,
      },
      query: {
        type: "object",
        description: "Query parameters for GET requests",
        additionalProperties: { type: "string" },
      },
    },
    required: ["endpoint"],
  },
};

export const COMPOSIO_EXECUTE_TOOL = {
  type: "function" as const,
  name: "composio_execute",
  description:
    "Execute a Composio action against a third-party app the user has connected " +
    "(Gmail, Calendar, Notion, GitHub, Slack, Drive, etc.). The action name follows the Composio toolkit naming, e.g. " +
    "GOOGLECALENDAR_FIND_EVENT, GMAIL_SEND_EMAIL, NOTION_CREATE_PAGE.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Composio action name (e.g. GOOGLECALENDAR_FIND_EVENT)",
      },
      arguments: {
        type: "object",
        description: "Action-specific arguments",
        additionalProperties: true,
      },
    },
    required: ["action"],
  },
};

/**
 * Static tool list (always present). The voice agent ALSO gets a dynamic
 * set of MCP tools merged at session.update time — see voice-call.ts and
 * mcp-clients.ts. `self` and `composio_execute` stay here for the cases
 * MCP doesn't cover (raw ctrl-api endpoints + Composio actions selected
 * at runtime).
 */
export const ALL_TOOLS = [SELF_TOOL, COMPOSIO_EXECUTE_TOOL];

// ── Dispatcher ───────────────────────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 25_000; // OpenAI Realtime function-call sequencing

export interface ToolResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

function buildCtrlUrl(
  tenant: TenantContext,
  endpoint: string,
  method: string,
  query?: Record<string, string>,
): string {
  let url = `https://${tenant.tailscaleHost}:3100${endpoint}`;
  if (query && method === "GET") {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  return url;
}

async function ctrlFetch(
  tenant: TenantContext,
  opts: {
    endpoint: string;
    method: string;
    body?: unknown;
    query?: Record<string, string>;
  },
): Promise<ToolResult> {
  const url = buildCtrlUrl(tenant, opts.endpoint, opts.method, opts.query);
  const fetchOpts: any = {
    method: opts.method,
    headers: {
      Authorization: `Bearer ${tenant.aasApiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  };
  if (opts.body && opts.method !== "GET") {
    fetchOpts.body = JSON.stringify(opts.body);
  }
  try {
    const res = await fetch(url, fetchOpts);
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function dispatchSelf(
  tenant: TenantContext,
  args: {
    endpoint?: string;
    method?: string;
    body?: unknown;
    query?: Record<string, string>;
  },
): Promise<ToolResult> {
  if (!args.endpoint) {
    return { ok: false, error: "endpoint argument required" };
  }
  return ctrlFetch(tenant, {
    endpoint: args.endpoint,
    method: (args.method ?? "GET").toUpperCase(),
    body: args.body,
    query: args.query,
  });
}

export async function dispatchComposioExecute(
  tenant: TenantContext,
  args: { action?: string; arguments?: Record<string, unknown> },
): Promise<ToolResult> {
  if (!args.action) {
    return { ok: false, error: "action argument required" };
  }
  return ctrlFetch(tenant, {
    endpoint: "/api/v1/integrations/execute",
    method: "POST",
    body: { action: args.action, arguments: args.arguments ?? {} },
  });
}

// ── Result formatting ────────────────────────────────────────────────────────
// OpenAI Realtime function-call results are JSON strings the model reads on
// the next `response.create`. Cap size to avoid blowing context — but large
// enough that real tool outputs (e.g. GOOGLECALENDAR_EVENTS_LIST, GMAIL_FETCH_
// EMAILS) don't get chopped mid-array, which is how the voice agent ends up
// confabulating missing items from surrounding context instead of saying
// "the result is truncated."
//
// 24 KB ≈ 6k tokens — small vs. gpt-realtime-1.5's context window, large
// enough for ~10-20 real calendar/email items.

const MAX_RESULT_BYTES = 24_000;

export function serializeToolResult(result: ToolResult): string {
  let json = JSON.stringify(result);
  if (json.length > MAX_RESULT_BYTES) {
    // Keep head + tail; signal truncation so the model doesn't infer empty.
    json =
      json.slice(0, MAX_RESULT_BYTES - 200) +
      `..."[truncated ${json.length - MAX_RESULT_BYTES + 200}b]"...` +
      json.slice(-180);
  }
  return json;
}
