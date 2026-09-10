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
  onboardingGates,
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

// The startOnboarding gate decision — the regression for the bug where the
// Gmail connection gate ran for an Outlook onboarding (issue #758 follow-up).
test("Outlook onboarding does NOT require a Gmail connection", () => {
  const g = onboardingGates("outlook", "composio");
  assert.equal(g.requireGmailConnection, false); // the bug: this was true
  assert.equal(g.requireOutlookConnection, true);
  assert.equal(g.outlookNeedsComposio, false);
  assert.equal(g.misconfigured, false);
});

test("Gmail onboarding requires the Gmail connection, not Outlook", () => {
  const g = onboardingGates("gmail", "composio");
  assert.equal(g.requireGmailConnection, true);
  assert.equal(g.requireOutlookConnection, false);
  assert.equal(g.outlookNeedsComposio, false);
});

test("Outlook without Composio is refused, not run as Gmail", () => {
  const g = onboardingGates("outlook", "google");
  assert.equal(g.outlookNeedsComposio, true);
  assert.equal(g.requireGmailConnection, false); // never gate Gmail for Outlook
  assert.equal(g.requireOutlookConnection, false);
});

test("no auth path configured is provider-neutral misconfigured", () => {
  for (const p of ["gmail", "outlook"] as const) {
    const g = onboardingGates(p, "none");
    assert.equal(g.misconfigured, true);
    assert.equal(g.requireGmailConnection, false);
    assert.equal(g.requireOutlookConnection, false);
  }
});

test("Gmail in google mode gates nothing here (legacy OAuthCredential path)", () => {
  const g = onboardingGates("gmail", "google");
  assert.equal(g.requireGmailConnection, false); // google mode uses the token check, not this gate
  assert.equal(g.misconfigured, false);
  assert.equal(g.outlookNeedsComposio, false);
});
