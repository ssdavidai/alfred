// McpAgent subclass that exposes the Sure tool catalogue over streamable
// HTTP. Cloudflare's `agents/mcp` runtime gives us a Durable Object with
// per-session state; we register every tool from src/tools/sure.ts in
// `init()` and wire each one to call its buildRequest + run through
// proxyToCtrl.
//
// Auth happens BEFORE the Durable Object is reached (see src/index.ts);
// any request that lands here is already authorised.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { ZodObject, ZodRawShape } from "zod";
import type { Env } from "../env.js";
import { ALL_TOOLS } from "../tools/sure.js";
import { runTool } from "../tools/types.js";

export class SureMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "alfred-sure",
    version: "1.0.0",
  });

  async init(): Promise<void> {
    for (const tool of ALL_TOOLS) {
      // McpServer.registerTool(name, config, handler) is the 2025 form.
      // The SDK expects the raw zod shape (a record of ZodType per key),
      // which is what `(zodObject).shape` returns.
      const shape = (tool.inputSchema as ZodObject<ZodRawShape>).shape;
      this.server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: shape,
        },
        async (args: unknown) => {
          // The DO's environment is exposed via `this.env` on McpAgent.
          // `runTool` calls buildRequest and proxies the result through
          // ctrl-api. Args are pre-validated by the SDK against the shape.
          return runTool(this.env, tool, args);
        },
      );
    }
  }
}
