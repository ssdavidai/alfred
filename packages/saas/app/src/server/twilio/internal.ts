// Internal endpoints called from tenant ctrl-api over Tailscale (and from
// the Voice Bridge). All gated on a Bearer VOICE_BRIDGE_INTERNAL_TOKEN — these
// must NEVER be exposed to user auth or to the open internet without that header.

import express from "express";
import type { Application, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { prisma } from "wasp/server";
import {
  buyNumberWithWebhooks,
  releaseNumber,
  sendSms,
  createCall,
} from "./client";
import { decryptApiKey } from "../tenantProxy";

// ── Token-bucket rate limiter (in-memory) ────────────────────────────────────
// Per-tenant per-action. Resets every minute. Process-local — fine for a single
// SaaS edge node; revisit if we scale horizontally.

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

function consumeRate(key: string, perMinute: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (b.count >= perMinute) return false;
  b.count++;
  return true;
}

// ── Auth middleware ──────────────────────────────────────────────────────────

function requireInternalToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.VOICE_BRIDGE_INTERNAL_TOKEN;
  if (!expected) {
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }
  const auth = req.headers.authorization;
  const presented = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!presented || presented !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function externalBase(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() ||
    req.protocol;
  const host =
    (req.headers["x-forwarded-host"] as string) ||
    (req.headers.host as string);
  return `${proto}://${host}`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function registerTwilioInternalRoutes(app: Application): void {
  const json = express.json();

  // POST /api/internal/twilio/send-sms { tenantId, from, to, body }
  app.post(
    "/api/internal/twilio/send-sms",
    requireInternalToken,
    json,
    async (req: Request, res: Response) => {
      try {
        const { tenantId, from, to, body } = (req.body ?? {}) as Record<
          string,
          string
        >;
        if (!tenantId || !from || !to || !body) {
          res
            .status(400)
            .json({ error: "tenantId, from, to, body are required" });
          return;
        }
        const dailyLimit = Number(process.env.TWILIO_DAILY_SMS_LIMIT ?? "500");
        if (!consumeRate(`sms:${tenantId}`, 10)) {
          res.status(429).json({ error: "rate_limited", scope: "per_minute" });
          return;
        }
        // (Daily cap enforcement deferred to Phase 9 alongside spam infra.)
        void dailyLimit;

        const result = await sendSms({ from, to, body });
        res.status(200).json({ sid: result.sid });
      } catch (err: any) {
        console.error("[internal/send-sms] error:", err);
        res.status(502).json({ error: err?.message ?? "Twilio error" });
      }
    },
  );

  // POST /api/internal/twilio/initiate-call { tenantId, to, mode, message? }
  // mode: "tts" | "realtime"
  app.post(
    "/api/internal/twilio/initiate-call",
    requireInternalToken,
    json,
    async (req: Request, res: Response) => {
      try {
        const { tenantId, to, mode, message } = (req.body ?? {}) as {
          tenantId?: string;
          to?: string;
          mode?: "tts" | "realtime";
          message?: string;
        };
        if (!tenantId || !to || !mode) {
          res.status(400).json({ error: "tenantId, to, mode are required" });
          return;
        }
        if (!consumeRate(`call:${tenantId}`, 5)) {
          res.status(429).json({ error: "rate_limited", scope: "per_minute" });
          return;
        }
        const instance = await prisma.instance.findUnique({
          where: { id: tenantId },
        });
        if (!instance?.phoneNumber) {
          res
            .status(409)
            .json({ error: "Tenant has no phone number provisioned" });
          return;
        }

        // Build the TwiML URL Twilio fetches when the call connects.
        const base = externalBase(req);
        let twimlUrl: string;
        if (mode === "tts") {
          if (!message) {
            res.status(400).json({ error: "message required for mode:tts" });
            return;
          }
          twimlUrl = `${base}/api/twiml/say?msg=${encodeURIComponent(message)}`;
        } else {
          // realtime — bridge-handled. Bridge prompts the agent to open with `intent`.
          const intent = message ?? "";
          // Note: we deliberately do NOT pre-sign the WS query here; the TwiML
          // endpoint /api/twiml/connect-bridge resolves & signs it at fetch time
          // so the signature stays fresh and tenant-scoped.
          twimlUrl = `${base}/api/twiml/connect-bridge?tenantId=${encodeURIComponent(
            instance.id,
          )}&initiator=alfred&intent=${encodeURIComponent(intent)}`;
        }

        const result = await createCall({
          from: instance.phoneNumber,
          to,
          twimlUrl,
        });
        res.status(200).json({ sid: result.sid });
      } catch (err: any) {
        console.error("[internal/initiate-call] error:", err);
        res.status(502).json({ error: err?.message ?? "Twilio error" });
      }
    },
  );

  // GET /api/twiml/say?msg=<urlencoded>
  // Twilio fetches this for outbound TTS calls. Returns <Say> TwiML.
  app.get("/api/twiml/say", (req: Request, res: Response) => {
    const msg = String(req.query.msg ?? "");
    const safe = escapeXml(msg.slice(0, 1000));
    res
      .type("text/xml")
      .status(200)
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say>${safe}</Say></Response>`,
      );
  });

  // GET /api/twiml/connect-bridge?tenantId=...&initiator=alfred&intent=...
  // Used by outbound realtime calls. Returns <Connect><Stream> with a freshly-
  // signed sig param so the Voice Bridge can validate the upgrade.
  app.get("/api/twiml/connect-bridge", (req: Request, res: Response) => {
    const tenantId = String(req.query.tenantId ?? "");
    const initiator = String(req.query.initiator ?? "user");
    const intent = String(req.query.intent ?? "");
    if (!tenantId) {
      res.status(400).send("Missing tenantId");
      return;
    }
    const token = process.env.VOICE_BRIDGE_INTERNAL_TOKEN;
    if (!token) {
      res.status(500).send("Server misconfigured");
      return;
    }
    const sig = crypto
      .createHmac("sha256", token)
      .update(tenantId)
      .digest("hex");
    const host =
      (req.headers["x-forwarded-host"] as string) ||
      (req.headers.host as string);
    const wsUrl = `wss://${host}/voice/${tenantId}?sig=${sig}&initiator=${encodeURIComponent(initiator)}&intent=${encodeURIComponent(intent)}`;
    res
      .type("text/xml")
      .status(200)
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><Stream url="${escapeXml(wsUrl)}"/></Connect></Response>`,
      );
  });

  // GET /api/internal/voice-bridge/tenant/:tenantId
  // Voice Bridge fetches per-call: { tailscaleHost, aasApiKey, phoneNumber }
  app.get(
    "/api/internal/voice-bridge/tenant/:tenantId",
    requireInternalToken,
    async (req: Request, res: Response) => {
      const tenantId = req.params["tenantId"];
      const instance = await prisma.instance.findUnique({
        where: { id: tenantId },
      });
      if (!instance) {
        res.status(404).json({ error: "Unknown tenant" });
        return;
      }
      if (!instance.tailscaleHostname || !instance.apiKey) {
        res.status(409).json({ error: "Tenant not provisioned for proxy" });
        return;
      }
      const aasApiKey = decryptApiKey(instance.apiKey);
      res.status(200).json({
        tailscaleHost: instance.tailscaleHostname,
        aasApiKey,
        phoneNumber: instance.phoneNumber ?? null,
      });
    },
  );

  // POST /api/internal/twilio/provision { tenantId? | customerName?, country?, areaCode? }
  // Buys a number for the tenant, sets webhooks, persists Instance fields.
  // The provisioner running on the SaaS host doesn't have the SaaS tenant
  // UUID, so we accept customerName as an alternate lookup key.
  app.post(
    "/api/internal/twilio/provision",
    requireInternalToken,
    json,
    async (req: Request, res: Response) => {
      try {
        const { tenantId, customerName, country, areaCode } = (req.body ??
          {}) as {
          tenantId?: string;
          customerName?: string;
          country?: string;
          areaCode?: string;
        };
        if (!tenantId && !customerName) {
          res.status(400).json({ error: "tenantId or customerName required" });
          return;
        }
        const instance = tenantId
          ? await prisma.instance.findUnique({ where: { id: tenantId } })
          : await prisma.instance.findUnique({
              where: { customerName: customerName! },
            });
        if (!instance) {
          res.status(404).json({ error: "Unknown tenant" });
          return;
        }
        if (instance.phoneNumber) {
          res.status(409).json({
            error: "Tenant already has a phone number",
            phoneNumber: instance.phoneNumber,
          });
          return;
        }

        const base = externalBase(req);
        const voiceUrl = `${base}/webhooks/twilio/voice`;
        const smsUrl = `${base}/webhooks/twilio/sms`;
        const resolvedCountry =
          country ?? process.env.TWILIO_DEFAULT_COUNTRY ?? "HU";

        const { phoneNumber, sid } = await buyNumberWithWebhooks({
          country: resolvedCountry,
          areaCode,
          voiceUrl,
          smsUrl,
          friendlyName: `alfred-${instance.customerName}`,
        });

        await prisma.instance.update({
          where: { id: instance.id },
          data: {
            phoneNumber,
            twilioNumberSid: sid,
            phoneCountry: resolvedCountry,
          },
        });

        res.status(200).json({
          tenantId: instance.id,
          phoneNumber,
          twilioNumberSid: sid,
          country: resolvedCountry,
        });
      } catch (err: any) {
        console.error("[internal/provision] error:", err);
        res.status(502).json({ error: err?.message ?? "Provision failed" });
      }
    },
  );

  // POST /api/internal/twilio/release { twilioNumberSid? | customerName? | tenantId? }
  // Either pass the SID directly (idempotent fast path), or a tenant
  // identifier so we look up the SID first.
  app.post(
    "/api/internal/twilio/release",
    requireInternalToken,
    json,
    async (req: Request, res: Response) => {
      try {
        const { twilioNumberSid, tenantId, customerName } = (req.body ??
          {}) as {
          twilioNumberSid?: string;
          tenantId?: string;
          customerName?: string;
        };
        let sid = twilioNumberSid ?? "";
        let instanceId: string | null = tenantId ?? null;
        if (!sid && (tenantId || customerName)) {
          const instance = tenantId
            ? await prisma.instance.findUnique({ where: { id: tenantId } })
            : await prisma.instance.findUnique({
                where: { customerName: customerName! },
              });
          if (instance) {
            sid = instance.twilioNumberSid ?? "";
            instanceId = instance.id;
          }
        }
        if (!sid) {
          // Nothing to release; treat as success so destroy is idempotent.
          res.status(200).json({ status: "noop" });
          return;
        }
        await releaseNumber(sid);
        if (instanceId) {
          await prisma.instance.update({
            where: { id: instanceId },
            data: {
              phoneNumber: null,
              twilioNumberSid: null,
              phoneCountry: null,
            },
          });
        }
        res.status(200).json({ status: "released" });
      } catch (err: any) {
        console.error("[internal/release] error:", err);
        res.status(502).json({ error: err?.message ?? "Release failed" });
      }
    },
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
