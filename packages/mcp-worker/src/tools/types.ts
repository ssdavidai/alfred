// Shared types for Sure MCP tool definitions.
//
// A tool is defined declaratively (name + description + zod input schema +
// async handler that proxies to ctrl-api), then registered with the MCP
// server in src/mcp/server.ts. The handler returns a ProxyResult; the
// shared `respond()` helper converts that into the MCP content format.

import { z } from "zod";
import type { Env } from "../env.js";
import { proxyToCtrl, toolResult } from "./helpers.js";
import type { ProxyOptions, ProxyResult } from "./helpers.js";

// `buildRequest` takes `any` rather than `z.infer<TSchema>` because we store
// heterogeneous tool defs in a single ALL_TOOLS array. The McpServer's zod
// validation runs before our handler is invoked, so args is always
// pre-validated by the time we hit the buildRequest call.
export interface ToolDef<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildRequest: (args: any) => ProxyOptions;
}

/**
 * Execute a tool definition: proxy to ctrl-api and convert the result
 * into the MCP tool-result content shape.
 */
export async function runTool(
  env: Env,
  tool: ToolDef,
  args: unknown,
): Promise<ReturnType<typeof toolResult>> {
  const opts = tool.buildRequest(args);
  const result: ProxyResult = await proxyToCtrl(env, opts);
  return toolResult(result);
}
