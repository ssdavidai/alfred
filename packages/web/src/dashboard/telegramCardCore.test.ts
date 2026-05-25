/**
 * /channels — Telegram card derivation tests.
 *
 * Covers the contract laid out in the lane brief:
 *   • derive each of the 4 visual states
 *   • isProbablyValidBotToken accept + reject
 *   • relativeTimeFromIso for just now / N min / N hours / N days
 *
 * Run with:  cd packages/web && npx tsx --test src/dashboard/telegramCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveTelegramCardState,
  isProbablyValidBotToken,
  relativeTimeFromIso,
  type TelegramStatus,
} from "./telegramCardCore";

const BASE: TelegramStatus = {
  configured: false,
  bot_handle: null,
  last_message_at: null,
  state: "unconfigured",
  error: null,
};

test("derive: unconfigured → setup state + BotFather hint", () => {
  const s = deriveTelegramCardState({ status: BASE });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.primaryAction, "Save token");
  assert.equal(s.showBotFatherHint, true);
  assert.equal(s.pill, "available");
});

test("derive: configured_starting → spinner copy, no actions", () => {
  const s = deriveTelegramCardState({
    status: { ...BASE, configured: true, state: "configured_starting" },
  });
  assert.equal(s.primaryAction, null);
  assert.deepEqual(s.secondaryActions, []);
  assert.equal(s.pill, "starting");
});

test("derive: configured_running → @handle + last_message_at + actions", () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const s = deriveTelegramCardState({
    status: {
      configured: true,
      bot_handle: "alfred_black_bot",
      last_message_at: oneHourAgo,
      state: "configured_running",
      error: null,
    },
  });
  assert.equal(s.heading, "Connected as @alfred_black_bot");
  assert.match(s.description, /1 hour ago/);
  assert.equal(s.primaryAction, "Pair this chat");
  assert.deepEqual(s.secondaryActions, ["Test connection", "Disconnect"]);
  assert.equal(s.pill, "active");
});

test("derive: error → verbatim message + Try again", () => {
  const s = deriveTelegramCardState({
    status: {
      configured: true,
      bot_handle: null,
      last_message_at: null,
      state: "error",
      error: "401 Unauthorized — token rejected by Telegram",
    },
  });
  assert.equal(s.description, "401 Unauthorized — token rejected by Telegram");
  assert.equal(s.primaryAction, "Try again");
  assert.equal(s.pill, "error");
});

// 9-digit id + 35-char secret = the canonical BotFather token shape.
const GOOD_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345678";

test("isProbablyValidBotToken: accepts canonical shape, rejects malformed", () => {
  assert.equal(isProbablyValidBotToken(GOOD_TOKEN), true);
  assert.equal(
    isProbablyValidBotToken("987654321:ABC-DEF1234ghIkl-zyx57W2v1u123ew_X1"),
    true,
  );
  assert.equal(isProbablyValidBotToken(`  ${GOOD_TOKEN}  `), true);
  assert.equal(isProbablyValidBotToken("nope"), false);
  assert.equal(isProbablyValidBotToken("123456789:tooShort"), false);
  assert.equal(isProbablyValidBotToken(""), false);
});

test("relativeTimeFromIso: just now / N min / N hours / N days", () => {
  const now = new Date("2026-05-25T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(relativeTimeFromIso(at(10_000), now), "just now");
  assert.equal(relativeTimeFromIso(at(7 * 60_000), now), "7 min ago");
  assert.equal(relativeTimeFromIso(at(60 * 60_000), now), "1 hour ago");
  assert.equal(relativeTimeFromIso(at(5 * 60 * 60_000), now), "5 hours ago");
  assert.equal(relativeTimeFromIso(at(86_400_000), now), "1 day ago");
  assert.equal(relativeTimeFromIso(at(3 * 86_400_000), now), "3 days ago");
  assert.equal(relativeTimeFromIso("not-a-date"), "unknown");
});
