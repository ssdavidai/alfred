import { describe, it } from "node:test";
import assert from "node:assert/strict";

// auth.ts has no external filesystem deps — import directly
const { setApiKey, authenticate } = await import("../src/api/auth.js");
const { AuthError } = await import("../src/api/errors.js");

function makeReq(headers: Record<string, string> = {}) {
  return { headers } as any;
}

describe("authenticate", () => {
  it("allows open access when no key is configured", () => {
    // Fresh worker process — apiKeyBuf starts null
    assert.doesNotThrow(() => authenticate(makeReq()));
  });

  it("allows a correct bearer token", () => {
    setApiKey("test-secret-key");
    assert.doesNotThrow(() =>
      authenticate(makeReq({ authorization: "Bearer test-secret-key" }))
    );
  });

  it("rejects a wrong token", () => {
    setApiKey("test-secret-key");
    assert.throws(
      () => authenticate(makeReq({ authorization: "Bearer wrong-value-xyz" })),
      (err: unknown) => {
        assert.ok(err instanceof AuthError, "expected AuthError");
        return true;
      }
    );
  });

  it("rejects a missing authorization header", () => {
    setApiKey("test-secret-key");
    assert.throws(
      () => authenticate(makeReq({})),
      (err: unknown) => err instanceof AuthError
    );
  });

  it("rejects a non-Bearer scheme", () => {
    setApiKey("test-secret-key");
    assert.throws(
      () => authenticate(makeReq({ authorization: "Basic dGVzdA==" })),
      (err: unknown) => err instanceof AuthError
    );
  });
});
