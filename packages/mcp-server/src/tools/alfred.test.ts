// Tests for the act_on_decision + reverse_decision tools.
//
// Coverage:
//   1. schema validation — per-action required-note rules
//   2. buildRequest — the POST /api/v1/decisions body shape mirrors the
//      dashboard's recordDecision() exactly for each of the five actions
//   3. action→intent mapping (do → take_mine; the others pass through)
//   4. source defaulting + source_record wrapping for needs_attention
//   5. reverse_decision path encoding

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ALL_ALFRED_TOOLS } from "./alfred.js";

function getTool(name: string) {
  const t = ALL_ALFRED_TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} not found`);
  return t;
}

const actOn = getTool("act_on_decision");
const reverse = getTool("reverse_decision");

// ─── act_on_decision · schema validation ────────────────────────────────────

test("act_on_decision: delegate requires note", () => {
  const r = actOn.inputSchema.safeParse({
    id: "2026-05-28-04-15-xyz",
    action: "delegate",
  });
  assert.equal(r.success, false);
  assert.ok(
    String(JSON.stringify(r.error?.issues ?? r.error)).includes("delegate"),
    "error should mention delegate",
  );
});

test("act_on_decision: delegate with note passes", () => {
  const r = actOn.inputSchema.safeParse({
    id: "abc",
    action: "delegate",
    note: "Settle it, then file the receipt under May expenses.",
  });
  assert.equal(r.success, true);
});

test("act_on_decision: defer requires note (the natural-language when)", () => {
  const r = actOn.inputSchema.safeParse({
    id: "abc",
    action: "defer",
    note: "   ",
  });
  assert.equal(r.success, false);
  assert.ok(
    String(JSON.stringify(r.error?.issues ?? r.error)).includes("defer"),
  );
});

test("act_on_decision: defer with note passes", () => {
  const r = actOn.inputSchema.safeParse({
    id: "abc",
    action: "defer",
    note: "Tomorrow morning",
  });
  assert.equal(r.success, true);
});

test("act_on_decision: done/do/noise allow empty note", () => {
  for (const action of ["done", "do", "noise"] as const) {
    const r = actOn.inputSchema.safeParse({ id: "abc", action });
    assert.equal(r.success, true, `${action} should pass without note`);
  }
});

test("act_on_decision: unknown action is rejected", () => {
  const r = actOn.inputSchema.safeParse({ id: "abc", action: "delete" });
  assert.equal(r.success, false);
});

test("act_on_decision: id required", () => {
  const r = actOn.inputSchema.safeParse({ action: "done" });
  assert.equal(r.success, false);
});

// ─── act_on_decision · buildRequest mapping ─────────────────────────────────

test("act_on_decision · delegate · maps to POST /api/v1/decisions with intent=delegate and wrapped source_record", () => {
  const req = actOn.buildRequest({
    id: "2026-05-28-04-15-xyz",
    action: "delegate",
    note: "Settle it, then file the receipt.",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/decisions");
  assert.deepEqual(req.body, {
    source: "needs_attention",
    source_record: "needs_attention/2026-05-28-04-15-xyz.md",
    intent: "delegate",
    note: "Settle it, then file the receipt.",
    matter_ref: "",
    task_ref: "",
    source_headline: "",
    time_to_decision_ms: null,
  });
});

test("act_on_decision · defer · intent=defer, note is the when-string", () => {
  const req = actOn.buildRequest({
    id: "abc",
    action: "defer",
    note: "After the Carter meeting",
  });
  assert.equal((req.body as any).intent, "defer");
  assert.equal((req.body as any).note, "After the Carter meeting");
  assert.equal((req.body as any).source, "needs_attention");
  assert.equal((req.body as any).source_record, "needs_attention/abc.md");
});

test("act_on_decision · done · intent=done, optional note OK", () => {
  const req = actOn.buildRequest({
    id: "abc",
    action: "done",
    note: "Already replied on the thread",
  });
  assert.equal((req.body as any).intent, "done");
  assert.equal((req.body as any).note, "Already replied on the thread");
});

test("act_on_decision · do · maps to intent=take_mine (dashboard's 'Sir takes this on')", () => {
  const req = actOn.buildRequest({ id: "abc", action: "do", note: "" });
  assert.equal((req.body as any).intent, "take_mine");
  assert.equal((req.body as any).note, "");
});

test("act_on_decision · noise · intent=noise, empty note (the gesture is the explanation)", () => {
  const req = actOn.buildRequest({ id: "abc", action: "noise" });
  assert.equal((req.body as any).intent, "noise");
  assert.equal((req.body as any).note, "");
});

test("act_on_decision · matter_ref / task_ref / source_headline forwarded when set", () => {
  const req = actOn.buildRequest({
    id: "abc",
    action: "done",
    note: "done",
    matter_ref: "matter/acme.md",
    task_ref: "task/follow-up-sam.md",
    source_headline: "Acme contract follow-up",
  });
  assert.equal((req.body as any).matter_ref, "matter/acme.md");
  assert.equal((req.body as any).task_ref, "task/follow-up-sam.md");
  assert.equal((req.body as any).source_headline, "Acme contract follow-up");
});

test("act_on_decision · non-needs_attention sources pass id through verbatim (no wrapping)", () => {
  const req = actOn.buildRequest({
    id: "pattern_proposal/2026-05-28-foo.md",
    action: "done",
    source: "pattern_proposal",
  });
  // The dashboard passes recordId verbatim for non-NA sources; mirror that.
  assert.equal(
    (req.body as any).source_record,
    "pattern_proposal/2026-05-28-foo.md",
  );
  assert.equal((req.body as any).source, "pattern_proposal");
});

test("act_on_decision · explicit source=needs_attention also wraps", () => {
  const req = actOn.buildRequest({
    id: "abc",
    action: "done",
    source: "needs_attention",
  });
  assert.equal((req.body as any).source_record, "needs_attention/abc.md");
});

// ─── reverse_decision ───────────────────────────────────────────────────────

test("reverse_decision · POST /api/v1/decisions/:id/reverse with encoded id", () => {
  const req = reverse.buildRequest({ id: "2026-05-28T04-15-22Z-a1b2c3d4" });
  assert.equal(req.method, "POST");
  assert.equal(
    req.path,
    "/api/v1/decisions/2026-05-28T04-15-22Z-a1b2c3d4/reverse",
  );
});

test("reverse_decision · id with slashes is URL-encoded", () => {
  const req = reverse.buildRequest({ id: "weird/id with space" });
  // encodeURIComponent encodes `/` and ` `
  assert.ok(
    req.path === "/api/v1/decisions/weird%2Fid%20with%20space/reverse",
    `unexpected path: ${req.path}`,
  );
});

test("reverse_decision · id required", () => {
  const r = reverse.inputSchema.safeParse({});
  assert.equal(r.success, false);
});
