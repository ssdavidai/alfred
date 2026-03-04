import crypto from "crypto";
import type { Application } from "express";
import { prisma } from "wasp/server";
import { proxyToTenant } from "./tenantProxy";

export function registerWebhookReceiver(app: Application): void {
  app.post("/webhooks/:webhookToken", async (req, res) => {
    try {
      const webhookToken = req.params["webhookToken"] as string;

      const stream = await prisma.stream.findUnique({
        where: { webhookToken },
      });

      if (!stream) {
        res.status(404).json({ error: "Unknown webhook token" });
        return;
      }

      if (!stream.enabled) {
        res.status(200).json({ status: "stream_paused" });
        return;
      }

      const config = stream.config as Record<string, unknown> | null;
      const webhookSecret =
        config && typeof config.webhookSecret === "string"
          ? config.webhookSecret
          : null;

      if (webhookSecret) {
        const rawSig = req.headers["x-webhook-signature"] ?? req.headers["x-hub-signature-256"];
        const signature: string | undefined = Array.isArray(rawSig) ? rawSig[0] : (rawSig as string | undefined);
        if (!signature) {
          res.status(401).json({ error: "Missing webhook signature" });
          return;
        }
        const rawBody = JSON.stringify(req.body);
        const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
        const sig = signature.replace(/^sha256=/, "");
        if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) {
          res.status(401).json({ error: "Invalid webhook signature" });
          return;
        }
      }

      const event = {
        stream_id: stream.id,
        stream_type: stream.source,
        tenant_id: stream.userId,
        received_at: new Date().toISOString(),
        source_ref: extractSourceRef(req.body),
        raw: req.body,
        summary: extractSummary(req.body),
      };

      // Fetch tenant instance separately
      const instance = await prisma.instance.findUnique({ where: { userId: stream.userId } });

      if (instance && instance.tailscaleHostname && instance.apiKey && instance.status === "running") {
        try {
          await proxyToTenant(instance, { method: "POST", path: "/api/v1/streams/ingest", body: event });
        } catch {
          await prisma.streamEvent.create({
            data: {
              streamId: stream.id,
              userId: stream.userId,
              sourceRef: event.source_ref ?? null,
              type: stream.source,
              raw: req.body as any,
              summary: event.summary ?? null,
            },
          });
        }
      } else {
        await prisma.streamEvent.create({
          data: {
            streamId: stream.id,
            userId: stream.userId,
            sourceRef: event.source_ref ?? null,
            type: stream.source,
            raw: req.body as any,
            summary: event.summary ?? null,
          },
        });
      }

      await prisma.stream.update({ where: { id: stream.id }, data: { lastEventAt: new Date() } });
      res.status(200).json({ status: "received" });
    } catch (error: unknown) {
      console.error("Webhook receiver error:", error);
      res.status(500).json({ error: "Internal error" });
    }
  });
}

function extractSourceRef(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  return (typeof b.id === "string" ? b.id : null) ??
         (typeof b.event_id === "string" ? b.event_id : null) ??
         (typeof b.message_id === "string" ? b.message_id : null);
}

function extractSummary(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.type === "string") {
    const detail =
      typeof b.subject === "string" ? b.subject :
      typeof b.title === "string" ? b.title :
      typeof b.description === "string" ? (b.description as string).slice(0, 100) : "";
    return detail ? `${b.type}: ${detail}` : b.type;
  }
  return null;
}