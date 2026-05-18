// Shared types for Sure MCP tool definitions.
//
// A tool is defined declaratively (name + description + zod input schema +
// buildRequest fn that returns the ProxyOptions). The actual HTTP call lives
// in proxyToCtrl(); runTool wires both together.
//
// Why CtrlContext instead of pulling from env directly: with OAuth, the
// authenticated principal's bearer token + ctrl URL come from the OAuth
// `props` payload attached to the access token, not from the Worker's
// global secrets. The DO's tool handler builds a CtrlContext from
// `this.props` per request and passes it through.

import { z } from "zod";
import { proxyToCtrl, toolResult } from "./helpers.js";
import type { ProxyOptions, ProxyResult } from "./helpers.js";

export interface CtrlContext {
  /** Base URL of the target ctrl-api (e.g. https://alfred-david-mnbqn4jg.alfred.black). */
  ctrlUrl: string;
  /** Bearer token forwarded as Authorization on every backend call. */
  aasApiKey: string;
  /** Optional Cloudflare Access service-token credentials. */
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

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
  ctx: CtrlContext,
  tool: ToolDef,
  args: unknown,
): Promise<ReturnType<typeof toolResult>> {
  const opts = tool.buildRequest(args);
  const result: ProxyResult = await proxyToCtrl(ctx, opts);
  return toolResult(result);
}
