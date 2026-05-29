// Tests for the files MCP tool catalogue (PR 2 of issue #114).
//
// Coverage:
//   1. catalogue shape — exactly 9 tools, correct names
//   2. schema validation — required vs optional fields, bounds
//   3. buildRequest mapping — every tool funnels to the right ctrl-api
//      route + method + path + query/body shape
//
// We don't exercise the ctrl-api side here — that's the job of
// packages/ctrl/tests/files-routes.test.ts. This file pins the
// contract between the MCP catalogue and ctrl-api so a breaking
// rename on either side fails fast.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ALL_FILES_TOOLS } from "./files.js";

function getTool(name: string) {
  const t = ALL_FILES_TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} not found in ALL_FILES_TOOLS`);
  return t;
}

// ─── catalogue shape ────────────────────────────────────────────────────────

test("ALL_FILES_TOOLS — exactly 9 tools, correct names", () => {
  assert.equal(ALL_FILES_TOOLS.length, 9);
  const names = ALL_FILES_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "create",
    "delete",
    "describe",
    "list",
    "read_base64",
    "read_text",
    "search",
    "stat",
    "usage",
  ]);
});

test("ALL_FILES_TOOLS — every tool has a non-empty description", () => {
  for (const t of ALL_FILES_TOOLS) {
    assert.ok(
      typeof t.description === "string" && t.description.length > 40,
      `${t.name}: description must be a substantive string`,
    );
  }
});

// ─── list ──────────────────────────────────────────────────────────────────

test("list · no args → GET /api/v1/files/list with empty query object", () => {
  const t = getTool("list");
  const r = t.inputSchema.safeParse({});
  assert.equal(r.success, true);
  const req = t.buildRequest({});
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/files/list");
  assert.deepEqual(req.query, {});
});

test("list · prefix/limit/offset land in query", () => {
  const t = getTool("list");
  const r = t.inputSchema.safeParse({
    prefix: "01J9X",
    limit: 50,
    offset: 100,
  });
  assert.equal(r.success, true);
  const req = t.buildRequest({ prefix: "01J9X", limit: 50, offset: 100 });
  assert.deepEqual(req.query, { prefix: "01J9X", limit: 50, offset: 100 });
});

test("list · limit/offset bounds enforced", () => {
  const t = getTool("list");
  assert.equal(t.inputSchema.safeParse({ limit: 0 }).success, false);
  assert.equal(t.inputSchema.safeParse({ limit: 1001 }).success, false);
  assert.equal(t.inputSchema.safeParse({ offset: -1 }).success, false);
  assert.equal(t.inputSchema.safeParse({ limit: 100, offset: 0 }).success, true);
});

// ─── stat ──────────────────────────────────────────────────────────────────

test("stat · path required, → GET /api/v1/files/stat/<path>", () => {
  const t = getTool("stat");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ path: "" }).success, false);
  const req = t.buildRequest({ path: "01J9X/q3-contract.pdf" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/files/stat/01J9X/q3-contract.pdf");
});

// ─── read_text ─────────────────────────────────────────────────────────────

test("read_text · → GET /api/v1/files/blob/<path>", () => {
  const t = getTool("read_text");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  const req = t.buildRequest({ path: "01J9X/notes.md" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/files/blob/01J9X/notes.md");
});

// ─── read_base64 ───────────────────────────────────────────────────────────

test("read_base64 · → GET /api/v1/files/blob/<path>, max_bytes in query", () => {
  const t = getTool("read_base64");
  const req = t.buildRequest({
    path: "01J9X/photo.png",
    max_bytes: 1024,
  });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/files/blob/01J9X/photo.png");
  assert.deepEqual(req.query, { max_bytes: 1024 });
});

test("read_base64 · max_bytes bounded to ≤ 5 MB", () => {
  const t = getTool("read_base64");
  // 5 MB + 1 byte rejected
  const tooBig = 5 * 1024 * 1024 + 1;
  assert.equal(
    t.inputSchema.safeParse({ path: "x", max_bytes: tooBig }).success,
    false,
  );
  // Exactly the cap is OK
  assert.equal(
    t.inputSchema.safeParse({ path: "x", max_bytes: 5 * 1024 * 1024 }).success,
    true,
  );
  // No max_bytes is fine (defaults server-side)
  assert.equal(t.inputSchema.safeParse({ path: "x" }).success, true);
});

test("read_base64 · max_bytes omitted → no query block", () => {
  const t = getTool("read_base64");
  const req = t.buildRequest({ path: "01J9X/photo.png" });
  assert.equal(req.query, undefined);
});

// ─── search ────────────────────────────────────────────────────────────────

test("search · query required → GET /list with q=<query>", () => {
  const t = getTool("search");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ query: "" }).success, false);
  const req = t.buildRequest({ query: "Acme contract" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/files/list");
  assert.deepEqual(req.query, { q: "Acme contract" });
});

test("search · limit/offset forwarded into query", () => {
  const t = getTool("search");
  const req = t.buildRequest({ query: "pizza", limit: 25, offset: 50 });
  assert.deepEqual(req.query, { q: "pizza", limit: 25, offset: 50 });
});

// ─── delete ────────────────────────────────────────────────────────────────

test("delete · → DELETE /api/v1/files/<path>", () => {
  const t = getTool("delete");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  const req = t.buildRequest({ path: "01J9X/q3-contract.pdf" });
  assert.equal(req.method, "DELETE");
  assert.equal(req.path, "/api/v1/files/01J9X/q3-contract.pdf");
});

// ─── create ────────────────────────────────────────────────────────────────

test("create · path + content_base64 required, → POST /api/v1/files/upload", () => {
  const t = getTool("create");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ path: "x", content_base64: "" }).success,
    false,
  );
  const req = t.buildRequest({
    path: "report.md",
    content_base64: "aGVsbG8=",
    content_type: "text/markdown",
    principal_label: "weekly digest",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/files/upload");
  assert.deepEqual(req.body, {
    path: "report.md",
    content_base64: "aGVsbG8=",
    content_type: "text/markdown",
    principal_label: "weekly digest",
  });
});

test("create · content_type + principal_label optional", () => {
  const t = getTool("create");
  const r = t.inputSchema.safeParse({
    path: "report.md",
    content_base64: "aGVsbG8=",
  });
  assert.equal(r.success, true);
});

// ─── usage ─────────────────────────────────────────────────────────────────

test("usage · no args, → GET /api/v1/files/usage", () => {
  const t = getTool("usage");
  const r = t.inputSchema.safeParse({});
  assert.equal(r.success, true);
  const req = t.buildRequest({});
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/files/usage");
});

// ─── describe ──────────────────────────────────────────────────────────────

test("describe · path + description required → PATCH /api/v1/files/<path> with principal_label", () => {
  const t = getTool("describe");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ path: "x" }).success, false);
  const req = t.buildRequest({
    path: "01J9X/receipt.pdf",
    description: "pizza receipt 2026-05-28",
  });
  assert.equal(req.method, "PATCH");
  assert.equal(req.path, "/api/v1/files/01J9X/receipt.pdf");
  assert.deepEqual(req.body, { principal_label: "pizza receipt 2026-05-28" });
});

test("describe · empty string description is allowed (clears the label)", () => {
  const t = getTool("describe");
  const r = t.inputSchema.safeParse({ path: "01J9X/x.bin", description: "" });
  assert.equal(r.success, true);
  const req = t.buildRequest({ path: "01J9X/x.bin", description: "" });
  assert.deepEqual(req.body, { principal_label: "" });
});
