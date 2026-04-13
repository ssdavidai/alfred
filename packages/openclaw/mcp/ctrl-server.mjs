#!/usr/bin/env node
/**
 * alfred-ctrl MCP server — single tool for ctrl-api access.
 *
 * Exposes one tool: `ctrl` that makes HTTP requests to the tenant's
 * ctrl-api. Spawned by OpenClaw as a stdio MCP server child process.
 *
 * Environment:
 *   CTRL_API_URL  — base URL (default: http://ctrl-api:3100)
 *   AAS_API_KEY   — bearer token for ctrl-api auth
 *   NODE_PATH     — must include /app/node_modules for SDK resolution
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CTRL_URL = process.env.CTRL_API_URL || "http://ctrl-api:3100";
const API_KEY = process.env.AAS_API_KEY || "";

const server = new McpServer({
  name: "alfred-ctrl",
  version: "1.0.0",
});

server.tool(
  "ctrl",
  "Call the Alfred ctrl-api. Check the alfred-vault-operations, alfred-chore-management, alfred-learning-introspection, and alfred-ops-health skill files for available endpoints and parameters.",
  {
    endpoint: z.string().describe("API path, e.g. /api/v1/vault/context"),
    method: z
      .enum(["GET", "POST", "PATCH", "DELETE"])
      .default("GET")
      .describe("HTTP method (default: GET)"),
    body: z
      .record(z.unknown())
      .optional()
      .describe("Request body for POST/PATCH/DELETE"),
    query: z
      .record(z.string())
      .optional()
      .describe("Query parameters for GET requests"),
  },
  async ({ endpoint, method = "GET", body, query }) => {
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
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
