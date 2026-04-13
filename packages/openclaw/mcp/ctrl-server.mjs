#!/usr/bin/env node
/**
 * alfred-ctrl MCP server — single tool for ctrl-api access.
 *
 * Exposes one tool: `ctrl` that makes HTTP requests to the tenant's
 * ctrl-api. Spawned by OpenClaw as a stdio MCP server child process.
 *
 * Uses the low-level Server class with proper request schemas to avoid
 * zod v3/v4 compatibility issues with McpServer.
 *
 * Environment:
 *   CTRL_API_URL  — base URL (default: http://ctrl-api:3100)
 *   AAS_API_KEY   — bearer token for ctrl-api auth
 */

import { Server } from "/app/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js";
import { StdioServerTransport } from "/app/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "/app/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";

const CTRL_URL = process.env.CTRL_API_URL || "http://ctrl-api:3100";
const API_KEY = process.env.AAS_API_KEY || "";

const server = new Server(
  { name: "alfred-ctrl", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ctrl",
      description:
        "Call the Alfred ctrl-api. Check the alfred-vault-operations, alfred-chore-management, alfred-learning-introspection, and alfred-ops-health skill files for available endpoints and parameters.",
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
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== "ctrl") {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const { endpoint, method = "GET", body, query } = args;

  try {
    let url = `${CTRL_URL}${endpoint}`;

    if (query && method === "GET") {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }

    const headers = {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    };

    const opts = { method, headers };
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

    if (!res.ok) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: true, status: res.status, body: content },
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
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: true, message: err.message }),
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
