/**
 * Integrations Wasp operations — proxy to tenant ctrl-api + SaaS-side state.
 *
 * Thin proxy layer between the IntegrationsPage UI and the per-tenant
 * ctrl-api integration routes, WITH a SaaS-side `ComposioConnection` row
 * that tracks the auto-config lifecycle of each connection so the dashboard
 * can render correct state after a page refresh.
 *
 * Lifecycle:
 *   initiateConnect            → upsertConnection (autoConfigState="pending")
 *   autoConfigIntegration      → markAutoConfigRunning → call tenant
 *                                → applyAutoConfigResult ("configured")
 *                                  OR markAutoConfigError ("error")
 *   disconnectIntegration      → proxyToTenant → deleteConnection
 *   getConnectedIntegrations   → merge tenant list with Prisma rows;
 *                                lazy-upsert any tenant connection that
 *                                doesn't yet have a Prisma row.
 */
import type {
  GetIntegrationCatalog,
  GetConnectedIntegrations,
  GetIntegrationCapabilities,
  GetOpenclawReadiness,
  InitiateConnect,
  InitiateApiKeyConnect,
  DisconnectIntegration,
  EnableIntegrationStream,
  DisableIntegrationStream,
  EnableIntegrationTool,
  DisableIntegrationTool,
  AutoConfigIntegration,
  FinalizeComposioConnections,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";
import {
  upsertConnection,
  applyAutoConfigResult,
  markAutoConfigRunning,
  markAutoConfigError,
  deleteConnection,
  listConnectionsForUser,
} from "./connectionRepo";

// =============================================================================
// Catalog + readiness (no DB state)
// =============================================================================

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

/**
 * Fast readiness probe for the tenant's openclaw gateway. Used by the
 * dashboard's `ReconfiguringBanner` to detect the ~40s restart window that
 * follows a `gateway.tools.allow` change (e.g. first Composio connect).
 * Returns:
 *   { ready: bool,
 *     last_config_touch_at: iso | null,
 *     restart_expected_until: iso | null }
 */
export const getOpenclawReadiness: GetOpenclawReadiness<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: "/api/v1/openclaw/ready",
    timeoutMs: 3000, // probe itself is bounded to 1.5s inside ctrl-api
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

// =============================================================================
// Connected integrations — the keystone query for the IntegrationsPage.
// Merges tenant connections (Composio truth) with Prisma rows (SaaS auto-config
// truth). The FE uses the merged shape to render state correctly across
// refreshes.
// =============================================================================

export const getConnectedIntegrations: GetConnectedIntegrations<void, any> = async (
  _args,
  context,
) => {
  const user = requireUser(context);
  const instance = await getUserInstance(context);

  // Fetch tenant-side list + our own rows in parallel
  const [tenantResp, saasRows] = await Promise.all([
    proxyToTenant(instance, { path: "/api/v1/integrations" }),
    listConnectionsForUser(context.entities.ComposioConnection, user.id),
  ]);

  const tenantList: any[] = Array.isArray(tenantResp?.integrations)
    ? tenantResp.integrations
    : [];
  const saasByConnId = new Map(saasRows.map((r) => [r.connectionId, r]));
  const saasByToolkit = new Map(saasRows.map((r) => [r.toolkit, r]));

  // Lazy backfill: any tenant connection we don't have a Prisma row for
  // gets a stub inserted. Uses connectionId as the primary key — handles
  // the case where a tenant re-connected a toolkit (new connectionId for
  // an existing toolkit row) by preferring the tenant's current value.
  const enriched = await Promise.all(
    tenantList.map(async (t: any) => {
      const toolkit = String(t.toolkit || "").toLowerCase();
      let row = saasByConnId.get(t.id) ?? saasByToolkit.get(toolkit) ?? null;

      if (!row) {
        try {
          row = await upsertConnection(context.entities.ComposioConnection, {
            userId: user.id,
            connectionId: t.id,
            toolkit,
            label: t.toolkit_name || null,
            iconUrl: t.toolkit_icon || null,
            authScheme: t.auth_scheme || null,
            status: t.status || "INITIATED",
          });
        } catch (err) {
          // Don't let a DB hiccup block the whole list; degrade gracefully.
          console.error("[getConnectedIntegrations] backfill upsert failed:", err);
        }
      } else if (row.status !== t.status || row.connectionId !== t.id) {
        // Tenant status changed (or connectionId was rotated) — resync the row
        try {
          row = await upsertConnection(context.entities.ComposioConnection, {
            userId: user.id,
            connectionId: t.id,
            toolkit,
            label: t.toolkit_name || row.label,
            iconUrl: t.toolkit_icon || row.iconUrl,
            authScheme: t.auth_scheme || row.authScheme,
            status: t.status || row.status,
          });
        } catch (err) {
          console.error("[getConnectedIntegrations] resync upsert failed:", err);
        }
      }

      return {
        // Composio fields (tenant truth)
        id: t.id,
        toolkit,
        toolkit_name: t.toolkit_name,
        toolkit_icon: t.toolkit_icon,
        status: t.status,
        auth_scheme: t.auth_scheme,
        created_at: t.created_at,
        // SaaS fields (our auto-config truth)
        auto_config_state: row?.autoConfigState ?? "pending",
        auto_config_error: row?.autoConfigError ?? null,
        auto_configured_at: row?.autoConfiguredAt
          ? row.autoConfiguredAt.toISOString()
          : null,
        streams_created: row?.streamsCreated ?? 0,
        tools_enabled: row?.toolsEnabled ?? 0,
        skill_name: row?.skillName ?? null,
      };
    }),
  );

  // Also handle the orphan case: a SaaS row exists but the tenant no longer
  // sees the connection (user disconnected via a different path, or the
  // Composio key was rotated). Surface these so the UI can prompt cleanup.
  const tenantIds = new Set(tenantList.map((t) => t.id));
  const orphans = saasRows
    .filter((r) => !tenantIds.has(r.connectionId))
    .map((r) => ({
      id: r.connectionId,
      toolkit: r.toolkit,
      toolkit_name: r.label,
      toolkit_icon: r.iconUrl,
      status: "ORPHAN",
      auth_scheme: r.authScheme,
      created_at: r.createdAt.toISOString(),
      auto_config_state: r.autoConfigState,
      auto_config_error: r.autoConfigError,
      auto_configured_at: r.autoConfiguredAt ? r.autoConfiguredAt.toISOString() : null,
      streams_created: r.streamsCreated,
      tools_enabled: r.toolsEnabled,
      skill_name: r.skillName,
    }));

  return {
    integrations: [...enriched, ...orphans],
    count: enriched.length + orphans.length,
  };
};

// =============================================================================
// Write actions
// =============================================================================

export const initiateConnect: InitiateConnect<
  { toolkit_slug: string; redirect_url?: string },
  any
> = async (args, context) => {
  if (!args?.toolkit_slug) throw new Error("toolkit_slug is required");
  const user = requireUser(context);
  const instance = await getUserInstance(context);
  const toolkit = args.toolkit_slug.toLowerCase();

  // Kick off OAuth at Composio
  const result = await proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/integrations/connect",
    body: {
      toolkit_slug: toolkit,
      redirect_url: args.redirect_url || "",
    },
  });

  // Upsert our tracking row. We won't know label/icon until the user
  // finishes OAuth and we list connections, but we'll resync there.
  const connectionId = result?.connection_id || result?.connectionId;
  if (connectionId) {
    try {
      await upsertConnection(context.entities.ComposioConnection, {
        userId: user.id,
        connectionId,
        toolkit,
        status: result?.status || "INITIATED",
      });
    } catch (err) {
      console.error("[initiateConnect] upsert failed:", err);
    }
  }

  return result;
};

/**
 * API-key / bearer-token connect flow for toolkits that don't use OAuth
 * (Clockify, Tavily, PostHog, …). Same end state as initiateConnect — a
 * tracked ComposioConnection row plus a live Composio connected_account —
 * but without the popup: the user supplies their key inline, we exchange
 * it for an ACTIVE connection in one round trip.
 */
export const initiateApiKeyConnect: InitiateApiKeyConnect<
  { toolkit_slug: string; credential: string; auth_scheme?: string },
  any
> = async (args, context) => {
  if (!args?.toolkit_slug) throw new Error("toolkit_slug is required");
  if (!args?.credential || !args.credential.trim()) {
    throw new Error("credential is required");
  }
  const user = requireUser(context);
  const instance = await getUserInstance(context);
  const toolkit = args.toolkit_slug.toLowerCase();

  const result = await proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/integrations/connect-api-key",
    body: {
      toolkit_slug: toolkit,
      credential: args.credential.trim(),
      auth_scheme: args.auth_scheme,
    },
  });

  const connectionId = result?.connection_id || result?.connectionId;
  if (connectionId) {
    try {
      await upsertConnection(context.entities.ComposioConnection, {
        userId: user.id,
        connectionId,
        toolkit,
        authScheme: result?.auth_scheme || args.auth_scheme || "API_KEY",
        status: result?.status || "ACTIVE",
      });
    } catch (err) {
      console.error("[initiateApiKeyConnect] upsert failed:", err);
    }
  }

  return result;
};

export const disconnectIntegration: DisconnectIntegration<
  { connectionId: string },
  any
> = async (args, context) => {
  if (!args?.connectionId) throw new Error("connectionId is required");
  const user = requireUser(context);
  const instance = await getUserInstance(context);

  // Proxy to tenant first — that's the authoritative delete for streams +
  // skills + gateway tools. Only after that succeeds do we remove our row,
  // so a failed cleanup doesn't orphan the SaaS record.
  const result = await proxyToTenant(instance, {
    method: "DELETE",
    path: `/api/v1/integrations/${encodeURIComponent(args.connectionId)}`,
  });

  try {
    await deleteConnection(
      context.entities.ComposioConnection,
      user.id,
      args.connectionId,
    );
  } catch (err) {
    console.error("[disconnectIntegration] delete row failed:", err);
  }

  return result;
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

  // 1. Create the stream config on the tenant
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

/**
 * Disable a Composio-backed stream for a connection. Inverse of
 * enableIntegrationStream: ctrl-api removes the config file + streams.json
 * entry + deletes the Temporal schedule. Safe to call even if the stream
 * was never enabled (the endpoint no-ops cleanly).
 */
export const disableIntegrationStream: DisableIntegrationStream<
  { connectionId: string; action_slug: string },
  any
> = async (args, context) => {
  if (!args?.connectionId || !args?.action_slug) {
    throw new Error("connectionId and action_slug are required");
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/integrations/${encodeURIComponent(args.connectionId)}/disable-stream`,
    body: { action_slug: args.action_slug },
  });
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

/**
 * Auto-configure a Composio connection. This is the moment we flip a row
 * from `pending` → `configured` (or `error`). Callers are the explicit
 * "Configure" button in the IntegrationsPage (removed in PR 2), the
 * onboarding finalize sweep, and — after PR 2 — the OAuth-callback
 * auto-fire.
 */
export const autoConfigIntegration: AutoConfigIntegration<
  { connectionId: string },
  any
> = async (args, context) => {
  if (!args?.connectionId) throw new Error("connectionId is required");
  const user = requireUser(context);
  const instance = await getUserInstance(context);

  const delegate = context.entities.ComposioConnection;

  try {
    await markAutoConfigRunning(delegate, user.id, args.connectionId);
  } catch (err) {
    console.error("[autoConfigIntegration] markRunning failed:", err);
  }

  let result: any;
  try {
    result = await proxyToTenant(instance, {
      method: "POST",
      path: `/api/v1/integrations/${encodeURIComponent(args.connectionId)}/auto-config`,
      timeoutMs: 30000,
    });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    try {
      await markAutoConfigError(delegate, user.id, args.connectionId, message);
    } catch { /* already logged below */ }
    throw err;
  }

  try {
    await applyAutoConfigResult(delegate, user.id, args.connectionId, result || {});
  } catch (err) {
    console.error("[autoConfigIntegration] applyResult failed:", err);
  }

  return result;
};

export const finalizeComposioConnections: FinalizeComposioConnections<void, any> = async (
  _args,
  context,
) => {
  const user = requireUser(context);
  const instance = await getUserInstance(context);
  const delegate = context.entities.ComposioConnection;

  const data = await proxyToTenant(instance, {
    path: "/api/v1/integrations",
  });
  const connections = (data?.integrations || []).filter(
    (c: any) => c.status === "ACTIVE",
  );

  const results: any[] = [];
  for (const conn of connections) {
    try {
      await markAutoConfigRunning(delegate, user.id, conn.id);
    } catch { /* logged via DB driver if it matters */ }

    try {
      const result = await proxyToTenant(instance, {
        method: "POST",
        path: `/api/v1/integrations/${encodeURIComponent(conn.id)}/auto-config`,
        timeoutMs: 30000,
      });
      try {
        await applyAutoConfigResult(delegate, user.id, conn.id, result || {});
      } catch (err) {
        console.error("[finalizeComposioConnections] applyResult failed:", err);
      }
      results.push({ toolkit: conn.toolkit, ...result });
    } catch (err: any) {
      try {
        await markAutoConfigError(
          delegate,
          user.id,
          conn.id,
          err?.message ?? String(err),
        );
      } catch { /* best-effort */ }
      // best-effort — don't block onboarding completion
    }
  }

  return { configured: results.length, results };
};

// =============================================================================
// Shared guards
// =============================================================================

function requireUser(context: any): { id: string } {
  const user = context?.user;
  if (!user?.id) throw new Error("Not authenticated");
  return user;
}
