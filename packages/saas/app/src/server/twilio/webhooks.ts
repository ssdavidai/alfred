// Twilio inbound webhook handlers — registered as raw Express routes from setup.ts.
// Receives form-encoded POSTs from Twilio. Validates X-Twilio-Signature, looks up
// the destination tenant by the To: number, and either:
//   - voice  → returns TwiML <Connect><Stream> directing the call to the Voice Bridge
//   - sms    → proxies to tenant ctrl-api /api/v1/phone/sms/inbound and returns 200

import express from "express";
import type { Application, Request, Response } from "express";
import crypto from "crypto";
import { prisma } from "wasp/server";
import { proxyToTenant } from "../tenantProxy";
import { validateTwilioSignature } from "./client";
import { isSpamNumber } from "./spam";

// Sign a tenantId so the Voice Bridge can verify the WS upgrade query came from us.
// HMAC-SHA256 over `${tenantId}` keyed with VOICE_BRIDGE_INTERNAL_TOKEN. Hex.
function signTenantId(tenantId: string): string {
  const token = process.env.VOICE_BRIDGE_INTERNAL_TOKEN;
  if (!token) throw new Error("VOICE_BRIDGE_INTERNAL_TOKEN not set");
  return crypto.createHmac("sha256", token).update(tenantId).digest("hex");
}

// Reconstruct the absolute URL Twilio used (signature is computed over this).
// Behind Caddy/Cloudflare we trust X-Forwarded-Proto/Host.
function absoluteWebhookUrl(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() ||
    req.protocol;
  const host =
    (req.headers["x-forwarded-host"] as string) ||
    (req.headers.host as string);
  return `${proto}://${host}${req.originalUrl}`;
}

export function registerTwilioWebhooks(app: Application): void {
  // Twilio posts application/x-www-form-urlencoded for both voice and SMS webhooks.
  const formParser = express.urlencoded({ extended: false });

  // ── Voice ─────────────────────────────────────────────────────────────────
  app.post("/webhooks/twilio/voice", formParser, async (req: Request, res: Response) => {
    try {
      const params = (req.body ?? {}) as Record<string, string>;
      const url = absoluteWebhookUrl(req);
      const sig = req.headers["x-twilio-signature"] as string | undefined;
      if (!validateTwilioSignature(sig, url, params)) {
        res.status(403).send("Forbidden");
        return;
      }

      const to = params.To;
      const from = params.From ?? "";
      if (!to) {
        res.status(400).send("Missing To");
        return;
      }
      // Spam pre-filter — reject before burning Realtime minutes.
      if (from && (await isSpamNumber(from))) {
        console.log(`[twilio/voice] rejecting spam caller ${from}`);
        res
          .type("text/xml")
          .status(200)
          .send(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>`,
          );
        return;
      }
      const instance = await prisma.instance.findUnique({
        where: { phoneNumber: to },
      });
      if (!instance) {
        // Unknown number — Twilio will play default failure tone. Could swap to
        // a friendlier <Reject reason="busy"/> in Phase 9 (spam hardening).
        res.type("text/xml").status(200).send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`,
        );
        return;
      }

      const sigParam = signTenantId(instance.id);
      const wsUrl = `wss://${req.headers["x-forwarded-host"] || req.headers.host}/voice/${instance.id}?sig=${sigParam}`;

      // <Connect><Stream> establishes a bidirectional Media Stream over WS to the
      // Voice Bridge. Twilio keeps the call leg alive while the bridge is connected.
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}"/>
  </Connect>
</Response>`;
      res.type("text/xml").status(200).send(twiml);
    } catch (err) {
      console.error("[twilio/voice] error:", err);
      // Always respond — Twilio retries 5xx aggressively. Reject the call cleanly.
      res
        .type("text/xml")
        .status(200)
        .send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`,
        );
    }
  });

  // ── SMS ───────────────────────────────────────────────────────────────────
  app.post("/webhooks/twilio/sms", formParser, async (req: Request, res: Response) => {
    try {
      const params = (req.body ?? {}) as Record<string, string>;
      const url = absoluteWebhookUrl(req);
      const sig = req.headers["x-twilio-signature"] as string | undefined;
      if (!validateTwilioSignature(sig, url, params)) {
        res.status(403).send("Forbidden");
        return;
      }

      const { From: from, To: to, Body: body, MessageSid: messageSid } = params;
      if (!from || !to || !messageSid) {
        res.status(400).send("Missing From/To/MessageSid");
        return;
      }
      const instance = await prisma.instance.findUnique({
        where: { phoneNumber: to },
      });
      if (!instance) {
        // Unknown destination — silently 200; Twilio sees delivery success.
        res.status(200).send("");
        return;
      }

      // Fire-and-forget proxy to tenant. The tenant's phone.ts decides
      // authorised-vs-stream and ships the SMS reply (if any) via the
      // SaaS internal /api/internal/twilio/send-sms endpoint.
      proxyToTenant(instance, {
        method: "POST",
        path: "/api/v1/phone/sms/inbound",
        body: { from, to, body: body ?? "", messageSid },
      }).catch((err) => {
        console.error("[twilio/sms] tenant proxy failed:", err);
      });

      // Respond 200 immediately. We never use TwiML for SMS replies — outbound
      // is a separate Twilio API call from the tenant via SaaS internal.
      res.status(200).send("");
    } catch (err) {
      console.error("[twilio/sms] error:", err);
      res.status(200).send(""); // never block Twilio
    }
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
