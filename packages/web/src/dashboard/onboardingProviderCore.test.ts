/**
 * #758 — onboarding provider chooser core logic.
 *
 * Pure functions: provider availability by transport mode, marker/storage
 * encode-decode, error copy, toolkit mapping, active-status. No React, no
 * network.
 *
 * Run with:  cd packages/web && npx tsx --test src/dashboard/onboardingProviderCore.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONNECTED_MARKER,
  connectErrorCopy,
  connectRedirect,
  isActiveStatus,
  isProviderAvailable,
  parseConnectedMarker,
  providerOptions,
  toolkitForProvider,
} from "./onboardingProviderCore";

test("toolkit slug per provider", () => {
  assert.equal(toolkitForProvider("gmail"), "gmail");
  assert.equal(toolkitForProvider("outlook"), "outlook");
});

test("provider availability follows the transport mode", () => {
  // composio: both available
  let opts = providerOptions("composio");
  assert.equal(opts.find((o) => o.id === "gmail")!.available, true);
  assert.equal(opts.find((o) => o.id === "outlook")!.available, true);

  // google: gmail available, outlook NOT (no direct Microsoft path)
  opts = providerOptions("google");
  assert.equal(opts.find((o) => o.id === "gmail")!.available, true);
  assert.equal(opts.find((o) => o.id === "outlook")!.available, false);
  assert.match(opts.find((o) => o.id === "outlook")!.reason!, /Composio/);

  // none: neither
  opts = providerOptions("none");
  assert.equal(opts.find((o) => o.id === "gmail")!.available, false);
  assert.equal(opts.find((o) => o.id === "outlook")!.available, false);
});

test("isProviderAvailable convenience", () => {
  assert.equal(isProviderAvailable("outlook", "composio"), true);
  assert.equal(isProviderAvailable("outlook", "google"), false);
  assert.equal(isProviderAvailable("gmail", "google"), true);
});

test("connect redirect carries the marker and provider", () => {
  const url = connectRedirect("https://home.example", "outlook");
  assert.equal(url, `https://home.example/desk?onboarding=${CONNECTED_MARKER}&provider=outlook`);
});

test("parse marker round-trips", () => {
  assert.deepEqual(
    parseConnectedMarker("?onboarding=connected&provider=outlook"),
    { marked: true, provider: "outlook" },
  );
  assert.deepEqual(
    parseConnectedMarker("?onboarding=connected"),
    { marked: true, provider: null },
  );
  assert.deepEqual(parseConnectedMarker("?foo=bar"), { marked: false, provider: null });
  assert.deepEqual(parseConnectedMarker("?provider=yahoo"), { marked: false, provider: null });
});

test("error copy is provider-aware", () => {
  assert.match(connectErrorCopy("admin_consent", "outlook"), /Microsoft 365 administrator/);
  assert.match(connectErrorCopy("popup_blocked", "outlook"), /Microsoft/);
  assert.match(connectErrorCopy("popup_blocked", "gmail"), /Google/);
  assert.match(connectErrorCopy("cancelled", "outlook"), /didn't complete/);
});

test("active status is case-insensitive and null-safe", () => {
  assert.equal(isActiveStatus("ACTIVE"), true);
  assert.equal(isActiveStatus("active"), true);
  assert.equal(isActiveStatus("INITIATED"), false);
  assert.equal(isActiveStatus(null), false);
  assert.equal(isActiveStatus(undefined), false);
});
