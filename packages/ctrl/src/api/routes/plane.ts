import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson, ApiError, AuthError, ValidationError } from "../errors.js";
import { emitStreamEvent } from "./streams.js";

// ---------------------------------------------------------------------------
// Persistent dedupe tail
//
// In-memory LRU dies on restart, so we also persist seen delivery UUIDs to
// /alfred-data/.plane-deliveries (one per line). On first webhook hit after
// a restart, we hydrate the LRU from the tail of that file. The file itself
// is rotated once it exceeds ROTATE_AT lines — we keep the newest KEEP_AT
// lines.
// ---------------------------------------------------------------------------

const DELIVERIES_FILE = "/alfred-data/.plane-deliveries";
const LRU_MAX = 1000;
const HYDRATE_FROM_TAIL = 1000;
const ROTATE_AT = 10_000;
const KEEP_AT = 5000;

/**
 * FIFO-evicting bounded Set. Using a plain `Set` preserves insertion order,
 * which is what we need for FIFO eviction.
 */
class BoundedSet {
  private set = new Set<string>();
  constructor(private max: number) {}

  has(key: string): boolean {
    return this.set.has(key);
  }

  add(key: string): void {
    if (this.set.has(key)) return;
    this.set.add(key);
    while (this.set.size > this.max) {
      // Remove oldest entry (first inserted)
      const oldest = this.set.values().next().value;
      if (oldest === undefined) break;
      this.set.delete(oldest);
    }
  }

  size(): number {
    return this.set.size;
  }
}

const seenDeliveries = new BoundedSet(LRU_MAX);
let hydrated = false;

function hydrateLruFromDisk(): void {
  if (hydrated) return;
  hydrated = true; // flip first so a failed hydrate doesn't retry forever
  try {
    if (!fs.existsSync(DELIVERIES_FILE)) return;
    const content = fs.readFileSync(DELIVERIES_FILE, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-HYDRATE_FROM_TAIL);
    for (const line of tail) {
      seenDeliveries.add(line.trim());
    }
    console.log(
      `[plane.webhook] hydrated ${tail.length} delivery IDs from ${DELIVERIES_FILE}`,
    );
  } catch (err) {
    console.warn(
      `[plane.webhook] failed to hydrate dedupe file: ${(err as Error).message}`,
    );
  }
}

function appendDeliveryToDisk(deliveryId: string): void {
  try {
    fs.mkdirSync(path.dirname(DELIVERIES_FILE), { recursive: true });
    fs.appendFileSync(DELIVERIES_FILE, deliveryId + "\n");
    // Cheap rotation check: only stat periodically; still O(1) in the common path.
    // We stat every time — it's a single syscall and cheap enough.
    const stat = fs.statSync(DELIVERIES_FILE);
    // Rough heuristic: average line ~37 bytes (36 UUID + \n). Trigger rotation
    // once the file grows past ROTATE_AT * ~40 bytes.
    if (stat.size > ROTATE_AT * 40) {
      const content = fs.readFileSync(DELIVERIES_FILE, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length > ROTATE_AT) {
        const keep = lines.slice(-KEEP_AT);
        fs.writeFileSync(DELIVERIES_FILE, keep.join("\n") + "\n");
        console.log(
          `[plane.webhook] rotated dedupe file: kept last ${keep.length} of ${lines.length} entries`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[plane.webhook] failed to persist delivery id: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function parseSignatureHeader(header: string | string[] | undefined): Buffer | null {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  // Accept either "sha256=<hex>" or a bare hex string (some setups strip the prefix)
  const hex = value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0) return null;
  try {
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

function verifySignature(rawBody: Buffer, signature: Buffer, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(expected, signature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPlaneRoutes(): void {
  // POST /api/v1/plane/webhook
  //
  // PUBLIC route — HMAC over the raw body is the authentication. The server's
  // request pipeline passes `body` as a Node Buffer (raw bytes) for this path
  // (configured in server.ts — see `isRawBody`). Do NOT re-serialize before
  // HMAC: whitespace differences would cause a valid payload to fail.
  addRoute("POST", "/api/v1/plane/webhook", async ({ req, res, body }) => {
    const secret = process.env.PLANE_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[plane.webhook] PLANE_WEBHOOK_SECRET is not set");
      throw new ApiError(
        500,
        "CONFIG_ERROR",
        "PLANE_WEBHOOK_SECRET is not configured",
      );
    }

    if (!Buffer.isBuffer(body)) {
      throw new ValidationError("Raw body not available");
    }
    const rawBody: Buffer = body;

    // Verify HMAC signature
    const sigHeader = req.headers["x-plane-signature"];
    const sigBuf = parseSignatureHeader(sigHeader);
    if (!sigBuf) {
      console.warn("plane.webhook.invalid_signature reason=missing_header");
      throw new AuthError("Missing or malformed X-Plane-Signature header");
    }

    if (!verifySignature(rawBody, sigBuf, secret)) {
      console.warn("plane.webhook.invalid_signature reason=mismatch");
      throw new AuthError("Invalid signature");
    }

    // Lazy hydrate dedupe LRU on the first verified webhook after startup
    hydrateLruFromDisk();

    // Parse JSON body (post-HMAC, so any parse error we report is about the
    // payload shape, not the signature).
    let payload: Record<string, unknown>;
    try {
      const text = rawBody.toString("utf-8");
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new ValidationError("Invalid JSON body");
    }

    // Delivery UUID — use the header if present, otherwise fall back to a
    // content-hash key so older Plane versions (or stripped headers) still
    // dedupe correctly.
    const deliveryHeader = req.headers["x-plane-delivery"];
    const headerValue = Array.isArray(deliveryHeader)
      ? deliveryHeader[0]
      : deliveryHeader;
    const deliveryId =
      (headerValue && headerValue.trim()) ||
      `sha256:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;

    const event = typeof payload.event === "string" ? (payload.event as string) : "unknown";
    const action = typeof payload.action === "string" ? (payload.action as string) : "unknown";
    const data =
      typeof payload.data === "object" && payload.data !== null
        ? (payload.data as Record<string, unknown>)
        : {};
    const dataId =
      (typeof data.id === "string" && data.id) ||
      (typeof data.id === "number" && String(data.id)) ||
      "noid";

    console.log(
      `plane.webhook.received event=${event} action=${action} delivery=${deliveryId}`,
    );

    if (seenDeliveries.has(deliveryId)) {
      console.log(`plane.webhook.deduped delivery=${deliveryId}`);
      sendJson(res, 200, {
        ok: true,
        delivery: deliveryId,
        forwarded: false,
        deduped: true,
      });
      return;
    }

    // Mark as seen BEFORE forwarding — if the forward throws, we still treat
    // this delivery as consumed (Plane retries would be duplicates anyway, and
    // the HTTP 500 lets Plane know to retry via its own logic if it chooses).
    seenDeliveries.add(deliveryId);
    appendDeliveryToDisk(deliveryId);

    // Forward to the stream ingest pipeline as `stream_type: "plane"`.
    // In-process call — avoids the extra HTTP loop back to 127.0.0.1:3100
    // and the extra AAS_API_KEY round-trip.
    const sourceRef = `plane:${event}:${dataId}:${deliveryId}`;
    try {
      emitStreamEvent({
        stream_id: "plane",
        stream_type: "plane",
        source_ref: sourceRef,
        raw: payload,
        summary: `Plane ${event} ${action}`,
        metadata: {
          plane_event: event,
          plane_action: action,
          plane_delivery: deliveryId,
        },
      });
    } catch (err) {
      console.error(
        `[plane.webhook] stream forward failed delivery=${deliveryId}: ${(err as Error).message}`,
      );
      throw new ApiError(500, "FORWARD_FAILED", "Failed to forward event to stream");
    }

    console.log(`plane.webhook.forwarded delivery=${deliveryId}`);

    sendJson(res, 200, {
      ok: true,
      delivery: deliveryId,
      forwarded: true,
    });
  });
}
