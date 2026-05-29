// channel_tokens — the shared per-channel bearer-token surface (#111 PR1).
//
// What's under test
// -----------------
// The DB helpers (mintChannelToken / listChannelTokens / revokeChannelToken /
// rotateChannelToken / validateChannelToken) and the four HTTP routes
// (POST /channel-tokens/mint, GET /channel-tokens, POST /:id/revoke,
//  POST /:id/rotate). The auth side (channelTokenBearer) is exercised in
// channels_ha.test.ts; here we focus on the table contract.
//
// Coverage:
//   1. Migration creates channel_tokens at user_version=3.
//   2. mintChannelToken: returns the raw token ONCE; persists sha256(raw).
//   3. mintChannelToken: subsequent mint on same channel returns a different
//      raw token (entropy + fresh ULID).
//   4. mintChannelToken: HA channel prefixes raw with `ha_`.
//   5. listChannelTokens: returns the public-safe view (no raw, no hash).
//   6. revokeChannelToken: sets revoked_at; subsequent validateChannelToken
//      returns null on the revoked token.
//   7. validateChannelToken: bumps last_used_at + last_used_ip.
//   8. validateChannelToken: cross-channel use of a valid token is rejected.
//   9. rotateChannelToken: mints a new token; rotated_from points at the
//      old; old token still validates until separately revoked.
//  10. Route POST /mint validates channel against KNOWN_CHANNELS.
//  11. Route GET /channel-tokens?channel=… requires the channel query.
//  12. Route POST /:id/revoke is idempotent.
//  13. Route POST /:id/rotate echoes the rotated_from.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channel-tokens-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const {
  mintChannelToken,
  listChannelTokens,
  revokeChannelToken,
  rotateChannelToken,
  validateChannelToken,
  hashToken,
} = await import("../src/db/channelTokens.js");
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerChannelTokenRoutes } = await import(
  "../src/api/routes/channel_tokens.js"
);
registerChannelTokenRoutes();

async function invokeRoute(
  method: string,
  p: string,
  opts: { body?: unknown; query?: string; params?: Record<string, string> } = {},
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    setHeader() {},
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { method, url: p, headers: {} } as any,
      res,
      params: opts.params ?? m!.params,
      body: opts.body,
      query: new URLSearchParams(opts.query ?? ""),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

function userVersion(): number {
  return (
    getStateDb().prepare("PRAGMA user_version").get() as {
      user_version: number;
    }
  ).user_version;
}

function clearChannelTokens(): void {
  getStateDb().exec("DELETE FROM channel_tokens");
}

describe("channel_tokens — DB helpers (#111 PR1)", () => {
  beforeEach(() => {
    clearChannelTokens();
  });

  it("migration creates the channel_tokens table at user_version >= 3", () => {
    assert.ok(userVersion() >= 3, "user_version must be at least 3");
    const tables = (
      getStateDb()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='channel_tokens'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    assert.deepEqual(tables, ["channel_tokens"]);
  });

  it("mintChannelToken returns the raw token; persists sha256(raw)", () => {
    const { raw, meta } = mintChannelToken(getStateDb(), {
      channel: "ha-conversation",
      label: "ha:test-uuid-1",
      scope: { haInstanceId: "test-uuid-1" },
    });
    assert.ok(raw.startsWith("ha_"), "HA channel raw token must use ha_ prefix");
    assert.equal(raw.length, 3 + 48, "raw token = prefix + 48 hex chars");
    assert.equal(meta.channel, "ha-conversation");
    assert.equal(meta.label, "ha:test-uuid-1");
    assert.deepEqual(meta.scope, { haInstanceId: "test-uuid-1" });
    assert.equal(meta.revoked_at, null);
    // The row in the DB must carry sha256(raw), not raw itself.
    const stored = getStateDb()
      .prepare("SELECT token_hash FROM channel_tokens WHERE id = ?")
      .get(meta.id) as { token_hash: string } | undefined;
    assert.ok(stored, "row exists");
    assert.equal(stored!.token_hash, hashToken(raw));
    // Raw must NOT appear in the DB at all.
    const stillRaw = getStateDb()
      .prepare("SELECT COUNT(*) AS n FROM channel_tokens WHERE token_hash = ?")
      .get(raw) as { n: number };
    assert.equal(stillRaw.n, 0, "raw token must not appear as any token_hash");
  });

  it("subsequent mint on same channel returns a different raw token", () => {
    const a = mintChannelToken(getStateDb(), { channel: "ha-conversation" });
    const b = mintChannelToken(getStateDb(), { channel: "ha-conversation" });
    assert.notEqual(a.raw, b.raw, "two mints must differ");
    assert.notEqual(a.meta.id, b.meta.id, "two mints must have different ULIDs");
  });

  it("listChannelTokens returns the public-safe view (no raw, no hash)", () => {
    mintChannelToken(getStateDb(), { channel: "ha-conversation" });
    mintChannelToken(getStateDb(), { channel: "ha-conversation" });
    mintChannelToken(getStateDb(), { channel: "ha-voice" });
    const haTokens = listChannelTokens(getStateDb(), "ha-conversation");
    assert.equal(haTokens.length, 2, "two ha-conversation tokens");
    for (const t of haTokens) {
      assert.equal(
        (t as Record<string, unknown>).token_hash,
        undefined,
        "token_hash never appears on the public view",
      );
      assert.equal(t.channel, "ha-conversation");
    }
    const haVoice = listChannelTokens(getStateDb(), "ha-voice");
    assert.equal(haVoice.length, 1, "ha-voice scoping works");
  });

  it("revokeChannelToken sets revoked_at; validateChannelToken rejects after", () => {
    const { raw, meta } = mintChannelToken(getStateDb(), {
      channel: "ha-conversation",
    });
    const before = validateChannelToken(getStateDb(), "ha-conversation", raw);
    assert.ok(before, "active token validates before revoke");
    const revoked = revokeChannelToken(getStateDb(), meta.id);
    assert.ok(revoked && revoked.revoked_at, "revoked_at populated");
    const after = validateChannelToken(getStateDb(), "ha-conversation", raw);
    assert.equal(after, null, "revoked token no longer validates");
    // List with includeRevoked sees the tombstone.
    const withRevoked = listChannelTokens(getStateDb(), "ha-conversation", {
      includeRevoked: true,
    });
    assert.ok(
      withRevoked.find((t) => t.id === meta.id && t.revoked_at),
      "revoked row is visible with includeRevoked=true",
    );
    // Active list excludes it.
    const active = listChannelTokens(getStateDb(), "ha-conversation");
    assert.equal(active.length, 0);
  });

  it("validateChannelToken bumps last_used_at + last_used_ip", () => {
    const { raw, meta } = mintChannelToken(getStateDb(), {
      channel: "ha-conversation",
    });
    assert.equal(meta.last_used_at, null);
    const v = validateChannelToken(getStateDb(), "ha-conversation", raw, {
      ip: "10.0.0.7",
    });
    assert.ok(v, "validates");
    assert.ok(v!.last_used_at, "last_used_at bumped");
    assert.equal(v!.last_used_ip, "10.0.0.7");
  });

  it("validateChannelToken refuses cross-channel use of a valid token", () => {
    const { raw } = mintChannelToken(getStateDb(), {
      channel: "ha-conversation",
    });
    // Same raw token, wrong channel name -> null.
    const v = validateChannelToken(getStateDb(), "ha-voice", raw);
    assert.equal(v, null);
  });

  it("rotateChannelToken: new token points at old via rotated_from", () => {
    const { raw: oldRaw, meta: oldMeta } = mintChannelToken(getStateDb(), {
      channel: "ha-conversation",
      label: "ha:abc",
      scope: { haInstanceId: "abc" },
    });
    const next = rotateChannelToken(getStateDb(), oldMeta.id);
    assert.ok(next, "rotation succeeds");
    assert.notEqual(next!.raw, oldRaw);
    assert.equal(next!.meta.rotated_from, oldMeta.id);
    assert.equal(next!.meta.label, "ha:abc", "label is carried forward");
    assert.deepEqual(
      next!.meta.scope,
      { haInstanceId: "abc" },
      "scope is carried forward",
    );
    // Old token still validates until separately revoked — the caller
    // decides when to flip the switch.
    const stillValid = validateChannelToken(
      getStateDb(),
      "ha-conversation",
      oldRaw,
    );
    assert.ok(stillValid, "old raw still valid pre-revoke");
  });
});

describe("channel_tokens — HTTP routes (#111 PR1)", () => {
  beforeEach(() => {
    clearChannelTokens();
  });

  it("POST /mint validates channel against KNOWN_CHANNELS", async () => {
    const bad = await invokeRoute("POST", "/api/v1/channel-tokens/mint", {
      body: { channel: "bogus" },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.payload.error.code, "VALIDATION_ERROR");
  });

  it("POST /mint returns the raw token in the response, exactly once", async () => {
    const r = await invokeRoute("POST", "/api/v1/channel-tokens/mint", {
      body: {
        channel: "ha-conversation",
        label: "ha:home-uuid",
        scope: { haInstanceId: "home-uuid" },
      },
    });
    assert.equal(r.status, 201);
    assert.ok(
      r.payload.token.startsWith("ha_"),
      "HA channel mint returns ha_-prefixed raw",
    );
    assert.equal(r.payload.meta.channel, "ha-conversation");
    assert.equal(r.payload.meta.label, "ha:home-uuid");
    // Listing must NOT echo the raw back.
    const list = await invokeRoute("GET", "/api/v1/channel-tokens", {
      query: "channel=ha-conversation",
    });
    assert.equal(list.status, 200);
    assert.equal(list.payload.tokens.length, 1);
    assert.equal(
      list.payload.tokens[0].token,
      undefined,
      "list response never carries raw token",
    );
    assert.equal(
      list.payload.tokens[0].token_hash,
      undefined,
      "list response never carries token_hash",
    );
  });

  it("GET /channel-tokens requires channel=…", async () => {
    const r = await invokeRoute("GET", "/api/v1/channel-tokens");
    assert.equal(r.status, 400);
    assert.equal(r.payload.error.code, "VALIDATION_ERROR");
  });

  it("POST /:id/revoke is idempotent", async () => {
    const mint = await invokeRoute("POST", "/api/v1/channel-tokens/mint", {
      body: { channel: "ha-conversation" },
    });
    const id = mint.payload.meta.id;
    const first = await invokeRoute(
      "POST",
      "/api/v1/channel-tokens/:id/revoke",
      { params: { id } },
    );
    assert.equal(first.status, 200);
    assert.ok(first.payload.meta.revoked_at);
    const firstRevokedAt = first.payload.meta.revoked_at;
    // Second revoke: still 200, same revoked_at (idempotent).
    const second = await invokeRoute(
      "POST",
      "/api/v1/channel-tokens/:id/revoke",
      { params: { id } },
    );
    assert.equal(second.status, 200);
    assert.equal(second.payload.meta.revoked_at, firstRevokedAt);
  });

  it("POST /:id/rotate returns the new raw token + rotated_from", async () => {
    const mint = await invokeRoute("POST", "/api/v1/channel-tokens/mint", {
      body: { channel: "ha-conversation" },
    });
    const oldId = mint.payload.meta.id;
    const rot = await invokeRoute(
      "POST",
      "/api/v1/channel-tokens/:id/rotate",
      { params: { id: oldId } },
    );
    assert.equal(rot.status, 201);
    assert.ok(rot.payload.token.startsWith("ha_"));
    assert.equal(rot.payload.rotated_from, oldId);
    assert.equal(rot.payload.meta.rotated_from, oldId);
    assert.notEqual(rot.payload.meta.id, oldId);
  });
});
