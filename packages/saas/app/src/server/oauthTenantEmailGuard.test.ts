/**
 * Unit tests for the tenant-email guard.
 *
 * Uses the built-in `node:test` runner (stable in Node 22+) so we don't need
 * to add a new dev dependency. Run with:
 *
 *   cd packages/saas/app
 *   npx tsx --test src/server/oauthTenantEmailGuard.test.ts
 *
 * or via the Makefile helper `make test-saas-unit`.
 *
 * The guard is the only backstop against the 2026-04-16 contamination bug
 * where a tenant got connected to the wrong Google account because the
 * operator's browser was signed into the wrong profile. Keep these tests
 * green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GoogleAccountMismatchError,
  isGoogleFamilyProvider,
  isGoogleFamilyToolkit,
  isGuardEnabled,
  verifyGoogleEmailMatch,
} from "./oauthTenantEmailGuard";

test("verifyGoogleEmailMatch: identical emails pass", () => {
  assert.equal(
    verifyGoogleEmailMatch("alfred@lumberjack.so", "alfred@lumberjack.so"),
    "alfred@lumberjack.so",
  );
});

test("verifyGoogleEmailMatch: case differences are ignored", () => {
  assert.equal(
    verifyGoogleEmailMatch("Alfred@Lumberjack.SO", "alfred@lumberjack.so"),
    "alfred@lumberjack.so",
  );
  assert.equal(
    verifyGoogleEmailMatch("alfred@lumberjack.so", "ALFRED@LUMBERJACK.SO"),
    "alfred@lumberjack.so",
  );
});

test("verifyGoogleEmailMatch: surrounding whitespace is trimmed", () => {
  assert.equal(
    verifyGoogleEmailMatch("  alfred@lumberjack.so  ", "alfred@lumberjack.so"),
    "alfred@lumberjack.so",
  );
});

test("verifyGoogleEmailMatch: different emails throw GoogleAccountMismatchError", () => {
  assert.throws(
    () => verifyGoogleEmailMatch("david@szabostuban.com", "alfred@lumberjack.so"),
    (err) => {
      assert.ok(err instanceof GoogleAccountMismatchError);
      assert.equal(err.code, "google_account_mismatch");
      assert.equal(err.connectedEmail, "david@szabostuban.com");
      assert.equal(err.expectedEmail, "alfred@lumberjack.so");
      return true;
    },
  );
});

test("verifyGoogleEmailMatch: empty connected email throws mismatch", () => {
  assert.throws(
    () => verifyGoogleEmailMatch("", "alfred@lumberjack.so"),
    GoogleAccountMismatchError,
  );
});

test("verifyGoogleEmailMatch: missing owner email throws a caller error", () => {
  assert.throws(
    () => verifyGoogleEmailMatch("alfred@lumberjack.so", ""),
    (err: unknown) => {
      // Should be a plain Error (caller contract violation), not a mismatch.
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof GoogleAccountMismatchError));
      return true;
    },
  );
});

test("isGoogleFamilyProvider: recognises the Google family", () => {
  for (const slug of [
    "google",
    "Google",
    "gmail",
    "googlecalendar",
    "google-calendar",
    "google_calendar",
    "googledrive",
    "googlemeet",
  ]) {
    assert.equal(isGoogleFamilyProvider(slug), true, `expected ${slug} to be google-family`);
  }
});

test("isGoogleFamilyProvider: rejects non-Google providers", () => {
  for (const slug of ["microsoft", "notion", "slack", "github", "linear", ""]) {
    assert.equal(isGoogleFamilyProvider(slug), false, `expected ${slug} NOT to be google-family`);
  }
});

test("isGoogleFamilyToolkit: covers composio toolkits", () => {
  assert.equal(isGoogleFamilyToolkit("gmail"), true);
  assert.equal(isGoogleFamilyToolkit("googlecalendar"), true);
  assert.equal(isGoogleFamilyToolkit("google_calendar"), true);
  assert.equal(isGoogleFamilyToolkit("youtube"), true);
  assert.equal(isGoogleFamilyToolkit("notion"), false);
  assert.equal(isGoogleFamilyToolkit("slack"), false);
  assert.equal(isGoogleFamilyToolkit(""), false);
});

test("isGuardEnabled: defaults to true when env is unset", () => {
  const saved = process.env.OAUTH_TENANT_EMAIL_GUARD_ENABLED;
  delete process.env.OAUTH_TENANT_EMAIL_GUARD_ENABLED;
  try {
    assert.equal(isGuardEnabled(), true);
  } finally {
    if (saved !== undefined) process.env.OAUTH_TENANT_EMAIL_GUARD_ENABLED = saved;
  }
});

test("isGuardEnabled: honours explicit disable values", () => {
  const saved = process.env.OAUTH_TENANT_EMAIL_GUARD_ENABLED;
  try {
    for (const v of ["false", "FALSE", "0", "off", "no"]) {
      process.env.OAUTH_TENANT_EMAIL_GUARD_ENABLED = v;
      assert.equal(isGuardEnabled(), false, `expected guard disabled for "${v}"`);
    }
    for (const v of ["true", "TRUE", "1", "on", "yes", "anything-else"]) {
      process.env.OAUTH_TENANT_EMAIL_GUARD_ENABLED = v;
      assert.equal(isGuardEnabled(), true, `expected guard enabled for "${v}"`);
    }
  } finally {
    if (saved !== undefined) {
      process.env.OAUTH_TENANT_EMAIL_GUARD_ENABLED = saved;
    } else {
      delete process.env.OAUTH_TENANT_EMAIL_GUARD_ENABLED;
    }
  }
});
