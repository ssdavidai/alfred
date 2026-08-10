// home-channel-routing.test.ts — #498 fail-closed delivery routing.
//
// Verifies resolveHomeChannelTarget() reads SLACK_HOME_CHANNEL /
// TELEGRAM_HOME_CHANNEL from the hermes profile .env, fails soft when absent,
// and that the Telegram DM guard in resolveDeliveryTarget() is intact.
import { mock, describe, it, before } from "node:test";
import assert from "node:assert/strict";

// ── node:fs mock (must precede any import of hermes-sessions) ───────────────

const envFiles: Map<string, string | null> = new Map();
const sessionsFiles: Map<string, string | null> = new Map();

const fsMock = {
  readFileSync: mock.fn((p: unknown, _enc?: unknown) => {
    const fp = String(p);
    if (fp.endsWith(".env")) {
      const c = envFiles.get(fp) ?? null;
      if (c === null) throw Object.assign(new Error(`ENOENT: ${fp}`), { code: "ENOENT" });
      return c;
    }
    if (fp.endsWith("sessions.json")) {
      const c = sessionsFiles.get(fp) ?? null;
      if (c === null) throw Object.assign(new Error(`ENOENT: ${fp}`), { code: "ENOENT" });
      return c;
    }
    throw Object.assign(new Error(`ENOENT: unexpected: ${fp}`), { code: "ENOENT" });
  }),
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: fsMock });

// ── Set test profile root & import ──────────────────────────────────────────

process.env.HERMES_CONFIG_DIR = "/test-profiles";
const ENV = "/test-profiles/main/.env";
const SESS = "/test-profiles/main/sessions/sessions.json";

const { resolveHomeChannelTarget, resolveDeliveryTarget } = await import(
  "../src/api/hermes-sessions.js"
);

// ── resolveHomeChannelTarget ─────────────────────────────────────────────────

describe("resolveHomeChannelTarget", () => {
  before(() => sessionsFiles.set(SESS, "{}"));

  it("returns Slack home channel when SLACK_HOME_CHANNEL is set", () => {
    envFiles.set(ENV, "SLACK_HOME_CHANNEL=C001ABCDEF\nFOO=bar\n");
    assert.deepEqual(resolveHomeChannelTarget(), { to: "C001ABCDEF", channel: "slack" });
  });

  it("returns Telegram home channel when only TELEGRAM_HOME_CHANNEL is set", () => {
    envFiles.set(ENV, "TELEGRAM_HOME_CHANNEL=12345678\n");
    assert.deepEqual(resolveHomeChannelTarget(), { to: "12345678", channel: "telegram" });
  });

  it("prefers Slack over Telegram when both are set", () => {
    envFiles.set(ENV, "SLACK_HOME_CHANNEL=C999\nTELEGRAM_HOME_CHANNEL=999\n");
    assert.deepEqual(resolveHomeChannelTarget(), { to: "C999", channel: "slack" });
  });

  it("returns undefined when neither home channel is set — fail-closed trigger", () => {
    envFiles.set(ENV, "SOME_OTHER_VAR=value\n");
    assert.equal(resolveHomeChannelTarget(), undefined);
  });

  it("returns undefined and does NOT throw when env file is absent (fails soft)", () => {
    envFiles.set(ENV, null as unknown as string);
    let threw = false;
    let result: ReturnType<typeof resolveHomeChannelTarget>;
    try { result = resolveHomeChannelTarget(); } catch { threw = true; }
    assert.equal(threw, false, "must not throw");
    assert.equal(result!, undefined);
  });

  it("strips surrounding quotes from env values", () => {
    envFiles.set(ENV, 'SLACK_HOME_CHANNEL="C-QUOTED"\n');
    assert.deepEqual(resolveHomeChannelTarget(), { to: "C-QUOTED", channel: "slack" });
  });
});

// ── resolveDeliveryTarget — Telegram DM guard still works ───────────────────

describe("resolveDeliveryTarget Telegram DM guard", () => {
  it("prefers a Telegram DM over a Telegram group even when group is more recent", () => {
    envFiles.set(ENV, ""); // no home channel needed here
    sessionsFiles.set(SESS, JSON.stringify({
      "tg-group": {
        session_id: "tg-group", platform: "telegram", chat_type: "group",
        updated_at: "2026-08-10T10:00:00Z",
        origin: { platform: "telegram", chat_id: "-100123456" },
      },
      "tg-dm": {
        session_id: "tg-dm", platform: "telegram", chat_type: "dm",
        updated_at: "2026-08-10T09:00:00Z",
        origin: { platform: "telegram", chat_id: "777888999" },
      },
    }));
    const t = resolveDeliveryTarget("telegram");
    assert.ok(t, "must resolve a target");
    assert.equal(t!.to, "777888999", "DM must win over group");
  });

  it("resolveDeliveryTarget(last) picks the most-recent Slack session regardless of chat_type — documenting the #498 bug that resolveHomeChannelTarget avoids", () => {
    sessionsFiles.set(SESS, JSON.stringify({
      "slack-group": {
        session_id: "slack-group", platform: "slack", chat_type: "channel",
        updated_at: "2026-08-10T12:00:00Z",
        origin: { platform: "slack", chat_id: "C-CLIENT-GRP" },
      },
      "slack-dm": {
        session_id: "slack-dm", platform: "slack", chat_type: "dm",
        updated_at: "2026-08-10T11:00:00Z",
        origin: { platform: "slack", chat_id: "D-PERSONAL-DM" },
      },
    }));
    // The Slack DM guard is Telegram-only; all Slack sessions are treated as
    // "DM-like", so order is by updated_at → group wins. This IS the bug.
    const t = resolveDeliveryTarget("last");
    assert.ok(t, "must resolve");
    assert.equal(t!.to, "C-CLIENT-GRP", "Slack group (most-recent) wins — the #498 bug");
  });
});
