/**
 * /channels — SMS card derivation tests. Mirrors slackCardCore.test.ts.
 *
 * Covers:
 *   • the four visual states (unconfigured / starting / running / error)
 *   • phone-number formatting + masked SID round-trip on running state
 *   • Phase-2 options detection (hasOptions flag for allowed_users)
 *   • isProbablyValidTwilioAccountSid accept + reject
 *   • isProbablyValidTwilioAuthToken accept + reject
 *
 * Phone numbers in fixtures use the NANPA reserved-for-fiction block
 * (+1-555-01XX) so this file is safe in a public OSS repo.
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/smsCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveSmsCardState,
  formatPhoneNumber,
  isProbablyValidTwilioAccountSid,
  isProbablyValidTwilioAuthToken,
  type SmsStatus,
} from "./smsCardCore";

const BASE: SmsStatus = {
  configured: false,
  state: "unconfigured",
  error: null,
  phone_number: null,
  account_sid_masked: null,
  allowed_users: "",
  allow_all: true,
};

test("derive: unconfigured → setup state with available pill", () => {
  const s = deriveSmsCardState({ status: BASE });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.pill, "available");
  assert.equal(s.hasOptions, false);
  assert.match(s.heading, /Set up SMS/);
  assert.match(s.description, /Twilio/);
});

test("derive: configured_starting → spinner copy + starting pill", () => {
  const s = deriveSmsCardState({
    status: { ...BASE, configured: true, state: "configured_starting" },
  });
  assert.equal(s.pill, "starting");
  assert.match(s.description, /restarting/i);
});

test("derive: configured_running → formatted phone + active pill", () => {
  const s = deriveSmsCardState({
    status: {
      ...BASE,
      configured: true,
      state: "configured_running",
      phone_number: "+15550100",
      account_sid_masked: "AC********************************",
    },
  });
  assert.equal(s.state, "configured_running");
  assert.equal(s.heading, "Connected as +1 555 0100");
  assert.equal(s.pill, "active");
  assert.equal(s.hasOptions, false, "no allowed_users → hasOptions is false");
});

test("derive: configured_running with allowed_users set → hasOptions true", () => {
  const s = deriveSmsCardState({
    status: {
      ...BASE,
      configured: true,
      state: "configured_running",
      phone_number: "+15550101",
      account_sid_masked: "AC********************************",
      allowed_users: "+15550102,+15550103",
    },
  });
  assert.equal(s.hasOptions, true);
});

test("derive: error → verbatim message + error pill", () => {
  const s = deriveSmsCardState({
    status: {
      ...BASE,
      configured: true,
      state: "error",
      error: "authenticate failed",
    },
  });
  assert.equal(s.description, "authenticate failed");
  assert.equal(s.pill, "error");
});

test("derive: error with empty error string → falls back to default message", () => {
  const s = deriveSmsCardState({
    status: { ...BASE, configured: true, state: "error", error: "" },
  });
  assert.match(s.description, /credentials.*try again/i);
});

test("derive: null status → unconfigured", () => {
  const s = deriveSmsCardState({ status: null });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.pill, "available");
});

test("formatPhoneNumber: E.164 +1NXXNXXXXXX → +1 NXX NXXXX", () => {
  assert.equal(formatPhoneNumber("+15550100"), "+1 555 0100");
  assert.equal(formatPhoneNumber("+15550101"), "+1 555 0101");
});

test("formatPhoneNumber: non-NANP falls back to raw input", () => {
  // We only format NANP shapes; everything else passes through.
  assert.equal(formatPhoneNumber("+447700900188"), "+447700900188");
  assert.equal(formatPhoneNumber(""), "");
  assert.equal(formatPhoneNumber(null as any), "");
});

test("isProbablyValidTwilioAccountSid: AC + 32 hex accepts, everything else rejects", () => {
  assert.equal(
    isProbablyValidTwilioAccountSid("AC" + "0".repeat(32)),
    true,
  );
  assert.equal(
    isProbablyValidTwilioAccountSid("  AC" + "0".repeat(32) + "  "),
    true,
  );
  // mixed-case hex is rejected — Twilio SIDs are lowercase hex.
  assert.equal(
    isProbablyValidTwilioAccountSid("AC" + "abcdef".padEnd(32, "0")),
    true,
  );
  assert.equal(
    isProbablyValidTwilioAccountSid("AC" + "ABCDEF".padEnd(32, "0")),
    false,
    "uppercase hex rejected",
  );
  assert.equal(isProbablyValidTwilioAccountSid("AC" + "0".repeat(31)), false);
  assert.equal(isProbablyValidTwilioAccountSid("SK" + "0".repeat(32)), false);
  assert.equal(isProbablyValidTwilioAccountSid("AC"), false);
  assert.equal(isProbablyValidTwilioAccountSid(""), false);
});

test("isProbablyValidTwilioAuthToken: 32 lower-hex accepts, everything else rejects", () => {
  assert.equal(isProbablyValidTwilioAuthToken("0".repeat(32)), true);
  assert.equal(isProbablyValidTwilioAuthToken("  " + "0".repeat(32) + "  "), true);
  assert.equal(isProbablyValidTwilioAuthToken("a".repeat(32)), true);
  assert.equal(
    isProbablyValidTwilioAuthToken("A".repeat(32)),
    false,
    "uppercase hex rejected",
  );
  assert.equal(isProbablyValidTwilioAuthToken("0".repeat(31)), false);
  assert.equal(isProbablyValidTwilioAuthToken("0".repeat(33)), false);
  assert.equal(isProbablyValidTwilioAuthToken("xoxb-secret"), false);
  assert.equal(isProbablyValidTwilioAuthToken(""), false);
});
