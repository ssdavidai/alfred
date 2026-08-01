import assert from "node:assert/strict";
import test from "node:test";
import { createProxyTrust } from "./proxyTrust.js";

test("direct requests trust no proxy", () => {
  assert.equal(createProxyTrust({ NODE_ENV: "test" }), 0);
});

test("production fails closed without explicit topology", () => {
  assert.throws(() => createProxyTrust({ NODE_ENV: "production" }), /requires MCP_TRUST_PROXY/);
});

test("trusted single-hop topology is bounded", () => {
  const trust = createProxyTrust({ NODE_ENV: "production", MCP_TRUST_PROXY_HOPS: "1" });
  assert.equal(trust, 1);
});

test("spoof-resistant configuration rejects unbounded and malformed values", () => {
  assert.throws(() => createProxyTrust({ NODE_ENV: "production", MCP_TRUST_PROXY_HOPS: "3" }), /between 0 and 2/);
  assert.throws(() => createProxyTrust({ NODE_ENV: "production", MCP_TRUST_PROXY_HOPS: "x-forwarded-for" }), /non-negative integer/);
  assert.throws(() => createProxyTrust({ NODE_ENV: "production", MCP_TRUST_PROXY_HOPS: "1", MCP_TRUST_PROXY_IPS: "127.0.0.1/8" }), /only one/);
});

test("CIDR trust is limited to the configured proxy network and hop bound", () => {
  const trust = createProxyTrust({ NODE_ENV: "production", MCP_TRUST_PROXY_IPS: "10.0.0.0/8" });
  assert.equal(typeof trust, "function");
  assert.equal((trust as (ip: string, index: number) => boolean)("10.1.2.3", 0), true);
  assert.equal((trust as (ip: string, index: number) => boolean)("192.0.2.1", 0), false);
  assert.equal((trust as (ip: string, index: number) => boolean)("10.1.2.3", 3), false);
});
