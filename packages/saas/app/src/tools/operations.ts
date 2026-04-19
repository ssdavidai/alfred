/**
 * Tools operations — list every tool registered in the tenant's openclaw
 * gateway.tools.allow plus MCP tool names.
 *
 * The Tools page uses this to render a grouped view of everything Alfred
 * can invoke:
 *   - Builtin (web_search, sessions_*, composio_execute, …)
 *   - MCP     (self, tenant, ask_alfred — on Prime)
 *   - Composio tools, grouped by toolkit (GMAIL_*, SLACK_*, …)
 *
 * This is a read-mostly query. Composio tools stay toggleable inline in
 * the Integrations page drawer (PR 3); the Tools page links back to the
 * owning toolkit for any action the user wants to flip.
 */
import type { GetAllowedTools } from "wasp/server/operations";
import { prisma } from "wasp/server";
import { HttpError } from "wasp/server";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";

interface TenantTool {
  name: string;
  group: "builtin" | "mcp" | "composio";
  toolkit: string | null;
}

export const getAllowedTools: GetAllowedTools<void, any> = async (
  _args,
  context,
) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");

  const instance = await getUserInstance(context);
  const tenantResp = await proxyToTenant(instance, {
    path: "/api/v1/openclaw/allowed-tools",
  });

  const tools: TenantTool[] = Array.isArray(tenantResp?.tools)
    ? tenantResp.tools
    : [];
  const mcpServers: string[] = Array.isArray(tenantResp?.mcp_servers)
    ? tenantResp.mcp_servers
    : [];

  // Join composio tools with ComposioConnection rows so we can show the
  // toolkit's display name + icon + owning connection_id, and surface the
  // link back to the Integrations page.
  const connections = await prisma.composioConnection.findMany({
    where: { userId: context.user.id },
    select: {
      toolkit: true,
      label: true,
      iconUrl: true,
      connectionId: true,
      autoConfigState: true,
    },
  });
  const byToolkit = new Map(connections.map((c) => [c.toolkit, c]));

  const enriched = tools.map((t) => {
    if (t.group === "composio" && t.toolkit) {
      const conn = byToolkit.get(t.toolkit);
      return {
        ...t,
        toolkit_name: conn?.label ?? t.toolkit,
        toolkit_icon: conn?.iconUrl ?? null,
        connection_id: conn?.connectionId ?? null,
      };
    }
    return { ...t, toolkit_name: null, toolkit_icon: null, connection_id: null };
  });

  return {
    tools: enriched,
    count: enriched.length,
    mcp_servers: mcpServers,
    // Expose unconnected Composio toolkits (tools named X_* with no matching
    // connection row) so the UI can flag orphaned allowlist entries.
    orphan_toolkits: Array.from(
      new Set(
        enriched
          .filter((t) => t.group === "composio" && t.toolkit && !byToolkit.has(t.toolkit))
          .map((t) => t.toolkit as string),
      ),
    ),
  };
};
