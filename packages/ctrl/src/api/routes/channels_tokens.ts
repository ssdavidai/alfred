// Canonical REST surface for channel-token management — `/api/v1/channels/tokens/*`.
//
// Background. The shared channel_tokens table is the per-channel
// bearer-token store every external surface (HA conversation, HA Voice,
// Paperclip, future Matter/HomeKit) authenticates against. PR1 (#111)
// shipped the table + DB helpers + an early route surface at
// /api/v1/channel-tokens/* (POST /mint, GET /, POST /:id/revoke,
// POST /:id/rotate). That surface stays for back-compat — existing
// fleet bearers + the legacy HaConversationSetupCard call it — but it
// is not the canonical REST shape.
//
// This module (#111 PR4) lands the canonical surface:
//
//   POST   /api/v1/channels/tokens          mint
//   GET    /api/v1/channels/tokens          list (?channel= optional filter)
//   GET    /api/v1/channels/tokens/:id      get one row
//   DELETE /api/v1/channels/tokens/:id      revoke (soft-delete)
//   POST   /api/v1/channels/tokens/:id/rotate   rotate (one-time raw)
//
// The shape is REST-uniform: the resource is at the path root, methods
// pick the operation. Same table, same DB helpers, same one-time-raw
// privacy posture as the legacy surface.
//
// Auth: all five endpoints are gated by the master AAS_API_KEY via the
// global authenticate() middleware. These are operator-facing tooling,
// not external surfaces. The TOKENS THIS MODULE MINTS are what external
// surfaces (HA, Paperclip, …) actually validate against via
// channelTokenBearer().
//
// PRIVACY contract (every response shape obeys this):
//   * `raw_token` appears EXACTLY ONCE — in the mint and rotate responses.
//   * `token_hash` is NEVER returned by any endpoint. It is sha256(raw),
//     stored at mint time, used only for the auth-path lookup.
//   * GET/list responses carry the public-safe ChannelTokenMeta view only.

import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import {
  mintChannelToken,
  listChannelTokens,
  revokeChannelToken,
  rotateChannelToken,
  getChannelTokenMeta,
  type ChannelTokenMeta,
} from "../../db/channelTokens.js";

/** Channels this route surface accepts at mint time. Anything else is a
 *  400 — keeps a typo from fragmenting the audit trail with
 *  `channel='ha_conversation'` vs `channel='ha-conversation'`. Update in
 *  lockstep with `generateRawToken`'s prefix arm in db/channelTokens.ts. */
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

/** Flatten the public-safe meta into the wire shape used by GET/list
 *  responses. Mirrors ChannelTokenMeta with `scope` renamed to
 *  `scope_json` on the wire so downstream consumers (the Wasp web layer,
 *  the legacy `vault-cli channel-token list` tooling) can rely on the
 *  same field name across both route surfaces. token_hash is NEVER
 *  exposed — the only mapping is hash → row inside auth.ts. */
function metaToWire(meta: ChannelTokenMeta): Record<string, unknown> {
  return {
    id: meta.id,
    channel: meta.channel,
    label: meta.label,
    scope_json: meta.scope,
    created_at: meta.created_at,
    last_used_at: meta.last_used_at,
    last_used_ip: meta.last_used_ip,
    rotated_from: meta.rotated_from,
    revoked_at: meta.revoked_at,
  };
}

export function registerChannelsTokensRoutes(): void {
  // POST /api/v1/channels/tokens — mint. Generates a raw token via
  // mintChannelToken() (which under the hood uses 24 random bytes →
  // hex + channel-specific prefix — `ha_…` for HA, `pcp_…` for
  // Paperclip — for at-a-glance log identification; 192 bits of
  // entropy either way) and stores sha256(raw) in token_hash. The raw
  // token is returned EXACTLY ONCE in `raw_token`; subsequent reads of
  // this row will never re-expose it.
  addRoute("POST", "/api/v1/channels/tokens", async ({ res, body }) => {
    const parsed = parseMintBody(body);
    const result = mintChannelToken(getStateDb(), {
      channel: parsed.channel,
      label: parsed.label,
      scope: parsed.scope,
    });
    sendJson(res, 201, {
      id: result.meta.id,
      channel: result.meta.channel,
      label: result.meta.label,
      raw_token: result.raw,
      scope_json: result.meta.scope,
      created_at: result.meta.created_at,
    });
  });

  // GET /api/v1/channels/tokens?channel=<filter>&include_revoked=false
  // — operator list. Returns the public-safe view. With no `channel`
  // filter the list spans every channel; with `channel=ha-conversation`
  // (et al.) it scopes. `include_revoked=true` surfaces tombstones for
  // audit views; the default is active-only so the HA card's install
  // table doesn't paint stale rows.
  addRoute("GET", "/api/v1/channels/tokens", async ({ res, query }) => {
    const includeRevoked =
      query.get("include_revoked") === "true" ||
      query.get("include_revoked") === "1";
    const channelFilter = query.get("channel");
    let metas: ChannelTokenMeta[];
    if (channelFilter) {
      // Unknown-channel filter returns an empty list (not a 400) — the
      // operator may be probing for an as-yet-unused channel surface.
      metas = listChannelTokens(getStateDb(), channelFilter, {
        includeRevoked,
      });
    } else {
      // No filter → list every channel. We do this channel-by-channel
      // rather than a raw SELECT because listChannelTokens centralises
      // the public-safe row projection (no token_hash).
      const all: ChannelTokenMeta[] = [];
      for (const channel of KNOWN_CHANNELS) {
        all.push(
          ...listChannelTokens(getStateDb(), channel, { includeRevoked }),
        );
      }
      // Newest first across channels.
      all.sort((a, b) => b.created_at - a.created_at);
      metas = all;
    }
    sendJson(res, 200, { tokens: metas.map(metaToWire) });
  });

  // GET /api/v1/channels/tokens/:id — single row, same shape as the
  // list rows. NotFound for unknown ids — the operator gets a clear
  // 404 rather than a generic empty list.
  addRoute(
    "GET",
    "/api/v1/channels/tokens/:id",
    async ({ res, params }) => {
      const id = params.id;
      if (!id) throw new ValidationError("id is required");
      const meta = getChannelTokenMeta(getStateDb(), id);
      if (!meta) throw new NotFoundError(`channel_token ${id} not found`);
      sendJson(res, 200, metaToWire(meta));
    },
  );

  // DELETE /api/v1/channels/tokens/:id — soft-revoke. Sets
  // `revoked_at = now()`. Idempotent: a second DELETE is a no-op (the
  // existing `revoked_at` stays). Returns `{ok, revoked_at}`. The next
  // request from the now-revoked token gets 401 via channelTokenBearer.
  addRoute(
    "DELETE",
    "/api/v1/channels/tokens/:id",
    async ({ res, params }) => {
      const id = params.id;
      if (!id) throw new ValidationError("id is required");
      const meta = revokeChannelToken(getStateDb(), id);
      if (!meta) throw new NotFoundError(`channel_token ${id} not found`);
      sendJson(res, 200, { ok: true, revoked_at: meta.revoked_at });
    },
  );

  // POST /api/v1/channels/tokens/:id/rotate — mint a fresh token in
  // the same channel (carrying label + scope), set `rotated_from = :id`,
  // and return the new row + new `raw_token` (one-time).
  //
  // GRACE WINDOW. The old row is deliberately NOT auto-revoked here.
  // channelTokenBearer accepts ANY non-revoked row matching
  // (channel, sha256(raw)), so during the operator-controlled cutover
  // BOTH the old and the new tokens keep authenticating — the consuming
  // surface (an HA install, a Paperclip agent, …) can be re-pointed at
  // the new bearer at the operator's pace. When the operator confirms
  // the new bearer is installed they DELETE the old row separately.
  // This is the "rotate, then explicit revoke" two-step that mirrors
  // how SSH key rotation is run in production.
  addRoute(
    "POST",
    "/api/v1/channels/tokens/:id/rotate",
    async ({ res, params }) => {
      const id = params.id;
      if (!id) throw new ValidationError("id is required");
      const existing = getChannelTokenMeta(getStateDb(), id);
      if (!existing) throw new NotFoundError(`channel_token ${id} not found`);
      const fresh = rotateChannelToken(getStateDb(), id);
      if (!fresh) throw new NotFoundError(`channel_token ${id} not found`);
      sendJson(res, 201, {
        id: fresh.meta.id,
        channel: fresh.meta.channel,
        label: fresh.meta.label,
        raw_token: fresh.raw,
        scope_json: fresh.meta.scope,
        created_at: fresh.meta.created_at,
        rotated_from: id,
      });
    },
  );
}
