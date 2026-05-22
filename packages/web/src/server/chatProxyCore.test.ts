/**
 * F61 — chat-proxy CORS origin + gateway-token fallback resolution.
 *
 * The chat widget calls the Wasp server on the cross-origin `api.` subdomain;
 * the custom `/api/chat/*` routes are mounted outside Wasp's CORS-bearing
 * router, so they must emit their own `Access-Control-Allow-Origin`. This
 * tests the pure origin-derivation helper that feeds `cors({ origin })` (the
 * exact value that was missing → "Could not reach the chat service.") and the
 * env token-fallback ordering (the aligned `OPENCLAW_GATEWAY_TOKEN` must win
 * over the historically-wrong `HERMES_API_SERVER_KEY`).
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/server/chatProxyCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveChatCorsOrigin,
  resolveGatewayTokenFromEnv,
} from "./chatProxyCore";

test("resolveChatCorsOrigin: derives the SPA origin from WASP_WEB_CLIENT_URL", () => {
  assert.equal(
    resolveChatCorsOrigin("https://test.alfred.black"),
    "https://test.alfred.black",
  );
});

test("resolveChatCorsOrigin: strips any path/trailing slash to a bare origin", () => {
  assert.equal(
    resolveChatCorsOrigin("https://alfred.black/"),
    "https://alfred.black",
  );
  assert.equal(
    resolveChatCorsOrigin("https://alfred.black/some/path"),
    "https://alfred.black",
  );
});

test("resolveChatCorsOrigin: reflects the request origin when unconfigured", () => {
  assert.equal(resolveChatCorsOrigin(undefined), true);
  assert.equal(resolveChatCorsOrigin(""), true);
});

test("resolveChatCorsOrigin: passes a non-URL string through unchanged", () => {
  assert.equal(resolveChatCorsOrigin("not a url"), "not a url");
});

test("resolveGatewayTokenFromEnv: prefers the aligned OPENCLAW_GATEWAY_TOKEN", () => {
  assert.equal(
    resolveGatewayTokenFromEnv({
      OPENCLAW_GATEWAY_TOKEN: "good",
      HERMES_API_SERVER_KEY: "wrong",
    } as NodeJS.ProcessEnv),
    "good",
  );
});

test("resolveGatewayTokenFromEnv: falls back to HERMES_API_SERVER_KEY only when aligned token absent", () => {
  assert.equal(
    resolveGatewayTokenFromEnv({
      HERMES_API_SERVER_KEY: "legacy",
    } as NodeJS.ProcessEnv),
    "legacy",
  );
  assert.equal(resolveGatewayTokenFromEnv({} as NodeJS.ProcessEnv), "");
});
