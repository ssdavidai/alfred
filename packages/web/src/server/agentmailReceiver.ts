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

/**
 * Extract the bare email address from an RFC 5322-ish `from` field.
 *   "Jane Doe <owner@example.com>"  → "owner@example.com"
 *   "owner@example.com"             → "owner@example.com"
 *   ""                              → ""
 * Returns lowercased, trimmed. Empty string on no match.
 */
function extractEmailAddress(raw: string): string {
  if (!raw) return "";
  const s = String(raw).trim();
  // Angle-bracket form wins
  const bracketMatch = s.match(/<([^>]+)>/);
  if (bracketMatch && bracketMatch[1]) {
    return bracketMatch[1].trim().toLowerCase();
  }
  // Otherwise: first "word@domain" token in the string
  const bareMatch = s.match(/[^\s<>,;]+@[^\s<>,;]+/);
  if (bareMatch) return bareMatch[0].trim().toLowerCase();
  return "";
}

// Single-VM: one local ctrl-api, so a single-slot cache of authorized senders.
let authorizedCache: { senders: Set<string>; expiresAt: number } | null = null;

async function fetchAuthorizedSenders(): Promise<Set<string> | null> {
  if (authorizedCache && authorizedCache.expiresAt > Date.now()) {
    return authorizedCache.senders;
  }
  try {
    const resp: any = await proxyToTenant(
      {},
      {
        method: "GET",
        path: "/api/v1/auth/senders",
      },
    );
    const senders = new Set<string>(
      Array.isArray(resp?.senders)
        ? resp.senders.map((s: string) => s.toLowerCase())
        : [],
    );
    authorizedCache = {
      senders,
      expiresAt: Date.now() + AUTHORIZED_CACHE_MS,
    };
    return senders;
  } catch (err) {
    // ctrl-api not reachable — fail closed (treat as unauthorized, which
    // routes to stream ingest; the StreamEvent fallback preserves the
    // message either way).
    console.warn(
      "[agentmail-receiver] failed to fetch authorized senders:",
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

      // 2. Owner lookup. Single-VM: there is exactly one household and one
      // local ctrl-api — the inbox belongs to the owner account. StreamEvent
      // fallbacks are attributed to that user.
      const owner =
        (await prisma.user.findFirst({ where: { isOwner: true } })) ??
        (await prisma.user.findFirst({ orderBy: { createdAt: "asc" } }));
      if (!owner) {
        // No account yet (fresh install, pre-signup) — ack and drop so
        // AgentMail doesn't retry.
        console.log(
          `[agentmail-receiver] no owner account for inbox_id=${inboxId}, dropping`,
        );
        res.status(204).send();
        return;
      }

      // Respond quickly to AgentMail and let the dispatch finish in the
      // background — the raw event is safely in our hands.
      res.status(204).send();

      try {
        // 3. Authorization. AgentMail's `from` field comes in two shapes
        // depending on the event schema version:
        //   - a plain string: `"Jane Doe <owner@example.com>"`
        //   - an array of strings (legacy `from_`)
        // And the string may be in RFC 5322 display-name form, which means
        // the bare email is inside the angle brackets. We compare the
        // extracted email (lowercased) against authorized_senders which
        // stores bare addresses.
        const fromRaw: string | string[] = message.from ?? message.from_ ?? "";
        const fromString = Array.isArray(fromRaw)
          ? (fromRaw[0] ?? "")
          : String(fromRaw);
        const sender = extractEmailAddress(fromString);
        const authorized = await fetchAuthorizedSenders();
        const isAuthorized = !!sender && authorized?.has(sender) === true;

        // 4. Dispatch
        if (isAuthorized) {
          // Channel path — full payload, preserve quoted history (Alfred needs context)
          await proxyToTenant({}, {
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
                userId: owner.id,
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
          await proxyToTenant({}, {
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
                userId: owner.id,
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
