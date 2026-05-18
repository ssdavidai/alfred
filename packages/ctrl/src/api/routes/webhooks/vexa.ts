// Vexa → Alfred webhook receiver (#840 Phase 4 — Steward transcript intake).
//
// `POST /api/v1/webhooks/vexa`
//
//   Headers (per Vexa upstream `services/meeting-api/meeting_api/webhook_delivery.py`):
//     * `Authorization: Bearer <VEXA_WEBHOOK_SECRET>` — back-compat sentinel.
//     * `X-Webhook-Signature: sha256=<hmac>` — HMAC-SHA-256 of the byte
//       sequence ``<X-Webhook-Timestamp>.<raw_body>`` keyed on the secret.
//     * `X-Webhook-Timestamp: <unix-seconds>` — replay-protection nonce.
//
//   We accept the canonical Vexa shape:
//     ``{ event_id, event_type, api_version, created_at, data: {...} }``
//   plus a tolerance fallback for any deployment that points its
//   ``webhook_url`` at us with a flatter ``{ bot_id, transcript, ... }``
//   shape (we don't enforce ``data.meeting`` is present).
//
// On a verified webhook the route appends one record to
// ``/alfred-data/streams/vexa-transcripts.jsonl`` and returns ``200 OK``.
// We do NOT trigger any workflow synchronously — ``MeetingCaptureWorkflow``
// polls the stream on its 60s tick, fetches the transcript via Vexa's
// ``GET /transcripts/{platform}/{native_meeting_id}`` API, and feeds the
// result into Steward's transcript-intake path.
//
// SECURITY: the route is public (the SaaS Caddy proxy strips auth before
// passing to ctrl-api) — HMAC over the raw body is the only auth. The
// path is registered in ``server.ts``'s ``isPublic`` whitelist AND in the
// ``isRawBody`` whitelist so the request pipeline hands us the exact
// bytes Vexa signed.
//
// SEPARATE FROM `/api/v1/webhooks/plane/steward`: that handler ingests
// Plane events as `plane:*` Steward signals. The Vexa path emits a
// dedicated transcript stream so the meeting-capture workflow can
// process transcripts at its own cadence (transcripts are bigger and
// fewer than Plane signals — the 30-min Steward cadence wouldn't fit
// the ingest model).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../../server.js";
import { sendJson, ApiError, AuthError, ValidationError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Vexa transcript stream — append-only JSONL
// ---------------------------------------------------------------------------

const VEXA_TRANSCRIPTS_FILE =
  process.env.ALFRED_DATA_DIR
    ? path.join(process.env.ALFRED_DATA_DIR, "streams", "vexa-transcripts.jsonl")
    : "/alfred-data/streams/vexa-transcripts.jsonl";

/** Append one transcript ingest record. Best-effort; failures are surfaced
 * to the caller as 500 since Vexa retries on non-2xx and a permanent
 * disk-write failure deserves operator attention. */
function appendTranscriptRecord(record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(VEXA_TRANSCRIPTS_FILE), { recursive: true });
  fs.appendFileSync(VEXA_TRANSCRIPTS_FILE, JSON.stringify(record) + "\n");
}

// ---------------------------------------------------------------------------
// HMAC verification — matches Vexa's `webhook_delivery.build_headers`
// ---------------------------------------------------------------------------

function parseSignatureHeader(header: string | string[] | undefined): Buffer | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  // Vexa always emits "sha256=<hex>"; we tolerate a bare hex digest too
  // for parity with the Plane handler so a misconfigured proxy that strips
  // the prefix doesn't lock us out.
  const hex = value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0) return null;
  try {
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

function parseTimestampHeader(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  // Vexa sends a unix-seconds integer as a string. We treat it opaquely
  // (just bytes for the HMAC) but reject anything non-numeric so a
  // typo'd header can't smuggle a forgery past timing-safe equal.
  if (!/^\d+$/.test(value.trim())) return null;
  return value.trim();
}

function verifySignature(
  rawBody: Buffer,
  signature: Buffer,
  timestamp: string,
  secret: string,
): boolean {
  // Vexa signs ``<timestamp>.<body>`` (note the literal dot). See
  // ``services/meeting-api/meeting_api/webhook_delivery.py::build_headers``.
  const signedContent = Buffer.concat([
    Buffer.from(`${timestamp}.`, "utf-8"),
    rawBody,
  ]);
  const expected = crypto.createHmac("sha256", secret).update(signedContent).digest();
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(expected, signature);
  } catch {
    return false;
  }
}

// Replay-protection window. Vexa's docs don't pin a number; we accept up
// to 5 minutes of clock skew which is comfortably over normal NTP drift
// and well under Vexa's own delivery retry envelope.
const TIMESTAMP_TOLERANCE_SECS = 300;

function timestampWithinTolerance(timestamp: string): boolean {
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= TIMESTAMP_TOLERANCE_SECS;
}

// ---------------------------------------------------------------------------
// Payload shape extraction
// ---------------------------------------------------------------------------

interface ExtractedPayload {
  event_id: string;
  event_type: string;
  meeting_id: string; // Vexa's native_meeting_id (e.g. "abc-defg-hij")
  platform: string;
  bot_id: string;
  has_transcript: boolean;
  transcript_segments: number;
}

/** Derive a normalised summary from the Vexa webhook envelope. Tolerates
 * both the canonical envelope shape (``{event_type, data: {meeting}}``)
 * and the simpler flat shapes some self-hosted deployments produce.
 *
 * ALL fields fall back to "" when missing — the only invariant we
 * enforce here is "we got SOMETHING parseable"; payload triage happens
 * in the workflow.
 */
function extractPayloadSummary(payload: Record<string, unknown>): ExtractedPayload {
  const event_type =
    (typeof payload.event_type === "string" && payload.event_type) ||
    (typeof (payload as Record<string, unknown>).event === "string" &&
      ((payload as Record<string, unknown>).event as string)) ||
    "";
  const event_id =
    (typeof payload.event_id === "string" && payload.event_id) ||
    `vexa_${crypto.randomUUID()}`;

  // Try the canonical Vexa envelope first.
  const data =
    typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : {};
  const meeting =
    typeof data.meeting === "object" && data.meeting !== null
      ? (data.meeting as Record<string, unknown>)
      : null;

  const platform =
    (meeting && typeof meeting.platform === "string" && meeting.platform) ||
    (typeof data.platform === "string" && data.platform) ||
    (typeof payload.platform === "string" && payload.platform) ||
    "";
  const meeting_id =
    (meeting &&
      typeof meeting.native_meeting_id === "string" &&
      meeting.native_meeting_id) ||
    (typeof data.native_meeting_id === "string" && data.native_meeting_id) ||
    (typeof data.meeting_id === "string" && data.meeting_id) ||
    (typeof payload.meeting_id === "string" && payload.meeting_id) ||
    "";

  const bot_id =
    (typeof data.bot_id === "string" && data.bot_id) ||
    (typeof payload.bot_id === "string" && payload.bot_id) ||
    (meeting && typeof meeting.bot_container_id === "string" && meeting.bot_container_id) ||
    "";

  // Transcript may arrive embedded (``data.transcript.segments``) or as a
  // pull-style shape where the webhook only signals completion and our
  // workflow fetches via ``GET /transcripts/...``. Both paths are valid;
  // the workflow checks `has_transcript` to decide whether to skip the
  // pull step.
  const transcriptObj =
    (typeof data.transcript === "object" && data.transcript !== null
      ? (data.transcript as Record<string, unknown>)
      : null) ||
    (typeof payload.transcript === "object" && payload.transcript !== null
      ? (payload.transcript as Record<string, unknown>)
      : null);
  let segments = 0;
  let has_transcript = false;
  if (transcriptObj) {
    has_transcript = true;
    const segs = transcriptObj.segments;
    if (Array.isArray(segs)) segments = segs.length;
  }

  return {
    event_id: String(event_id),
    event_type: String(event_type),
    meeting_id: String(meeting_id),
    platform: String(platform),
    bot_id: String(bot_id),
    has_transcript,
    transcript_segments: segments,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerVexaWebhookRoute(): void {
  // POST /api/v1/webhooks/vexa
  //
  // PUBLIC route — HMAC over (timestamp + "." + raw body) is the auth.
  // Server pipeline must pass `body` as a Node Buffer (configured in
  // server.ts via the `isRawBody` whitelist).
  addRoute("POST", "/api/v1/webhooks/vexa", async ({ req, res, body }) => {
    const secret = process.env.VEXA_WEBHOOK_SECRET;
    if (!secret) {
      console.error(
        "[webhooks.vexa] VEXA_WEBHOOK_SECRET is not configured — refusing all webhooks",
      );
      throw new ApiError(
        500,
        "CONFIG_ERROR",
        "VEXA_WEBHOOK_SECRET is not configured",
      );
    }

    if (!Buffer.isBuffer(body)) {
      throw new ValidationError("Raw body not available");
    }
    const rawBody: Buffer = body;

    // 1. Parse + validate the timestamp header (replay protection).
    const tsHeader = parseTimestampHeader(req.headers["x-webhook-timestamp"]);
    if (!tsHeader) {
      console.warn(
        "webhooks.vexa.invalid_signature reason=missing_or_malformed_timestamp",
      );
      throw new AuthError("Missing or malformed X-Webhook-Timestamp header");
    }
    if (!timestampWithinTolerance(tsHeader)) {
      console.warn(
        "webhooks.vexa.invalid_signature reason=timestamp_outside_tolerance ts=%s",
        tsHeader,
      );
      throw new AuthError("Webhook timestamp outside replay-protection window");
    }

    // 2. Verify HMAC over `<timestamp>.<body>` per Vexa's signing scheme.
    const sigHeader = req.headers["x-webhook-signature"];
    const sigBuf = parseSignatureHeader(sigHeader);
    if (!sigBuf) {
      console.warn(
        "webhooks.vexa.invalid_signature reason=missing_or_malformed_signature",
      );
      throw new AuthError("Missing or malformed X-Webhook-Signature header");
    }
    if (!verifySignature(rawBody, sigBuf, tsHeader, secret)) {
      console.warn("webhooks.vexa.invalid_signature reason=mismatch");
      throw new AuthError("Invalid signature");
    }

    // 3. Parse JSON body (post-HMAC so any parse error we report is about
    //    the payload, not the signature).
    let payload: Record<string, unknown>;
    try {
      const text = rawBody.toString("utf-8");
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new ValidationError("Invalid JSON body");
    }

    const summary = extractPayloadSummary(payload);

    // 4. We always persist; the workflow drops events it doesn't care
    //    about (e.g. ``meeting.started`` — useful as a heartbeat, not as
    //    transcript ingest). Recording everything keeps the audit trail
    //    intact and lets us debug the calibration loop in Phase 5.
    const record = {
      id: summary.event_id,
      ts: new Date().toISOString(),
      event_type: summary.event_type || "vexa:unknown",
      platform: summary.platform,
      meeting_id: summary.meeting_id,
      bot_id: summary.bot_id,
      has_transcript: summary.has_transcript,
      transcript_segments: summary.transcript_segments,
      // Persist the full payload so the workflow has access to attendee
      // metadata, status_change info, and (if embedded) the transcript
      // text without an extra fetch round-trip.
      raw: payload,
      // Legacy flag kept in sync so the workflow can short-circuit on
      // events it doesn't need to fetch transcripts for.
      processed: false,
    };

    try {
      appendTranscriptRecord(record);
    } catch (err) {
      console.error(
        `[webhooks.vexa] failed to append transcript record: ${(err as Error).message}`,
      );
      throw new ApiError(500, "WRITE_FAILED", "Failed to write transcript stream");
    }

    console.log(
      `webhooks.vexa.recorded event=${summary.event_type} platform=${summary.platform} meeting=${summary.meeting_id} bot=${summary.bot_id} has_transcript=${summary.has_transcript} segments=${summary.transcript_segments}`,
    );
    sendJson(res, 200, {
      ok: true,
      event_id: summary.event_id,
      event_type: summary.event_type,
      platform: summary.platform,
      meeting_id: summary.meeting_id,
    });
  });
}
