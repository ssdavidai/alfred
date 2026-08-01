// #372 — the alfred-channel-delivery skill mandates that the agent POST an
// audit record to /api/v1/streams/ingest after every outbound Slack /
// Telegram / email / voice delivery, so a fresh session can answer "what did
// you just send me?". Those records were ALSO mirrored into ingest.db, the
// feed SignalExtractWorkflow consumes — but the extractor has no source_type
// for self-generated outbound traffic, so every one burned 5 retries and
// dead-lettered. Live on home: 100% (3/3) of `outbound-deliveries` events
// dead-lettered vs 100% success on every real inbound stream.
//
// The memory read path (/api/v1/streams/:id/events, JSONL-backed) is
// unaffected — only the Store-4 mirror is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";

const { isSelfGeneratedStreamEvent } = await import(
  "../src/api/routes/streams.js"
);

test("outbound-delivery is treated as self-generated", () => {
  assert.equal(isSelfGeneratedStreamEvent("outbound-delivery"), true);
});

test("any outbound-* stream type is self-generated", () => {
  assert.equal(isSelfGeneratedStreamEvent("outbound-sms"), true);
  assert.equal(isSelfGeneratedStreamEvent("outbound-voice"), true);
});

test("case and whitespace tolerant", () => {
  assert.equal(isSelfGeneratedStreamEvent("  Outbound-Delivery "), true);
});

test("real inbound streams still mirror to ingest.db", () => {
  for (const t of ["email", "gmail", "slack", "webhook", "media", "system"]) {
    assert.equal(isSelfGeneratedStreamEvent(t), false, t);
  }
});

test("undefined stream type is not self-generated", () => {
  assert.equal(isSelfGeneratedStreamEvent(undefined), false);
});
