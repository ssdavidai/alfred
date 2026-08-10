// #318 slice 2 — data_quality on balance_sheet + sync-health remediation hints.
// Tests buildDataQuality and remediationHint from sure_freshness.ts directly.
// NOT_CONFIGURED coverage is structural: requireSureConfig() is the first call
// in every sure route handler — the same guard tested in sure-mutate.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDataQuality, remediationHint, buildAnchorMap, type AnchorEntry,
} from "../src/api/lib/sure_freshness.js";

const freshEntry: AnchorEntry = { account_id: "a1", has_provider_anchor: true,
  provider_status: "ACTIVE", provider_observed_at: "2026-08-10T06:00:00Z" };
const disconnEntry: AnchorEntry = { account_id: "a2", has_provider_anchor: false,
  provider_status: "DISCONNECTED", provider_observed_at: null };
const errorEntry: AnchorEntry = { account_id: "a3", has_provider_anchor: false,
  provider_status: "ERROR", provider_observed_at: null };

const mkAcct = (id: string) => ({ id });

describe("buildDataQuality", () => {
  it("mixed fresh/stale/unknown → correct counts, partial:true", () => {
    const m = buildAnchorMap([freshEntry, disconnEntry]);
    const dq = buildDataQuality(m, [mkAcct("a1"), mkAcct("a2"), mkAcct("unknown")]);
    assert.equal(dq.fresh_accounts, 1);
    assert.equal(dq.stale_accounts, 1);
    assert.equal(dq.unknown_accounts, 1);
    assert.equal(dq.partial, true);
  });

  it("all fresh → partial:false", () => {
    const dq = buildDataQuality(buildAnchorMap([freshEntry]), [mkAcct("a1")]);
    assert.equal(dq.fresh_accounts, 1);
    assert.equal(dq.stale_accounts, 0);
    assert.equal(dq.unknown_accounts, 0);
    assert.equal(dq.partial, false);
  });

  it("upstream anchor down (empty map) → all unknown, partial:true", () => {
    // fetchAnchorMap returns new Map() on any failure; all accounts → unknown.
    const dq = buildDataQuality(new Map(), [mkAcct("a1"), mkAcct("a2")]);
    assert.equal(dq.fresh_accounts, 0);
    assert.equal(dq.stale_accounts, 0);
    assert.equal(dq.unknown_accounts, 2);
    assert.equal(dq.partial, true);
  });

  it("stale-only portfolio → partial:true", () => {
    const dq = buildDataQuality(buildAnchorMap([disconnEntry, errorEntry]),
      [mkAcct("a2"), mkAcct("a3")]);
    assert.equal(dq.stale_accounts, 2);
    assert.equal(dq.partial, true);
  });

  it("no accounts → zeros, partial:false", () => {
    const dq = buildDataQuality(new Map(), []);
    assert.equal(dq.partial, false);
    assert.equal(dq.fresh_accounts + dq.stale_accounts + dq.unknown_accounts, 0);
  });
});

describe("remediationHint — sync-health per-account actionable text", () => {
  it("fresh → null (no action needed)", () => {
    assert.equal(remediationHint("fresh", "ACTIVE"), null);
    assert.equal(remediationHint("fresh", null), null);
  });

  it("stale + DISCONNECTED → re-authorise hint", () => {
    const h = remediationHint("stale", "DISCONNECTED");
    assert.ok(h, "must be non-null");
    assert.ok(h!.toLowerCase().includes("re-authorise") || h!.toLowerCase().includes("re-authorize"),
      `expected re-authorise language, got: ${h}`);
  });

  it("stale + non-DISCONNECTED → sync hint (not re-authorise)", () => {
    const h = remediationHint("stale", "ERROR");
    assert.ok(h, "must be non-null");
    assert.ok(!h!.toLowerCase().includes("re-authorise") && !h!.toLowerCase().includes("re-authorize"),
      `must not suggest re-authorise for non-DISCONNECTED, got: ${h}`);
  });

  it("stale + null status → still returns a hint", () => {
    const h = remediationHint("stale", null);
    assert.ok(typeof h === "string" && h.length > 0);
  });

  it("unknown → manual-account hint", () => {
    const h = remediationHint("unknown", null);
    assert.ok(h, "must be non-null");
    assert.ok(h!.toLowerCase().includes("manual") || h!.toLowerCase().includes("not linked"),
      `expected manual/not-linked language, got: ${h}`);
  });
});
