import { test } from "node:test";
import assert from "node:assert/strict";
import { continuityRecent, continuityNote, continuityBind, ALL_CONTINUITY_TOOLS } from "./continuity.js";

test("continuity_recent reads the owner's cross-channel window", () => {
  const r = continuityRecent.buildRequest({ limit: 30, within_hours: 48 });
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/v1/alfred-journal/recent");
  assert.deepEqual(r.query, { principal_id: "owner", limit: 30, within_hours: 48 });
});

test("continuity_recent omits unset window params so server defaults apply", () => {
  const r = continuityRecent.buildRequest({});
  assert.equal((r.query as Record<string, unknown>).limit, undefined);
  assert.equal((r.query as Record<string, unknown>).principal_id, "owner");
});

test("continuity_note maps direction to the journal's status vocabulary", () => {
  const inb = continuityNote.buildRequest({ channel: "cowork", chat_id: "s1", direction: "inbound", message: "hi" });
  const out = continuityNote.buildRequest({ channel: "cowork", chat_id: "s1", direction: "outbound", message: "hello" });
  assert.equal(inb.method, "POST");
  assert.equal(inb.path, "/api/v1/alfred-journal");
  assert.equal((inb.body as { status: string }).status, "received");
  assert.equal((out.body as { status: string }).status, "delivered");
  assert.equal((out.body as { source_kind: string }).source_kind, "cowork");
});

test("continuity_bind always binds to the owner principal", () => {
  const r = continuityBind.buildRequest({ channel: "cowork", chat_id: "abc" });
  assert.equal(r.path, "/api/v1/alfred-journal/principal/bind");
  assert.deepEqual(r.body, { channel: "cowork", chat_id: "abc", principal_id: "owner" });
});

test("schemas reject a bad channel slug and an empty message", () => {
  assert.equal(continuityNote.inputSchema.safeParse({ channel: "Bad Channel", chat_id: "x", direction: "inbound", message: "m" }).success, false);
  assert.equal(continuityNote.inputSchema.safeParse({ channel: "cowork", chat_id: "x", direction: "inbound", message: "" }).success, false);
  assert.equal(continuityRecent.inputSchema.safeParse({ limit: 51 }).success, false);
});

test("all three are exported in the catalogue with unique names", () => {
  const names = ALL_CONTINUITY_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ["alfred_continuity_recent", "alfred_continuity_note", "alfred_continuity_bind"]);
  assert.equal(new Set(names).size, 3);
});
