/**
 * /channels — Slack card derivation tests. Mirrors telegramCardCore.test.ts.
 *
 * Covers:
 *   • the four visual states (unconfigured / starting / running / error)
 *   • workspace info round-trips on running state
 *   • Phase-2 options detection (hasOptions flag for allowed_users etc.)
 *   • isProbablyValidSlackBotToken / SlackAppToken accept + reject
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/slackCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveSlackCardState,
  isProbablyValidSlackBotToken,
  isProbablyValidSlackAppToken,
  type SlackStatus,
} from "./slackCardCore";

const BASE: SlackStatus = {
  configured: false,
  state: "unconfigured",
  error: null,
  workspace: {
    team: null,
    team_id: null,
    bot_user: null,
    bot_user_id: null,
    url: null,
  },
  allowed_users: "",
  home_channel: "",
  allowed_channels: "",
};

test("derive: unconfigured → setup state with available pill", () => {
  const s = deriveSlackCardState({ status: BASE });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.pill, "available");
  assert.equal(s.hasOptions, false);
  assert.match(s.description, /manifest/);
});

test("derive: configured_starting → spinner copy + starting pill", () => {
  const s = deriveSlackCardState({
    status: { ...BASE, configured: true, state: "configured_starting" },
  });
  assert.equal(s.pill, "starting");
  assert.match(s.description, /restarting/i);
});

test("derive: configured_running → team + bot handle, active pill", () => {
  const s = deriveSlackCardState({
    status: {
      ...BASE,
      configured: true,
      state: "configured_running",
      workspace: {
        team: "Acme Inc.",
        team_id: "T01ACME",
        bot_user: "alfred",
        bot_user_id: "U01ALFRED",
        url: "https://acme.slack.com/",
      },
    },
  });
  assert.equal(s.state, "configured_running");
  assert.equal(s.heading, "Connected as @alfred");
  assert.match(s.description, /Acme Inc\./);
  assert.equal(s.pill, "active");
  assert.equal(s.hasOptions, false, "no options set → hasOptions is false");
});

test("derive: configured_running with home_channel set → hasOptions true", () => {
  const s = deriveSlackCardState({
    status: {
      ...BASE,
      configured: true,
      state: "configured_running",
      workspace: {
        team: "Acme Inc.",
        team_id: "T01ACME",
        bot_user: "@alfred",
        bot_user_id: "U01ALFRED",
        url: "https://acme.slack.com/",
      },
      home_channel: "C09HOME",
    },
  });
  assert.equal(s.hasOptions, true);
});

test("derive: error → verbatim message + error pill", () => {
  const s = deriveSlackCardState({
    status: {
      ...BASE,
      configured: true,
      state: "error",
      error: "invalid_auth",
    },
  });
  assert.equal(s.description, "invalid_auth");
  assert.equal(s.pill, "error");
});

test("derive: error with empty error string → falls back to default message", () => {
  const s = deriveSlackCardState({
    status: { ...BASE, configured: true, state: "error", error: "" },
  });
  assert.match(s.description, /tokens.*try again/i);
});

test("isProbablyValidSlackBotToken: accepts xoxb-…, rejects everything else", () => {
  assert.equal(
    isProbablyValidSlackBotToken("xoxb-1234567890-abcd1234EFGH"),
    true,
  );
  assert.equal(isProbablyValidSlackBotToken("  xoxb-1234567890-abcd1234EFGH  "), true);
  assert.equal(isProbablyValidSlackBotToken("xoxp-not-a-bot-token"), false);
  assert.equal(isProbablyValidSlackBotToken("xapp-not-the-right-prefix"), false);
  assert.equal(isProbablyValidSlackBotToken("xoxb-tooshort"), true); // {8,} allows short tails
  assert.equal(isProbablyValidSlackBotToken("xoxb-"), false, "empty tail rejects");
  assert.equal(isProbablyValidSlackBotToken(""), false);
});

test("isProbablyValidSlackAppToken: accepts xapp-…, rejects everything else", () => {
  assert.equal(
    isProbablyValidSlackAppToken("xapp-1-A1B2C3D4-9876543210-secret"),
    true,
  );
  assert.equal(isProbablyValidSlackAppToken("xoxb-bot-token-not-app"), false);
  assert.equal(isProbablyValidSlackAppToken("xapp-"), false);
  assert.equal(isProbablyValidSlackAppToken(""), false);
});
