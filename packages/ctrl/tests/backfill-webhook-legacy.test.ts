// Tests for the pure helper functions exported by the backfill script.
// The main() execution path is guarded by import.meta.url so it does not
// run on import — only the pure parsing + keying functions are exercised here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// @ts-ignore — the script is a .mjs file with no TypeScript declarations
const { parseFrontmatter, extractPayload, computeExternalId } = await import(
  "../scripts/backfill-webhook-legacy.mjs"
);

// ── parseFrontmatter ──────────────────────────────────────────────────────────
describe("parseFrontmatter", () => {
  it("extracts source_type and source_ref from a legacy webhook record", () => {
    const content =
      `---\ntype: stream_event\nsource_type: "webhook:Test Label"\nreceived_at: "2026-07-21T10:00:00.000Z"\nsource_ref: "abc123:deadbeef"\nprocessed: false\n---\n\n# body`;
    const fm = parseFrontmatter(content);
    assert.equal(fm.source_type, "webhook:Test Label");
    assert.equal(fm.source_ref, "abc123:deadbeef");
    assert.equal(fm.received_at, "2026-07-21T10:00:00.000Z");
  });

  it("returns empty object when no frontmatter block", () => {
    assert.deepEqual(parseFrontmatter("no frontmatter here"), {});
  });

  it("handles null values", () => {
    const fm = parseFrontmatter("---\nkey: null\n---\n");
    assert.equal(fm.key, null);
  });
});

// ── extractPayload ────────────────────────────────────────────────────────────
describe("extractPayload", () => {
  const BODY = [
    "---\ntype: stream_event\n---\n",
    "\n# Inbound webhook payload\n\nLabel: Test\n\n",
    "```json\n",
    JSON.stringify({ recording_id: "171112331", meeting_title: "RJ sync" }),
    "\n```\n",
  ].join("");

  it("extracts valid JSON from code block", () => {
    const result = extractPayload(BODY);
    assert.ok(result !== null);
    assert.equal(result!.parsed.recording_id, "171112331");
  });

  it("returns null when no ```json block", () => {
    assert.equal(extractPayload("no code block here"), null);
  });

  it("returns parsed=null for malformed JSON", () => {
    const bad = "---\n---\n\n```json\n{not json\n```\n";
    const result = extractPayload(bad);
    assert.ok(result !== null);
    assert.equal(result!.parsed, null);
    assert.ok(result!.text.includes("{not json"));
  });
});

// ── computeExternalId ─────────────────────────────────────────────────────────
describe("computeExternalId", () => {
  it("produces a stable, deterministic key", () => {
    const id1 = computeExternalId("abc123token", '{"recording_id":"171112331"}');
    const id2 = computeExternalId("abc123token", '{"recording_id":"171112331"}');
    assert.equal(id1, id2);
  });

  it("differs across tokens (scoped to the webhook endpoint)", () => {
    const id1 = computeExternalId("tokenA", "payload");
    const id2 = computeExternalId("tokenB", "payload");
    assert.notEqual(id1, id2);
  });

  it("starts with token prefix and a colon", () => {
    const id = computeExternalId("mytoken", "{}");
    assert.ok(id.startsWith("mytoken:"));
  });

  it("hash segment is 32 hex chars", () => {
    const id = computeExternalId("tok", "{}");
    const hash = id.split(":")[1];
    assert.match(hash, /^[0-9a-f]{32}$/);
  });
});
