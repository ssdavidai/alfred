// Tests for the NAR attention MCP tools.
//
// Coverage: catalogue shape, get_attention_statement argument validation
// (single date / range / malformed / mutual-exclusion / missing),
// buildRequest mapping, and get_attention_stats validation + mapping.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ALL_ATTENTION_TOOLS } from "./attention.js";

function getTool(name: string) {
  const t = ALL_ATTENTION_TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} not found in ALL_ATTENTION_TOOLS`);
  return t;
}

// ─── catalogue shape ────────────────────────────────────────────────────────

test("ALL_ATTENTION_TOOLS — exactly 2 tools", () => {
  assert.equal(ALL_ATTENTION_TOOLS.length, 2);
});

test("ALL_ATTENTION_TOOLS — correct names", () => {
  const names = ALL_ATTENTION_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_attention_statement", "get_attention_stats"]);
});

test("ALL_ATTENTION_TOOLS — every tool has a substantive description", () => {
  for (const t of ALL_ATTENTION_TOOLS) {
    assert.ok(
      typeof t.description === "string" && t.description.length > 100,
      `${t.name}: description must be substantive`,
    );
  }
});

// ─── get_attention_statement · schema validation ─────────────────────────────

const stmt = getTool("get_attention_statement");

test("statement: single date passes", () => {
  assert.equal(stmt.inputSchema.safeParse({ date: "2026-08-13" }).success, true);
});

test("statement: range passes", () => {
  assert.equal(stmt.inputSchema.safeParse({ from: "2026-08-07", to: "2026-08-13" }).success, true);
});

test("statement: no args rejected", () => {
  const r = stmt.inputSchema.safeParse({});
  assert.equal(r.success, false);
  const msg = JSON.stringify(r.error?.issues);
  assert.ok(msg.includes("from") || msg.includes("date"), "error must name the missing field");
});

test("statement: malformed date rejected", () => {
  assert.equal(stmt.inputSchema.safeParse({ date: "13-08-2026" }).success, false);
});

test("statement: date + from conflict rejected (mutually exclusive)", () => {
  const r = stmt.inputSchema.safeParse({ date: "2026-08-13", from: "2026-08-07", to: "2026-08-13" });
  assert.equal(r.success, false);
  assert.ok(
    JSON.stringify(r.error?.issues).includes("mutually exclusive"),
    "should mention mutual exclusion",
  );
});

test("statement: date + to conflict rejected", () => {
  assert.equal(stmt.inputSchema.safeParse({ date: "2026-08-13", to: "2026-08-13" }).success, false);
});

test("statement: from without to rejected", () => {
  const r = stmt.inputSchema.safeParse({ from: "2026-08-07" });
  assert.equal(r.success, false);
  assert.ok(JSON.stringify(r.error?.issues).includes("to"), "error must mention `to`");
});

test("statement: to without from rejected", () => {
  const r = stmt.inputSchema.safeParse({ to: "2026-08-13" });
  assert.equal(r.success, false);
  assert.ok(JSON.stringify(r.error?.issues).includes("from"), "error must mention `from`");
});

// ─── get_attention_statement · buildRequest mapping ──────────────────────────

test("statement · single date → GET /api/v1/attention/statement?date=…", () => {
  const req = stmt.buildRequest({ date: "2026-08-13" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/attention/statement");
  assert.deepEqual(req.query, { date: "2026-08-13" });
  assert.equal(req.body, undefined);
});

test("statement · range → ?from=…&to=…, no body", () => {
  const req = stmt.buildRequest({ from: "2026-08-07", to: "2026-08-13" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/attention/statement");
  assert.deepEqual(req.query, { from: "2026-08-07", to: "2026-08-13" });
  assert.equal(req.body, undefined);
});

// ─── get_attention_stats · schema + buildRequest ─────────────────────────────

const stats = getTool("get_attention_stats");

test("stats: from + to passes", () => {
  assert.equal(stats.inputSchema.safeParse({ from: "2026-08-07", to: "2026-08-13" }).success, true);
});

test("stats: missing from rejected", () => {
  assert.equal(stats.inputSchema.safeParse({ to: "2026-08-13" }).success, false);
});

test("stats: missing to rejected", () => {
  assert.equal(stats.inputSchema.safeParse({ from: "2026-08-07" }).success, false);
});

test("stats: malformed date rejected", () => {
  assert.equal(stats.inputSchema.safeParse({ from: "2026/08/07", to: "2026-08-13" }).success, false);
});

test("stats · → GET /api/v1/attention/stats?from=…&to=…", () => {
  const req = stats.buildRequest({ from: "2026-08-07", to: "2026-08-13" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/attention/stats");
  assert.deepEqual(req.query, { from: "2026-08-07", to: "2026-08-13" });
  assert.equal(req.body, undefined);
});
