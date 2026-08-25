import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { anyProfileDegraded, deriveProfileViews } from "./codexProfilesCore";

// The payloads below are the real shapes observed on the fleet, not invented:
// a healthy tenant, and one whose three gateways answered 200 while every
// profile's token set was empty with refresh_token_reused.
const HEALTHY = {
  profiles: [
    { profile: "main", state: "ok", last_refresh: "2026-08-17T08:57:53.813568Z", error: null },
    { profile: "workers", state: "ok", last_refresh: "2026-08-17T08:57:53.813568Z", error: null },
    { profile: "heavy", state: "ok", last_refresh: "2026-08-17T08:57:53.813568Z", error: null },
  ],
};
const BROKEN = {
  profiles: [
    { profile: "main", state: "no_tokens", last_refresh: "2026-07-09T23:51:07Z", error: "refresh_token_reused" },
    { profile: "workers", state: "no_tokens", last_refresh: "2026-07-09T23:51:07Z", error: "refresh_token_reused" },
    { profile: "heavy", state: "no_tokens", last_refresh: "2026-07-09T23:51:07Z", error: "refresh_token_reused" },
  ],
};

describe("codexProfilesCore", () => {
  it("reports a healthy tenant as authenticated, with the refresh date", () => {
    const v = deriveProfileViews(HEALTHY);
    assert.equal(v.length, 3);
    assert.ok(v.every((r) => r.authenticated));
    assert.ok(v.every((r) => !r.needsAuth));
    assert.equal(v[0].label, "Authenticated");
    assert.equal(v[0].detail, "Last refreshed 2026-08-17");
    assert.equal(anyProfileDegraded(HEALTHY), false);
  });

  it("flags empty token sets as needing re-auth, and names the cause", () => {
    const v = deriveProfileViews(BROKEN);
    assert.ok(v.every((r) => !r.authenticated));
    assert.ok(v.every((r) => r.needsAuth));
    assert.equal(v[0].label, "Re-auth required");
    assert.match(v[0].detail, /refresh_token_reused/);
    assert.equal(anyProfileDegraded(BROKEN), true);
  });

  it("treats a stale-but-present token as degraded, not healthy", () => {
    // `error` keeps a token, so a naive check would call it fine. It is the
    // state a credential passes through on its way to dead — surface it.
    const p = { profiles: [{ profile: "main", state: "error", last_refresh: "2026-08-13T00:00:00Z", error: "refresh_token_reused" }] };
    const [v] = deriveProfileViews(p);
    assert.equal(v.authenticated, false);
    assert.equal(v.needsAuth, false, "a stale token does not require the ceremony, but is not healthy");
    assert.equal(v.label, "Refresh failed");
    assert.equal(anyProfileDegraded(p), true);
  });

  it("treats a missing provider as never connected", () => {
    const p = { profiles: [{ profile: "heavy", state: "no_provider", last_refresh: null, error: null }] };
    const [v] = deriveProfileViews(p);
    assert.equal(v.needsAuth, true);
    assert.equal(v.label, "Not connected");
    assert.match(v.detail, /never been connected/);
  });

  it("degrades safely when the runtime does not answer", () => {
    // No data must not read as "all good" — that is the failure this panel exists to prevent.
    for (const bad of [null, undefined, {}, { profiles: null }, "nope"]) {
      assert.deepEqual(deriveProfileViews(bad), []);
      assert.equal(anyProfileDegraded(bad), false, "empty means unknown, not degraded — the panel says so in words");
    }
  });
});
