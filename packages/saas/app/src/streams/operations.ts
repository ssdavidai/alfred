import { HttpError } from "wasp/server";
import { prisma } from "wasp/server";
import crypto from "crypto";
import type {
  GetStreams,
  GetStreamEvents,
  CreateStream,
  UpdateStream,
  DeleteStream,
  PauseStream,
  ResumeStream,
  RegenerateWebhookToken,
  StoreIntegrationToken,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";
import { encryptApiKey } from "../server/tenantProxy";

export const getStreams: GetStreams<void, any> = async (_args, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");

  // Get Prisma streams (for SaaS-side fields: webhookToken, config, etc.)
  const prismaStreams = await prisma.stream.findMany({
    where: { userId: context.user.id },
    orderBy: { createdAt: "desc" },
  });

  // Merge with tenant-side event counts AND synthesize entries for tenant-only
  // streams (composio streams live in the tenant's streams.json but have no
  // Prisma row). Surfacing them here is what makes the Streams page show a
  // unified list.
  try {
    const instance = await getUserInstance(context);
    const tenantData = await proxyToTenant(instance, { path: "/api/v1/streams" });
    const tenantStreams: any[] = tenantData?.streams || [];
    const countById = new Map(
      tenantStreams.map((s: any) => [
        s.id,
        { event_count: s.event_count || 0, last_event_at: s.last_event_at, status: s.status, enabled: s.enabled },
      ]),
    );
    const countBySource = new Map(
      tenantStreams.map((s: any) => [
        s.source,
        { event_count: s.event_count || 0, last_event_at: s.last_event_at, status: s.status, enabled: s.enabled },
      ]),
    );

    const tenantBaseUrl = (instance as any)?.subdomainUrl?.replace(/\/$/, "") || null;

    const merged = prismaStreams.map((s: any) => {
      const tenant = countById.get(s.id) || countBySource.get(s.source);
      return {
        ...s,
        _count: { events: tenant?.event_count ?? 0 },
        lastEventAt: tenant?.last_event_at ?? s.lastEventAt,
        tenantBaseUrl,
      };
    });

    // Synthesize "virtual" entries for tenant streams that have no Prisma
    // counterpart. These are the Composio streams created by auto-config.
    // They live entirely on the tenant (streams.json + STREAM_CONFIGS_DIR)
    // — we expose them read-mostly: the user can see event counts + go to
    // the Integrations page to toggle them, but can't edit them inline.
    const prismaIds = new Set(prismaStreams.map((s: any) => s.id));
    const composioConnections = await prisma.composioConnection.findMany({
      where: { userId: context.user.id },
      select: { toolkit: true, label: true, iconUrl: true, connectionId: true },
    });
    const toolkitMeta = new Map(
      composioConnections.map((c) => [c.toolkit, c]),
    );

    const virtualStreams = tenantStreams
      .filter((t: any) => t.type === "composio" && !prismaIds.has(t.id))
      .map((t: any) => {
        const toolkit = String(t.composio_toolkit || (t.source || "").replace(/^composio:/, "") || "").toLowerCase();
        const meta = toolkitMeta.get(toolkit) ?? null;
        return {
          id: t.id,
          userId: context.user!.id,
          name: t.name || t.id,
          type: "composio",
          source: t.source || `composio:${toolkit}`,
          isSystem: false,
          enabled: t.enabled !== false,
          config: {},
          webhookToken: null,
          lastRunAt: null,
          lastEventAt: t.last_event_at ?? null,
          status: t.status ?? "idle",
          errorMessage: null,
          createdAt: t.created_at ?? new Date().toISOString(),
          updatedAt: t.updated_at ?? new Date().toISOString(),
          _count: { events: t.event_count ?? 0 },
          tenantBaseUrl,
          // Extra fields for the UI to render this as a Composio-backed stream
          isComposio: true,
          composioAction: t.composio_action ?? null,
          composioConnectionId: t.composio_connection_id ?? meta?.connectionId ?? null,
          composioToolkit: toolkit || null,
          composioLabel: meta?.label ?? null,
          composioIconUrl: meta?.iconUrl ?? null,
        };
      });

    return [...merged, ...virtualStreams];
  } catch {
    // Tenant unreachable — return Prisma data with 0 counts
    return prismaStreams.map((s: any) => ({ ...s, _count: { events: 0 } }));
  }
};

export const getStreamEvents: GetStreamEvents<{ streamId: string }, any> = async (args, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");

  // Proxy to tenant ctrl API for actual events (stored in JSONL on tenant)
  try {
    const instance = await getUserInstance(context);

    // Resolve tenant stream ID — system streams use "system-{source}" on the tenant
    let tenantStreamId = args.streamId;
    const stream = await prisma.stream.findUnique({ where: { id: args.streamId } });
    if (stream?.isSystem) {
      tenantStreamId = `system-${stream.source}`;
    }

    const tenantData = await proxyToTenant(instance, {
      path: `/api/v1/streams/${tenantStreamId}/events`,
      query: { limit: "50" },
    });
    // Map snake_case from ctrl API to camelCase for the UI
    const events = tenantData?.events || [];
    return events.map((e: any) => ({
      id: e.id,
      streamId: e.stream_id,
      receivedAt: e.received_at,
      type: e.stream_type || e.type,
      summary: e.summary,
      raw: e.raw,
      sourceRef: e.source_ref,
      processed: false,
    }));
  } catch (err: any) {
    console.error(`[getStreamEvents] proxy failed: ${err?.message || err}`);
    // Tenant unreachable — return empty
    return [];
  }
};

export const createStream: CreateStream<any, any> = async (args: any, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const webhookToken = args.type === "webhook" ? crypto.randomBytes(24).toString("hex") : null;
  const stream = await prisma.stream.create({
    data: {
      userId: context.user.id,
      name: args.name,
      type: args.type,
      source: args.source,
      config: (args.config as any) ?? {},
      webhookToken,
    },
  });
  try {
    const instance = await getUserInstance(context);
    // Create stream on tenant
    await proxyToTenant(instance, {
      method: "POST",
      path: "/api/v1/streams",
      body: { id: stream.id, name: stream.name, type: stream.type, source: stream.source, config: stream.config, enabled: stream.enabled, webhookToken: stream.webhookToken },
    });

    // If this is a pull stream, configure the pull engine on the tenant
    const pullConfig = (args.config as any)?.pull;
    if (args.type === "scheduled" && pullConfig) {
      const authProvider = (args.config as any)?.auth_provider || args.source;
      const patchBody: Record<string, unknown> = {
        pull_endpoint: pullConfig.endpoint,
        pull_method: pullConfig.method || "GET",
        parser: (args.config as any)?.parser || "passthrough",
        auth_type: (args.config as any)?.auth_type || "none",
        auth_config: { provider: authProvider, user_id: context.user.id },
        schedule_interval_seconds: pullConfig.intervalSeconds || 300,
      };
      // Static headers from config (e.g. Notion-Version)
      if (pullConfig.headers) {
        patchBody.pull_headers = pullConfig.headers;
      }
      if (pullConfig.detailEndpoint) {
        patchBody.detail_endpoint = pullConfig.detailEndpoint;
        patchBody.detail_id_field = pullConfig.detailIdField || "id";
      }

      await proxyToTenant(instance, {
        method: "PATCH",
        path: `/api/v1/streams/${stream.id}`,
        body: patchBody,
      });

      // Create Temporal schedule for the pull
      const scheduleId = `al-stream-pull-${args.source}-${stream.id.slice(0, 8)}`;
      const intervalMin = Math.max(Math.round((pullConfig.intervalSeconds || 300) / 60), 1);
      await proxyToTenant(instance, {
        method: "POST",
        path: "/api/v1/schedules",
        body: {
          schedule_id: scheduleId,
          workflow_type: "StreamPullerWorkflow",
          task_queue: "alfred-learn",
          cron: `*/${intervalMin} * * * *`,
          input: { stream_id: stream.id },
          overlap_policy: "Skip",
        },
      });
    }
  } catch (err: any) {
    console.error("[createStream] Tenant setup failed:", err?.message);
  }
  return stream;
};

export const updateStream: UpdateStream<any, any> = async (args: any, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const existing = await prisma.stream.findUnique({ where: { id: args.id } });
  if (!existing || existing.userId !== context.user.id) throw new HttpError(404, "Stream not found");
  return prisma.stream.update({
    where: { id: args.id },
    data: {
      ...(args.name !== undefined && { name: args.name }),
      ...(args.config !== undefined && { config: args.config as any }),
      ...(args.enabled !== undefined && { enabled: args.enabled }),
    },
  });
};

export const deleteStream: DeleteStream<any, any> = async (args: any, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const existing = await prisma.stream.findUnique({ where: { id: args.id } });
  if (!existing || existing.userId !== context.user.id) throw new HttpError(404, "Stream not found");
  if (existing.isSystem) throw new HttpError(400, "Cannot delete a system stream");
  try {
    const instance = await getUserInstance(context);
    await proxyToTenant(instance, { method: "DELETE", path: `/api/v1/streams/${args.id}` });
  } catch { /* tenant may not be reachable */ }
  await prisma.stream.delete({ where: { id: args.id } });
};

export const pauseStream: PauseStream<any, any> = async (args: any, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const existing = await prisma.stream.findUnique({ where: { id: args.id } });
  if (!existing || existing.userId !== context.user.id) throw new HttpError(404, "Stream not found");
  if (existing.isSystem) throw new HttpError(400, "Cannot pause a system stream");
  try {
    const instance = await getUserInstance(context);
    await proxyToTenant(instance, { method: "POST", path: `/api/v1/streams/${args.id}/pause` });
  } catch { /* continue */ }
  return prisma.stream.update({ where: { id: args.id }, data: { enabled: false, status: "paused" } });
};

export const resumeStream: ResumeStream<any, any> = async (args: any, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const existing = await prisma.stream.findUnique({ where: { id: args.id } });
  if (!existing || existing.userId !== context.user.id) throw new HttpError(404, "Stream not found");
  if (existing.isSystem) throw new HttpError(400, "Cannot resume a system stream");
  try {
    const instance = await getUserInstance(context);
    await proxyToTenant(instance, { method: "POST", path: `/api/v1/streams/${args.id}/resume` });
  } catch { /* continue */ }
  return prisma.stream.update({ where: { id: args.id }, data: { enabled: true, status: "idle", errorMessage: null } });
};

export const regenerateWebhookToken: RegenerateWebhookToken<any, any> = async (args: any, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const existing = await prisma.stream.findUnique({ where: { id: args.id } });
  if (!existing || existing.userId !== context.user.id) throw new HttpError(404, "Stream not found");
  if (existing.type !== "webhook") throw new HttpError(400, "Only webhook streams have tokens");
  return prisma.stream.update({ where: { id: args.id }, data: { webhookToken: crypto.randomBytes(24).toString("hex") } });
};

export const storeIntegrationToken: StoreIntegrationToken<any, any> = async (args: any, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");

  const { provider, token } = args;
  if (!provider || !token) throw new HttpError(400, "provider and token are required");

  // Store as an OAuthCredential — same shape the pull engine expects
  await prisma.oAuthCredential.upsert({
    where: {
      userId_provider: {
        userId: context.user.id,
        provider,
      },
    },
    create: {
      userId: context.user.id,
      provider,
      accessToken: encryptApiKey(token),
      refreshToken: null,
      tokenType: "Bearer",
      expiresAt: null, // Internal tokens don't expire
      scopes: [],
      accountLabel: `${provider} integration`,
    },
    update: {
      accessToken: encryptApiKey(token),
      expiresAt: null,
    },
  });

  return { status: "stored" };
};

// ---------------------------------------------------------------------------
// A.2: applyStreamSuggestions
//
// Reads onboard.json["suggested_streams"] from the tenant via proxy and
// auto-creates Stream rows for sources where we already have credentials
// (notably gmail, since the user authorized Google during signup). Sources
// that need user action (github, polar, notion) are returned in the
// `skipped` list with a `needs_user_action` reason — the UI surfaces those
// as cards with Connect buttons in A.3.
//
// Idempotent: if a Stream of the same source already exists for the user,
// skipped with reason "already_exists". Safe to re-run.
//
// Returns:
//   {
//     created: [{id, source, name}],
//     skipped: [{source, reason}],
//     errors: [{source, error}],
//     suggested_count: number,
//   }
// ---------------------------------------------------------------------------

import { SOURCES } from "./sources";

// Sources we can auto-create on the user's behalf because we already have
// the credentials at signup time. Currently just gmail (Google OAuth happens
// during signup). System streams (openclaw-sessions) are auto-created
// elsewhere.
const _AUTO_CREATABLE_SOURCES = new Set(["gmail"]);

// A.3: getStreamSuggestions — return the suggestions that need user
// action (i.e. would have been skipped by applyStreamSuggestions because
// they need OAuth/api_key/webhook setup). The Streams page renders these
// as Connect cards.
export const getStreamSuggestions = async (
  _args: void,
  context: any,
): Promise<{
  unresolved: Array<{
    source_id: string;
    label: string;
    description: string;
    auth_type: string;
    detected_from_domain: string;
    suggested_name: string;
  }>;
  total_suggested: number;
}> => {
  if (!context.user) throw new HttpError(401, "Not authenticated");

  // Fetch suggestions from tenant
  let suggested: any[] = [];
  try {
    const instance = await getUserInstance(context);
    const data = await proxyToTenant(instance, {
      method: "GET",
      path: "/api/v1/onboarding/suggested-streams",
    });
    suggested = Array.isArray(data?.suggested_streams)
      ? data.suggested_streams
      : [];
  } catch (err: any) {
    console.error("[getStreamSuggestions] proxy fetch failed:", err?.message);
    return { unresolved: [], total_suggested: 0 };
  }

  if (suggested.length === 0) {
    return { unresolved: [], total_suggested: 0 };
  }

  // Look up existing streams to filter duplicates
  const existing = await prisma.stream.findMany({
    where: { userId: context.user.id },
    select: { source: true },
  });
  const existingSources = new Set(existing.map((s: any) => s.source));

  const unresolved: Array<{
    source_id: string;
    label: string;
    description: string;
    auth_type: string;
    detected_from_domain: string;
    suggested_name: string;
  }> = [];

  const seen = new Set<string>();

  for (const suggestion of suggested) {
    if (typeof suggestion !== "object" || !suggestion) continue;
    const sourceId = String(
      suggestion.type ?? suggestion.source ?? "",
    ).trim();
    if (!sourceId) continue;

    const sourceDef = SOURCES.find(
      (s: any) =>
        s.id === sourceId ||
        sourceId === `${s.id}_webhook` ||
        sourceId === `${s.id}_pull` ||
        sourceId.startsWith(`${s.id}_`),
    );

    if (!sourceDef) continue;
    if (seen.has(sourceDef.id)) continue;
    seen.add(sourceDef.id);

    // Skip already-existing
    if (existingSources.has(sourceDef.id)) continue;

    // Skip auto-creatable (those flow through applyStreamSuggestions)
    if (_AUTO_CREATABLE_SOURCES.has(sourceDef.id)) continue;

    // Skip system streams (auto-created elsewhere)
    if (sourceDef.transport === "system") continue;

    // Skip custom — nothing to suggest about a generic webhook
    if (sourceDef.id === "custom") continue;

    unresolved.push({
      source_id: sourceDef.id,
      label: sourceDef.label,
      description: sourceDef.description,
      auth_type: sourceDef.authType,
      detected_from_domain: String(suggestion.detected_from_domain ?? ""),
      suggested_name: String(suggestion.name ?? sourceDef.label),
    });
  }

  return {
    unresolved,
    total_suggested: suggested.length,
  };
};


export const applyStreamSuggestions = async (
  _args: void,
  context: any,
): Promise<{
  created: Array<{ id: string; source: string; name: string }>;
  skipped: Array<{ source: string; reason: string }>;
  errors: Array<{ source: string; error: string }>;
  suggested_count: number;
}> => {
  if (!context.user) throw new HttpError(401, "Not authenticated");

  // 1. Fetch suggestions from tenant
  let suggested: any[] = [];
  try {
    const instance = await getUserInstance(context);
    const data = await proxyToTenant(instance, {
      method: "GET",
      path: "/api/v1/onboarding/suggested-streams",
    });
    suggested = Array.isArray(data?.suggested_streams)
      ? data.suggested_streams
      : [];
  } catch (err: any) {
    console.error("[applyStreamSuggestions] proxy fetch failed:", err?.message);
    return {
      created: [],
      skipped: [],
      errors: [{ source: "_proxy", error: err?.message ?? "unknown" }],
      suggested_count: 0,
    };
  }

  if (suggested.length === 0) {
    return {
      created: [],
      skipped: [],
      errors: [],
      suggested_count: 0,
    };
  }

  // 2. Look up existing streams to avoid duplicates
  const existing = await prisma.stream.findMany({
    where: { userId: context.user.id },
    select: { source: true, name: true },
  });
  const existingSources = new Set(existing.map((s: any) => s.source));

  const created: Array<{ id: string; source: string; name: string }> = [];
  const skipped: Array<{ source: string; reason: string }> = [];
  const errors: Array<{ source: string; error: string }> = [];

  // 3. For each suggestion, decide what to do
  for (const suggestion of suggested) {
    if (typeof suggestion !== "object" || !suggestion) continue;
    const sourceId = String(
      suggestion.type ?? suggestion.source ?? "",
    ).trim();
    if (!sourceId) {
      skipped.push({ source: "_unknown", reason: "missing source id" });
      continue;
    }

    // Map detection types like "stripe_webhook" to known SOURCES ids
    // (gmail -> gmail, github_webhook -> github, etc.)
    const sourceDef = SOURCES.find(
      (s: any) =>
        s.id === sourceId ||
        sourceId === `${s.id}_webhook` ||
        sourceId === `${s.id}_pull` ||
        sourceId.startsWith(`${s.id}_`),
    );

    if (!sourceDef) {
      skipped.push({ source: sourceId, reason: "unknown source" });
      continue;
    }

    // Skip duplicates
    if (existingSources.has(sourceDef.id)) {
      skipped.push({ source: sourceDef.id, reason: "already_exists" });
      continue;
    }

    // Skip if not auto-creatable (UI surfaces these as Connect cards in A.3)
    if (!_AUTO_CREATABLE_SOURCES.has(sourceDef.id)) {
      skipped.push({ source: sourceDef.id, reason: "needs_user_action" });
      continue;
    }

    // Determine the stream type from the source's transport
    const streamType =
      sourceDef.transport === "pull" ? "scheduled" :
      sourceDef.transport === "push" ? "webhook" :
      sourceDef.transport === "system" ? "system" :
      "scheduled";

    // 4. Create the stream via the existing createStream code path
    try {
      const result = await createStream(
        {
          name: suggestion.name || sourceDef.label,
          type: streamType,
          source: sourceDef.id,
          config: sourceDef.defaultConfig,
        },
        context,
      );
      created.push({
        id: (result as any).id,
        source: sourceDef.id,
        name: (result as any).name,
      });
    } catch (err: any) {
      errors.push({
        source: sourceDef.id,
        error: err?.message ?? String(err),
      });
    }
  }

  return {
    created,
    skipped,
    errors,
    suggested_count: suggested.length,
  };
};
