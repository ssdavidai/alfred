import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrustProxy } from "./trustProxy.js";

test("trusts exactly one documented Caddy hop by default", () => assert.equal(resolveTrustProxy(undefined, true), 1));
test("accepts only bounded hop counts", () => {
  assert.equal(resolveTrustProxy("0", true), 0);
  assert.equal(resolveTrustProxy("2", true), 2);
  assert.throws(() => resolveTrustProxy("6", true), /bounded integer/);
});
test("rejects permisive trust in production", () => {
  assert.throws(() => resolveTrustProxy("true", true), /Unsafe TRUST_PROXY_HOPS/);
  assert.throws(() => resolveTrustProxy("0.0.0.0/0", true), /Unsafe TRUST_PROXY_HOPS/);
});
test("fails closed in development", () => assert.equal(resolveTrustProxy("true", false), 0));
