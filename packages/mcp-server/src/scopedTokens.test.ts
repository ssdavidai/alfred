// Tests for per-app scoped bearer tokens (mint + verify logic).
//
// Storage SQL is exercised live against the running container; here we cover
// the pure logic with a fake reader so the suite needs no sqlite flag.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";

import { mintScopedToken, verifyScopedToken, type ScopedTokenReader } from "./scopedTokens.js";
import type { ScopedTokenRow } from "./oauth/storage.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// A minimal in-memory ScopedTokenReader keyed by hash, tracking touches.
function fakeReader(rows: ScopedTokenRow[]) {
  const touched: Array<{ id: string; ts: number }> = [];
  const reader: ScopedTokenReader = {
    getScopedTokenByHash(hash) {
      return rows.find((r) => r.token_hash === hash) ?? null;
    },
    touchScopedToken(id, ts) {
      touched.push({ id, ts });
    },
  };
  return { reader, touched };
}

function row(over: Partial<ScopedTokenRow> & { token_hash: string; app_id: string }): ScopedTokenRow {
  return {
    id: "tok_test",
    prefix: "alf_x",
    label: "test",
    created_at: 1,
    last_used_at: null,
    revoked_at: null,
    ...over,
  };
}

// ─── mint ───────────────────────────────────────────────────────────────────

test("mintScopedToken · shape: alf_<app>_<random>, tok_ id, correct hash", () => {
  const m = mintScopedToken("execute");
  assert.ok(m.token.startsWith("alf_execute_"), `token should carry app prefix: ${m.token}`);
  assert.ok(m.id.startsWith("tok_"), "id should be a tok_ handle");
  assert.equal(m.token_hash, sha256(m.token), "hash must be sha256 of the raw token");
  assert.equal(m.prefix, m.token.slice(0, 16), "prefix is the first 16 chars");
  assert.ok(m.token.length > 30, "token should carry real entropy");
});

test("mintScopedToken · handles hyphenated app ids (paperclip-admin)", () => {
  const m = mintScopedToken("paperclip-admin");
  assert.ok(m.token.startsWith("alf_paperclip-admin_"));
});

test("mintScopedToken · two mints are distinct (token + id + hash)", () => {
  const a = mintScopedToken("sure");
  const b = mintScopedToken("sure");
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.token_hash, b.token_hash);
});

// ─── verify ─────────────────────────────────────────────────────────────────

test("verifyScopedToken · valid token for the right app → true, and touches last_used", () => {
  const m = mintScopedToken("execute");
  const { reader, touched } = fakeReader([row({ id: "tok_1", token_hash: m.token_hash, app_id: "execute" })]);
  assert.equal(verifyScopedToken(reader, "execute", m.token, 1000), true);
  assert.deepEqual(touched, [{ id: "tok_1", ts: 1000 }]);
});

test("verifyScopedToken · token bound to another app → false (no cross-app replay)", () => {
  const m = mintScopedToken("execute");
  const { reader, touched } = fakeReader([row({ token_hash: m.token_hash, app_id: "execute" })]);
  assert.equal(verifyScopedToken(reader, "sure", m.token, 1000), false);
  assert.equal(touched.length, 0, "a rejected token must not be touched");
});

test("verifyScopedToken · revoked token → false", () => {
  const m = mintScopedToken("sure");
  const { reader } = fakeReader([row({ token_hash: m.token_hash, app_id: "sure", revoked_at: 500 })]);
  assert.equal(verifyScopedToken(reader, "sure", m.token, 1000), false);
});

test("verifyScopedToken · unknown token → false", () => {
  const { reader } = fakeReader([]);
  assert.equal(verifyScopedToken(reader, "sure", mintScopedToken("sure").token, 1000), false);
});

test("verifyScopedToken · empty bearer → false (no lookup)", () => {
  let looked = false;
  const reader: ScopedTokenReader = {
    getScopedTokenByHash() { looked = true; return null; },
    touchScopedToken() {},
  };
  assert.equal(verifyScopedToken(reader, "sure", "", 1000), false);
  assert.equal(looked, false, "empty token should short-circuit before any lookup");
});
