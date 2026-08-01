import assert from "node:assert/strict";
import test from "node:test";
import { boundedProxyTrust } from "./proxyTrust.js";
import { parseTrustProxyHops } from "./env.js";

test("trusts only the configured proxy hops", () => {
  const trust = boundedProxyTrust(2);
  assert.equal(trust("10.0.0.1", 0), true);
  assert.equal(trust("10.0.0.2", 1), true);
  assert.equal(trust("198.51.100.9", 2), false);
});

test("rejects permissive and malformed production proxy configuration", () => {
  assert.throws(() => parseTrustProxyHops("true", "production"), /non-negative integer/);
  assert.throws(() => parseTrustProxyHops(undefined, "production"), /must be set/);
  assert.throws(() => parseTrustProxyHops("5", "production"), /between 0 and 4/);
});

test("allows an explicit single-hop deployment", () => {
  assert.equal(parseTrustProxyHops("1", "production"), 1);
});
