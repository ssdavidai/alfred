// /api/v1/channels/tokens/* — canonical REST surface (#111 PR4).
//
// What's under test
// -----------------
// The five HTTP routes added by registerChannelsTokensRoutes:
//
//   POST   /api/v1/channels/tokens                  mint
//   GET    /api/v1/channels/tokens                  list
//   GET    /api/v1/channels/tokens/:id              get one
//   DELETE /api/v1/channels/tokens/:id              revoke
//   POST   /api/v1/channels/tokens/:id/rotate       rotate
//
// Companion to channel_tokens.test.ts (legacy /channel-tokens/* surface)
// and channels_ha_turn.test.ts (channelTokenBearer integration). The DB
// helpers are covered by channel_tokens.test.ts; this file focuses on
// the wire shape + the surrounding invariants of the new REST surface.

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-tokens-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const {
  mintChannelToken,
  validateChannelToken,
  hashToken,
} = await import("../src/db/channelTokens.js");
const { matchRoute } = await import("../src/api/server.js");
const { handleError, AuthError } = await import("../src/api/errors.js");
const { authenticate, setApiKey, _resetAuthForTests, channelTokenBearer } =
  await import("../src/api/auth.js");
const { registerChannelsTokensRoutes } = await import(
  "../src/api/routes/channels_tokens.js"
);
const { registerHaChannelRoutes } = await import(
  "../src/api/routes/channels_ha.js"
);
registerChannelsTokensRoutes();
// channels_ha registers POST /api/v1/channels/ha/turn — we use it to
// regression-test that channelTokenBearer 401s a revoked token through
// the new DELETE path.
registerHaChannelRoutes();

interface InvokeOpts {
  body?: unknown;
  query?: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

async function invokeRoute(
  method: string,
  p: string,
  opts: InvokeOpts = {},
): Promise<{ status: number; payload: any }> {
  const pathOnly = p.split("?")[0];
  // The route key for matchRoute is the literal pattern path
  // (`/api/v1/channels/tokens/:id`). For ":id"-style patterns the
  // helper falls back to `opts.params`. For concrete paths we let
  // matchRoute do the parameter extraction so the test catches a
  // typo in the route registration (the same failure mode the
  // channel_tokens.test.ts suite uses).
  const m = matchRoute(method, pathOnly);
  assert.ok(m, `${method} ${pathOnly} must be registered`);
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
      req: {
        method,
        url: p,
        headers: opts.headers ?? {},
        socket: { remoteAddress: "10.0.0.42" },
      } as any,
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

function clearTokens(): void {
  getStateDb().exec("DELETE FROM channel_tokens");
}

async function mintViaRoute(
  channel: string,
  label?: string,
  scope?: Record<string, unknown>,
): Promise<{ id: string; raw_token: string; payload: any }> {
  const r = await invokeRoute("POST", "/api/v1/channels/tokens", {
    body: { channel, label, scope },
  });
  assert.equal(r.status, 201, `mint should 201; got ${r.status}`);
  return { id: r.payload.id, raw_token: r.payload.raw_token, payload: r.payload };
}

describe("/api/v1/channels/tokens — operator surface (#111 PR4)", () => {
  beforeEach(() => {
    clearTokens();
  });

  // ---- mint ----------------------------------------------------------

  it("mint requires AAS_API_KEY (authenticate() rejects when no bearer)", () => {
    // The route handler itself does NOT call channelTokenBearer — the
    // master-key gate sits in front of every /api/v1/* path in
    // server.ts via authenticate(). Test the gate directly so we don't
    // need to spin up an http server: with the key set, an empty-
    // Authorization request is rejected exactly like the runtime
    // would reject the mint call.
    setApiKey("master-secret-test-key");
    try {
      assert.throws(
        () =>
          authenticate(
            { headers: {} } as any,
            { method: "POST", pathname: "/api/v1/channels/tokens" },
          ),
        (err: unknown) => err instanceof AuthError,
      );
      // Sanity: a request with the right master key passes.
      assert.doesNotThrow(() =>
        authenticate(
          {
            headers: { authorization: "Bearer master-secret-test-key" },
          } as any,
          { method: "POST", pathname: "/api/v1/channels/tokens" },
        ),
      );
    } finally {
      _resetAuthForTests();
    }
  });

  it("mint returns raw_token ONCE; subsequent reads never re-expose it", async () => {
    const mint = await mintViaRoute(
      "ha-conversation",
      "ha:home-uuid-1",
      { haInstanceId: "home-uuid-1" },
    );
    // The mint response carries raw_token (one-time field) + all the
    // public-safe fields the operator UI surfaces.
    assert.ok(
      typeof mint.payload.raw_token === "string" &&
        mint.payload.raw_token.length > 0,
      "raw_token present on mint",
    );
    assert.equal(mint.payload.channel, "ha-conversation");
    assert.equal(mint.payload.label, "ha:home-uuid-1");
    assert.deepEqual(mint.payload.scope_json, { haInstanceId: "home-uuid-1" });
    assert.ok(mint.payload.id, "id present");
    assert.ok(
      typeof mint.payload.created_at === "number",
      "created_at present",
    );
    // GET /:id — raw_token MUST NOT come back.
    const one = await invokeRoute(
      "GET",
      `/api/v1/channels/tokens/${mint.id}`,
    );
    assert.equal(one.status, 200);
    assert.equal(
      one.payload.raw_token,
      undefined,
      "GET /:id never re-exposes raw_token",
    );
    assert.equal(
      one.payload.token,
      undefined,
      "GET /:id never re-exposes a legacy `token` field either",
    );
  });

  it("response shapes NEVER include token_hash", async () => {
    await mintViaRoute("ha-conversation", "ha:a");
    await mintViaRoute("ha-voice", "voice:a");
    // mint response
    const mintB = await mintViaRoute("paperclip-heartbeat", "pcp:b");
    assert.equal(mintB.payload.token_hash, undefined);
    // list response — both filtered and unfiltered
    const list = await invokeRoute("GET", "/api/v1/channels/tokens", {
      query: "channel=ha-conversation",
    });
    assert.equal(list.status, 200);
    for (const t of list.payload.tokens) {
      assert.equal(t.token_hash, undefined);
      assert.equal(t.raw_token, undefined);
    }
    const all = await invokeRoute("GET", "/api/v1/channels/tokens");
    assert.equal(all.status, 200);
    for (const t of all.payload.tokens) {
      assert.equal(t.token_hash, undefined);
      assert.equal(t.raw_token, undefined);
    }
    // GET /:id
    const single = await invokeRoute(
      "GET",
      `/api/v1/channels/tokens/${mintB.id}`,
    );
    assert.equal(single.payload.token_hash, undefined);
  });

  // ---- list ----------------------------------------------------------

  it("list is filtered by `channel` query parameter", async () => {
    await mintViaRoute("ha-conversation");
    await mintViaRoute("ha-conversation");
    await mintViaRoute("ha-voice");
    const haConv = await invokeRoute("GET", "/api/v1/channels/tokens", {
      query: "channel=ha-conversation",
    });
    assert.equal(haConv.status, 200);
    assert.equal(haConv.payload.tokens.length, 2);
    for (const t of haConv.payload.tokens) {
      assert.equal(t.channel, "ha-conversation");
    }
    const haVoice = await invokeRoute("GET", "/api/v1/channels/tokens", {
      query: "channel=ha-voice",
    });
    assert.equal(haVoice.payload.tokens.length, 1);
    // No filter → spans every channel.
    const all = await invokeRoute("GET", "/api/v1/channels/tokens");
    assert.equal(all.payload.tokens.length, 3);
  });

  it("scope_json round-trips through mint + list + get", async () => {
    const scope = {
      haInstanceId: "kitchen-tablet",
      nested: { count: 3, allowed: true },
    };
    const m = await mintViaRoute("ha-conversation", "ha:kitchen", scope);
    assert.deepEqual(m.payload.scope_json, scope);
    const single = await invokeRoute(
      "GET",
      `/api/v1/channels/tokens/${m.id}`,
    );
    assert.deepEqual(single.payload.scope_json, scope);
    const list = await invokeRoute("GET", "/api/v1/channels/tokens", {
      query: "channel=ha-conversation",
    });
    const row = list.payload.tokens.find((t: any) => t.id === m.id);
    assert.deepEqual(row.scope_json, scope);
  });

  it("label persists across mint → list → get", async () => {
    const m = await mintViaRoute("ha-voice", "ha-voice:greatroom");
    assert.equal(m.payload.label, "ha-voice:greatroom");
    const one = await invokeRoute(
      "GET",
      `/api/v1/channels/tokens/${m.id}`,
    );
    assert.equal(one.payload.label, "ha-voice:greatroom");
  });

  // ---- revoke (DELETE) ----------------------------------------------

  it("DELETE /:id sets revoked_at and returns {ok, revoked_at}", async () => {
    const m = await mintViaRoute("ha-conversation");
    const before = await invokeRoute(
      "GET",
      `/api/v1/channels/tokens/${m.id}`,
    );
    assert.equal(before.payload.revoked_at, null);
    const del = await invokeRoute("DELETE", `/api/v1/channels/tokens/${m.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.payload.ok, true);
    assert.ok(
      typeof del.payload.revoked_at === "number" && del.payload.revoked_at > 0,
      "revoked_at populated",
    );
    const after = await invokeRoute(
      "GET",
      `/api/v1/channels/tokens/${m.id}`,
    );
    assert.equal(after.payload.revoked_at, del.payload.revoked_at);
  });

  it("a revoked token is rejected by channelTokenBearer (regression)", async () => {
    // End-to-end: mint via the new route, hit a real channel route
    // (POST /api/v1/channels/ha/turn) with the raw, revoke via the
    // new DELETE route, hit /turn again — second call must 401. This
    // catches a regression where revoke_at would be set on the wrong
    // row, or channelTokenBearer would cache.
    const m = await mintViaRoute(
      "ha-conversation",
      "ha:test",
      { haInstanceId: "test-uuid" },
    );
    // Direct channelTokenBearer probe — cheaper than invoking /turn,
    // and tests the auth path we actually care about.
    const stillValid = validateChannelToken(
      getStateDb(),
      "ha-conversation",
      m.raw_token,
    );
    assert.ok(stillValid, "raw token validates pre-revoke");
    const del = await invokeRoute("DELETE", `/api/v1/channels/tokens/${m.id}`);
    assert.equal(del.status, 200);
    const afterRevoke = validateChannelToken(
      getStateDb(),
      "ha-conversation",
      m.raw_token,
    );
    assert.equal(afterRevoke, null, "revoked token no longer validates");
    // And channelTokenBearer surfaces that as a 401:
    assert.throws(
      () =>
        channelTokenBearer(
          {
            headers: { authorization: `Bearer ${m.raw_token}` },
            socket: { remoteAddress: "10.0.0.99" },
          } as any,
          "ha-conversation",
        ),
      (err: unknown) => err instanceof AuthError,
    );
  });

  // ---- rotate -------------------------------------------------------

  it("rotate mints fresh row + sets rotated_from + carries label/scope", async () => {
    const original = await mintViaRoute(
      "ha-conversation",
      "ha:home",
      { haInstanceId: "home" },
    );
    const rot = await invokeRoute(
      "POST",
      "/api/v1/channels/tokens/:id/rotate",
      { params: { id: original.id } },
    );
    assert.equal(rot.status, 201);
    assert.ok(rot.payload.raw_token, "new raw_token in response");
    assert.notEqual(
      rot.payload.raw_token,
      original.raw_token,
      "rotated token differs",
    );
    assert.notEqual(rot.payload.id, original.id, "new id");
    assert.equal(rot.payload.rotated_from, original.id);
    assert.equal(rot.payload.channel, "ha-conversation");
    assert.equal(rot.payload.label, "ha:home", "label carried forward");
    assert.deepEqual(
      rot.payload.scope_json,
      { haInstanceId: "home" },
      "scope carried forward",
    );
    // Both old and new validate (60s grace — operator decides when to
    // revoke the old). We assert this directly via validateChannelToken
    // because the grace window predates an explicit DELETE on the old
    // row; channelTokenBearer is hash-lookup, not time-bound.
    const oldStill = validateChannelToken(
      getStateDb(),
      "ha-conversation",
      original.raw_token,
    );
    assert.ok(oldStill, "old token still valid during grace window");
    const newAlso = validateChannelToken(
      getStateDb(),
      "ha-conversation",
      rot.payload.raw_token,
    );
    assert.ok(newAlso, "new token valid");
    // After operator-controlled cutover (DELETE the old row), only the
    // new token validates.
    const del = await invokeRoute(
      "DELETE",
      `/api/v1/channels/tokens/${original.id}`,
    );
    assert.equal(del.status, 200);
    const oldAfter = validateChannelToken(
      getStateDb(),
      "ha-conversation",
      original.raw_token,
    );
    assert.equal(oldAfter, null, "old token rejected post-revoke");
    const newAfter = validateChannelToken(
      getStateDb(),
      "ha-conversation",
      rot.payload.raw_token,
    );
    assert.ok(newAfter, "new token still validates post-cutover");
  });

  it("last_used_at + last_used_ip are bumped on channelTokenBearer hit", async () => {
    const m = await mintViaRoute("ha-conversation");
    const before = await invokeRoute(
      "GET",
      `/api/v1/channels/tokens/${m.id}`,
    );
    assert.equal(before.payload.last_used_at, null);
    assert.equal(before.payload.last_used_ip, null);
    // Walk the channelTokenBearer path with a concrete remoteAddress.
    channelTokenBearer(
      {
        headers: { authorization: `Bearer ${m.raw_token}` },
        socket: { remoteAddress: "192.0.2.17" },
      } as any,
      "ha-conversation",
    );
    const after = await invokeRoute(
      "GET",
      `/api/v1/channels/tokens/${m.id}`,
    );
    assert.ok(
      typeof after.payload.last_used_at === "number" &&
        after.payload.last_used_at > 0,
      "last_used_at bumped",
    );
    assert.equal(after.payload.last_used_ip, "192.0.2.17");
  });

  // ---- validation / error shapes ------------------------------------

  it("mint with missing channel → 400 VALIDATION_ERROR", async () => {
    const r = await invokeRoute("POST", "/api/v1/channels/tokens", {
      body: { label: "no-channel" },
    });
    assert.equal(r.status, 400);
    assert.equal(r.payload.error.code, "VALIDATION_ERROR");
  });

  it("mint with unknown channel → 400 (only 3 channels are allowed)", async () => {
    const r = await invokeRoute("POST", "/api/v1/channels/tokens", {
      body: { channel: "made-up-channel", label: "x" },
    });
    assert.equal(r.status, 400);
    assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    assert.ok(
      /must be one of/.test(r.payload.error.message),
      "error message enumerates known channels",
    );
    // Triple-check the 3 known channels documented in the contract
    // mint without 400:
    for (const c of ["ha-conversation", "ha-voice", "paperclip-heartbeat"]) {
      const ok = await invokeRoute("POST", "/api/v1/channels/tokens", {
        body: { channel: c },
      });
      assert.equal(ok.status, 201, `channel=${c} should mint cleanly`);
    }
  });

  it("DELETE /:id on a non-existent id → 404", async () => {
    const r = await invokeRoute(
      "DELETE",
      "/api/v1/channels/tokens/01HZZZZZZZZZZZZZZZZZZZZZZZ",
      { params: { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" } },
    );
    assert.equal(r.status, 404);
    assert.equal(r.payload.error.code, "NOT_FOUND");
  });

  it("GET /:id on a non-existent id → 404", async () => {
    const r = await invokeRoute(
      "GET",
      "/api/v1/channels/tokens/01HZZZZZZZZZZZZZZZZZZZZZZZ",
      { params: { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" } },
    );
    assert.equal(r.status, 404);
    assert.equal(r.payload.error.code, "NOT_FOUND");
  });

  it("POST /:id/rotate on a non-existent id → 404", async () => {
    const r = await invokeRoute(
      "POST",
      "/api/v1/channels/tokens/01HZZZZZZZZZZZZZZZZZZZZZZZ/rotate",
      { params: { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" } },
    );
    assert.equal(r.status, 404);
  });

  it("mint persists the row as sha256(raw_token) — never the raw bytes", async () => {
    const m = await mintViaRoute("ha-conversation", "ha:hash-check");
    const row = getStateDb()
      .prepare(
        "SELECT token_hash FROM channel_tokens WHERE id = ?",
      )
      .get(m.id) as { token_hash: string } | undefined;
    assert.ok(row, "row exists");
    assert.equal(
      row!.token_hash,
      hashToken(m.raw_token),
      "stored hash is sha256(raw_token)",
    );
    // And the raw bytes never appear anywhere in the channel_tokens
    // table:
    const allRows = getStateDb()
      .prepare("SELECT * FROM channel_tokens")
      .all() as Array<Record<string, unknown>>;
    for (const r of allRows) {
      for (const v of Object.values(r)) {
        if (typeof v === "string") {
          assert.notEqual(
            v,
            m.raw_token,
            "raw_token must never appear verbatim in the DB",
          );
        }
      }
    }
  });

  after(() => {
    // Don't leak the master-key into other test files in this process.
    _resetAuthForTests();
  });
});
