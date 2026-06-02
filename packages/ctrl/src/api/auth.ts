// ctrl-api Bearer-token authentication.
//
// Two tokens are accepted:
//
//   1. The master AAS_API_KEY (always required if any caller is to be
//      authenticated). Master grants access to every /api/v1/* route.
//
//   2. Optional VOICE_BRIDGE_INTERNAL_TOKEN — a scoped, path-allowlisted
//      Bearer for the voice-bridge sibling container. It is permitted
//      ONLY on the routes voice-bridge actually needs (see the two
//      allowlists below). Everything else 401s as if no token were sent.
//
//      The allowlist comes in two shapes:
//
//      (a) VOICE_BRIDGE_ALLOWLIST — exact `METHOD:/exact/path` matches.
//          Used for routes that have no path parameters (`/voice-context`,
//          `/transcript`, `/integrations/execute`, `/briefings`, etc.).
//          No prefix inheritance — a future `/voice-context/raw` would not
//          accidentally inherit privilege from `/voice-context`.
//
//      (b) VOICE_BRIDGE_PATTERN_ALLOWLIST — anchored regexes, one per
//          parameterized route (`/briefings/:slugDate`, `/decisions/:id`,
//          `/vault/list/:type`, `/vault/records/*`, etc.). Each pattern is
//          `^...$` anchored and uses a tight `[^/]+` (or path-tail) match,
//          so adjacent routes can't inherit privilege either. The shape
//          mirrors what the `self` realtime tool surface needs (vault
//          read, briefings, decisions, schedules, workflows, matters,
//          chores, signals, observations) — added 2026-05-28 when sir's
//          home call sid CAb414732e8fce45b65d1d9f236d91b984 surfaced
//          `tool self ok=false status=401 4ms argsLen=89` (the residual
//          PR #95 called out: the voice-bridge `self` tool was routing
//          correctly to single-VM ctrl-api but the scoped bearer had no
//          path beyond the original two).
//
//      Writes intentionally omitted: the realtime agent has MCP coverage
//      for the write paths it needs (alfred__act_on_decision /
//      alfred__reverse_decision were added in PR #97, alfred__notify_*,
//      alfred__create_vault_record, etc.). `self` stays read-only — if
//      voice-bridge is ever compromised the blast radius is bounded to
//      observable state, never mutation.
//
//      This is principle-of-least-privilege for an internal monorepo
//      service that lives on the same docker network as ctrl-api but is
//      large attack surface (Twilio mulaw, OpenAI Realtime WebSocket). The
//      master key never leaves ctrl-api.
//
// Both token validations are constant-time (`crypto.timingSafeEqual`) so
// a network attacker can't time the comparison to recover bytes.

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ApiError, AuthError } from "./errors.js";
import { getStateDb } from "../db/state.js";
import {
  validateChannelToken,
  type ChannelTokenMeta,
} from "../db/channelTokens.js";

let apiKeyBuf: Buffer | null = null;
let voiceBridgeKeyBuf: Buffer | null = null;

/**
 * The exact set of method:pathname pairs the voice-bridge scoped token is
 * allowed to call. The match is EXACT (no prefix matching, no wildcards) so
 * a future route accidentally named close to one of these (e.g.
 * /api/v1/phone/voice-context/raw) does NOT inherit the privilege.
 *
 * Routes with path parameters (e.g. `/decisions/:id`) live in
 * VOICE_BRIDGE_PATTERN_ALLOWLIST below — anchored-regex per route, never a
 * blanket prefix.
 */
const VOICE_BRIDGE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Voice primer + transcript hand-off — the original two routes from
  // Phase 4.1 (commit 85be684e).
  "GET:/api/v1/phone/voice-context",
  "POST:/api/v1/phone/transcript",
  // composio_execute dispatch path — added 2026-05-28 in PR #95. The
  // realtime agent's built-in `composio_execute` tool routes through here.
  // Auth body is tenant-bound (one Composio user-id per ctrl-api), so this
  // token cannot hop tenants.
  "POST:/api/v1/integrations/execute",
  // ── `self` realtime tool, read-only surface — added 2026-05-28. ──────
  // Sir said the call sid CAb414732e8fce45b65d1d9f236d91b984 logged
  // `tool self ok=false status=401 4ms argsLen=89`. PR #95 fixed the
  // dispatcher; this widens the allowlist to the read-only catalogue the
  // persona file documents (vault, briefings, decisions, schedules,
  // workflows, matters, chores, signals, observations, learning).
  //
  // Briefings — Sir asks "what's my brief?" / list briefings.
  "GET:/api/v1/briefings",
  // Vault context primer + parameterless reads.
  "GET:/api/v1/vault/context",
  "GET:/api/v1/vault/search",
  "GET:/api/v1/vault/index",
  "GET:/api/v1/vault/schema",
  "GET:/api/v1/vault/inbox",
  "GET:/api/v1/vault/graph",
  "GET:/api/v1/vault/nebula-data",
  // Decision queue — Sir asks "what's on my desk?"
  "GET:/api/v1/decisions",
  "GET:/api/v1/decisions/in-flight",
  // Matters / chores / workflows / schedules — listing the top-level set.
  "GET:/api/v1/matters",
  "GET:/api/v1/chores",
  "GET:/api/v1/chore-actions",
  "GET:/api/v1/workflows",
  "GET:/api/v1/schedules",
  // Signals + observations top-of-list (state.db read surface).
  "GET:/api/v1/state/signals",
  "GET:/api/v1/state/observations",
  // Desk queue (needs_attention) — the Desk audit ledger.
  "GET:/api/v1/admin/needs-attention",
  // Learning surfaces — Sir asks "what's Alfred figured out lately?"
  "GET:/api/v1/learning/status",
  "GET:/api/v1/learning/observations",
  "GET:/api/v1/learning/instincts",
  "GET:/api/v1/learning/reflections",
  "GET:/api/v1/learning/sessions",
  // Tailscale channel — Sir asks "is Tailscale on right now?" via voice.
  // Read-only surface (status + peer list); connect/disconnect intentionally
  // omitted (writes go through MCP per the voice-bridge contract). Added
  // by issue #109 PR 2 alongside the routes themselves.
  "GET:/api/v1/channels/tailscale/status",
  "GET:/api/v1/channels/tailscale/peers",
  // Home Assistant channel — Sir asks "is the front door light on?" via
  // voice. Spec §7 Q13 lists exactly 4 read routes for the voice surface
  // (status, registry, state/:entity_id, automations). connect /
  // disconnect / service / automation CRUD / proposal / discovery /
  // snapshots are intentionally absent — writes go through MCP and the
  // /snapshots forensic surface is operator-only. Added by issue #110 PR1
  // alongside the route implementations themselves.
  "GET:/api/v1/channels/ha/status",
  "GET:/api/v1/channels/ha/registry",
  "GET:/api/v1/channels/ha/automations",
  // #110 PR6 — gap detection + proposal generation read surfaces.
  // Voice CAN ask "what gaps does Alfred see?" / "what proposals are
  // pending?" — but CANNOT trigger applyHaProposal (that stays through
  // the MCP write surface so the loop-guard + snapshot pattern in
  // PR4 still wraps every write).
  "GET:/api/v1/channels/ha/gaps",
  "GET:/api/v1/channels/ha/proposals",
  // ── Files store, read-only — issue #114 PR4 (voice-bridge files surface). ─
  // The voice agent surfaces four read-only `files__*` tools (list / stat /
  // read_text / search). list + usage have no path params; stat + blob carry
  // the `<ULID>/<safe-name>` tail and live in the PATTERN allowlist below.
  // Writes (POST /upload, PATCH /:path, DELETE /:path) are INTENTIONALLY
  // omitted — voice never writes to the files store. See packages/voice-
  // bridge/src/files-tools.ts for the per-tool rationale.
  "GET:/api/v1/files/list",
  "GET:/api/v1/files/usage",
  // ── Recall PR5: in-meeting voice ────────────────────────────────────
  // The voice-bridge calls /api/v1/voice-bridge/recall-turn synchronously
  // when ctrl-api's realtime subscriber wants Alfred to speak into a
  // meeting — passing the wake-word transcript + meeting context, getting
  // back rendered audio for output_audio. Scoped, write-narrow. Bot
  // speaks AS ALFRED (the RP butler persona enforced in voice-bridge's
  // buildMeetingPrefix), never as the principal.
  "POST:/api/v1/voice-bridge/recall-turn",
  // ── #120 Lane Vb: per-profile voice routing ─────────────────────────
  // voice-bridge fetches the resolved profile's calling number + key set
  // via /status?profile=<slug> on every inbound call so a creds rotation
  // applies without a container restart. The status route does NOT return
  // the OpenAI key value; the internal helper below does. Both queries
  // include ?profile=<slug>; auth.ts compares against the pathname only,
  // and the query is matched in the route handler.
  "GET:/api/v1/channels/voice/status",
  // The bridge needs the per-profile OPENAI_API_KEY value to open the
  // Realtime socket against the right account. ctrl-api exposes this only
  // to the voice-bridge bearer; the route reads the per-profile .env via
  // dockerExec. Allowed paths return the raw value; non-voice-bridge
  // callers 401.
  "GET:/api/v1/channels/voice/internal/openai-key",
]);

/**
 * Parameterised routes the voice-bridge scoped token can read. Each entry is
 * an anchored regex matched against the request pathname — no prefix
 * inheritance, no wildcard between segments. Generated once at module load.
 *
 * The shape is deliberately tight: a `[^/]+` for `:id`-style placeholders,
 * and a `.+` only for the documented `/vault/records/*` tail (the vault
 * surface natively uses slash-separated record paths). Anything outside
 * this catalogue 401s through the same code path as a wrong token would.
 */
const VOICE_BRIDGE_PATTERN_ALLOWLIST: ReadonlyArray<{
  method: string;
  regex: RegExp;
}> = [
  // GET /api/v1/briefings/:slugDate — read one brief by date.
  { method: "GET", regex: /^\/api\/v1\/briefings\/[^/]+$/ },
  // GET /api/v1/decisions/:id — read one decision (the Desk row).
  { method: "GET", regex: /^\/api\/v1\/decisions\/[^/]+$/ },
  // GET /api/v1/vault/list/:type — list vault records by type.
  { method: "GET", regex: /^\/api\/v1\/vault\/list\/[^/]+$/ },
  // GET /api/v1/vault/records/<path>  — read one vault record (path can
  // contain slashes; the route uses an explicit /* tail). Read-only.
  { method: "GET", regex: /^\/api\/v1\/vault\/records\/.+$/ },
  // GET /api/v1/matters/:id — read one matter.
  { method: "GET", regex: /^\/api\/v1\/matters\/[^/]+$/ },
  // GET /api/v1/chores/:slug — read one chore.
  { method: "GET", regex: /^\/api\/v1\/chores\/[^/]+$/ },
  // GET /api/v1/chores/:slug/runs — recent runs of a chore.
  { method: "GET", regex: /^\/api\/v1\/chores\/[^/]+\/runs$/ },
  // GET /api/v1/chores/:slug/source — the YAML source of a chore.
  { method: "GET", regex: /^\/api\/v1\/chores\/[^/]+\/source$/ },
  // GET /api/v1/workflows/:wfId — read one workflow's status.
  { method: "GET", regex: /^\/api\/v1\/workflows\/[^/]+$/ },
  // GET /api/v1/workflows/:wfId/history — workflow history (read-only).
  { method: "GET", regex: /^\/api\/v1\/workflows\/[^/]+\/history$/ },
  // GET /api/v1/schedules/:schId — read one schedule's status.
  { method: "GET", regex: /^\/api\/v1\/schedules\/[^/]+$/ },
  // GET /api/v1/state/signals/:id — read one signal.
  { method: "GET", regex: /^\/api\/v1\/state\/signals\/[^/]+$/ },
  // GET /api/v1/state/observations/:id — read one observation.
  { method: "GET", regex: /^\/api\/v1\/state\/observations\/[^/]+$/ },
  // GET /api/v1/learning/observations/:id — one learn observation.
  { method: "GET", regex: /^\/api\/v1\/learning\/observations\/[^/]+$/ },
  // GET /api/v1/learning/instincts/:id — one instinct.
  { method: "GET", regex: /^\/api\/v1\/learning\/instincts\/[^/]+$/ },
  // GET /api/v1/channels/ha/state/:entity_id — read one HA entity's last
  // observed state. Entity ids look like `light.kitchen` /
  // `binary_sensor.front_door` — domain.object_id, no slashes, so
  // [^/]+ is the right shape (no nested paths under /state/). Added by
  // issue #110 PR1 alongside the route implementation.
  { method: "GET", regex: /^\/api\/v1\/channels\/ha\/state\/[^/]+$/ },
  // GET /api/v1/files/stat/<path> — metadata for one stored file. The
  // ctrl-api route is `/api/v1/files/stat/*` (splat-tail captures the
  // entire `<ULID>/<safe-name>` shape, which CONTAINS a `/`), so the
  // regex tail is `.+` not `[^/]+`. The leading anchor on `/stat/` keeps
  // the privilege from leaking to a future `/stats/...` neighbour.
  // Added by issue #114 PR4.
  { method: "GET", regex: /^\/api\/v1\/files\/stat\/.+$/ },
  // GET /api/v1/files/blob/<path> — stream the raw bytes. Same `.+` tail
  // shape as /stat/. Voice-bridge's `files__read_text` short-circuits via
  // stat first, so a 5 MB blob never crosses the wire from this token
  // (the dispatcher refuses to fetch if stat reports size > 64 KB).
  // Added by issue #114 PR4.
  { method: "GET", regex: /^\/api\/v1\/files\/blob\/.+$/ },
];

function voiceBridgeRouteAllowed(method: string, pathname: string): boolean {
  if (VOICE_BRIDGE_ALLOWLIST.has(`${method}:${pathname}`)) return true;
  for (const entry of VOICE_BRIDGE_PATTERN_ALLOWLIST) {
    if (entry.method === method && entry.regex.test(pathname)) return true;
  }
  return false;
}

export function setApiKey(key: string): void {
  apiKeyBuf = Buffer.from(key);
}

/**
 * Install the scoped voice-bridge token. Pass an empty string to disable
 * (e.g. when running ctrl-api without a voice-bridge sibling).
 */
export function setVoiceBridgeKey(key: string): void {
  voiceBridgeKeyBuf = key ? Buffer.from(key) : null;
}

/** For tests only — reset both keys to the unconfigured state. */
export function _resetAuthForTests(): void {
  apiKeyBuf = null;
  voiceBridgeKeyBuf = null;
}

export function authenticate(
  req: IncomingMessage,
  route?: { method: string; pathname: string },
): void {
  if (!apiKeyBuf) return; // no key configured — open access (dev only)

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AuthError("Missing or malformed Authorization header");
  }

  const tokenBuf = Buffer.from(header.slice(7));

  // Path 1 — master key. Grants everything.
  if (
    tokenBuf.length === apiKeyBuf.length &&
    crypto.timingSafeEqual(tokenBuf, apiKeyBuf)
  ) {
    return;
  }

  // Path 2 — scoped voice-bridge token. Allowed iff (a) the token matches
  // and (b) the request is for one of the allowlisted routes.
  if (
    voiceBridgeKeyBuf &&
    tokenBuf.length === voiceBridgeKeyBuf.length &&
    crypto.timingSafeEqual(tokenBuf, voiceBridgeKeyBuf)
  ) {
    if (route && voiceBridgeRouteAllowed(route.method, route.pathname)) {
      return;
    }
    // Token recognised but route not in allowlist — explicit 401 with a
    // generic message (don't leak the allowlist to a probing caller).
    throw new AuthError("Token not permitted on this route");
  }

  throw new AuthError("Invalid API key");
}

// ──────────────────────────────────────────────────────────────────────────
// Shared channel-token bearer path.
//
// Used by channel-keyed routes (HA-conversation /turn, future HA-voice
// /audio, future Paperclip /heartbeat post-migration) to swap an inbound
// bearer for the `channel_tokens` row that authorises it. The token shape
// is `<prefix>_<48hex>` per channel; the validator (a) sha256-hashes the
// raw bytes, (b) looks up by `(channel, token_hash)` with
// `revoked_at IS NULL`, (c) bumps `last_used_at` + `last_used_ip` as a
// side effect.
//
// IMPORTANT: this path is OUTSIDE the master-key authenticate() flow. A
// channel-keyed route's place in server.ts must either:
//   * list its path in `isPublic` so the global gate doesn't pre-empt it
//     with a 401, OR
//   * accept the master key in addition (the master AAS_API_KEY route also
//     reaches the handler; the handler can opt into channelTokenBearer for
//     the non-master case).
//
// The contract: when this returns a `ChannelTokenMeta`, the request is
// authenticated as the principal that minted the row. When it throws
// AuthError, the global error path returns 401.
// ──────────────────────────────────────────────────────────────────────────

/** Extract the bearer token bytes from `Authorization: Bearer <token>`.
 *  Returns null if absent or malformed (so the caller decides whether to
 *  401 or fall through to another auth path). */
export function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  if (!header.startsWith("Bearer ")) return null;
  const tok = header.slice(7).trim();
  return tok.length > 0 ? tok : null;
}

/** Best-effort source ip for the `last_used_ip` column. Honours
 *  X-Forwarded-For when behind Caddy (the apex passes traffic through to
 *  ctrl-api with the original remote in the header). */
function extractRemoteIp(req: IncomingMessage): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    // first hop is the originating client
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const sock = (req as { socket?: { remoteAddress?: string } }).socket;
  return sock?.remoteAddress ?? null;
}

/** Require an operator-grade bearer (the master AAS_API_KEY) on the request.
 *
 *  The global `authenticate()` already accepts both the master key and the
 *  scoped voice-bridge token (the latter gated by the allowlists above).
 *  This helper layers an EXPLICIT operator-only check on top — used by
 *  routes that handle sensitive material (HA LLAT retrieval, registry
 *  bulk-upsert, on-demand workflow refresh) where defence-in-depth matters
 *  even though those routes are NOT in either allowlist.
 *
 *  Failure modes:
 *    * `apiKeyBuf` unset → returns silently (dev-only open-access mode).
 *    * Bearer missing/malformed → throws ApiError(401).
 *    * Bearer matches the voice-bridge token → throws ApiError(403). This
 *      is the load-bearing branch: a voice-bridge sibling that ever tries
 *      to reach an operator-only route must be told NO with a code that
 *      surfaces in logs as a permission boundary, NOT confused with a
 *      stale-token 401.
 *    * Bearer matches a channel_tokens row (`pcp_*` / `cnv_*` / etc.) →
 *      throws ApiError(403). Same rationale.
 *    * Bearer matches the master key → returns.
 *
 *  IMPORTANT: never logs or echoes the bearer bytes — the operator-key
 *  surface accepts an LLAT-shaped secret in its response payload, so the
 *  failure path mustn't leak any token material via the error envelope.
 */
export function requireOperatorBearer(req: IncomingMessage): void {
  if (!apiKeyBuf) return; // dev-only open-access mode (same as authenticate())

  const raw = extractBearerToken(req);
  if (!raw) {
    throw new ApiError(401, "UNAUTHORIZED", "Missing or malformed Authorization header");
  }

  const tokenBuf = Buffer.from(raw);

  // Master key — operator. Allowed.
  if (
    tokenBuf.length === apiKeyBuf.length &&
    crypto.timingSafeEqual(tokenBuf, apiKeyBuf)
  ) {
    return;
  }

  // Voice-bridge token — explicitly forbidden. 403, not 401: this is a
  // permission boundary, not a credentials problem.
  if (
    voiceBridgeKeyBuf &&
    tokenBuf.length === voiceBridgeKeyBuf.length &&
    crypto.timingSafeEqual(tokenBuf, voiceBridgeKeyBuf)
  ) {
    throw new ApiError(403, "FORBIDDEN", "Operator-only route");
  }

  // Channel token (pcp_…, ha-… etc.) — also forbidden. We don't have to
  // look it up against the channel_tokens table; ANY non-master bearer
  // that isn't voice-bridge falls through to this branch. Returning 403
  // (not 401) makes the boundary explicit in the request log.
  throw new ApiError(403, "FORBIDDEN", "Operator-only route");
}

// Re-export ApiError as an internal-only name used by requireOperatorBearer
// — kept private to this module so callers see the right error class.

/** Authenticate a channel-keyed bearer for one channel. Throws AuthError
 *  on no/bad/revoked token. Returns the row metadata on success.
 *
 *  Side-effect: bumps `last_used_at` and `last_used_ip` on the matched
 *  row.
 *
 *  This is the single function every channel route imports — there is no
 *  parallel auth module. */
export function channelTokenBearer(
  req: IncomingMessage,
  channel: string,
): ChannelTokenMeta {
  const raw = extractBearerToken(req);
  if (!raw) {
    throw new AuthError("Missing or malformed Authorization header");
  }
  const meta = validateChannelToken(getStateDb(), channel, raw, {
    ip: extractRemoteIp(req),
  });
  if (!meta) {
    // Don't leak whether the token was unknown vs revoked vs wrong-channel
    // — every failure mode is the same 401 to the caller.
    throw new AuthError("Invalid or revoked token");
  }
  return meta;
}
