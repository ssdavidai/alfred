/**
 * F76 — API-keys quick-start base URL. Must use the Wasp server host (api.
 * subdomain), strip a trailing slash, and never the dead /user-api base.
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/apiKeysCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { apiBaseUrl } from "./apiKeysCore";

test("apiBaseUrl: uses config.apiUrl (the api. subdomain) verbatim", () => {
  assert.equal(apiBaseUrl("https://api.alfred.black"), "https://api.alfred.black");
  assert.equal(apiBaseUrl("https://api.test.alfred.black"), "https://api.test.alfred.black");
});

test("apiBaseUrl: strips a trailing slash", () => {
  assert.equal(apiBaseUrl("https://api.alfred.black/"), "https://api.alfred.black");
});

test("apiBaseUrl: falls back to the prod api host when unset", () => {
  assert.equal(apiBaseUrl(undefined), "https://api.alfred.black");
  assert.equal(apiBaseUrl(""), "https://api.alfred.black");
});
