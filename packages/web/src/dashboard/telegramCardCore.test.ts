/**
 * /channels — Telegram card derivation tests.
 *
 * Covers the contract laid out in the lane brief:
 *   • derive each of the 4 visual states (unconfigured / starting /
 *     running / error)
 *   • running-state branches on paired_chats: empty vs 1 vs many
 *   • isProbablyValidBotToken accept + reject
 *   • relativeTimeFromIso for just now / N min / N hours / N days
 *
 * The 2026-05-25 redesign dropped `primaryAction`/`secondaryActions` from
 * TelegramCardState (the card no longer offers a "Pair this chat" mint-a-
 * code surface — that subcommand never existed in hermes) and added
 * `pairedChats` + `showChatList` derived from the API's `paired_chats`.
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
  state: "unconfigured",
  error: null,
  paired_chats: [],
};

test("derive: unconfigured → setup state + BotFather hint", () => {
  const s = deriveTelegramCardState({ status: BASE });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.showBotFatherHint, true);
  assert.equal(s.showChatList, false);
  assert.equal(s.pill, "available");
});

test("derive: configured_starting → spinner copy, no chat list", () => {
  const s = deriveTelegramCardState({
    status: { ...BASE, configured: true, state: "configured_starting" },
  });
  assert.equal(s.showChatList, false);
  assert.equal(s.pill, "starting");
  assert.match(s.description, /restarting/i);
});

test("derive: configured_running with 0 paired chats → 'DM the bot' nudge", () => {
  const s = deriveTelegramCardState({
    status: {
      ...BASE,
      configured: true,
      bot_handle: "alfred_black_bot",
      state: "configured_running",
      paired_chats: [],
    },
  });
  assert.equal(s.heading, "Connected as @alfred_black_bot");
  assert.match(s.description, /DM @alfred_black_bot/);
  assert.equal(s.showChatList, false);
  assert.equal(s.pairedChats.length, 0);
  assert.equal(s.pill, "active");
});

test("derive: configured_running with 1 paired chat → shows chat list + 'add another' hint", () => {
  const s = deriveTelegramCardState({
    status: {
      ...BASE,
      configured: true,
      bot_handle: "@alfred_black_bot",
      state: "configured_running",
      paired_chats: [
        { id: "432094090", name: "David Szabo-Stuban", type: "dm" },
      ],
    },
  });
  assert.equal(s.showChatList, true);
  assert.equal(s.pairedChats.length, 1);
  assert.equal(s.pairedChats[0].name, "David Szabo-Stuban");
  assert.match(s.description, /Authorised for 1 chat/);
  assert.match(s.description, /from any other chat to add it/);
});

test("derive: configured_running with N paired chats → plural copy", () => {
  const s = deriveTelegramCardState({
    status: {
      ...BASE,
      configured: true,
      bot_handle: "@alfred_black_bot",
      state: "configured_running",
      paired_chats: [
        { id: 1, name: "Sir", type: "dm" },
        { id: 2, name: "Family group", type: "group" },
        { id: 3, name: null, type: null },
      ],
    },
  });
  assert.equal(s.pairedChats.length, 3);
  assert.equal(s.pairedChats[2].name, "chat 3");
  assert.match(s.description, /Authorised for 3 chats/);
});

test("derive: error → verbatim message + error pill", () => {
  const s = deriveTelegramCardState({
    status: {
      ...BASE,
      configured: true,
      state: "error",
      error: "401 Unauthorized — token rejected by Telegram",
    },
  });
  assert.equal(s.description, "401 Unauthorized — token rejected by Telegram");
  assert.equal(s.pill, "error");
  assert.equal(s.showChatList, false);
});

// 9-digit id + 35-char secret = the canonical BotFather token shape.
const GOOD_TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345678";
// Modern Telegram tokens commonly run longer (45+ chars after the colon).
// 2026-05-25: Sir's real token rejected by the stricter 35-exact rule —
// we now accept ≥30, open-ended (mirrors Hermes' own setup wizard regex).
const MODERN_TOKEN_46 =
  "8939474742:AAEa1B2c3D4e5F6g7H8i9J0k_lMnOpQrStUvWxYz-01234";

test("isProbablyValidBotToken: accepts canonical shape, rejects malformed", () => {
  assert.equal(isProbablyValidBotToken(GOOD_TOKEN), true);
  assert.equal(
    isProbablyValidBotToken("987654321:ABC-DEF1234ghIkl-zyx57W2v1u123ew_X1"),
    true,
  );
  // Modern long-form tokens must validate too.
  assert.equal(
    isProbablyValidBotToken(MODERN_TOKEN_46),
    true,
    "modern Telegram tokens (>35 char secret) must validate — Hermes accepts them",
  );
  // Surrounding whitespace is trimmed before validation.
  assert.equal(isProbablyValidBotToken(`  ${GOOD_TOKEN}  `), true);
  assert.equal(isProbablyValidBotToken("nope"), false);
  // ≥30 chars after the colon is the floor — 29 still rejects.
  assert.equal(
    isProbablyValidBotToken("123456789:" + "A".repeat(29)),
    false,
    "29-char secret is below the floor (need ≥30)",
  );
  assert.equal(isProbablyValidBotToken("123456789:tooShort"), false);
  assert.equal(isProbablyValidBotToken(""), false);
  // Secret with disallowed char (+, /, =) still rejects.
  assert.equal(
    isProbablyValidBotToken("123456789:" + "A".repeat(34) + "+"),
    false,
    "secret with + must reject — [A-Za-z0-9_-] only",
  );
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
