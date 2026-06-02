// #206 Lane IV — adapter-side identity override application.
//
// Each outbound channel adapter (telegram / slack / sms / channelsEmail)
// consumes `resolveChannelIdentity(db, profile_slug, channel_kind)` from
// Lane I (`packages/ctrl/src/db/channelIdentity.ts`) at send time and
// applies the override where the protocol supports it.
//
// These tests pin the SHAPE of the outbound payload each adapter builds
// given an override row — without firing any real third-party call. The
// adapters expose pure-function build helpers (`buildTelegramIdentityCalls`,
// `buildSlackPostMessagePayload`, `buildSmsIdentityIgnoredLogLine`,
// `buildEmailSendPayload`) precisely so the test surface stays narrow.
//
// What the test guarantees:
//   1. Each adapter, given a mock override row, builds the right payload.
//   2. No override row (`null`) → adapters preserve pre-#206 behaviour.
//   3. Reserved profile (`main` / `workers` / `heavy` / `codex-builder`)
//      → no override applied (defensive — Lane I refuses to write the row).
//
// The live wiring (resolveChannelIdentity → DB row → helper → fetch) is
// covered post-merge against home.alfred.black; see PR body.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── env setup BEFORE adapter modules load ────────────────────────────────
//
// The adapter modules (telegram/slack/sms/channelsEmail) transitively import
// `streams.ts`, which creates `${ALFRED_DATA_DIR}/streams` at module load.
// Set every needed env var to a tmp dir so the import chain succeeds in a
// clean test environment. ESM hoists static imports — we use top-level
// `await import(...)` below so this env setup runs first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channel-identity-apply-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_PATH = path.join(tmp, "vault");
fs.mkdirSync(process.env.VAULT_PATH, { recursive: true });
process.env.HERMES_CONFIG_DIR = path.join(tmp, "hermes-state", "profiles");
process.env.HERMES_STATE_DIR_CTRL_VIEW = path.join(tmp, "hermes-state");
fs.mkdirSync(process.env.HERMES_CONFIG_DIR, { recursive: true });

const { buildTelegramIdentityCalls } = await import(
  "../src/api/routes/telegram.js"
);
const { buildSlackPostMessagePayload } = await import(
  "../src/api/routes/slack.js"
);
const { buildSmsIdentityIgnoredLogLine } = await import(
  "../src/api/routes/sms.js"
);
const { buildEmailSendPayload } = await import(
  "../src/api/routes/channelsEmail.js"
);

// Fixture rows mirror Lane I's `ResolvedChannelIdentity` shape exactly.
const fullOverride = {
  display_name: "Cratchit",
  avatar_path: "/hermes-state/profiles/cratchit/avatars/telegram.png",
  avatar_mime: "image/png" as const,
};
const nameOnlyOverride = {
  display_name: "Cratchit",
  avatar_path: null,
  avatar_mime: null,
};
const avatarOnlyOverride = {
  display_name: null,
  avatar_path: "/hermes-state/profiles/cratchit/avatars/telegram.png",
  avatar_mime: "image/png" as const,
};

// ── Telegram ──────────────────────────────────────────────────────────────

describe("buildTelegramIdentityCalls", () => {
  const TOKEN = "1234567890:fake-bot-token-for-testing-only-not-real";

  it("emits setMyName URL when display_name is set + cache is empty", () => {
    const calls = buildTelegramIdentityCalls(TOKEN, nameOnlyOverride, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "setMyName");
    assert.ok(calls[0].url.startsWith(`https://api.telegram.org/bot${TOKEN}/setMyName?name=`));
    assert.ok(calls[0].url.endsWith(encodeURIComponent("Cratchit")));
  });

  it("emits setUserProfilePhotos URL when avatar_path is set + cache is empty", () => {
    const calls = buildTelegramIdentityCalls(TOKEN, avatarOnlyOverride, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "setUserProfilePhotos");
    assert.equal(
      calls[0].url,
      `https://api.telegram.org/bot${TOKEN}/setUserProfilePhotos`,
    );
    assert.equal(
      calls[0].avatar_path,
      "/hermes-state/profiles/cratchit/avatars/telegram.png",
    );
  });

  it("emits BOTH calls when both fields set + cache is empty", () => {
    const calls = buildTelegramIdentityCalls(TOKEN, fullOverride, null);
    assert.equal(calls.length, 2);
    const kinds = calls.map((c) => c.kind).sort();
    assert.deepEqual(kinds, ["setMyName", "setUserProfilePhotos"]);
  });

  it("emits NOTHING when the cache already holds the same override", () => {
    const calls = buildTelegramIdentityCalls(TOKEN, fullOverride, {
      display_name: fullOverride.display_name,
      avatar_path: fullOverride.avatar_path,
    });
    assert.equal(calls.length, 0);
  });

  it("emits ONLY the changed field when one half of the cache matches", () => {
    const calls = buildTelegramIdentityCalls(TOKEN, fullOverride, {
      display_name: fullOverride.display_name, // same
      avatar_path: "/old/path.png", // different
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "setUserProfilePhotos");
  });

  it("URL-encodes the display_name", () => {
    const calls = buildTelegramIdentityCalls(
      TOKEN,
      { display_name: "Bob & Co.", avatar_path: null, avatar_mime: null },
      null,
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("Bob%20%26%20Co."));
  });
});

// ── Slack ─────────────────────────────────────────────────────────────────

describe("buildSlackPostMessagePayload", () => {
  it("returns the bare payload when no override row exists (pre-#206 shape)", () => {
    const p = buildSlackPostMessagePayload("C123", "hello", null);
    assert.deepEqual(p, { channel: "C123", text: "hello", mrkdwn: true });
  });

  it("adds username when display_name is set", () => {
    const p = buildSlackPostMessagePayload(
      "C123",
      "hi",
      nameOnlyOverride,
      "cratchit",
    );
    assert.equal(p.username, "Cratchit");
    assert.equal(p.icon_url, undefined);
  });

  it("adds icon_url when SLACK_AVATAR_BASE_URL is set + avatar_path is set", () => {
    const prev = process.env.SLACK_AVATAR_BASE_URL;
    process.env.SLACK_AVATAR_BASE_URL = "https://home.alfred.black/_avatars";
    try {
      const p = buildSlackPostMessagePayload(
        "C123",
        "hi",
        fullOverride,
        "cratchit",
      );
      assert.equal(p.username, "Cratchit");
      assert.equal(
        p.icon_url,
        "https://home.alfred.black/_avatars/cratchit/telegram.png",
      );
    } finally {
      if (prev === undefined) delete process.env.SLACK_AVATAR_BASE_URL;
      else process.env.SLACK_AVATAR_BASE_URL = prev;
    }
  });

  it("skips icon_url + logs when SLACK_AVATAR_BASE_URL is not set", () => {
    const prev = process.env.SLACK_AVATAR_BASE_URL;
    delete process.env.SLACK_AVATAR_BASE_URL;
    try {
      const p = buildSlackPostMessagePayload(
        "C123",
        "hi",
        fullOverride,
        "cratchit",
      );
      assert.equal(p.username, "Cratchit");
      assert.equal(p.icon_url, undefined);
    } finally {
      if (prev !== undefined) process.env.SLACK_AVATAR_BASE_URL = prev;
    }
  });

  it("preserves the channel/text/mrkdwn fields when overriding", () => {
    const p = buildSlackPostMessagePayload(
      "C999",
      "*bold*",
      nameOnlyOverride,
      "cratchit",
    );
    assert.equal(p.channel, "C999");
    assert.equal(p.text, "*bold*");
    assert.equal(p.mrkdwn, true);
  });
});

// ── SMS ───────────────────────────────────────────────────────────────────

describe("buildSmsIdentityIgnoredLogLine", () => {
  it("returns null when no override exists", () => {
    const line = buildSmsIdentityIgnoredLogLine("cratchit", null);
    assert.equal(line, null);
  });

  it("returns a single log line when an override exists", () => {
    const line = buildSmsIdentityIgnoredLogLine("cratchit", fullOverride);
    assert.ok(line);
    assert.ok(line!.includes("[sms]"));
    assert.ok(line!.includes("cratchit"));
    assert.ok(line!.includes("display_name='Cratchit'"));
    assert.ok(line!.includes("avatar_path="));
  });

  it("returns null for reserved profiles (defensive)", () => {
    for (const slug of ["main", "workers", "heavy", "codex-builder"]) {
      assert.equal(
        buildSmsIdentityIgnoredLogLine(slug, fullOverride),
        null,
        `expected null for reserved profile '${slug}'`,
      );
    }
  });

  it("returns null when override row has both fields null (Lane I prunes these but defensive)", () => {
    const line = buildSmsIdentityIgnoredLogLine("cratchit", {
      display_name: null,
      avatar_path: null,
      avatar_mime: null,
    });
    assert.equal(line, null);
  });
});

// ── Email (AgentMail outbound) ────────────────────────────────────────────

describe("buildEmailSendPayload", () => {
  it("returns bare payload when no override exists (pre-#206 shape)", () => {
    const { payload, avatar_warning } = buildEmailSendPayload(
      "alice@example.com",
      "Hello",
      "Body text",
      null,
    );
    assert.deepEqual(payload, {
      to: ["alice@example.com"],
      subject: "Hello",
      text: "Body text",
    });
    assert.equal(avatar_warning, null);
  });

  it("adds from_name when display_name is set", () => {
    const { payload, avatar_warning } = buildEmailSendPayload(
      "alice@example.com",
      "Hello",
      "Body",
      nameOnlyOverride,
      "cratchit",
    );
    assert.equal(payload.from_name, "Cratchit");
    assert.equal(avatar_warning, null);
  });

  it("returns avatar_warning when avatar_path is set (informational only)", () => {
    const { payload, avatar_warning } = buildEmailSendPayload(
      "alice@example.com",
      "Hi",
      "Body",
      fullOverride,
      "cratchit",
    );
    assert.equal(payload.from_name, "Cratchit");
    assert.ok(avatar_warning);
    assert.ok(avatar_warning!.includes("informational only"));
    assert.ok(avatar_warning!.includes("cratchit"));
  });

  it("does NOT apply override for reserved profiles", () => {
    for (const slug of ["main", "workers", "heavy", "codex-builder"]) {
      const { payload, avatar_warning } = buildEmailSendPayload(
        "a@b.test",
        "S",
        "B",
        fullOverride,
        slug,
      );
      assert.equal(payload.from_name, undefined, `slug=${slug}`);
      assert.equal(avatar_warning, null, `slug=${slug}`);
    }
  });

  it("preserves to/subject/text exactly", () => {
    const { payload } = buildEmailSendPayload(
      "x@y.test",
      "Subj",
      "Body line\nwith\nbreaks",
      nameOnlyOverride,
      "cratchit",
    );
    assert.deepEqual(payload.to, ["x@y.test"]);
    assert.equal(payload.subject, "Subj");
    assert.equal(payload.text, "Body line\nwith\nbreaks");
  });
});

// ── Cross-cutting: no-override isolation ──────────────────────────────────

describe("no override row → exact pre-#206 payload shape", () => {
  it("Slack: no override → only {channel, text, mrkdwn}", () => {
    const p = buildSlackPostMessagePayload("C", "t", null);
    assert.deepEqual(Object.keys(p).sort(), ["channel", "mrkdwn", "text"]);
  });

  it("Email: no override → only {to, subject, text}", () => {
    const { payload, avatar_warning } = buildEmailSendPayload(
      "to@x",
      "s",
      "t",
      null,
    );
    assert.deepEqual(Object.keys(payload).sort(), ["subject", "text", "to"]);
    assert.equal(avatar_warning, null);
  });

  it("Telegram: no override row → buildTelegramIdentityCalls returns []", () => {
    // The adapter's `applyTelegramIdentity` short-circuits on
    // resolveChannelIdentity → null; here we exercise the pure-fn
    // contract: a null-ish override (both fields null) produces no calls.
    const calls = buildTelegramIdentityCalls(
      "1234567890:fake",
      { display_name: null, avatar_path: null, avatar_mime: null },
      null,
    );
    assert.equal(calls.length, 0);
  });

  it("SMS: no override row → no log line", () => {
    assert.equal(buildSmsIdentityIgnoredLogLine("cratchit", null), null);
  });
});
