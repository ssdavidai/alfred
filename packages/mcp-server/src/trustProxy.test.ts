import assert from "node:assert/strict";
import test from "node:test";

import { resolveTrustProxy } from "./trustProxy.js";

test("development defaults to a single documented Caddy hop", () => {
  assert.equal(resolveTrustProxy(undefined, false), 1);
});

test("accepts only bounded hop counts", () => {
  assert.equal(resolveTrustProxy("0", true), 0);
  assert.equal(resolveTrustProxy("1", true), 1);
  assert.equal(resolveTrustProxy("5", true), 5);
  assert.throws(() => resolveTrustProxy("6", true), /between 0 and 5/);
});

test("production fails closed when configuration is missing", () => {
  assert.throws(() => resolveTrustProxy(undefined, true), /must be set/);
});

test("rejects malformed and permissive values", () => {
  for (const value of ["true", "*", "all", "0.0.0.0/0", "-1", "1.5"]) {
    assert.throws(() => resolveTrustProxy(value, true), /TRUST_PROXY_HOPS/);
  }
});
