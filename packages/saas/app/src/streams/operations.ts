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

  // Merge with tenant-side event counts
  try {
    const instance = await getUserInstance(context);
    const tenantData = await proxyToTenant(instance, { path: "/api/v1/streams" });
    const tenantStreams: any[] = tenantData?.streams || [];
    // Build lookup by both ID and source — system streams use different IDs on SaaS vs tenant
    const countById = new Map(tenantStreams.map((s: any) => [s.id, { event_count: s.event_count || 0, last_event_at: s.last_event_at }]));
    const countBySource = new Map(tenantStreams.map((s: any) => [s.source, { event_count: s.event_count || 0, last_event_at: s.last_event_at }]));

    return prismaStreams.map((s: any) => {
      const tenant = countById.get(s.id) || countBySource.get(s.source);
      return { ...s, _count: { events: tenant?.event_count ?? 0 }, lastEventAt: tenant?.last_event_at ?? s.lastEventAt };
    });
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
    const tenantData = await proxyToTenant(instance, {
      path: `/api/v1/streams/${args.streamId}/events`,
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
      body: { id: stream.id, name: stream.name, type: stream.type, source: stream.source, config: stream.config, enabled: stream.enabled },
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