// SaaS webhook receiver for AgentMail `message.received` events.
//
// AgentMail delivers signed POST requests via Svix. We verify with the
// shared webhook signing secret, look up the tenant by payload.message.inbox_id,
// then dual-dispatch to the tenant's ctrl-api:
//
//   authorized sender → POST /api/v1/channels/email/inbound   (openclaw session)
//   anyone else       → POST /api/v1/streams/ingest           (zero-LLM ingest)
//
// The route does NOT go through Wasp's global json parser — Svix needs
// the raw body bytes for signature verification. Same pattern as
// `webhookReceiver.ts` (which uses raw HMAC, not Svix).

import express from "express";
import type { Application } from "express";
import { Webhook, WebhookVerificationError } from "svix";
import { prisma } from "wasp/server";
import { proxyToTenant } from "./tenantProxy";

const AGENTMAIL_WEBHOOK_SECRET = process.env.AGENTMAIL_WEBHOOK_SECRET || "";
const AUTHORIZED_CACHE_MS = 60_000; // 60s — list changes slowly

// Per-tenant cache of { senders: Set<string>, expiresAt: number }
const authorizedCache = new Map<
  string,
  { senders: Set<string>; expiresAt: number }
>();

async function fetchAuthorizedSenders(instance: {
  id: string;
  tailscaleHostname: string | null;
  apiKey: string | null;
  status: string;
}): Promise<Set<string> | null> {
  const cached = authorizedCache.get(instance.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.senders;
  }
  if (!instance.tailscaleHostname || !instance.apiKey || instance.status !== "running") {
    // Tenant VM not reachable right now — fail closed (treat as unauthorized
    // which routes to stream ingest; safer than treating unknown senders as
    // authorized). StreamEvent fallback below preserves the message.
    return null;
  }
  try {
    const resp: any = await proxyToTenant(instance as any, {
      method: "GET",
      path: "/api/v1/auth/senders",
    });
    const senders = new Set<string>(
      Array.isArray(resp?.senders)
        ? resp.senders.map((s: string) => s.toLowerCase())
        : [],
    );
    authorizedCache.set(instance.id, {
      senders,
      expiresAt: Date.now() + AUTHORIZED_CACHE_MS,
    });
    return senders;
  } catch (err) {
    console.warn(
      `[agentmail-receiver] failed to fetch authorized senders for ${instance.id}:`,
      err,
    );
    return null;
  }
}

export function registerAgentMailReceiver(app: Application): void {
  if (!AGENTMAIL_WEBHOOK_SECRET) {
    console.log(
      "[agentmail-receiver] AGENTMAIL_WEBHOOK_SECRET not set — AgentMail webhook disabled",
    );
    return;
  }

  app.post(
    "/webhooks/agentmail",
    // Svix signature is over the raw bytes, so we need the unparsed body.
    express.raw({ type: "application/json", limit: "2mb" }),
    async (req: any, res) => {
      const rawBody: Buffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body ?? "");

      // 1. Svix verification
      let verified: any;
      try {
        const wh = new Webhook(AGENTMAIL_WEBHOOK_SECRET);
        verified = wh.verify(rawBody, req.headers as Record<string, string>);
      } catch (err) {
        if (err instanceof WebhookVerificationError) {
          res.status(400).json({ error: "invalid signature" });
          return;
        }
        console.error("[agentmail-receiver] verification error:", err);
        res.status(400).json({ error: "verification failed" });
        return;
      }

      const eventType = verified?.event_type;
      // Ack anything that's not message.received quickly — we only act
      // on inbound messages today.
      if (eventType !== "message.received") {
        res.status(204).send();
        return;
      }

      const message = verified?.message ?? {};
      const inboxId: string | undefined = message.inbox_id;
      if (!inboxId) {
        res.status(204).send();
        return;
      }

      // 2. Tenant lookup
      const instance = await prisma.instance.findFirst({
        where: { agentmailInboxId: inboxId },
      });
      if (!instance) {
        // Stale inbox id — either the tenant was destroyed or this event
        // belongs to a non-fleet inbox (e.g. David's personal one). Ack
        // and drop so AgentMail doesn't retry.
        console.log(
          `[agentmail-receiver] no instance for inbox_id=${inboxId}, dropping`,
        );
        res.status(204).send();
        return;
      }

      // Respond quickly to AgentMail and let the dispatch finish in the
      // background — the raw event is safely in our hands.
      res.status(204).send();

      try {
        // 3. Authorization
        const fromList: string[] = Array.isArray(message.from_)
          ? message.from_
          : [];
        const sender = (fromList[0] ?? "").toLowerCase();
        const authorized = await fetchAuthorizedSenders(instance as any);
        const isAuthorized = sender && authorized?.has(sender) === true;

        // 4. Dispatch
        if (isAuthorized) {
          // Channel path — full payload, preserve quoted history (Alfred needs context)
          await proxyToTenant(instance as any, {
            method: "POST",
            path: "/api/v1/channels/email/inbound",
            body: {
              message,
              event_id: verified.event_id,
            },
          }).catch((err) => {
            console.warn(
              "[agentmail-receiver] channel dispatch failed, falling back to StreamEvent:",
              err,
            );
            return prisma.streamEvent.create({
              data: {
                streamId: "agentmail-channel-buffer", // logical marker
                userId: instance.userId,
                sourceRef: message.message_id ?? null,
                type: "agentmail-channel",
                raw: message as any,
                summary: message.subject ?? null,
              },
            }).catch(() => {});
          });
        } else {
          // Stream path — extracted_text for quote-stripped body (noise reduction)
          const bodyText =
            typeof message.extracted_text === "string"
              ? message.extracted_text
              : typeof message.text === "string"
                ? message.text
                : null;
          await proxyToTenant(instance as any, {
            method: "POST",
            path: "/api/v1/streams/ingest",
            body: {
              stream_type: "agentmail",
              received_at: new Date().toISOString(),
              source_ref: message.message_id ?? null,
              summary: message.subject ?? null,
              raw: message,
              body_text: bodyText,
            },
          }).catch((err) => {
            console.warn(
              "[agentmail-receiver] stream dispatch failed, falling back to StreamEvent:",
              err,
            );
            return prisma.streamEvent.create({
              data: {
                streamId: "agentmail-stream-buffer",
                userId: instance.userId,
                sourceRef: message.message_id ?? null,
                type: "agentmail",
                raw: message as any,
                summary: message.subject ?? null,
              },
            }).catch(() => {});
          });
        }
      } catch (err) {
        console.error("[agentmail-receiver] dispatch pipeline error:", err);
      }
    },
  );
}
