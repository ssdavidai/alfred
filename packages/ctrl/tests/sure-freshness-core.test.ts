// #318 slice 1 — per-account balance_provenance classification.
// Tests: classifyProvenance, buildAnchorMap, fetchAnchorMap.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  classifyProvenance,
  buildAnchorMap,
  fetchAnchorMap,
  type AnchorEntry,
} from "../src/api/lib/sure_freshness.js";

const activeAnchor: AnchorEntry = {
  account_id: "aa", has_provider_anchor: true,
  provider_status: "ACTIVE", provider_observed_at: "2026-08-10T00:00:00Z",
};
const disconnectedAnchor: AnchorEntry = {
  account_id: "bb", has_provider_anchor: false,
  provider_status: "DISCONNECTED", provider_observed_at: null,
};
const noStatusAnchor: AnchorEntry = {
  account_id: "cc", has_provider_anchor: false,
  provider_status: null, provider_observed_at: null,
};
const nullAnchor: AnchorEntry = {
  account_id: "dd", has_provider_anchor: null,
  provider_status: null, provider_observed_at: null,
};

describe("classifyProvenance", () => {
  it("true → provider / fresh / observed_at preserved", () => {
    const p = classifyProvenance(activeAnchor);
    assert.equal(p.source, "provider");
    assert.equal(p.freshness, "fresh");
    assert.equal(p.fallback_reason, null);
    assert.equal(p.observed_at, "2026-08-10T00:00:00Z");
  });

  it("false + status → cached_fallback / stale / reason includes status", () => {
    const p = classifyProvenance(disconnectedAnchor);
    assert.equal(p.source, "cached_fallback");
    assert.equal(p.freshness, "stale");
    assert.ok(p.fallback_reason?.includes("DISCONNECTED"));
    assert.equal(p.observed_at, null);
  });

  it("false + null status → cached_fallback / stale / generic reason", () => {
    const p = classifyProvenance(noStatusAnchor);
    assert.equal(p.source, "cached_fallback");
    assert.equal(p.freshness, "stale");
    assert.ok(p.fallback_reason && p.fallback_reason.length > 0);
  });

  it("null has_provider_anchor → unknown / no reason", () => {
    const p = classifyProvenance(nullAnchor);
    assert.equal(p.source, null);
    assert.equal(p.freshness, "unknown");
    assert.equal(p.fallback_reason, null);
  });

  it("undefined (absent from upstream) → unknown — must not render as fresh", () => {
    const p = classifyProvenance(undefined);
    assert.equal(p.source, null);
    assert.equal(p.freshness, "unknown");
    assert.notEqual(p.freshness, "fresh");
  });
});

describe("buildAnchorMap", () => {
  it("indexes by account_id; missing key returns undefined", () => {
    const m = buildAnchorMap([activeAnchor, disconnectedAnchor]);
    assert.equal(m.size, 2);
    assert.equal(m.get("aa")!.has_provider_anchor, true);
    assert.equal(m.get("bb")!.has_provider_anchor, false);
    assert.equal(m.get("zz"), undefined);
  });
});

describe("fetchAnchorMap", () => {
  let savedFetch: typeof globalThis.fetch;
  before(() => { savedFetch = globalThis.fetch; });
  after(() => { globalThis.fetch = savedFetch; });

  it("returns populated map on 200 success", async () => {
    const payload = { accounts: [
      { account_id: "x1", has_provider_anchor: true, provider_status: "ACTIVE", provider_observed_at: "2026-01-01T00:00:00Z" },
    ]};
    globalThis.fetch = async () => new Response(JSON.stringify(payload),
      { status: 200, headers: { "content-type": "application/json" } });
    const m = await fetchAnchorMap("http://sure-web:3000", "tok");
    assert.equal(m.size, 1);
    assert.equal(m.get("x1")!.has_provider_anchor, true);
  });

  it("returns empty map on non-200", async () => {
    globalThis.fetch = async () => new Response("", { status: 401 });
    assert.equal((await fetchAnchorMap("http://sure-web:3000", "tok")).size, 0);
  });

  it("returns empty map when fetch throws — accounts response still returns 200", async () => {
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    assert.equal((await fetchAnchorMap("http://sure-web:3000", "tok")).size, 0);
  });
});
