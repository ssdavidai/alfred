/**
 * /channels — HA conversation setup-card helper tests (#111 PR3).
 *
 * The HA-conversation card is a documentation surface, not a runtime
 * state machine — so these tests cover the small pure-function surface
 * the card uses to validate input + summarise the persisted channel-
 * token rows that ctrl-api returns.
 *
 * Covers:
 *   • buildHacsRepoUrl is stable + points at the public custom repo
 *   • parseHaInstallId accepts uuid v4 + plain slug; rejects junk
 *   • summariseInstalledHaTokens groups + sorts + drops revoked rows
 *   • truncateInstallId keeps head + tail
 *   • formatLastUsed handles never / just-now / minutes / hours / days
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/haConversationCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildHacsRepoUrl,
  parseHaInstallId,
  summariseInstalledHaTokens,
  truncateInstallId,
  formatLastUsed,
  type ChannelTokenRow,
} from "./haConversationCardCore";

const FROZEN_NOW = new Date("2026-05-29T12:00:00Z");

function unixMsAgo(seconds: number): number {
  return FROZEN_NOW.getTime() - seconds * 1000;
}

// ---------------------------------------------------------------------------
// buildHacsRepoUrl — stable copyable URL
// ---------------------------------------------------------------------------

test("buildHacsRepoUrl: returns the public HACS custom-repo URL", () => {
  assert.equal(buildHacsRepoUrl(), "https://github.com/ssdavidai/alfred-ha");
});

// ---------------------------------------------------------------------------
// parseHaInstallId — accepts uuid v4 and plain slug
// ---------------------------------------------------------------------------

test("parseHaInstallId: accepts a HA-style uuid v4 (lowercased)", () => {
  const id = "63B96C8A-9D6F-4A7B-BCEF-1234567890AB";
  assert.equal(parseHaInstallId(id), "63b96c8a-9d6f-4a7b-bcef-1234567890ab");
});

test("parseHaInstallId: accepts a plain slug between 8 and 64 chars", () => {
  assert.equal(parseHaInstallId("home-kitchen"), "home-kitchen");
  assert.equal(parseHaInstallId("vacation_house_42"), "vacation_house_42");
  assert.equal(parseHaInstallId("a".repeat(64)), "a".repeat(64));
});

test("parseHaInstallId: rejects empty / whitespace / too-short / too-long", () => {
  assert.equal(parseHaInstallId(""), null);
  assert.equal(parseHaInstallId("   "), null);
  assert.equal(parseHaInstallId("short"), null); // 5 < 8
  assert.equal(parseHaInstallId("a".repeat(65)), null);
});

test("parseHaInstallId: rejects strings with whitespace or quotes", () => {
  assert.equal(parseHaInstallId("ha install"), null);
  assert.equal(parseHaInstallId("'home-kitchen'"), null);
  assert.equal(parseHaInstallId('"home-kitchen"'), null);
  // tabs/newlines and unicode punctuation are also out
  assert.equal(parseHaInstallId("home\tkitchen"), null);
  assert.equal(parseHaInstallId("home/kitchen"), null);
});

test("parseHaInstallId: trims surrounding whitespace before validating", () => {
  assert.equal(parseHaInstallId("  home-kitchen  "), "home-kitchen");
});

// ---------------------------------------------------------------------------
// summariseInstalledHaTokens — group + filter + sort
// ---------------------------------------------------------------------------

test("summariseInstalledHaTokens: empty/null/undefined → empty installs", () => {
  assert.deepEqual(summariseInstalledHaTokens(null), { installs: [] });
  assert.deepEqual(summariseInstalledHaTokens(undefined), { installs: [] });
  assert.deepEqual(summariseInstalledHaTokens([]), { installs: [] });
});

test("summariseInstalledHaTokens: groups ha-conversation rows + drops others", () => {
  const rows: ChannelTokenRow[] = [
    {
      id: "01JXAA",
      channel: "ha-conversation",
      label: "ha:home",
      scope: { haInstanceId: "home-kitchen" },
      created_at: unixMsAgo(60),
      last_used_at: unixMsAgo(30),
      last_used_ip: "100.64.1.5",
      rotated_from: null,
      revoked_at: null,
    },
    {
      id: "01JXBB",
      channel: "paperclip-heartbeat", // dropped: wrong channel
      label: "pcp:something",
      scope: null,
      created_at: unixMsAgo(120),
      last_used_at: null,
      last_used_ip: null,
      rotated_from: null,
      revoked_at: null,
    },
    {
      id: "01JXCC",
      channel: "ha-conversation",
      label: "ha:vacation",
      scope: { haInstanceId: "vacation_house" },
      created_at: unixMsAgo(15),
      last_used_at: null,
      last_used_ip: null,
      rotated_from: null,
      revoked_at: null,
    },
  ];
  const { installs } = summariseInstalledHaTokens(rows);
  assert.equal(installs.length, 2);
  // Newest-first: vacation (15s ago) before home (60s ago).
  assert.equal(installs[0].installId, "vacation_house");
  assert.equal(installs[0].label, "ha:vacation");
  assert.equal(installs[1].installId, "home-kitchen");
  assert.equal(installs[1].lastUsedIp, "100.64.1.5");
});

test("summariseInstalledHaTokens: drops revoked tokens (tombstones)", () => {
  const rows: ChannelTokenRow[] = [
    {
      id: "01JXAA",
      channel: "ha-conversation",
      label: "ha:revoked",
      scope: { haInstanceId: "revoked-install" },
      created_at: unixMsAgo(60),
      last_used_at: null,
      last_used_ip: null,
      rotated_from: null,
      revoked_at: unixMsAgo(10), // tombstone
    },
    {
      id: "01JXBB",
      channel: "ha-conversation",
      label: "ha:live",
      scope: { haInstanceId: "live-install" },
      created_at: unixMsAgo(30),
      last_used_at: null,
      last_used_ip: null,
      rotated_from: null,
      revoked_at: null,
    },
  ];
  const { installs } = summariseInstalledHaTokens(rows);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].installId, "live-install");
});

test("summariseInstalledHaTokens: falls back to row id when scope is missing", () => {
  const rows: ChannelTokenRow[] = [
    {
      id: "01JXAA",
      channel: "ha-conversation",
      label: null,
      scope: null,
      created_at: unixMsAgo(60),
      last_used_at: null,
      last_used_ip: null,
      rotated_from: null,
      revoked_at: null,
    },
    {
      id: "01JXBB",
      channel: "ha-conversation",
      label: "ha:malformed",
      scope: { foo: "bar" }, // no haInstanceId key
      created_at: unixMsAgo(30),
      last_used_at: null,
      last_used_ip: null,
      rotated_from: null,
      revoked_at: null,
    },
  ];
  const { installs } = summariseInstalledHaTokens(rows);
  assert.equal(installs.length, 2);
  assert.equal(installs[0].installId, "01JXBB");
  assert.equal(installs[1].installId, "01JXAA");
});

// ---------------------------------------------------------------------------
// truncateInstallId — UI helper
// ---------------------------------------------------------------------------

test("truncateInstallId: short ids pass through unchanged", () => {
  assert.equal(truncateInstallId("short"), "short");
  assert.equal(truncateInstallId("home-kitchen"), "home-kitchen");
});

test("truncateInstallId: long ids get head + ellipsis + tail", () => {
  const id = "63b96c8a-9d6f-4a7b-bcef-1234567890ab"; // 36 chars
  const out = truncateInstallId(id);
  assert.match(out, /…/);
  assert.ok(out.length <= 17, `truncated id length ${out.length} > 17`);
});

// ---------------------------------------------------------------------------
// formatLastUsed — relative-time helper
// ---------------------------------------------------------------------------

test("formatLastUsed: null → Never", () => {
  assert.equal(formatLastUsed(null, FROZEN_NOW), "Never");
});

test("formatLastUsed: < 60s → Just now", () => {
  assert.equal(formatLastUsed(unixMsAgo(5), FROZEN_NOW), "Just now");
});

test("formatLastUsed: minutes / hours / days", () => {
  assert.equal(formatLastUsed(unixMsAgo(120), FROZEN_NOW), "2 min ago");
  assert.equal(formatLastUsed(unixMsAgo(7200), FROZEN_NOW), "2 h ago");
  assert.equal(formatLastUsed(unixMsAgo(86_400 * 3), FROZEN_NOW), "3 d ago");
});

test("formatLastUsed: future timestamp (clock drift) → Just now", () => {
  assert.equal(formatLastUsed(unixMsAgo(-30), FROZEN_NOW), "Just now");
});
