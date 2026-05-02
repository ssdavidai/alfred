// Bearer-token auth for the MCP endpoint.
//
// v1 shipping pattern: a single hardcoded bearer in a Worker secret
// (MCP_DAVID_BEARER). Sir copies it into Claude Desktop's MCP config exactly
// once after `wrangler secret put`. Validation runs in the outer fetch
// handler so unauthenticated requests never reach the McpAgent Durable
// Object. This keeps the auth boundary outside the agent's session state.
//
// Multi-tenant generalisation (KV-backed bearer → tenant lookup) lives
// behind issue #772.

import type { Env } from "./env.js";

/**
 * Compare two strings in constant time. Standard timing-safe equality is not
 * exposed to Workers, so this is a hand-rolled equivalent — sufficient
 * because both strings are short, fixed-length tokens.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Validate the Authorization header against the expected bearer.
 * Returns null on success, or a Response (401) on rejection.
 *
 * Defensive against:
 *   - missing header
 *   - non-Bearer scheme
 *   - empty bearer secret (rejects ALL requests rather than allow open access)
 *   - timing side channels
 */
export function checkBearer(request: Request, env: Env): Response | null {
  const expected = env.MCP_DAVID_BEARER;
  if (!expected || expected.length < 32) {
    // Misconfigured Worker — fail closed loudly instead of letting traffic
    // through. The 503 + body is intentional: callers (Sir + the operator)
    // need to know the secret is missing/short, not get a vague 401.
    return new Response(
      JSON.stringify({ error: "MCP_DAVID_BEARER not configured (set via `wrangler secret put`)" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return unauthorized();
  }
  const token = header.slice(7);
  if (!timingSafeEqual(token, expected)) {
    return unauthorized();
  }
  return null;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized — invalid or missing Bearer token" }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}
