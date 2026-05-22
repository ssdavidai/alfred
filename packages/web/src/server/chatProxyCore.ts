/**
 * chatProxyCore — pure, dependency-free helpers for the chat proxy (F61).
 *
 * Kept import-free (no Wasp, no express) so it can be unit-tested with
 * `node:test` without booting the Wasp server env (which validates and would
 * otherwise throw on missing DATABASE_URL etc. — see reconcileCore.ts for the
 * same split rationale).
 */

/**
 * Resolve the allowed CORS origin for the `/api/chat/*` routes.
 *
 * The chat widget calls the Wasp server on the cross-origin `api.` subdomain
 * (`config.apiUrl`), but `/api/chat/*` is mounted directly on `app` in
 * `serverSetup` — OUTSIDE Wasp's CORS-bearing router — so it returned no
 * `Access-Control-Allow-Origin` header and the browser blocked the fetch
 * ("Could not reach the chat service."). Mirror Wasp's own
 * `cors({ origin: getOrigin(WASP_WEB_CLIENT_URL) })` by deriving the SPA origin
 * from `WASP_WEB_CLIENT_URL`.
 */
export function resolveChatCorsOrigin(
  webClientUrl: string | undefined,
): string | boolean {
  if (!webClientUrl) {
    // No client URL configured (local dev / preview) — reflect the request
    // origin rather than emit a wrong allowlist that would block every caller.
    return true;
  }
  try {
    return new URL(webClientUrl).origin;
  } catch {
    return webClientUrl;
  }
}

/**
 * Path prefix the chat-proxy CORS middleware is mounted on, and the four
 * concrete chat route paths registered under it.
 *
 * B10 — these MUST all be static path strings. A bare `*` wildcard (the old
 * `app.options("/api/chat/*", …)`) is rejected by the deployed Express /
 * path-to-regexp version with "Missing parameter name … /api/chat/*", which
 * threw inside `registerChatProxy` BEFORE any route registered — so all four
 * routes 404'd and the widget showed "Could not reach the chat service." CORS
 * preflight is handled by the `cors` middleware mounted on the prefix below,
 * so no wildcard route is needed. `assertStaticChatRoutePaths` is the pure
 * guard the test exercises.
 */
export const CHAT_ROUTE_PREFIX = "/api/chat" as const;

export const CHAT_ROUTE_PATHS = [
  "/api/chat/status",
  "/api/chat/turn",
  "/api/chat/run",
  "/api/chat/stream",
] as const;

/**
 * Throw if any chat route path contains a routing-token character (`*`, `:`,
 * `(`, `)`) the deployed path-to-regexp rejects. Pure + import-free so it can
 * gate the boot-time registration without booting the Wasp env.
 */
export function assertStaticChatRoutePaths(
  paths: readonly string[] = CHAT_ROUTE_PATHS,
): void {
  for (const p of paths) {
    if (/[*:()]/.test(p)) {
      throw new Error(
        `chat route path is not a static string and would throw at boot: ${p}`,
      );
    }
  }
}

/**
 * Resolve the Hermes upstream gateway token from env (the file-based source is
 * tried first by the caller). The init container writes the SAME token to both
 * the `/alfred-data/.gateway-token` file and `OPENCLAW_GATEWAY_TOKEN`;
 * `HERMES_API_SERVER_KEY` historically carried a DIFFERENT value that Hermes
 * rejects (401), so it is the lowest-priority fallback — the aligned token is
 * tried first.
 */
export function resolveGatewayTokenFromEnv(env: NodeJS.ProcessEnv): string {
  return env.OPENCLAW_GATEWAY_TOKEN ?? env.HERMES_API_SERVER_KEY ?? "";
}
