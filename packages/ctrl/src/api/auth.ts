// ctrl-api Bearer-token authentication.
//
// Two tokens are accepted:
//
//   1. The master AAS_API_KEY (always required if any caller is to be
//      authenticated). Master grants access to every /api/v1/* route.
//
//   2. Optional VOICE_BRIDGE_INTERNAL_TOKEN — a scoped, path-allowlisted
//      Bearer for the voice-bridge sibling container. It is permitted
//      ONLY on the routes voice-bridge actually needs:
//
//        GET  /api/v1/phone/voice-context   (read primer for the realtime agent)
//        POST /api/v1/phone/transcript      (post call transcript at hangup)
//        POST /api/v1/integrations/execute  (dispatch composio_execute tool
//                                            calls during the realtime session
//                                            — added 2026-05-28; without this
//                                            the realtime agent could not call
//                                            Composio actions on home.alfred.
//                                            black, surfacing as a 6ms
//                                            `composio_execute ok=false
//                                            status=err` on every voice call.)
//
//      Any other route requested with this token rejects with 401, as if
//      no token were presented. This is principle-of-least-privilege for an
//      internal monorepo service that lives on the same docker network as
//      ctrl-api but is large attack surface (Twilio mulaw, OpenAI Realtime
//      WebSocket). If voice-bridge is ever compromised, the blast radius is
//      bounded to these routes — the master key never leaves ctrl-api.
//
// Both validations are constant-time (`crypto.timingSafeEqual`) so a
// network attacker can't time the comparison to recover bytes.

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AuthError } from "./errors.js";

let apiKeyBuf: Buffer | null = null;
let voiceBridgeKeyBuf: Buffer | null = null;

/**
 * The exact set of method:pathname pairs the voice-bridge scoped token is
 * allowed to call. The match is EXACT (no prefix matching, no wildcards) so
 * a future route accidentally named close to one of these (e.g.
 * /api/v1/phone/voice-context/raw) does NOT inherit the privilege.
 */
const VOICE_BRIDGE_ALLOWLIST: ReadonlySet<string> = new Set([
  "GET:/api/v1/phone/voice-context",
  "POST:/api/v1/phone/transcript",
  // composio_execute dispatch path — added 2026-05-28. The realtime agent's
  // built-in `composio_execute` tool routes through here. Auth body is
  // tenant-bound (one Composio user-id per ctrl-api), so this token cannot
  // hop tenants. Action arguments are model-supplied — we accept the same
  // surface Hermes uses through MCP, scoped to this single endpoint.
  "POST:/api/v1/integrations/execute",
]);

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
    if (
      route &&
      VOICE_BRIDGE_ALLOWLIST.has(`${route.method}:${route.pathname}`)
    ) {
      return;
    }
    // Token recognised but route not in allowlist — explicit 401 with a
    // generic message (don't leak the allowlist to a probing caller).
    throw new AuthError("Token not permitted on this route");
  }

  throw new AuthError("Invalid API key");
}
