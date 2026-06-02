// Voice Bridge — TwiML responder for Twilio "A CALL COMES IN" webhook.
//
// On alfred-black single-VM there is no SaaS layer between Twilio and the
// voice-bridge. Twilio's voice webhook expects TwiML pointing at the WSS
// Media Streams endpoint, and that TwiML used to be emitted by the
// multi-tenant SaaS (packages/saas/app/src/server/twilio/webhooks.ts).
// On alfred-black we serve it from voice-bridge itself — same container
// that owns the WSS endpoint and the HMAC secret, so there is no
// inter-service handshake needed.
//
// Configure the Twilio Console phone number with:
//
//   A CALL COMES IN  ▸  Webhook  ▸  POST  ▸
//     https://voice.<domain>/twiml/inbound
//
// Twilio POSTs an application/x-www-form-urlencoded body with the call
// envelope (From, To, CallSid, ...). We respond with:
//
//   <Response>
//     <Connect>
//       <Stream url="wss://voice.<domain>/voice/<tenant_id>">
//         <Parameter name="sig" value="<hmac>"/>
//         <Parameter name="from" value="<From>"/>
//         <Parameter name="to" value="<To>"/>
//       </Stream>
//     </Connect>
//   </Response>
//
// Twilio then opens the Media Streams WebSocket back to us at the wss URL,
// at which point server.ts's `upgrade` handler takes over. The WSS handler
// verifies `sig` against the HMAC secret before doing any billable work.
//
// Security:
//
//  - If TWILIO_AUTH_TOKEN is set, we verify Twilio's X-Twilio-Signature on
//    every POST and reject mismatches with 403 — exactly the same
//    algorithm Twilio docs prescribe (HMAC-SHA1 over URL + sorted form
//    params, base64). This is the strongest check available; only Twilio
//    can produce a valid signature.
//
//  - If TWILIO_AUTH_TOKEN is NOT set (e.g. early bring-up before Sir
//    pastes Twilio creds into /channels), we log a warning, accept the
//    request, and still embed a fresh HMAC `sig` in the TwiML. The WSS
//    handler is still authenticated by its own sig — anyone who scrapes
//    /twiml/inbound for a sig must then connect to the WSS endpoint via
//    Twilio's infrastructure for it to actually carry audio, which is
//    impractical. Twilio-signature validation closes the
//    burn-OpenAI-credits abuse window cleanly; turn it on as soon as
//    creds are configured.

import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

import { config } from "./config.js";

/** Path Twilio POSTs to. Caddy proxies `voice.<domain>/*` here. */
export const TWIML_INBOUND_PATH = "/twiml/inbound";

/**
 * Default tenant id used on this VM. alfred-black is single-VM, so the WSS
 * path `/voice/<id>` doesn't actually scope multi-tenancy — but it still has
 * to be a non-empty segment. Use the canonical principal slug for symmetry
 * with the alfred_journal binding ("owner").
 *
 * #120 Lane Vb — when the inbound webhook URL carries `?profile=<slug>`,
 * we route to `/voice/<slug>` instead so the WSS handler can resolve the
 * profile context (per-profile OPENAI key + Twilio creds + persona) at
 * session-open time. The "owner" default applies only to the pre-Vb wire
 * shape where no profile hint is present.
 */
const DEFAULT_TENANT_ID = "owner";

/**
 * Validate a slug pulled out of the inbound URL. Mirrors the server-side
 * regex in ctrl-api's agentProfiles.validateSlug — refuse anything that
 * doesn't look like a kebab-case lowercase slug so the WSS path segment
 * remains a safe identifier (no path traversal, no special chars).
 */
const _SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
function safeSlug(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return _SLUG_RE.test(t) ? t : null;
}

interface TwilioCallParams {
  From: string;
  To: string;
  CallSid: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateSig(tenantId: string): string {
  return crypto
    .createHmac("sha256", config.internalToken)
    .update(tenantId)
    .digest("hex");
}

function renderTwiml(opts: {
  wssUrl: string;
  sig: string;
  from: string;
  to: string;
}): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<Response>\n" +
    "  <Connect>\n" +
    `    <Stream url="${escapeXml(opts.wssUrl)}">\n` +
    `      <Parameter name="sig" value="${escapeXml(opts.sig)}"/>\n` +
    `      <Parameter name="from" value="${escapeXml(opts.from)}"/>\n` +
    `      <Parameter name="to" value="${escapeXml(opts.to)}"/>\n` +
    "    </Stream>\n" +
    "  </Connect>\n" +
    "</Response>\n"
  );
}

/**
 * TwiML body that hangs up disallowed callers immediately. Twilio plays a
 * busy signal then ends the call — no audio frames consumed, no Realtime
 * session opened, no OpenAI cost. The /channels Phone card surfaces both
 * the allowlist and the open/closed toggle so the operator can flip it.
 */
function renderRejectTwiml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<Response>\n" +
    "  <Reject reason=\"busy\"/>\n" +
    "</Response>\n"
  );
}

/**
 * Caller-allowlist check. Default policy: OPEN — anyone can call. Lock down
 * by setting VOICE_ALLOWED_CALLERS to a comma-separated E.164 list (and
 * leaving VOICE_ALLOW_ALL_CALLERS unset or "false"). Matches `From` exactly;
 * loose matching would let attackers spoof a prefix.
 */
function isCallerAllowed(from: string): boolean {
  const allowAll = (process.env.VOICE_ALLOW_ALL_CALLERS || "").trim().toLowerCase() === "true";
  if (allowAll) return true;
  const list = (process.env.VOICE_ALLOWED_CALLERS || "").trim();
  if (!list) {
    // Default-open: if neither env var is set, accept all callers. Matches
    // the SMS adapter's behaviour and avoids "set up everything but voice
    // mysteriously rejects every call" UX surprise.
    return true;
  }
  const allowed = new Set(list.split(",").map((s) => s.trim()).filter(Boolean));
  // Strip the display-name shape (`"Name" <+E164>`) if Twilio ever sends one.
  const m = from.match(/<([^>]+)>/);
  const normalised = (m ? m[1] : from).trim();
  return allowed.has(normalised);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Twilio's X-Twilio-Signature is HMAC-SHA1 over:
 *   <full request URL> + concat(sortedKey + value for each form field)
 * base64-encoded. Constant-time compare with the provided header.
 *
 * Reference: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
function verifyTwilioSignature(opts: {
  url: string;
  body: string;
  signature: string;
  authToken: string;
}): boolean {
  // Build the canonical string: url + sorted params concatenated.
  const params = new URLSearchParams(opts.body);
  const sortedKeys = [...params.keys()].sort();
  let canonical = opts.url;
  for (const k of sortedKeys) {
    canonical += k + (params.get(k) ?? "");
  }
  const expected = crypto
    .createHmac("sha1", opts.authToken)
    .update(canonical, "utf-8")
    .digest("base64");
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(opts.signature, "utf-8");
    b = Buffer.from(expected, "utf-8");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Reconstruct the URL Twilio called. Twilio signs the public URL it POSTed
 * to (https://voice.<domain>/twiml/inbound), so we must use the
 * X-Forwarded-* headers Caddy sets — `req.url` is just the path inside
 * the container.
 */
function publicUrl(req: IncomingMessage): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) || "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ||
    (req.headers.host as string | undefined) ||
    "localhost";
  return `${proto}://${host}${req.url ?? ""}`;
}

export async function handleTwimlInbound(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    res.end();
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    console.error("[twiml] failed to read request body:", err);
    res.writeHead(400);
    res.end();
    return;
  }

  // Twilio signature validation. Skip with a warning when the auth token
  // isn't configured yet — voice-bridge can still serve TwiML so Sir can
  // test the call path; close the gap by setting TWILIO_AUTH_TOKEN in
  // /opt/alfred/.env (or the /channels SMS card).
  const authToken = config.twilioAuthToken;
  if (authToken) {
    const sigHeader = req.headers["x-twilio-signature"];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!signature) {
      console.warn("[twiml] missing X-Twilio-Signature header — rejecting");
      res.writeHead(403);
      res.end();
      return;
    }
    const ok = verifyTwilioSignature({
      url: publicUrl(req),
      body,
      signature,
      authToken,
    });
    if (!ok) {
      console.warn("[twiml] X-Twilio-Signature mismatch — rejecting");
      res.writeHead(403);
      res.end();
      return;
    }
  } else {
    console.warn(
      "[twiml] TWILIO_AUTH_TOKEN unset — accepting request without signature " +
        "verification (set it in .env to enable strict mode)",
    );
  }

  const params = new URLSearchParams(body);
  const callParams: TwilioCallParams = {
    From: params.get("From") ?? "",
    To: params.get("To") ?? "",
    CallSid: params.get("CallSid") ?? "",
  };

  // Caller allowlist — VOICE_ALLOWED_CALLERS / VOICE_ALLOW_ALL_CALLERS in the
  // compose .env, set via /channels Phone card → PUT /api/v1/channels/voice/allowlist.
  // Default policy: OPEN. Disallowed callers get a <Reject> and never reach
  // gpt-realtime, so they cost zero OpenAI credits.
  if (!isCallerAllowed(callParams.From)) {
    console.log(
      `[twiml] reject disallowed caller from=${callParams.From} sid=${callParams.CallSid}`,
    );
    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(renderRejectTwiml());
    return;
  }

  // #120 Lane Vb — per-profile routing. The principal configures the
  // Twilio webhook URL as
  //   https://voice.<domain>/twiml/inbound?profile=<slug>
  // so the slug arrives in the URL query (parsed off req.url). When
  // absent we fall back to the "owner" tenant id, which the WSS handler
  // resolves to the `main` profile via the channel_profile_binding
  // default. The sig is HMAC over whatever slug we routed to — so a
  // profile rebinding in ctrl-api cannot mint a valid sig for the wrong
  // routing key.
  const reqUrl = new URL(req.url ?? "/", "http://localhost");
  const profileFromQuery = safeSlug(reqUrl.searchParams.get("profile"));
  const tenantId = profileFromQuery ?? DEFAULT_TENANT_ID;

  // Build the wss URL. Twilio strips query strings from <Stream url=...>,
  // so the sig must travel inside <Parameter>, not the URL.
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ||
    (req.headers.host as string | undefined) ||
    "voice.example";
  const wssUrl = `wss://${host}/voice/${tenantId}`;
  const sig = generateSig(tenantId);
  const twiml = renderTwiml({
    wssUrl,
    sig,
    from: callParams.From,
    to: callParams.To,
  });

  console.log(
    `[twiml] inbound call from=${callParams.From} to=${callParams.To} sid=${callParams.CallSid} profile=${tenantId} → ${wssUrl}`,
  );

  res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
  res.end(twiml);
}
