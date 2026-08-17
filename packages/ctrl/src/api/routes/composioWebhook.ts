// Composio inbound webhook receiver — flips a local ComposioConnection row
// from INITIATED → ACTIVE the moment Composio confirms the OAuth exchange.
//
// The incident this fixes
// -----------------------
// On a client tenant (2026-05-27) Composio finished authenticating Gmail
// on their side, but our local ComposioConnection row stuck at status=
// INITIATED for ~36 minutes. The existing 1-minute reconciler
// (`reconcileComposioAutoConfigJob` → `buildPendingRowsWhere`, web side)
// only acts on rows that already have status="ACTIVE" — chicken-and-egg.
// Composio HAD attempted a webhook, and ctrl-api logged the inbound as
//
//     POST /api/v1/composio/webhook 401 0ms
//
// — the 401 was the global auth middleware seeing no Bearer header and
// rejecting before any route lookup, because no route was registered.
// This file is that route.
//
// What it does
// ------------
// On a `connected_account.updated` event with `data.status === "ACTIVE"`,
// POST to the web side's internal /webhook/composio/finalize endpoint with
// `Authorization: Bearer ${AAS_API_KEY}` (the shared secret already in
// both containers). Web flips the Prisma row's `status` from INITIATED to
// ACTIVE; the existing 1-min reconciler then picks it up on its next tick
// and runs the actual auto-config side-effects. We do NOT touch
// autoConfigState — that's the reconciler's lane.
//
// Why ctrl-api and not web
// ------------------------
// ctrl-api owns the public webhook surface for this platform (the Caddy
// `@public_webhooks` matcher routes /api/v1/webhooks/* + /api/v1/channels/*
// through to ctrl-api on :3100). web-1 sits behind Wasp auth middleware.
// Putting the webhook landing here keeps the "public, HMAC-only" pattern
// consistent with the Paperclip heartbeat and the Plane steward hook.
// The state write *does* live in web-db, so we hop one container
// over via the AAS_API_KEY-secured internal endpoint. This avoids giving
// ctrl-api a Prisma client just for a single field-flip.
//
// Auth model
// ----------
// Two layers stacked, in order:
//
//   1. **Composio HMAC** (preferred). Two schemes supported:
//      - **Standard Webhooks** (Composio's documented scheme today —
//        `webhook-id` / `webhook-timestamp` / `webhook-signature`
//        headers, signing string `<id>.<ts>.<body>`, HMAC-SHA-256,
//        base64, signature header value is `v1,<b64>` (possibly
//        multiple comma-separated versions).
//      - **Simple SHA-256 over raw body** in `x-composio-signature`
//        as `sha256=<hex>` — older / alternative scheme, accept too.
//      Either secret bytes come from `COMPOSIO_WEBHOOK_SECRET`.
//
//   2. **Unsigned fallback** (deploy-friendly). If
//      `COMPOSIO_WEBHOOK_SECRET` is unset, accept anyway with a loud
//      `WARN` log. The 5 live tenants today have NO secret configured;
//      this fallback unblocks them immediately. Sir can rotate in the
//      secret via Composio's webhook config UI later.
//
// Event shape tolerance
// ---------------------
// We accept both the V3 envelope (`{ metadata: { event_type, ... }, data:
// {...} }`) and the older flat shape (`{ type, data: {...} }`). The
// canonical signal we care about is `connected_account.updated` (or any
// event_type containing `connected_account` plus a state-change marker)
// with `data.status === "ACTIVE"`. Anything else → 200 no-op so Composio
// doesn't retry on events we don't care about.
//
// 200 vs 4xx policy
// -----------------
// Composio retries on non-2xx. Therefore:
//   * unknown connectionId          → 200 (the row was deleted on our side)
//   * already-ACTIVE row            → 200 (idempotent no-op)
//   * unknown event type            → 200 (we don't care)
//   * malformed body                → 200 + WARN (don't trigger retries on
//                                       a body shape we don't understand)
//   * bad signature (when secret IS set) → 401 (genuine auth failure)
//   * web-side flip failed          → 502 (transient; do retry)

import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";

// Web-internal URL for the row flip. Same compose-network reach as
// apikeys/proxy.ts uses for ctrl-api (`http://ctrl-api:3100`). The web
// container is reachable at `http://web:3000` on the compose network.
const WEB_BASE_URL = process.env.WEB_BASE_URL ?? "http://web:3000";
const WEB_FINALIZE_PATH = "/webhook/composio/finalize";
const WEB_TIMEOUT_MS = 15_000;

// ── signature verification ─────────────────────────────────────────────────

interface VerifyResult {
  ok: boolean;
  /** Human-readable reason; used in the WARN log when unsigned-fallback fires. */
  reason: string;
}

/** Composio's Standard-Webhooks scheme:
 *
 *   webhook-id:        <ulid-ish string>
 *   webhook-timestamp: <unix-seconds>
 *   webhook-signature: v1,<base64-hmac>  (or "v1,<sig1> v1,<sig2>" with
 *                                          multiple signatures separated by
 *                                          spaces during key rotation)
 *
 * signing string:  `${id}.${ts}.${rawBody}`
 * algorithm:       HMAC-SHA-256, base64-encoded
 *
 * Implementation cross-references:
 *  - https://docs.composio.dev (webhook verification page) — quoted in the
 *    PR body.
 *  - The Standard Webhooks spec (standardwebhooks.com) is the umbrella;
 *    Composio is svix-compatible.
 */
function verifyStandardWebhooks(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  const id = headerString(headers["webhook-id"]);
  const ts = headerString(headers["webhook-timestamp"]);
  const sig = headerString(headers["webhook-signature"]);
  if (!id || !ts || !sig) return false;

  // The secret arrives base64-prefixed-with-"whsec_" in some
  // implementations; tolerate that.
  const secretBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf-8");

  const signed = Buffer.concat([
    Buffer.from(`${id}.${ts}.`, "utf-8"),
    rawBody,
  ]);
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signed)
    .digest("base64");

  // Header is space-separated "v1,<sig> v1,<sig2> ..." — any match wins.
  for (const part of sig.split(" ")) {
    const eq = part.indexOf(",");
    if (eq < 0) continue;
    const version = part.slice(0, eq).trim();
    const received = part.slice(eq + 1).trim();
    if (version !== "v1") continue;
    if (constantTimeStringEq(expected, received)) return true;
  }
  return false;
}

/** Alternative scheme some Composio deployments emit (also matches the
 * shape mentioned in the joe-incident triage): a single header
 *
 *   x-composio-signature: sha256=<hex>
 *
 * over the raw body keyed on the shared secret. Provided as a defensive
 * fallback so we don't 401 a real Composio webhook just because their
 * docs and their actual emission don't match. */
function verifyXComposioSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  const sig = headerString(headers["x-composio-signature"]);
  if (!sig) return false;
  const hex = sig.startsWith("sha256=") ? sig.slice("sha256=".length) : sig;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0) return false;
  let received: Buffer;
  try {
    received = Buffer.from(hex, "hex");
  } catch {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest();
  if (expected.length !== received.length) return false;
  try {
    return crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

function verifyComposioWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): VerifyResult {
  // Accept either scheme. A real Composio webhook only carries one of
  // them; both being absent means "no signature presented" — distinguish
  // that from "signature presented but wrong" so the log line is honest.
  const hasStandard = headerString(headers["webhook-signature"]) !== null;
  const hasXSig = headerString(headers["x-composio-signature"]) !== null;
  if (!hasStandard && !hasXSig) {
    return { ok: false, reason: "no signature headers present" };
  }
  if (hasStandard && verifyStandardWebhooks(rawBody, headers, secret)) {
    return { ok: true, reason: "standard-webhooks signature verified" };
  }
  if (hasXSig && verifyXComposioSignature(rawBody, headers, secret)) {
    return { ok: true, reason: "x-composio-signature verified" };
  }
  return { ok: false, reason: "signature did not validate against COMPOSIO_WEBHOOK_SECRET" };
}

function headerString(h: string | string[] | undefined): string | null {
  if (!h) return null;
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v !== "string" || v.length === 0) return null;
  return v;
}

/** Timing-safe compare of two string-as-bytes views. */
function constantTimeStringEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// ── event shape tolerance ──────────────────────────────────────────────────

interface NormalisedEvent {
  /** "connected_account.updated", "connected_account.created", etc. */
  type: string;
  /** Composio's connected_account id ("ca_..."). May be empty if the payload
   * version omits it — caller should bail on the empty case. */
  connectionId: string;
  /** "ACTIVE" | "FAILED" | "INITIATED" | ... */
  status: string;
}

/** Parse the event-type slug + connection id + status out of either the
 * V3 envelope or the older flat shape. Returns null if the payload doesn't
 * look like a connected_account event we can act on. */
function normaliseEvent(payload: unknown): NormalisedEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;

  // Event type: V3 puts it at metadata.event_type or metadata.trigger_slug;
  // older shape uses top-level `type`.
  let type = "";
  const meta = p.metadata;
  if (typeof meta === "object" && meta !== null) {
    const m = meta as Record<string, unknown>;
    if (typeof m.event_type === "string") type = m.event_type;
    else if (typeof m.trigger_slug === "string") type = m.trigger_slug;
  }
  if (!type && typeof p.type === "string") type = p.type;
  type = type.toLowerCase();

  // Connection id: V3 puts it at metadata.connected_account_id; older shape
  // nests it at data.id, sometimes data.connected_account_id, sometimes
  // data.connectionId.
  let connectionId = "";
  if (typeof meta === "object" && meta !== null) {
    const m = meta as Record<string, unknown>;
    if (typeof m.connected_account_id === "string")
      connectionId = m.connected_account_id;
  }
  const data = p.data;
  if (!connectionId && typeof data === "object" && data !== null) {
    const d = data as Record<string, unknown>;
    if (typeof d.id === "string") connectionId = d.id;
    else if (typeof d.connected_account_id === "string")
      connectionId = d.connected_account_id;
    else if (typeof d.connectionId === "string") connectionId = d.connectionId;
  }

  // Status: data.status (or data.state for older payloads).
  let status = "";
  if (typeof data === "object" && data !== null) {
    const d = data as Record<string, unknown>;
    if (typeof d.status === "string") status = d.status;
    else if (typeof d.state === "string") status = d.state;
  }
  status = status.toUpperCase();

  if (!type) return null;
  return { type, connectionId, status };
}

/** Is this an event we care about? We act on connected-account state
 * changes to ACTIVE. Anything else → no-op (200). */
function isConnectedAccountActivation(ev: NormalisedEvent): boolean {
  if (ev.status !== "ACTIVE") return false;
  // Tolerate both "connected_account.updated" (current) and
  // "connected_account.created" / "connection.created" (legacy slugs).
  return /connected[_-]?account|connection/.test(ev.type);
}

// ── web-side flip ──────────────────────────────────────────────────────────

interface FlipResult {
  ok: boolean;
  /** HTTP status from the web endpoint (or 0 on transport failure). */
  status: number;
  detail: string;
}

/** POST {connectionId} to web's /webhook/composio/finalize. The web endpoint
 * validates the `Authorization: Bearer ${AAS_API_KEY}` and idempotently sets
 * status=ACTIVE on the matching ComposioConnection row. */
async function flipRowOnWeb(connectionId: string): Promise<FlipResult> {
  const apiKey = process.env.AAS_API_KEY ?? "";
  if (!apiKey) {
    return {
      ok: false,
      status: 0,
      detail: "AAS_API_KEY is not set on ctrl-api; cannot reach web internal endpoint",
    };
  }
  const url = `${WEB_BASE_URL.replace(/\/$/, "")}${WEB_FINALIZE_PATH}`;
  let resp: Response;
  try {
    // IMPORTANT: do NOT send `Authorization: Bearer ...` here. Wasp's
    // global `auth` middleware sits in front of every `api` route and
    // tries to validate any Bearer token as a Wasp user session token —
    // a service-side key gets rejected with `{"message":"Invalid
    // credentials"}` BEFORE the route's own middlewareConfigFn can run.
    // (Confirmed live: bundle wires `[auth, ...customMiddleware]` for
    // every api route. The middlewareConfigFn `.delete("authMiddleware")`
    // only affects the express-global hook, not the per-route shim.)
    // Wasp's auth middleware passes through when the Authorization
    // header is absent / non-Bearer, so we ship the secret on a custom
    // header that the web handler picks up on its own.
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "X-AAS-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ connectionId, status: "ACTIVE" }),
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!resp.ok) {
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* swallow */
    }
    return {
      ok: false,
      status: resp.status,
      detail: text.slice(0, 500),
    };
  }
  return { ok: true, status: resp.status, detail: "" };
}

// Exported for tests so they can stub the network seam without touching
// globalThis.fetch. NOT part of the HTTP surface.
export const _composioWebhookInternals = {
  verifyComposioWebhook,
  normaliseEvent,
  isConnectedAccountActivation,
  flipRowOnWeb,
};

// ── route ──────────────────────────────────────────────────────────────────

export function registerComposioWebhookRoutes(): void {
  addRoute("POST", "/api/v1/composio/webhook", async ({ req, res, body }) => {
    // server.ts hands us the raw Buffer because the path is in the
    // isRawBody allowlist. Defensive fallback: if for any reason it's
    // not a Buffer, re-serialise — HMAC-over-the-canonical-bytes is
    // what matters for the standard-webhooks scheme.
    const rawBody: Buffer = Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {}), "utf-8");

    const secret = process.env.COMPOSIO_WEBHOOK_SECRET ?? "";
    const headers = req.headers ?? {};

    // ── signature gate ────────────────────────────────────────────────────
    if (secret) {
      const v = verifyComposioWebhook(rawBody, headers, secret);
      if (!v.ok) {
        // Genuine auth failure — return 401 so Composio's retry surface
        // shows the misconfiguration. Do NOT echo the secret-derived
        // detail to the client.
        console.warn(
          `[composio-webhook] signature rejected: ${v.reason}`,
        );
        sendJson(res, 401, {
          error: {
            code: "AUTH_FAILED",
            message: "Composio webhook signature did not validate",
          },
        });
        return;
      }
    } else {
      // The 5 live tenants today have no COMPOSIO_WEBHOOK_SECRET set.
      // Refusing here would re-break the very thing this PR fixes. Loud-
      // log so the operator can see exactly what landed unsigned.
      console.warn(
        "[composio-webhook] COMPOSIO_WEBHOOK_SECRET is not set on this tenant — accepting unsigned webhook. Rotate a secret in via Composio's webhook config UI to enable HMAC enforcement.",
      );
    }

    // ── parse body ────────────────────────────────────────────────────────
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch (err) {
      // 200 + WARN — see the file-header policy block. Composio retries on
      // non-2xx, and we don't want retries on a body shape we can't parse.
      console.warn(
        `[composio-webhook] body was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJson(res, 200, { ok: true, noop: "unparseable body" });
      return;
    }

    // ── dispatch ──────────────────────────────────────────────────────────
    const ev = normaliseEvent(payload);
    if (!ev) {
      console.warn("[composio-webhook] payload did not match any known event shape");
      sendJson(res, 200, { ok: true, noop: "unrecognised event shape" });
      return;
    }
    if (!isConnectedAccountActivation(ev)) {
      // Other events (deletion, failure, refresh, …) deferred to a later
      // PR per task scope. Today: just connected_account.updated → ACTIVE.
      sendJson(res, 200, {
        ok: true,
        noop: "event not actionable",
        event_type: ev.type,
        event_status: ev.status,
      });
      return;
    }
    if (!ev.connectionId) {
      console.warn(
        `[composio-webhook] ${ev.type} event missing connectionId — cannot flip a row`,
      );
      sendJson(res, 200, { ok: true, noop: "missing connectionId" });
      return;
    }

    // Flip the row on the web side. The web endpoint is idempotent — if
    // the row is already ACTIVE it returns 200 with `noop: true` and we
    // surface that downstream so retries don't churn the row's
    // updated_at.
    const flip = await flipRowOnWeb(ev.connectionId);
    if (!flip.ok) {
      console.error(
        `[composio-webhook] web-side flip failed for ${ev.connectionId}: ` +
          `status=${flip.status} detail=${flip.detail}`,
      );
      // Transport / web-side failures should be retried by Composio — 502.
      sendJson(res, 502, {
        error: {
          code: "WEB_FLIP_FAILED",
          message: flip.detail || "Failed to flip ComposioConnection.status on web",
        },
      });
      return;
    }

    console.info(
      `[composio-webhook] flipped ${ev.connectionId} → ACTIVE (event ${ev.type})`,
    );
    sendJson(res, 200, {
      ok: true,
      connection_id: ev.connectionId,
      flipped_to: "ACTIVE",
    });
  });
}
