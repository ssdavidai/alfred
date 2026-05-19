// signals-engineering-tag-filter.test.ts
//
// PR fix/learn-signal-writer-block-engineering-tags — unit coverage for
// the engineering-tag deny-list at POST /api/v1/signals.
//
// We exercise the deny-list helpers directly (not via HTTP) so the test
// doesn't need to stand up state.db / openStateDb / the .sql migration
// loader. Helpers live in ``signals_filter.ts`` specifically so this
// test can import them without dragging in the rest of the route.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { classifyEngineeringNoise, matchesEngineeringTag } = await import(
  "../src/api/routes/signals_filter.js"
);

describe("matchesEngineeringTag (deny-list regex)", () => {
  it("matches STORE-* prefixes", () => {
    assert.equal(matchesEngineeringTag("STORE-P6-1 thing happened"), "STORE-");
    assert.equal(
      matchesEngineeringTag("STORE-P3-2 smoke detector re-applied"),
      "STORE-",
    );
  });

  it("matches OPS-* and MCP-* prefixes", () => {
    assert.ok(matchesEngineeringTag("OPS-TOKEN-1 fixed"));
    assert.ok(matchesEngineeringTag("MCP-AUTH-7 broke"));
  });

  it("matches bare P<digit>-<digit> prefixes (the smoke-test leak)", () => {
    assert.equal(matchesEngineeringTag("P3-2 smoke detector re-applied"), "P3-2");
    assert.equal(matchesEngineeringTag("P12-4 anomaly"), "P12-4");
  });

  it("matches bracketed [P<d>-<d>] prefixes", () => {
    assert.ok(matchesEngineeringTag("[P3-2] smoke detector"));
    assert.ok(matchesEngineeringTag("[P3-2]: alert"));
  });

  it("matches SM-A.. and OBS-<digit> prefixes", () => {
    assert.ok(matchesEngineeringTag("SM-A pipeline stalled"));
    assert.ok(matchesEngineeringTag("OBS-2 acceptor degraded"));
  });

  it("does not match user-facing prose that happens to mention codes", () => {
    assert.equal(matchesEngineeringTag(""), null);
    assert.equal(matchesEngineeringTag(null), null);
    assert.equal(matchesEngineeringTag("Krio Intézet sent an overdue invoice"), null);
    assert.equal(matchesEngineeringTag("Ed Cave waiting on RSVP"), null);
    // Engineering-style suffix mid-sentence must NOT trigger.
    assert.equal(
      matchesEngineeringTag("The audit covered the P3-2 cohort last week"),
      null,
    );
  });
});

describe("classifyEngineeringNoise (POST /api/v1/signals deny-list)", () => {
  it("rejects the actual david P3-2 smoke-detector row", () => {
    // The literal row that leaked into david's 2026-05-19 brief:
    //   id: aeb40ea8-0d1d-40d6-aafa-ce2303d62d14
    //   source_type: manual
    //   actor: smoke
    //   body: "P3-2 reapply smoke"
    const r = classifyEngineeringNoise({
      source_type: "manual",
      actor: "smoke",
      display_headline: null,
      display_body: null,
      body: "P3-2 reapply smoke",
    });
    assert.ok(r !== null, "expected the P3-2 row to be rejected");
    // The actor check fires first (operational actor); that's the
    // strongest evidence the row is infra, so we lock the assertion to
    // it. If the order changes, update both this test and the body
    // check below.
    assert.equal(r!.reason, "actor is operational");
    assert.equal(r!.pattern, "smoke");
  });

  it("rejects a STORE-P3-2 smoke summary even without operational actor", () => {
    const r = classifyEngineeringNoise({
      source_type: "manual",
      actor: null,
      display_headline: "STORE-P3-2 smoke detector re-applied its alert",
      display_body: null,
      body: "...",
    });
    assert.ok(r !== null);
    assert.equal(
      r!.reason,
      "display_headline matches engineering-tag deny-list",
    );
    assert.equal(r!.pattern, "STORE-");
  });

  it("accepts a normal counterparty signal (Krio Intézet invoice)", () => {
    const r = classifyEngineeringNoise({
      source_type: "gmail",
      actor: "counterparty",
      display_headline: "Krio Intézet sent an overdue invoice",
      display_body: "Reminder #2 — payment due 2026-05-30. Total: 184 000 HUF.",
      body: "Source: gmail email event. Effect: action against task/krio-invoice.md.",
    });
    assert.equal(
      r,
      null,
      `expected accept, got ${JSON.stringify(r)}`,
    );
  });

  it("accepts a normal gcal RSVP signal (regression: do not over-block)", () => {
    const r = classifyEngineeringNoise({
      source_type: "gcal",
      actor: "counterparty",
      display_headline: "M. Brennan Sweeney is waiting for your RSVP.",
      display_body: "Fireroad call, 30 minutes, Jan 30 at 6pm.",
      body: "Source: gcal stream event. Effect: action (no target resolved).",
    });
    assert.equal(r, null);
  });

  it("rejects an operational source_type even with benign body", () => {
    const r = classifyEngineeringNoise({
      source_type: "ops:janitor",
      actor: null,
      display_headline: "vault index refreshed",
      display_body: null,
      body: "completed in 412ms",
    });
    assert.ok(r !== null);
    assert.equal(r!.reason, "source_type is operational");
    assert.equal(r!.pattern, "ops:janitor");
  });
});
