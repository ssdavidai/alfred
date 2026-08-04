// #416 — schedule-time dedup for announce:true spawns.
import test from "node:test";
import assert from "node:assert/strict";

const {
  normalizeTask,
  announceDedupKey,
  checkAnnounceDedup,
  _resetAnnounceDedupForTests,
} = await import("../src/api/announceDedup.js");

test("normalize collapses volatile bits (timestamps/uuids/digit runs)", () => {
  const a = normalizeTask("Research pancake route at 2026-08-04T14:25:41Z run 12345678");
  const b = normalizeTask("Research pancake route at 2026-08-04T14:40:22Z run 99887766");
  assert.equal(a, b, "retried research with different ts/ids must normalize equal");
});

test("same channel+target+task within window dedups; second call sees existing job", () => {
  _resetAnnounceDedupForTests();
  const k = announceDedupKey("slack", "D123", "post the pancake route");
  assert.equal(checkAnnounceDedup(k, "job-1"), null, "first is not a dup");
  assert.equal(checkAnnounceDedup(k, "job-2"), "job-1", "second returns the first job");
});

test("different channel is not a dup", () => {
  _resetAnnounceDedupForTests();
  const k1 = announceDedupKey("slack", "D123", "post the route");
  const k2 = announceDedupKey("telegram", "999", "post the route");
  assert.equal(checkAnnounceDedup(k1, "j1"), null);
  assert.equal(checkAnnounceDedup(k2, "j2"), null, "telegram target is distinct");
});

test("different task is not a dup", () => {
  _resetAnnounceDedupForTests();
  const k1 = announceDedupKey("slack", "D123", "post the pancake route");
  const k2 = announceDedupKey("slack", "D123", "send the quarterly invoice");
  assert.equal(checkAnnounceDedup(k1, "j1"), null);
  assert.equal(checkAnnounceDedup(k2, "j2"), null, "distinct request goes through");
});
