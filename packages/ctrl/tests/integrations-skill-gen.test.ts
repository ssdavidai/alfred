import { mock, describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Tests for buildToolkitGuidance and DEFAULT_ARGS in integrations.ts
//
// These tests exist because Alfred was only seeing 1 message per Gmail
// fetch call regardless of maxResults — the openclaw runtime caps tool
// results at ~15 KB and a full Gmail message is ~14 KB. The fix:
//   1. Default GMAIL_FETCH_EMAILS to format=metadata + maxResults=50
//   2. Inject a "Reading email — payload-size budget" section into the
//      generated alfred-composio-gmail SKILL.md teaching pagination.
//
// If a future change drops the format=metadata default OR the worked-example
// pagination loop, Alfred's morning email triage silently regresses to
// "1 message per call". These tests guard against that.
// ---------------------------------------------------------------------------

// Mock node:fs so the streams.ts module-load mkdirSync of /mnt/encrypted/...
// doesn't fail in CI / dev machines where that path doesn't exist.
const mkdirSyncFn = mock.fn(() => undefined);
const writeFileSyncFn = mock.fn(() => undefined);
const readFileSyncFn = mock.fn(() => "{}");
const readdirSyncFn = mock.fn(() => [] as any[]);
const existsSyncFn = mock.fn(() => false);
const statSyncFn = mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false }));
const unlinkSyncFn = mock.fn();
const renameSyncFn = mock.fn();
const appendFileSyncFn = mock.fn();
const openSyncFn = mock.fn(() => 0);
const readSyncFn = mock.fn(() => 0);
const closeSyncFn = mock.fn();
const createReadStreamFn = mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() }));
const chownSyncFn = mock.fn();

const fsMock = {
  mkdirSync: mkdirSyncFn,
  writeFileSync: writeFileSyncFn,
  readFileSync: readFileSyncFn,
  readdirSync: readdirSyncFn,
  existsSync: existsSyncFn,
  statSync: statSyncFn,
  unlinkSync: unlinkSyncFn,
  renameSync: renameSyncFn,
  appendFileSync: appendFileSyncFn,
  openSync: openSyncFn,
  readSync: readSyncFn,
  closeSync: closeSyncFn,
  createReadStream: createReadStreamFn,
  chownSync: chownSyncFn,
  promises: { mkdir: mock.fn(async () => undefined), writeFile: mock.fn(async () => undefined) },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    mkdirSync: mkdirSyncFn,
    writeFileSync: writeFileSyncFn,
    readFileSync: readFileSyncFn,
    readdirSync: readdirSyncFn,
    existsSync: existsSyncFn,
    statSync: statSyncFn,
    unlinkSync: unlinkSyncFn,
    renameSync: renameSyncFn,
    appendFileSync: appendFileSyncFn,
    openSync: openSyncFn,
    readSync: readSyncFn,
    closeSync: closeSyncFn,
    createReadStream: createReadStreamFn,
    chownSync: chownSyncFn,
  },
});

const { buildToolkitGuidance, buildUserIdClarification } = await import("../src/api/routes/integrations.js");

describe("buildToolkitGuidance", () => {
  it("returns empty string for non-gmail toolkits", () => {
    assert.strictEqual(buildToolkitGuidance("notion"), "");
    assert.strictEqual(buildToolkitGuidance("slack"), "");
    assert.strictEqual(buildToolkitGuidance("googlecalendar"), "");
    assert.strictEqual(buildToolkitGuidance("github"), "");
    assert.strictEqual(buildToolkitGuidance(""), "");
  });

  describe("gmail toolkit", () => {
    const md = buildToolkitGuidance("gmail");

    it("teaches the format=metadata default", () => {
      assert.match(md, /format/, "should mention 'format'");
      assert.match(md, /metadata/, "should mention 'metadata'");
      assert.match(
        md,
        /format:\s*"metadata"/,
        'worked example must literally show format: "metadata"',
      );
    });

    it("teaches pageToken pagination", () => {
      assert.match(md, /pageToken/, "should mention 'pageToken'");
      assert.match(md, /nextPageToken/, "should mention 'nextPageToken'");
    });

    it("teaches Gmail's native query syntax for time windows", () => {
      assert.match(
        md,
        /newer_than/,
        "should teach newer_than: query syntax (Gmail's native time filter)",
      );
    });

    it("documents the 15 KB tool-result cap warning", () => {
      assert.match(
        md,
        /15\s*KB/i,
        "should warn about the openclaw ~15 KB tool-result cap",
      );
      assert.match(
        md,
        /14\s*KB/i,
        "should explain that one full Gmail message is ~14 KB (i.e. why one fits, not many)",
      );
    });

    it("includes a runnable worked example using self() + integrations/execute", () => {
      // The worked example must use the MCP self tool, not any ghost
      // ctrl_* name (#430 regression class).
      assert.match(md, /self\(/, "worked example must call self()");
      assert.match(
        md,
        /\/api\/v1\/integrations\/execute/,
        "worked example must hit the integrations/execute endpoint",
      );
      assert.match(
        md,
        /GMAIL_FETCH_EMAILS/,
        "worked example must use the actual action name",
      );
      assert.doesNotMatch(
        md,
        /ctrl_/,
        "worked example must NOT use legacy ctrl_* tool names (#431)",
      );
    });

    it("explains when to use format=full (single message lookup)", () => {
      assert.match(
        md,
        /format:\s*"full"/,
        "should show format: \"full\" for the one-message case",
      );
    });
  });
});

describe("buildUserIdClarification", () => {
  // Rapali's Alfred wasted ~10s confused by a Slack response saying
  // `user_id: "alfred-rapali-101"` (the tenant's Composio identity), trying
  // to reconcile it with a Slack U-id. The clarification block in every
  // generated alfred-composio-* SKILL.md guards against that misread.
  const md = buildUserIdClarification();

  it("names the field that confuses the agent", () => {
    assert.match(md, /user_id/, "must mention the user_id field by name");
  });

  it("makes it clear this is the TENANT identity, not the human's app identity", () => {
    assert.match(md, /tenant/i, "should label the value as the tenant's identity");
    assert.match(
      md,
      /alfred-/,
      "should give the actual `alfred-<tenant>-<n>` shape so the agent recognises it",
    );
  });

  it("redirects the agent to KNOWN_CONTACTS.md for the human's per-app identity", () => {
    assert.match(
      md,
      /KNOWN_CONTACTS\.md/,
      "must point at KNOWN_CONTACTS.md as the source of truth for per-app identity",
    );
  });

  it("warns against feeding the Composio user_id back into app-native targeting fields", () => {
    assert.match(
      md,
      /never|do not|don't/i,
      "should explicitly forbid passing the Composio user_id into provider user fields",
    );
  });
});
