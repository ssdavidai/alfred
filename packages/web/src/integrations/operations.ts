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
  GetIntegrationScope,
  InitiateConnect,
  InitiateApiKeyConnect,
  DisconnectIntegration,
  EnableIntegrationStream,
  DisableIntegrationStream,
  MigrateIntegrationStream,
  EnableIntegrationTool,
  DisableIntegrationTool,
  AutoConfigIntegration,
  FinalizeComposioConnections,
  CreateInboundWebhook,
  DeleteInboundWebhook,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";
import {
  GoogleAccountMismatchError,
  isGoogleFamilyToolkit,
  isGuardEnabled,
  verifyGoogleEmailMatch,
} from "../server/oauthTenantEmailGuard";
import { prisma } from "wasp/server";
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

      // Synthetic non-Composio rows (Omi devices, custom webhooks) pass
      // through untouched — they don't have a ComposioConnection Prisma
      // row and never will. They live on the tenant (vault + openclaw
      // device list) as the only source of truth.
      const isSynthetic =
        typeof t.id === "string" &&
        (t.id.startsWith("omi:") || t.id.startsWith("webhook:"));
      if (isSynthetic) {
        return {
          id: t.id,
          toolkit,
          toolkit_name: t.toolkit_name,
          toolkit_icon: t.toolkit_icon,
          status: t.status,
          auth_scheme: t.auth_scheme,
          created_at: t.created_at,
          is_stream_source: Boolean(t.is_stream_source),
          // Auto-config fields don't apply to non-Composio sources —
          // surface clean defaults so the UI doesn't render half-state.
          auto_config_state: "configured",
          auto_config_error: null,
          auto_configured_at: null,
          streams_created: 0,
          tools_enabled: 0,
          skill_name: null,
        };
      }

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
        is_stream_source: Boolean(t.is_stream_source),
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
 * Migrate a stale stream to a new Composio action slug. Used when Composio
 * removes/renames an action (e.g. NOTION_LIST_PAGES → NOTION_FETCH_DATA) —
 * without this, the stream keeps 404'ing every pull forever.
 *
 * If new_action_slug is omitted, ctrl-api falls back to RECOMMENDED_STREAMS
 * for the toolkit.
 */
export const migrateIntegrationStream: MigrateIntegrationStream<
  { connectionId: string; old_action_slug: string; new_action_slug?: string },
  any
> = async (args, context) => {
  if (!args?.connectionId) throw new Error("connectionId is required");
  if (!args?.old_action_slug) throw new Error("old_action_slug is required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/integrations/${encodeURIComponent(args.connectionId)}/migrate-stream`,
    body: {
      old_action_slug: args.old_action_slug,
      new_action_slug: args.new_action_slug,
    },
  });
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

  // -----------------------------------------------------------------------
  // Tenant-email guard for Google-family Composio connections. Must run
  // BEFORE auto-config writes streams/skills/tools — that way a mismatched
  // connection never leaves side effects on the tenant filesystem. See
  // oauthTenantEmailGuard.ts for background on the 2026-04-16 incident.
  // -----------------------------------------------------------------------
  const existingRow = await delegate.findUnique({
    where: { connectionId: args.connectionId },
    select: { toolkit: true, userId: true },
  });
  const toolkit = (existingRow?.toolkit ?? "").toLowerCase();
  if (toolkit && isGuardEnabled() && isGoogleFamilyToolkit(toolkit)) {
    try {
      await enforceComposioGoogleFamilyGuard(
        instance,
        user.id,
        args.connectionId,
        toolkit,
      );
    } catch (err) {
      if (err instanceof GoogleAccountMismatchError) {
        console.error(
          `[autoConfigIntegration] guard REJECTED — user ${user.id} tried to connect ${toolkit} as ${err.connectedEmail}, expected ${err.expectedEmail}`,
        );
        await rollbackMismatchedComposioConnection(
          instance,
          user.id,
          args.connectionId,
          delegate,
        );
        const rejection: any = new Error(
          `This tenant is owned by ${err.expectedEmail}. ` +
            `You connected ${err.connectedEmail} instead. ` +
            `Sign out of ${err.connectedEmail} in your browser, sign in as ${err.expectedEmail}, and try again.`,
        );
        rejection.code = "google_account_mismatch";
        rejection.statusCode = 400;
        rejection.connectedEmail = err.connectedEmail;
        rejection.expectedEmail = err.expectedEmail;
        throw rejection;
      }
      // Non-mismatch error from the guard itself — already logged; continue
      // to auto-config (the guard logs "SKIPPED" reasons explicitly).
    }
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

    // Tenant-email guard for Google-family toolkits, same as autoConfigIntegration.
    const toolkit = String(conn.toolkit ?? "").toLowerCase();
    if (toolkit && isGuardEnabled() && isGoogleFamilyToolkit(toolkit)) {
      try {
        await enforceComposioGoogleFamilyGuard(instance, user.id, conn.id, toolkit);
      } catch (err) {
        if (err instanceof GoogleAccountMismatchError) {
          console.error(
            `[finalizeComposioConnections] guard REJECTED — ${toolkit} connection ${conn.id} connected=${err.connectedEmail} expected=${err.expectedEmail}`,
          );
          await rollbackMismatchedComposioConnection(
            instance,
            user.id,
            conn.id,
            delegate,
          );
          try {
            await markAutoConfigError(
              delegate,
              user.id,
              conn.id,
              `google_account_mismatch: connected=${err.connectedEmail} expected=${err.expectedEmail}`,
            );
          } catch { /* best-effort */ }
          results.push({
            toolkit,
            error: "google_account_mismatch",
            connected_email: err.connectedEmail,
            expected_email: err.expectedEmail,
          });
          continue;
        }
        // Non-mismatch: fall through to auto-config as before.
      }
    }

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

/**
 * Tenant-email guard for Composio connections (Google family only).
 *
 * Mirrors the oauth2.ts guard but for Composio-managed OAuth: after a
 * Google-family toolkit connects, we ask the tenant ctrl-api to report
 * the provider-returned email (extracted from Composio metadata or a live
 * GMAIL_GET_PROFILE call), then compare against the tenant owner's email.
 * Mismatch → throw GoogleAccountMismatchError, caller rolls back.
 *
 * Throws on mismatch. Returns silently on match or on "can't verify / not
 * applicable" outcomes (logged via console).
 */
async function enforceComposioGoogleFamilyGuard(
  instance: any,
  userId: string,
  connectionId: string,
  toolkit: string,
): Promise<void> {
  if (!isGuardEnabled()) return;
  if (!isGoogleFamilyToolkit(toolkit)) return;

  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  const ownerEmail = owner?.email ?? null;
  if (!ownerEmail) {
    console.warn(
      `[composio guard] SKIPPED — user ${userId} has no email on record; allowing ${toolkit} connection`,
    );
    return;
  }

  let identity: any;
  try {
    identity = await proxyToTenant(instance, {
      path: `/api/v1/integrations/${encodeURIComponent(connectionId)}/google-identity`,
      timeoutMs: 15000,
    });
  } catch (err: any) {
    console.warn(
      `[composio guard] SKIPPED — identity probe errored for ${toolkit}/${connectionId}: ${String(
        err?.message ?? err,
      ).slice(0, 200)}`,
    );
    return;
  }

  const email = identity?.email;
  if (typeof email !== "string" || !email.includes("@")) {
    console.warn(
      `[composio guard] SKIPPED — no email in identity response for ${toolkit}/${connectionId}`,
    );
    return;
  }

  verifyGoogleEmailMatch(email, ownerEmail);
  console.log(
    `[composio guard] OK — ${toolkit}/${connectionId} identity=${email} matches owner=${ownerEmail}`,
  );
}

/**
 * Roll back a Composio connection that failed the tenant-email guard. We
 * tell the tenant ctrl-api to disconnect it so no tokens/streams persist,
 * and drop the SaaS tracking row. Best-effort — if cleanup fails we log and
 * keep going; the mismatch error is what matters.
 */
async function rollbackMismatchedComposioConnection(
  instance: any,
  userId: string,
  connectionId: string,
  delegate: any,
): Promise<void> {
  try {
    await proxyToTenant(instance, {
      method: "DELETE",
      path: `/api/v1/integrations/${encodeURIComponent(connectionId)}`,
      timeoutMs: 15000,
    });
  } catch (err) {
    console.error(
      `[composio guard] rollback: tenant DELETE failed for ${connectionId}:`,
      err,
    );
  }
  try {
    await deleteConnection(delegate, userId, connectionId);
  } catch (err) {
    console.error(
      `[composio guard] rollback: SaaS delete failed for ${connectionId}:`,
      err,
    );
  }
}

// =============================================================================
// Unified-connections additions (#863 follow-up):
//   - getIntegrationScope    — per-row "read · write" labels for the table
//   - createInboundWebhook   — generate a per-tenant inbound webhook URL
//   - deleteInboundWebhook   — revoke one
//
// ctrl-api owns the truth; these are thin proxies. Webhooks are stored as
// vault `webhook_endpoint` records on the tenant; Composio + Omi rows are
// folded into the same /api/v1/integrations response so the SaaS only has
// to consume one merged list.
// =============================================================================

export const getIntegrationScope: GetIntegrationScope<
  { connectionId: string },
  any
> = async (args, context) => {
  if (!args?.connectionId) throw new Error("connectionId is required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: `/api/v1/integrations/${encodeURIComponent(args.connectionId)}/scope`,
  });
};

export const createInboundWebhook: CreateInboundWebhook<
  { label: string },
  any
> = async (args, context) => {
  const label = String(args?.label ?? "").trim();
  if (!label) throw new Error("label is required");
  const instance = await getUserInstance(context);
  const result: any = await proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/webhooks/inbound",
    body: { label },
  });
  // Prepend the tenant's subdomain (cloudflared tunnel) so the user sees a
  // copyable absolute URL, not just the path. The frontend can't safely
  // assemble this on its own — it doesn't know the tenant base URL.
  const base = (instance as any).subdomainUrl
    ? String((instance as any).subdomainUrl).replace(/\/$/, "")
    : "";
  if (result?.url && !/^https?:\/\//i.test(result.url) && base) {
    result.url = `${base}${result.url}`;
  }
  return result;
};

export const deleteInboundWebhook: DeleteInboundWebhook<
  { id: string },
  any
> = async (args, context) => {
  if (!args?.id) throw new Error("id is required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "DELETE",
    path: `/api/v1/webhooks/inbound/${encodeURIComponent(args.id)}`,
  });
};
