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
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";

export const getStreams: GetStreams<void, any> = async (_args, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  return prisma.stream.findMany({
    where: { userId: context.user.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { events: true } } },
  });
};

export const getStreamEvents: GetStreamEvents<{ streamId: string }, any> = async (args, context) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const stream = await prisma.stream.findUnique({ where: { id: args.streamId } });
  if (!stream || stream.userId !== context.user.id) throw new HttpError(404, "Stream not found");
  return prisma.streamEvent.findMany({
    where: { streamId: args.streamId },
    orderBy: { receivedAt: "desc" },
    take: 50,
  });
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
    await proxyToTenant(instance, {
      method: "POST",
      path: "/api/v1/streams",
      body: { id: stream.id, name: stream.name, type: stream.type, source: stream.source, enabled: stream.enabled },
    });
  } catch { /* tenant may not be reachable */ }
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