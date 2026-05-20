#!/usr/bin/env node
/**
 * alfred-ctrl MCP server — federated ctrl-api access.
 *
 * Exposes between 2 and 4 tools depending on whether this tenant is
 * "Alfred Prime" (controlled by the ALFRED_PRIME env var, only set on
 * the Prime instance):
 *
 *   self        — always present. Call THIS tenant's ctrl-api. Generic
 *                 HTTP proxy: { endpoint, method?, body?, query? }.
 *
 *   vault_search — always present. Semantic (meaning-based) search over the
 *                 vault, backed by the state.db sqlite-vec embedding store.
 *                 ctrl-api embeds the query and runs a k-NN lookup. This is
 *                 the Hermes-native replacement for OpenClaw's QMD recall.
 *
 *   tenant      — Prime only. Call a named PEER tenant's ctrl-api via
 *                 Tailscale. Same params as `self` plus a required
 *                 `tenant` name. Uses Prime's LLM tokens (direct tool
 *                 call). Peer list comes from CROSS_TENANT_PEERS.
 *
 *   ask_alfred  — Prime only. Hand a prompt to a named peer's Alfred
 *                 and return its answer. Uses the PEER's LLM tokens
 *                 (the peer's Alfred thinks, returns a reply).
 *
 * Spawned by OpenClaw as a stdio MCP server child process.
 *
 * Uses the low-level Server class with explicit request schemas to
 * avoid zod v3/v4 compatibility issues with McpServer.
 *
 * Environment:
 *   CTRL_API_URL         — base URL for self tool (default: http://ctrl-api:3100)
 *   AAS_API_KEY          — bearer token for self tool's ctrl-api auth
 *   ALFRED_PRIME         — "true" to enable tenant + ask_alfred tools
 *   CROSS_TENANT_PEERS   — JSON array of peer configs (see PeerConfig shape below)
 *
 * PeerConfig shape (matches packages/ctrl/src/api/routes/crossTenant.ts):
 *   {
 *     "id": "tenant-b",
 *     "tailscaleHost": "alfred-alfred-tenant-b.tailnet.ts.net",
 *     "tailscaleIp":   "100.64.0.2",
 *     "apiKey":        "<peer tenant's AAS_API_KEY>",
 *     "label":         "Tenant B"
 *   }
 */

// Relative imports into the sibling mcp-stdio bundle's node_modules.
// The init container deploys this file to <profile>/mcp/ctrl-server.mjs
// and the stdio bundle (with its node_modules) to <profile>/mcp-stdio/ —
// siblings — so ../mcp-stdio/node_modules/... is a stable relative path.
//
// Previously these were hardcoded /app/node_modules/... absolute paths
// to a directory that does not exist in the hermes container, so the
// stdio child crashed on first import and the alfred-ctrl MCP server
// never connected. A bare specifier would NOT fix it: Node's ESM loader
// does not honour NODE_PATH (only the legacy CJS resolver does), and no
// node_modules is reachable by walking up from mcp/. A relative path is
// the only form that resolves here.
import { Server } from "../mcp-stdio/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js";
import { StdioServerTransport } from "../mcp-stdio/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "../mcp-stdio/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";

const CTRL_URL = process.env.CTRL_API_URL || "http://ctrl-api:3100";
const API_KEY = process.env.AAS_API_KEY || "";
const IS_PRIME = process.env.ALFRED_PRIME === "true";

// Default timeout for ask_alfred (peer's Alfred may take a while to think).
// A peer with a large system prompt + MEMORY/SOUL/USER files needs ~80–100s
// for the spawn-and-first-answer roundtrip on Gemini, and chatty multi-turn
// reasoning can push it well past that. 240s gives us comfortable headroom
// while still bounding pathological hangs. Per-call override accepted via
// the `timeout_seconds` arg (see askAlfredTool.inputSchema).
const ASK_ALFRED_DEFAULT_TIMEOUT_S = 240;
const ASK_ALFRED_FETCH_OVERHEAD_S = 30;

// ── Peer discovery ───────────────────────────────────────────────────────────

function loadPeers() {
  try {
    const raw = process.env.CROSS_TENANT_PEERS;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[alfred-ctrl] Failed to parse CROSS_TENANT_PEERS:", err.message);
    return [];
  }
}

function resolvePeer(id) {
  return loadPeers().find((p) => p && p.id === id);
}

function peerBaseUrl(peer) {
  // Prefer Tailscale hostname (enables TLS) over raw IP
  return peer.tailscaleHost
    ? `https://${peer.tailscaleHost}:3100`
    : `http://${peer.tailscaleIp}:3100`;
}

// ── Shared HTTP helpers ──────────────────────────────────────────────────────

function buildCtrlUrl(base, endpoint, method, query) {
  let url = `${base}${endpoint}`;
  if (query && method === "GET") {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  return url;
}

async function callCtrl({ base, apiKey, endpoint, method = "GET", body, query }) {
  const url = buildCtrlUrl(base, endpoint, method, query);
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };
  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let content;
  try {
    content = JSON.parse(text);
  } catch {
    content = text;
  }
  return { ok: res.ok, status: res.status, content };
}

function toolResult({ ok, status, content }) {
  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: true, status, body: content },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          typeof content === "string"
            ? content
            : JSON.stringify(content, null, 2),
      },
    ],
  };
}

function errorResult(message, extra = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: true, message, ...extra }, null, 2),
      },
    ],
    isError: true,
  };
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const selfTool = {
  name: "self",
  description:
    "Call THIS tenant's own ctrl-api. Use for all local vault / streams / learning / workflows / schedules / workers / admin operations. Check the alfred-vault-operations, alfred-chore-management, alfred-learning-introspection, and alfred-ops-health skills for endpoint catalogue. For operations on OTHER tenants, use the `tenant` tool if available.",
  inputSchema: {
    type: "object",
    properties: {
      endpoint: {
        type: "string",
        description: "API path, e.g. /api/v1/vault/context",
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PATCH", "DELETE"],
        default: "GET",
        description: "HTTP method (default: GET)",
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

const vaultSearchTool = {
  name: "vault_search",
  description:
    "Semantic search over the vault by MEANING (not keyword). Backed by the " +
    "state.db sqlite-vec embedding store: ctrl-api embeds your query and " +
    "returns the nearest vault records by vector distance, each with a " +
    "text preview and a `ref` you can read in full via `self`. Use this to " +
    "answer \"what do I know about X\" / \"recent signals on matter Y\" — it " +
    "is the Hermes-native replacement for OpenClaw's QMD recall. For exact " +
    "string / path lookups use `self` with /api/v1/vault/search instead.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language search query (a phrase or question).",
      },
      k: {
        type: "number",
        description: "Number of nearest results to return (1–50, default 10).",
        default: 10,
      },
      ref_kind: {
        type: "string",
        description:
          "Optional filter on the embedding source kind (e.g. \"vault\"). " +
          "Omit to search every kind.",
      },
    },
    required: ["query"],
  },
};

const tenantTool = {
  name: "tenant",
  description:
    "Alfred Prime only — call a NAMED PEER tenant's ctrl-api via Tailscale. Same endpoint catalogue as `self`, but routed to the peer. Use this when Sir explicitly asks you to inspect or modify another tenant (e.g. \"what does Tenant B have in his inbox?\"). Executes as a direct tool call using YOUR tokens; does NOT invoke the peer's Alfred. For a reasoning response from the peer's Alfred, use `ask_alfred`.",
  inputSchema: {
    type: "object",
    properties: {
      tenant: {
        type: "string",
        description:
          "Peer tenant id (e.g. \"tenant-b\", \"tenant-a\"). Use the alfred-prime-federation skill's peer list.",
      },
      endpoint: {
        type: "string",
        description: "API path on the peer, e.g. /api/v1/vault/context",
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PATCH", "DELETE"],
        default: "GET",
        description: "HTTP method (default: GET)",
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
    required: ["tenant", "endpoint"],
  },
};

const askAlfredTool = {
  name: "ask_alfred",
  description:
    "Alfred Prime only — hand a PROMPT to a named peer tenant's Alfred and return his answer. Use this when Sir wants the peer's Alfred to think, reason, or synthesise something from the peer's vault (e.g. \"ask Tenant B what his top priority is this week\"). The peer's Alfred processes the prompt using HIS tokens and vault context, then returns the reply. For direct CRUD without invoking the peer's LLM, use `tenant`.",
  inputSchema: {
    type: "object",
    properties: {
      tenant: {
        type: "string",
        description: "Peer tenant id (e.g. \"tenant-b\").",
      },
      prompt: {
        type: "string",
        description: "Natural-language prompt for the peer's Alfred.",
      },
      timeout_seconds: {
        type: "number",
        description: `Max seconds to wait for the peer's Alfred to respond. Default ${ASK_ALFRED_DEFAULT_TIMEOUT_S}s.`,
        default: ASK_ALFRED_DEFAULT_TIMEOUT_S,
      },
    },
    required: ["tenant", "prompt"],
  },
};

// ── Tool dispatch ────────────────────────────────────────────────────────────

async function dispatchSelf(args) {
  const { endpoint, method, body, query } = args;
  const result = await callCtrl({
    base: CTRL_URL,
    apiKey: API_KEY,
    endpoint,
    method,
    body,
    query,
  });
  return toolResult(result);
}

async function dispatchVaultSearch(args) {
  const { query, k, ref_kind: refKind } = args;
  if (typeof query !== "string" || !query.trim()) {
    return errorResult("vault_search requires a non-empty `query` string.");
  }
  const body = { query: query.trim() };
  if (typeof k === "number" && Number.isFinite(k)) body.k = k;
  if (typeof refKind === "string" && refKind.trim()) body.ref_kind = refKind.trim();
  const result = await callCtrl({
    base: CTRL_URL,
    apiKey: API_KEY,
    endpoint: "/api/v1/state/embeddings/search-text",
    method: "POST",
    body,
  });
  return toolResult(result);
}

async function dispatchTenant(args) {
  const { tenant: peerId, endpoint, method, body, query } = args;
  const peer = resolvePeer(peerId);
  if (!peer) {
    return errorResult(`Unknown tenant "${peerId}".`, {
      known_tenants: loadPeers().map((p) => p.id),
    });
  }
  const result = await callCtrl({
    base: peerBaseUrl(peer),
    apiKey: peer.apiKey,
    endpoint,
    method,
    body,
    query,
  });
  return toolResult(result);
}

async function dispatchAskAlfred(args) {
  const {
    tenant: peerId,
    prompt,
    timeout_seconds: timeoutSeconds = ASK_ALFRED_DEFAULT_TIMEOUT_S,
  } = args;
  const peer = resolvePeer(peerId);
  if (!peer) {
    return errorResult(`Unknown tenant "${peerId}".`, {
      known_tenants: loadPeers().map((p) => p.id),
    });
  }
  const url = `${peerBaseUrl(peer)}/api/v1/cross-tenant/ask`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${peer.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        callerId: "alfred-prime",
        timeoutSeconds,
      }),
      signal: AbortSignal.timeout(
        (timeoutSeconds + ASK_ALFRED_FETCH_OVERHEAD_S) * 1000,
      ),
    });
    const text = await res.text();
    let content;
    try {
      content = JSON.parse(text);
    } catch {
      content = text;
    }
    return toolResult({ ok: res.ok, status: res.status, content });
  } catch (err) {
    return errorResult(`ask_alfred to ${peerId} failed: ${err.message}`);
  }
}

// ── Wire it up ───────────────────────────────────────────────────────────────

function assembleTools() {
  const tools = [selfTool, vaultSearchTool];
  if (IS_PRIME) {
    tools.push(tenantTool, askAlfredTool);
  }
  return tools;
}

const server = new Server(
  { name: "alfred-ctrl", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: assembleTools(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "self":
        return await dispatchSelf(args);
      case "vault_search":
        return await dispatchVaultSearch(args);
      case "tenant":
        if (!IS_PRIME) {
          return errorResult(
            "The `tenant` tool is only available on Alfred Prime.",
          );
        }
        return await dispatchTenant(args);
      case "ask_alfred":
        if (!IS_PRIME) {
          return errorResult(
            "The `ask_alfred` tool is only available on Alfred Prime.",
          );
        }
        return await dispatchAskAlfred(args);
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err.message || String(err));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
