/**
 * Tools page — what Alfred can actually do on this tenant.
 *
 * Response shape (used by ToolsPage.tsx):
 *
 *   {
 *     apps: [
 *       {
 *         connection_id, toolkit, toolkit_name, toolkit_icon,
 *         composio_execute_enabled: bool,   // false = Alfred can't dispatch this app at all
 *         auto_config_state: "configured"|"pending"|"running"|"error",
 *         streams: [{slug, display_name, description, enabled, schedule_interval_seconds, ...}],
 *         actions: [{slug, display_name, description}],
 *         stale_streams: [{action, suggested_replacement, ...}],  // for the migrate banner
 *         error: string | null,
 *       }
 *     ],
 *     builtin_tools: [{name, description}],
 *     mcp_tools:     [{name, server, description, prime_only}],
 *     prime_enabled: bool,
 *   }
 *
 * The fan-out here is O(connections): we call GET /capabilities on ctrl-api
 * once per ComposioConnection row in parallel. ctrl-api caches the Composio
 * catalog internally (CATALOG_TTL_MS), so the per-toolkit HTTP round-trip to
 * Composio is amortized across all users on this tenant.
 */
import type { GetAllowedTools } from "wasp/server/operations";
import { HttpError } from "wasp/server";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";

interface StreamActionEntry {
  slug: string;
  display_name: string;
  description: string;
  deprecated: boolean;
  enabled: boolean;
  stream_id: string | null;
  schedule_interval_seconds: number | null;
  last_pull_at: string | null;
  last_pull_status: string | null;
  event_count: number;
  last_event_at: string | null;
}

interface ToolActionEntry {
  slug: string;
  display_name: string;
  description: string;
  deprecated: boolean;
}

interface StaleStreamEntry {
  stream_id: string;
  action: string;
  interval_seconds: number;
  last_pull_status: string | null;
  event_count: number;
  suggested_replacement: string | null;
}

interface CapabilitiesResp {
  connection_id: string;
  toolkit: string;
  toolkit_name: string;
  toolkit_icon: string | null;
  composio_execute_enabled: boolean;
  stream_actions: StreamActionEntry[];
  tool_actions: ToolActionEntry[];
  stale_streams: StaleStreamEntry[];
}

export const getAllowedTools: GetAllowedTools<void, any> = async (
  _args,
  context,
) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const instance = await getUserInstance(context);

  // 1. Builtin + MCP tools from the tenant. The runtime is Hermes — the
  //    Phase-1 `/api/v1/openclaw/*` alias was retired (ctrl-api issue #25),
  //    so this reads the canonical `/api/v1/hermes/allowed-tools` route.
  const builtinMcpResp = await proxyToTenant(instance, {
    path: "/api/v1/hermes/allowed-tools",
  });
  const builtin_tools: Array<{ name: string; description: string | null }> =
    Array.isArray(builtinMcpResp?.builtin_tools) ? builtinMcpResp.builtin_tools : [];
  const mcp_tools: Array<{ name: string; server: string; description: string; prime_only: boolean }> =
    Array.isArray(builtinMcpResp?.mcp_tools) ? builtinMcpResp.mcp_tools : [];
  const prime_enabled: boolean = Boolean(builtinMcpResp?.prime_enabled);

  // 2. All connected apps + their auto-config state. We join with
  //    ComposioConnection so the Tools page knows which toolkits are
  //    fully configured vs mid-config vs errored.
  const connections = await context.entities.ComposioConnection.findMany({
    where: { userId: context.user.id },
    select: {
      connectionId: true,
      toolkit: true,
      label: true,
      iconUrl: true,
      status: true,
      autoConfigState: true,
    },
    orderBy: { toolkit: "asc" },
  });

  // 3. Fan out: one capabilities call per connection, in parallel. Treat
  //    any per-connection failure as a soft error — still render the
  //    app card with an error flag so the page isn't blanked by one
  //    bad toolkit.
  const appResults = await Promise.all(
    connections.map(async (conn) => {
      try {
        if (conn.status !== "ACTIVE") {
          // Don't query capabilities for INITIATED/INACTIVE/ORPHAN connections
          // — Composio might 404 and it's noise. Render a placeholder.
          return {
            connection_id: conn.connectionId,
            toolkit: conn.toolkit,
            toolkit_name: conn.label ?? conn.toolkit,
            toolkit_icon: conn.iconUrl ?? null,
            auto_config_state: conn.autoConfigState,
            composio_execute_enabled: false,
            streams: [] as StreamActionEntry[],
            actions: [] as ToolActionEntry[],
            stale_streams: [] as StaleStreamEntry[],
            error: `Connection status is ${conn.status}`,
          };
        }

        const caps = (await proxyToTenant(instance, {
          path: `/api/v1/integrations/${encodeURIComponent(conn.connectionId)}/capabilities`,
        })) as CapabilitiesResp;

        return {
          connection_id: conn.connectionId,
          toolkit: conn.toolkit,
          toolkit_name: caps.toolkit_name || conn.label || conn.toolkit,
          toolkit_icon: caps.toolkit_icon || conn.iconUrl || null,
          auto_config_state: conn.autoConfigState,
          composio_execute_enabled: Boolean(caps.composio_execute_enabled),
          streams: Array.isArray(caps.stream_actions) ? caps.stream_actions : [],
          actions: Array.isArray(caps.tool_actions) ? caps.tool_actions : [],
          stale_streams: Array.isArray(caps.stale_streams) ? caps.stale_streams : [],
          error: null as string | null,
        };
      } catch (err: any) {
        return {
          connection_id: conn.connectionId,
          toolkit: conn.toolkit,
          toolkit_name: conn.label ?? conn.toolkit,
          toolkit_icon: conn.iconUrl ?? null,
          auto_config_state: conn.autoConfigState,
          composio_execute_enabled: false,
          streams: [] as StreamActionEntry[],
          actions: [] as ToolActionEntry[],
          stale_streams: [] as StaleStreamEntry[],
          error: String(err?.message ?? err).slice(0, 200),
        };
      }
    }),
  );

  return {
    apps: appResults,
    builtin_tools,
    mcp_tools,
    prime_enabled,
  };
};

// ----------------------------------------------------------------------------
// Tool dispositions (Phase B) — per-MCP-server DIRECT/DELEGATED toggle
// ----------------------------------------------------------------------------
// The `tool_disposition` table in state.db records, for each of the 9 MCP
// servers Hermes-main loads, whether its tools are exposed inline (DIRECT)
// or hidden behind the `delegate_to_focused_agent` gateway (DELEGATED).
// Defaults are all-DIRECT so existing tenants behave unchanged. A flip
// queues a debounced Hermes restart (~10s) so the new `tools.include: []`
// whitelist takes effect.
//
// Three servers are SELF-PROTECTED: alfred-ctrl, alfred, execute. Delegating
// them would break Alfred's ability to reach the ctrl-api side of his own
// brain (alfred-ctrl), call his own briefing/decision tools (alfred), or
// run the Composio progressive-disclosure surface that Phase A optimised
// (execute). The backend accepts the flip but the UI surfaces them as
// locked with an explanation.

export interface ToolDisposition {
  server: string;
  disposition: "direct" | "delegated";
  updated_at: string;
  updated_by: string | null;
}

interface ToolDispositionsResp {
  dispositions: ToolDisposition[];
}

// Plain async functions, no Wasp generic types AND no explicit return
// type. The Wasp-generated `GenericAuthenticatedOperationDefinition`
// constraint requires `Promise<Payload>`, and a concrete custom type
// is not assignable to `Payload`. The dashboard convention
// (setTelegramBotToken, setPaperclipApiKey, ~14 others) is plain
// async + context: any, with no return-type annotation (so TS infers
// the loose `Promise<any>` that satisfies the constraint). The Wasp
// runtime reads main.wasp for the wire schema — the TS types here
// are local hints, not the source of truth.
//
// Memory: PRs #139 and #145 both fixed the same `Promise<T>` trap. Do
// not reintroduce explicit return types on Wasp operations.

export const getToolDispositions = async (
  _args: unknown,
  context: any,
): Promise<any> => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const instance = await getUserInstance(context);
  const resp = (await proxyToTenant(instance, {
    path: "/api/v1/agents/tool-disposition",
  })) as ToolDispositionsResp;
  return {
    dispositions: Array.isArray(resp?.dispositions) ? resp.dispositions : [],
  };
};

interface SetToolDispositionArgs {
  server: string;
  disposition: "direct" | "delegated";
}

interface SetToolDispositionResp {
  ok: boolean;
  server: string;
  disposition: "direct" | "delegated";
  restart_queued: boolean;
  restart_in_ms: number;
}

export const setToolDisposition = async (
  args: SetToolDispositionArgs,
  context: any,
): Promise<any> => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const server = String(args?.server ?? "").trim();
  const disposition = args?.disposition;
  if (!server) throw new HttpError(400, "server required");
  if (disposition !== "direct" && disposition !== "delegated") {
    throw new HttpError(400, "disposition must be 'direct' or 'delegated'");
  }
  const instance = await getUserInstance(context);
  // updated_by is always 'sir' from the UI — Alfred himself flips via the
  // MCP tool which sets updated_by='alfred'. The init seed uses 'init'.
  const resp = await proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/agents/tool-disposition",
    body: { server, disposition, updated_by: "sir" },
  });
  return {
    ok: Boolean(resp?.ok ?? true),
    server: String(resp?.server ?? server),
    disposition: (resp?.disposition ?? disposition) as "direct" | "delegated",
    restart_queued: Boolean(resp?.restart_queued ?? false),
    restart_in_ms: Number(resp?.restart_in_ms ?? 10_000),
  };
};
