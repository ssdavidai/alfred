/**
 * Integrations Wasp operations — proxy to tenant ctrl-api.
 *
 * Thin proxy layer between the IntegrationsPage UI and the per-tenant
 * ctrl-api integration routes. Same pattern as chores/operations.ts.
 */
import type {
  GetIntegrationCatalog,
  GetConnectedIntegrations,
  GetIntegrationCapabilities,
  InitiateConnect,
  DisconnectIntegration,
  EnableIntegrationStream,
  EnableIntegrationTool,
  DisableIntegrationTool,
  AutoConfigIntegration,
  FinalizeComposioConnections,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";

export const getIntegrationCatalog: GetIntegrationCatalog<
  { search?: string; category?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  const query: Record<string, string> = {};
  if (args?.search) query.search = args.search;
  if (args?.category) query.category = args.category;
  return proxyToTenant(instance, {
    path: "/api/v1/integrations/catalog",
    query,
  });
};

export const getConnectedIntegrations: GetConnectedIntegrations<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: "/api/v1/integrations",
  });
};

export const getIntegrationCapabilities: GetIntegrationCapabilities<
  { connectionId: string },
  any
> = async (args, context) => {
  if (!args?.connectionId) throw new Error("connectionId is required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: `/api/v1/integrations/${encodeURIComponent(args.connectionId)}/capabilities`,
  });
};

export const initiateConnect: InitiateConnect<
  { toolkit_slug: string; redirect_url?: string },
  any
> = async (args, context) => {
  if (!args?.toolkit_slug) throw new Error("toolkit_slug is required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/integrations/connect",
    body: {
      toolkit_slug: args.toolkit_slug,
      redirect_url: args.redirect_url || "",
    },
  });
};

export const disconnectIntegration: DisconnectIntegration<
  { connectionId: string },
  any
> = async (args, context) => {
  if (!args?.connectionId) throw new Error("connectionId is required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "DELETE",
    path: `/api/v1/integrations/${encodeURIComponent(args.connectionId)}`,
  });
};

export const enableIntegrationStream: EnableIntegrationStream<
  {
    connectionId: string;
    action_slug: string;
    poll_interval_seconds?: number;
    stream_name?: string;
  },
  any
> = async (args, context) => {
  if (!args?.connectionId || !args?.action_slug) {
    throw new Error("connectionId and action_slug are required");
  }
  const instance = await getUserInstance(context);

  // 1. Create the stream config
  const streamResult = await proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/integrations/${encodeURIComponent(args.connectionId)}/enable-stream`,
    body: {
      action_slug: args.action_slug,
      poll_interval_seconds: args.poll_interval_seconds || 300,
      stream_name: args.stream_name || args.action_slug.replace(/_/g, " "),
    },
  });

  // 2. Create Temporal schedule for the stream puller
  const streamId = streamResult?.stream_id;
  if (streamId) {
    const intervalMin = Math.max(
      Math.round((args.poll_interval_seconds || 300) / 60),
      1,
    );
    try {
      await proxyToTenant(instance, {
        method: "POST",
        path: "/api/v1/schedules",
        body: {
          schedule_id: `al-stream-pull-composio-${streamId.slice(0, 20)}`,
          workflow_type: "StreamPullerWorkflow",
          task_queue: "alfred-learn",
          cron: `*/${intervalMin} * * * *`,
          input: { stream_id: streamId },
          overlap_policy: "Skip",
        },
      });
    } catch (err: any) {
      console.error("[enableIntegrationStream] Schedule creation failed:", err?.message);
    }
  }

  return streamResult;
};

export const enableIntegrationTool: EnableIntegrationTool<
  { action_slug: string },
  any
> = async (args, context) => {
  if (!args?.action_slug) throw new Error("action_slug is required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/integrations/enable-tool",
    body: { action_slug: args.action_slug },
  });
};

export const disableIntegrationTool: DisableIntegrationTool<
  { action_slug: string },
  any
> = async (args, context) => {
  if (!args?.action_slug) throw new Error("action_slug is required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/integrations/disable-tool",
    body: { action_slug: args.action_slug },
  });
};

export const autoConfigIntegration: AutoConfigIntegration<
  { connectionId: string },
  any
> = async (args, context) => {
  if (!args?.connectionId) throw new Error("connectionId is required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/integrations/${encodeURIComponent(args.connectionId)}/auto-config`,
    timeoutMs: 30000, // auto-config may take a few seconds
  });
};

export const finalizeComposioConnections: FinalizeComposioConnections<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);

  // Get all connected integrations
  const data = await proxyToTenant(instance, {
    path: "/api/v1/integrations",
  });
  const connections = (data?.integrations || []).filter(
    (c: any) => c.status === "ACTIVE",
  );

  // Auto-config each connection (creates streams, skills, disables legacy)
  const results: any[] = [];
  for (const conn of connections) {
    try {
      const result = await proxyToTenant(instance, {
        method: "POST",
        path: `/api/v1/integrations/${encodeURIComponent(conn.id)}/auto-config`,
        timeoutMs: 30000,
      });
      results.push({ toolkit: conn.toolkit, ...result });
    } catch {
      // best-effort — don't block onboarding completion
    }
  }

  return { configured: results.length, results };
};
