/**
 * testEnvironment() tests — verify the operator gets the right shape
 * when clicking "Test agent" in Paperclip.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeTestEnvironment } from "../src/server/test.js";

describe("testEnvironment", () => {
  it("passes when hermes is healthy AND api key is readable", async () => {
    const testEnvironment = makeTestEnvironment({
      ping: async () => ({ ok: true, status: 200, detail: "ok" }),
      readApiKey: () => "stub-key",
    });
    const res = await testEnvironment({
      companyId: "c",
      adapterType: "hermes_local",
      config: {},
    });
    assert.equal(res.status, "pass");
    assert.ok(res.checks.find((c) => c.code === "hermes_health_ok"));
    assert.ok(res.checks.find((c) => c.code === "hermes_api_key_ok"));
  });

  it("warns when hermes is healthy but api key is missing", async () => {
    const testEnvironment = makeTestEnvironment({
      ping: async () => ({ ok: true, status: 200, detail: "ok" }),
      readApiKey: () => null,
    });
    const res = await testEnvironment({
      companyId: "c",
      adapterType: "hermes_local",
      config: {},
    });
    assert.equal(res.status, "warn");
    assert.ok(res.checks.find((c) => c.code === "hermes_api_key_missing"));
  });

  it("fails fast when hermes /health is unreachable", async () => {
    const testEnvironment = makeTestEnvironment({
      ping: async () => ({
        ok: false,
        status: null,
        detail: "ECONNREFUSED",
      }),
      readApiKey: () => "stub-key",
    });
    const res = await testEnvironment({
      companyId: "c",
      adapterType: "hermes_local",
      config: {},
    });
    assert.equal(res.status, "fail");
    assert.equal(res.checks.length, 1);
    assert.equal(res.checks[0]!.code, "hermes_health_unreachable");
  });
});
