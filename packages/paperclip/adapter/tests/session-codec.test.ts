/**
 * Session codec tests — verify both the new shape and the legacy
 * `sessionId` migration path stay alive.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sessionCodec } from "../src/server/session-codec.js";

describe("sessionCodec.deserialize", () => {
  it("returns null for non-objects", () => {
    assert.equal(sessionCodec.deserialize(null), null);
    assert.equal(sessionCodec.deserialize("string"), null);
    assert.equal(sessionCodec.deserialize([]), null);
  });

  it("returns null when no key field present", () => {
    assert.equal(sessionCodec.deserialize({}), null);
    assert.equal(sessionCodec.deserialize({ unrelated: "x" }), null);
  });

  it("reads the new sessionKey field", () => {
    assert.deepEqual(
      sessionCodec.deserialize({ sessionKey: "paperclip-abc" }),
      { sessionKey: "paperclip-abc" },
    );
  });

  it("falls back to legacy sessionId", () => {
    assert.deepEqual(
      sessionCodec.deserialize({ sessionId: "legacy-cli-id" }),
      { sessionKey: "legacy-cli-id" },
    );
  });

  it("trims whitespace", () => {
    assert.deepEqual(
      sessionCodec.deserialize({ sessionKey: "  paperclip-abc  " }),
      { sessionKey: "paperclip-abc" },
    );
  });
});

describe("sessionCodec.serialize", () => {
  it("normalises to {sessionKey}", () => {
    assert.deepEqual(sessionCodec.serialize({ sessionKey: "k" }), {
      sessionKey: "k",
    });
    assert.deepEqual(sessionCodec.serialize({ sessionId: "k" }), {
      sessionKey: "k",
    });
  });

  it("returns null for empty input", () => {
    assert.equal(sessionCodec.serialize(null), null);
    assert.equal(sessionCodec.serialize({}), null);
  });
});

describe("sessionCodec.getDisplayId", () => {
  it("surfaces whichever field is set", () => {
    assert.equal(
      sessionCodec.getDisplayId?.({ sessionKey: "paperclip-x" }),
      "paperclip-x",
    );
    assert.equal(
      sessionCodec.getDisplayId?.({ sessionId: "legacy-y" }),
      "legacy-y",
    );
    assert.equal(sessionCodec.getDisplayId?.(null), null);
  });
});
