/**
 * /channels — Tailscale card derivation tests.
 *
 * Covers the contract laid out in the lane brief (#109 PR3, 2026-05-29):
 *   • status-string formatter (heading + pill) for each of the 5 ctrl-api
 *     `state` values (disabled / starting / authenticating / connected /
 *     error) and the 4 derived view modes (disabled / connecting /
 *     connected / error)
 *   • paste-authkey-vs-device-auth derivation (`deriveConnectMode`):
 *     non-empty key → "authkey", empty/whitespace → "device-auth"
 *   • peer-count derivation when peers returns [] vs N vs undefined
 *   • redactAuthKey only ever leaks the first 6 characters
 *   • isProbablyValidAuthKey accept (both shapes) + reject
 *   • formatProbeTime: just now / N min / N hours / N days
 *
 * SECURITY: all fixture auth keys are synthetic placeholders prefixed
 * with FIXTUREONLY. Real `tskey-…` values never appear in this file.
 * The path is allowlisted in .gitguardian.yaml.
 *
 * Run with:  cd packages/web && npx tsx --test src/dashboard/tailscaleCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveTailscaleCardState,
  deriveConnectMode,
  derivePeerCount,
  formatProbeTime,
  isProbablyValidAuthKey,
  normalisePeer,
  redactAuthKey,
  type TailscaleStatus,
  type TailscalePeersResponse,
} from "./tailscaleCardCore";

const BASE: TailscaleStatus = {
  state: "disabled",
  tailnet_ip: null,
  tailnet_hostname: null,
  auth_url: null,
  authkey_used_at: null,
  last_status_probe_at: null,
  last_error: null,
  reason: null,
};

// ── Status formatter — one test per state ────────────────────────────────

test("derive: disabled → both CTAs + 'available' pill", () => {
  const s = deriveTailscaleCardState({ status: BASE });
  assert.equal(s.state, "disabled");
  assert.equal(s.mode, "disabled");
  assert.equal(s.pill, "available");
  assert.equal(s.heading, "Join your tailnet");
  assert.equal(s.connectChoice.primaryLabel, "Connect via auth key");
  assert.equal(s.connectChoice.secondaryLabel, "Use device auth URL");
  assert.equal(s.shouldPoll, false);
  assert.equal(s.showDisconnect, false);
  assert.equal(s.showRetry, false);
  assert.equal(s.showAuthUrl, false);
});

test("derive: starting → spinner copy + polls + no auth URL yet", () => {
  const s = deriveTailscaleCardState({
    status: { ...BASE, state: "starting" },
  });
  assert.equal(s.mode, "connecting");
  assert.equal(s.pill, "starting");
  assert.match(s.heading, /Starting Tailscale/i);
  assert.equal(s.shouldPoll, true);
  assert.equal(s.showAuthUrl, false);
  assert.equal(s.authUrl, null);
});

test("derive: authenticating with auth_url → URL shown + polls", () => {
  const s = deriveTailscaleCardState({
    status: {
      ...BASE,
      state: "authenticating",
      auth_url: "https://login.tailscale.com/a/FIXTUREONLY-deviceAuth-XYZ",
    },
  });
  assert.equal(s.mode, "connecting");
  assert.equal(s.pill, "starting");
  assert.equal(s.showAuthUrl, true);
  assert.equal(
    s.authUrl,
    "https://login.tailscale.com/a/FIXTUREONLY-deviceAuth-XYZ",
  );
  assert.equal(s.shouldPoll, true);
  assert.match(s.heading, /Open the device-auth URL/i);
});

test("derive: authenticating without auth_url → 'awaiting' copy, no URL block", () => {
  const s = deriveTailscaleCardState({
    status: { ...BASE, state: "authenticating", auth_url: null },
  });
  assert.equal(s.showAuthUrl, false);
  assert.equal(s.authUrl, null);
  assert.match(s.heading, /Awaiting device auth/i);
  assert.equal(s.shouldPoll, true);
});

test("derive: connected → hostname + IP + last-probe in description, no poll", () => {
  const now = new Date("2026-05-29T12:00:00Z");
  const probedAt = now.getTime() - 30_000; // 30s ago → "just now"
  const s = deriveTailscaleCardState({
    status: {
      ...BASE,
      state: "connected",
      tailnet_hostname: "home-alfred-black",
      tailnet_ip: "100.64.0.42",
      last_status_probe_at: probedAt,
    },
  });
  assert.equal(s.mode, "connected");
  assert.equal(s.pill, "active");
  assert.equal(s.heading, "Connected as home-alfred-black");
  assert.match(s.description, /100\.64\.0\.42/);
  assert.equal(s.shouldPoll, false);
  assert.equal(s.showDisconnect, true);
  assert.equal(s.showRetry, false);
});

test("derive: connected with only an IP → still renders sensibly", () => {
  const s = deriveTailscaleCardState({
    status: {
      ...BASE,
      state: "connected",
      tailnet_hostname: null,
      tailnet_ip: "100.64.0.42",
    },
  });
  assert.equal(s.heading, "Connected to your tailnet");
  assert.match(s.description, /100\.64\.0\.42/);
});

test("derive: error → verbatim last_error + retry button", () => {
  const s = deriveTailscaleCardState({
    status: {
      ...BASE,
      state: "error",
      last_error: "docker compose up tailscale failed: exit code 1",
      reason: "docker compose up tailscale failed: exit code 1",
    },
  });
  assert.equal(s.mode, "error");
  assert.equal(s.pill, "error");
  assert.match(s.description, /docker compose up tailscale failed/);
  assert.equal(s.errorMessage, "docker compose up tailscale failed: exit code 1");
  assert.equal(s.showRetry, true);
  assert.equal(s.showDisconnect, true);
});

test("derive: error falls back to a default message when last_error is empty", () => {
  const s = deriveTailscaleCardState({
    status: { ...BASE, state: "error", last_error: "", reason: null },
  });
  assert.equal(s.mode, "error");
  assert.match(s.description, /couldn't bring the Tailscale sidecar up/i);
  assert.equal(s.errorMessage, null);
});

test("derive: null/undefined status → safe disabled state", () => {
  const s1 = deriveTailscaleCardState({ status: null });
  const s2 = deriveTailscaleCardState({ status: undefined });
  assert.equal(s1.mode, "disabled");
  assert.equal(s2.mode, "disabled");
  assert.equal(s1.pill, "available");
});

// ── Connect-mode derivation (paste-authkey vs device-auth) ───────────────

test("deriveConnectMode: non-empty authkey → 'authkey'", () => {
  assert.equal(
    deriveConnectMode({ authkey: "tskey-auth-FIXTUREONLY-aaaaaa" }),
    "authkey",
  );
  assert.equal(
    deriveConnectMode({ authkey: "  tskey-auth-FIXTUREONLY-bbbbbb  " }),
    "authkey",
  );
});

test("deriveConnectMode: empty / whitespace / undefined → 'device-auth'", () => {
  assert.equal(deriveConnectMode({ authkey: "" }), "device-auth");
  assert.equal(deriveConnectMode({ authkey: "   " }), "device-auth");
  assert.equal(deriveConnectMode({ authkey: null }), "device-auth");
  assert.equal(deriveConnectMode({ authkey: undefined }), "device-auth");
  assert.equal(deriveConnectMode({}), "device-auth");
});

// ── isProbablyValidAuthKey ───────────────────────────────────────────────

test("isProbablyValidAuthKey: accepts both shapes, rejects malformed", () => {
  // Modern reusable shape: tskey-auth-<id>-<secret>.
  assert.equal(
    isProbablyValidAuthKey("tskey-auth-FIXTUREONLY-aaaaaaaaaa"),
    true,
  );
  // Older single-segment shape: tskey-<secret>.
  assert.equal(isProbablyValidAuthKey("tskey-FIXTUREONLYxxxxxxx"), true);
  // Surrounding whitespace is trimmed.
  assert.equal(
    isProbablyValidAuthKey("  tskey-auth-FIXTUREONLY-cccccccccc  "),
    true,
  );
  // Wrong prefix.
  assert.equal(isProbablyValidAuthKey("not-a-key"), false);
  // Too short after the prefix.
  assert.equal(isProbablyValidAuthKey("tskey-short"), false);
  // Empty / non-string.
  assert.equal(isProbablyValidAuthKey(""), false);
  // Disallowed characters (slash) reject.
  assert.equal(
    isProbablyValidAuthKey("tskey-auth-FIXTUREONLY/slash"),
    false,
  );
});

// ── redactAuthKey — only the first 6 chars may ever leak ─────────────────

test("redactAuthKey: only the first 6 chars survive, never the secret", () => {
  // Synthetic placeholder — never a real tskey.
  const fake = "tskey-auth-FIXTUREONLY-12345-deadbeefcafebabe";
  const red = redactAuthKey(fake);
  assert.equal(red, "tskey-…");
  assert.equal(red.includes("FIXTUREONLY"), false);
  assert.equal(red.includes("deadbeef"), false);
  // Very short input degrades to a single ellipsis token.
  assert.equal(redactAuthKey("abc"), "abc…");
  // Empty / non-string returns "".
  assert.equal(redactAuthKey(""), "");
  assert.equal(redactAuthKey(null), "");
  assert.equal(redactAuthKey(undefined), "");
  assert.equal(redactAuthKey("   "), "");
});

// ── Peer-count derivation ────────────────────────────────────────────────

test("derivePeerCount: empty peers array returns 0", () => {
  const r: TailscalePeersResponse = { peers: [] };
  assert.equal(derivePeerCount(r), 0);
});

test("derivePeerCount: N peers returns N", () => {
  const r: TailscalePeersResponse = {
    peers: [
      {
        id: "peer-1",
        hostname: "macbook",
        dns_name: "macbook.tail-scale.ts.net",
        os: "macOS",
        tailscale_ips: ["100.64.0.10"],
        online: true,
        last_seen: null,
      },
      {
        id: "peer-2",
        hostname: "phone",
        dns_name: "phone.tail-scale.ts.net",
        os: "iOS",
        tailscale_ips: ["100.64.0.11"],
        online: false,
        last_seen: "2026-05-29T11:00:00Z",
      },
    ],
  };
  assert.equal(derivePeerCount(r), 2);
});

test("derivePeerCount: null/undefined/reason-only response returns 0", () => {
  assert.equal(derivePeerCount(null), 0);
  assert.equal(derivePeerCount(undefined), 0);
  // `{reason: "..."}` is the fail-soft shape ctrl-api returns when the
  // probe failed — no `peers` array at all.
  const fail = { reason: "Tailscale is disabled" } as TailscalePeersResponse;
  assert.equal(derivePeerCount(fail), 0);
});

// ── normalisePeer — displayName fallback chain ───────────────────────────

test("normalisePeer: prefers hostname, falls back to dns_name, then IP", () => {
  assert.equal(
    normalisePeer({
      id: "1",
      hostname: "macbook",
      dns_name: "macbook.tail-scale.ts.net",
      os: "macOS",
      tailscale_ips: ["100.64.0.10"],
      online: true,
      last_seen: null,
    }).displayName,
    "macbook",
  );
  assert.equal(
    normalisePeer({
      id: "2",
      hostname: null,
      dns_name: "phone.tail-scale.ts.net",
      os: "iOS",
      tailscale_ips: ["100.64.0.11"],
      online: true,
      last_seen: null,
    }).displayName,
    "phone.tail-scale.ts.net",
  );
  assert.equal(
    normalisePeer({
      id: "3",
      hostname: null,
      dns_name: null,
      os: null,
      tailscale_ips: ["100.64.0.12"],
      online: false,
      last_seen: null,
    }).displayName,
    "100.64.0.12",
  );
  assert.equal(
    normalisePeer({
      id: "4",
      hostname: null,
      dns_name: null,
      os: null,
      tailscale_ips: [],
      online: false,
      last_seen: null,
    }).displayName,
    "unknown",
  );
});

// ── formatProbeTime ──────────────────────────────────────────────────────

test("formatProbeTime: just now / N min / N hours / N days", () => {
  const now = new Date("2026-05-29T12:00:00Z");
  const at = (ms: number) => now.getTime() - ms;
  assert.equal(formatProbeTime(at(10_000), now), "just now");
  assert.equal(formatProbeTime(at(7 * 60_000), now), "7 min ago");
  assert.equal(formatProbeTime(at(60 * 60_000), now), "1 hour ago");
  assert.equal(formatProbeTime(at(5 * 60 * 60_000), now), "5 hours ago");
  assert.equal(formatProbeTime(at(86_400_000), now), "1 day ago");
  assert.equal(formatProbeTime(at(3 * 86_400_000), now), "3 days ago");
  // Garbage input returns "".
  assert.equal(formatProbeTime(null), "");
  assert.equal(formatProbeTime(undefined), "");
  assert.equal(formatProbeTime(Number.NaN), "");
  assert.equal(formatProbeTime(0), "");
  assert.equal(formatProbeTime(-1), "");
});
