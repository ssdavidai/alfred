// Generic stdio entrypoint for one of the five Alfred MCP apps.
//
// What openclaw spawns as a stdio MCP server child process (one per app).
// Same tool catalog the HTTP server in ../index.ts exposes, served over
// stdio instead — so every Alfred agent surface (claude.ai over HTTP+OAuth,
// learn-clerk on openclaw main, ephemeral exec subagents on openclaw-workers)
// sees the SAME tool surface from the SAME source.
//
// Invoke as:
//   node dist/bin/stdio-app.js <appId>
//
// Where <appId> ∈ SUPPORTED_APPS = {alfred, sure, plane, vaultwarden, execute}.
//
// Environment:
//   CTRL_API_URL   — base URL for ctrl-api (default: http://ctrl-api:3100)
//   AAS_API_KEY    — bearer token for ctrl-api
//   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET — optional CF Access creds
//
// No OAuth here — this binary runs inside the tenant compose stack as a
// trusted child of openclaw, reading the same ctrl-api env vars every other
// tenant service uses. The OAuth dance only applies to the HTTP transport
// in ../index.ts where remote untrusted clients (claude.ai) connect.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodObject, ZodRawShape } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getToolsForApp, isAppId, SUPPORTED_APPS } from "../tools/registry.js";
import type { CtrlContext } from "../tools/types.js";
import { runTool } from "../tools/types.js";

async function main(): Promise<void> {
  const appArg = process.argv[2] ?? "";
  if (!isAppId(appArg)) {
    process.stderr.write(
      `[mcp-stdio] usage: node stdio-app.js <appId> — got "${appArg}".\n` +
        `              valid: ${[...SUPPORTED_APPS].join(", ")}\n`,
    );
    process.exit(2);
  }
  const appId = appArg;
  const tools = getToolsForApp(appId);

  const ctx: CtrlContext = {
    ctrlUrl: process.env.CTRL_API_URL ?? "http://ctrl-api:3100",
    aasApiKey: process.env.AAS_API_KEY ?? "",
    cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID,
    cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
  };
  if (!ctx.aasApiKey) {
    process.stderr.write(
      "[mcp-stdio] WARN: AAS_API_KEY unset — ctrl-api calls will be unauthenticated\n",
    );
  }

  // McpServer wires zod-shape → JSON Schema automatically the same way
  // the HTTP path in ../index.ts does, so the stdio transport ends up
  // serving the same tools/list payload claude.ai sees today.
  const mcp = new McpServer({
    name: `alfred-${appId}`,
    version: "1.0.0",
  });

  for (const tool of tools) {
    const shape = (tool.inputSchema as ZodObject<ZodRawShape>).shape;
    mcp.registerTool(
      tool.name,
      { description: tool.description, inputSchema: shape },
      async (args: unknown) => {
        return runTool(ctx, tool, args);
      },
    );
  }

  // Expose the corresponding skill markdown as an MCP resource. An
  // agent that doesn't yet know how to use this app can resources/read
  // skills/<app>-mcp-skill.md as context.
  //
  // Path resolved relative to this compiled bin's location:
  //   dist/bin/stdio-app.js → ../../skills/<app>-mcp-skill.md
  const here = path.dirname(fileURLToPath(import.meta.url));
  const skillPath = path.resolve(here, `../../skills/${appId}-mcp-skill.md`);
  const skillUri = `alfred://skills/${appId}-mcp-skill.md`;
  let skillBody: string | null = null;
  try {
    skillBody = await fs.readFile(skillPath, "utf-8");
  } catch {
    skillBody = null;
  }

  if (skillBody) {
    mcp.registerResource(
      `${appId}-skill`,
      skillUri,
      {
        title: `${appId} skill`,
        description: `How to use the ${appId} MCP toolset effectively.`,
        mimeType: "text/markdown",
      },
      async () => ({
        contents: [
          {
            uri: skillUri,
            mimeType: "text/markdown",
            text: skillBody!,
          },
        ],
      }),
    );
  }

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // No console.log here — stdout is reserved for the MCP JSON-RPC stream.
  process.stderr.write(
    `[mcp-stdio] alfred-${appId} ready (${tools.length} tools, skill=${skillBody ? "yes" : "no"})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[mcp-stdio] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
