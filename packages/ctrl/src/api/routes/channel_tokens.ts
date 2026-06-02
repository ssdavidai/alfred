// Shared /api/v1/channel-tokens/* surface — every channel's bearer-token
// rotation/audit/revoke lives here.
//
// Background. Sir's decision Q2 (issue #111) ratifies a single shared
// `channel_tokens` table for every per-channel bearer the platform issues.
// HA-conversation is the first user (this PR); HA Voice (#112) joins next;
// Paperclip migrates onto it later as housekeeping. The HTTP surface is
// uniform: mint by channel name, list by channel name, revoke by id,
// rotate by id. Channel-specific shape (HA installation id, etc.) rides
// along on `scope` — opaque to this module, meaningful to the channel
// route that issued the token.
//
// All four endpoints are bearer-authed by the master AAS_API_KEY — they
// are operator-facing tooling, not external surfaces. The TOKENS THIS
// MODULE MINTS are what external surfaces (HA, Paperclip, …) actually
// validate against.
//
// PRIVACY: the raw token is shown EXACTLY ONCE at mint. Only sha256(raw)
// is stored. Listing endpoints return a public-safe view (no token_hash,
// no raw). Compare with the voice-bridge token UX: same posture (one
// reveal, no recovery) but plumbed through the shared table this time.

import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import {
  mintChannelToken,
  listChannelTokens,
  revokeChannelToken,
  rotateChannelToken,
  getChannelTokenMeta,
} from "../../db/channelTokens.js";

/** The set of channel names this module accepts at mint time. Each entry
 *  here also pins a token-prefix discipline in db/channelTokens.ts's
 *  `generateRawToken`. Adding a new channel: add the name here AND the
 *  prefix arm there. We refuse unknown channels at the HTTP layer so a
 *  typo can't fragment the audit trail with `channel='ha_conversation'`
 *  vs `channel='ha-conversation'`. */
const KNOWN_CHANNELS: ReadonlySet<string> = new Set([
  "ha-conversation",
  "ha-voice",
  "paperclip-heartbeat",
]);

interface MintBody {
  channel: string;
  label?: string | null;
  scope?: Record<string, unknown> | null;
}

function parseMintBody(raw: unknown): MintBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.channel !== "string" || b.channel.length === 0) {
    throw new ValidationError("channel must be a non-empty string");
  }
  if (!KNOWN_CHANNELS.has(b.channel)) {
    throw new ValidationError(
      `channel must be one of ${[...KNOWN_CHANNELS].join(", ")}`,
    );
  }
  let label: string | null = null;
  if (b.label !== undefined && b.label !== null) {
    if (typeof b.label !== "string") {
      throw new ValidationError("label must be a string or omitted");
    }
    label = b.label;
  }
  let scope: Record<string, unknown> | null = null;
  if (b.scope !== undefined && b.scope !== null) {
    if (typeof b.scope !== "object" || Array.isArray(b.scope)) {
      throw new ValidationError("scope must be a JSON object or omitted");
    }
    scope = b.scope as Record<string, unknown>;
  }
  return { channel: b.channel, label, scope };
}

export function registerChannelTokenRoutes(): void {
  // POST /channel-tokens/mint — mint a new token. Returns the raw token
  // EXACTLY ONCE. The caller must capture and store it now; there is no
  // recovery path.
  addRoute("POST", "/api/v1/channel-tokens/mint", async ({ res, body }) => {
    const parsed = parseMintBody(body);
    const result = mintChannelToken(getStateDb(), {
      channel: parsed.channel,
      label: parsed.label,
      scope: parsed.scope,
    });
    // Shape mirrors the once-only-reveal pattern used by Paperclip's
    // bootstrap and by voice-bridge's pairing: `token` at top level, the
    // public-safe meta under `meta` so the caller can persist whichever
    // piece they need.
    sendJson(res, 201, {
      token: result.raw,
      meta: result.meta,
    });
  });

  // GET /channel-tokens?channel=… — list active tokens for a channel.
  // Public-safe view: no raw token, no hash. `?include_revoked=1` returns
  // tombstones too for audit views.
  addRoute("GET", "/api/v1/channel-tokens", async ({ res, query }) => {
    const channel = query.get("channel");
    if (!channel) {
      throw new ValidationError("channel query parameter is required");
    }
    const includeRevoked = query.get("include_revoked") === "1";
    const tokens = listChannelTokens(getStateDb(), channel, {
      includeRevoked,
    });
    sendJson(res, 200, { tokens });
  });

  // POST /channel-tokens/:id/revoke — soft-revoke. Sets `revoked_at`.
  // Idempotent: a second revoke is a no-op (the existing `revoked_at`
  // stays). Returns the row for confirmation.
  addRoute(
    "POST",
    "/api/v1/channel-tokens/:id/revoke",
    async ({ res, params }) => {
      const id = params.id;
      if (!id) throw new ValidationError("id is required");
      const meta = revokeChannelToken(getStateDb(), id);
      if (!meta) throw new NotFoundError(`channel_token ${id} not found`);
      sendJson(res, 200, { ok: true, meta });
    },
  );

  // POST /channel-tokens/:id/rotate — mint a new token in the same channel
  // that points back at the old via `rotated_from`. Returns the new raw
  // token ONCE. Does NOT revoke the old token automatically — caller does
  // that once the new one is installed on the consuming side.
  addRoute(
    "POST",
    "/api/v1/channel-tokens/:id/rotate",
    async ({ res, params }) => {
      const id = params.id;
      if (!id) throw new ValidationError("id is required");
      // Surface the not-found explicitly so the operator gets a clear
      // message rather than a generic 500.
      const existing = getChannelTokenMeta(getStateDb(), id);
      if (!existing) throw new NotFoundError(`channel_token ${id} not found`);
      const result = rotateChannelToken(getStateDb(), id);
      if (!result) throw new NotFoundError(`channel_token ${id} not found`);
      sendJson(res, 201, {
        token: result.raw,
        meta: result.meta,
        rotated_from: id,
      });
    },
  );
}
