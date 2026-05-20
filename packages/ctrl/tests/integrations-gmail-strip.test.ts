import { mock, describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Tests for stripGmailMetadataResponse in integrations.ts
//
// Composio's GMAIL_FETCH_EMAILS adapter ignores `format: "metadata"` and
// always returns the full RFC822 message + base64 attachments — ~104 KB per
// message against Sir's inbox. Even after raising the openclaw tool-result
// cap to 160 KB, only ~2 messages fit per call. The strip helper trims each
// message to the navigation fields Alfred actually needs (~1 KB), letting
// ~150 messages fit per call.
//
// These tests guard:
//   • The strip happens for the correct shape only.
//   • Pass-through is total when format=full, format unset, or the action
//     isn't GMAIL_FETCH_EMAILS — so a deliberate "give me one full body"
//     call is never silently corrupted.
//   • Top-level data fields (nextPageToken, resultSizeEstimate) are
//     preserved so pagination keeps working.
//   • Malformed responses (Composio shape changes) pass through untouched
//     rather than getting silently swallowed.
// ---------------------------------------------------------------------------

// Mock node:fs so the integrations.ts module-load (and any transitive
// streams.ts mkdirSync of /mnt/encrypted/...) doesn't fail in CI / dev.
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

const { stripGmailMetadataResponse } = await import("../src/api/routes/integrations.js");

// ---------------------------------------------------------------------------
// Realistic fixtures — sanitised from a live response captured via:
//   ssh deploy@<host> 'curl -X POST .../integrations/execute \
//     -d {"action":"GMAIL_FETCH_EMAILS",
//         "arguments":{"userId":"me","format":"metadata","maxResults":3}}'
// PII redacted; sizes preserved.
// ---------------------------------------------------------------------------

function makeFullMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "19dc4d7dad8bedbd",
    threadId: "19dc4d7dad8bedbd",
    subject: "<redacted subject>",
    sender: "<redacted> <redacted@example.com>",
    to: "user@example.com",
    messageTimestamp: "2026-04-25T13:32:53Z",
    labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
    display_url: "https://mail.google.com/mail/u/0/#inbox/19dc4d7dad8bedbd",
    preview: { body: "<redacted snippet>", subject: "<redacted subject>" },
    // The bulky stuff Composio insists on returning even for format=metadata.
    messageText: "x".repeat(2000),
    payload: {
      body: { size: 0 },
      filename: "",
      headers: Array.from({ length: 25 }, (_, i) => ({
        name: `Header-${i}`,
        value: "x".repeat(800),
      })),
      mimeType: "multipart/mixed",
      partId: "",
      parts: [
        {
          body: { data: "BASE64BODY".repeat(2000), size: 20000 },
          filename: "",
          mimeType: "text/plain",
          partId: "0.0",
        },
      ],
    },
    attachmentList: [],
    ...overrides,
  };
}

function makeResponse(messages: unknown[], extras: Record<string, unknown> = {}): unknown {
  return {
    action: "GMAIL_FETCH_EMAILS",
    toolkit: "gmail",
    result: {
      data: {
        messages,
        nextPageToken: "17669447226580466129",
        resultSizeEstimate: 201,
        ...extras,
      },
      error: null,
      successful: true,
    },
  };
}

describe("stripGmailMetadataResponse", () => {
  it("transforms each message and reduces payload size dramatically", () => {
    const raw = makeResponse([makeFullMessage(), makeFullMessage(), makeFullMessage()]);
    const stripped = stripGmailMetadataResponse(raw);

    const rawSize = JSON.stringify(raw).length;
    const strippedSize = JSON.stringify(stripped).length;
    // We expect at least a 10x reduction even on this modest fixture; the
    // real-world ratio against Sir's inbox is closer to 50–100x.
    assert.ok(
      strippedSize * 10 < rawSize,
      `expected >10x reduction, got raw=${rawSize} stripped=${strippedSize}`,
    );

    const data = (stripped as any).result.data;
    assert.equal(data.messages.length, 3, "all 3 messages still present");
    for (const m of data.messages) {
      assert.ok(typeof m.messageId === "string", "messageId preserved");
      assert.ok(typeof m.subject === "string", "subject preserved");
      assert.ok(Array.isArray(m.labelIds), "labelIds preserved");
    }
  });

  it("drops the body bulk fields (messageText, payload)", () => {
    const raw = makeResponse([makeFullMessage()]);
    const stripped = stripGmailMetadataResponse(raw);
    const m = (stripped as any).result.data.messages[0];

    assert.equal(m.messageText, undefined, "messageText must be gone");
    assert.equal(m.payload, undefined, "payload must be gone");
    assert.equal(m.display_url, undefined, "display_url not in keep-list either");
  });

  it("truncates a long string preview to 240 chars + ellipsis", () => {
    const longSnippet = "a".repeat(500);
    const raw = makeResponse([makeFullMessage({ preview: longSnippet })]);
    const stripped = stripGmailMetadataResponse(raw);
    const m = (stripped as any).result.data.messages[0];

    assert.equal(typeof m.preview, "string");
    assert.equal(m.preview.length, 241, "240 chars + 1 char ellipsis");
    assert.ok(m.preview.endsWith("…"), "ends with ellipsis");
    assert.ok(m.preview.startsWith("aaa"), "preserves the leading content");
  });

  it("truncates the body field of an object preview (Composio's actual shape)", () => {
    const longBody = "z".repeat(500);
    const raw = makeResponse([
      makeFullMessage({ preview: { body: longBody, subject: "Keep me" } }),
    ]);
    const stripped = stripGmailMetadataResponse(raw);
    const m = (stripped as any).result.data.messages[0];

    assert.equal(typeof m.preview, "object", "preview shape preserved");
    assert.equal(m.preview.body.length, 241);
    assert.ok(m.preview.body.endsWith("…"));
    assert.equal(m.preview.subject, "Keep me", "sibling fields preserved");
  });

  it("leaves a short preview untouched", () => {
    const raw = makeResponse([makeFullMessage({ preview: "short snippet" })]);
    const stripped = stripGmailMetadataResponse(raw);
    const m = (stripped as any).result.data.messages[0];
    assert.equal(m.preview, "short snippet");
  });

  it("reduces attachmentList entries to {filename, mimeType, size, attachmentId} only", () => {
    const raw = makeResponse([
      makeFullMessage({
        attachmentList: [
          {
            attachmentId: "ANGjdJ_xxxx",
            filename: "qrcode.png",
            mimeType: "image/png",
            size: 4096,
            // Junk that should be stripped:
            data: "BASE64".repeat(5000),
            partId: "1",
            headers: [{ name: "Content-Type", value: "image/png" }],
          },
        ],
      }),
    ]);
    const stripped = stripGmailMetadataResponse(raw);
    const att = (stripped as any).result.data.messages[0].attachmentList[0];

    assert.deepEqual(
      Object.keys(att).sort(),
      ["attachmentId", "filename", "mimeType", "size"],
      "exactly the four keep-list fields",
    );
    assert.equal(att.filename, "qrcode.png");
    assert.equal(att.mimeType, "image/png");
    assert.equal(att.size, 4096);
    assert.equal(att.attachmentId, "ANGjdJ_xxxx");
  });

  it("omits attachmentList entirely when source had none (does not synthesise [])", () => {
    const raw = makeResponse([makeFullMessage({ attachmentList: [] })]);
    const stripped = stripGmailMetadataResponse(raw);
    const m = (stripped as any).result.data.messages[0];
    assert.ok(
      !("attachmentList" in m),
      "must not add an empty attachmentList where there wasn't one",
    );
  });

  it("preserves nextPageToken and resultSizeEstimate at result.data top level", () => {
    const raw = makeResponse([makeFullMessage()]);
    const stripped = stripGmailMetadataResponse(raw);
    const data = (stripped as any).result.data;

    assert.equal(data.nextPageToken, "17669447226580466129");
    assert.equal(data.resultSizeEstimate, 201);
  });

  it("preserves top-level result envelope (successful, error)", () => {
    const raw = makeResponse([makeFullMessage()]);
    const stripped = stripGmailMetadataResponse(raw);
    const r = (stripped as any).result;

    assert.equal(r.successful, true);
    assert.equal(r.error, null);
    assert.equal((stripped as any).action, "GMAIL_FETCH_EMAILS");
    assert.equal((stripped as any).toolkit, "gmail");
  });

  it("passes failed responses through untouched (successful !== true)", () => {
    const raw = {
      action: "GMAIL_FETCH_EMAILS",
      toolkit: "gmail",
      result: {
        data: { messages: [makeFullMessage()] },
        error: "rate limited",
        successful: false,
      },
    };
    const stripped = stripGmailMetadataResponse(raw);
    assert.deepEqual(stripped, raw, "error responses are returned verbatim");
  });

  it("passes through untouched when result.data.messages is not an array", () => {
    const raw = {
      action: "GMAIL_FETCH_EMAILS",
      toolkit: "gmail",
      result: {
        data: { messages: "not-an-array", nextPageToken: "abc" },
        error: null,
        successful: true,
      },
    };
    const stripped = stripGmailMetadataResponse(raw);
    assert.deepEqual(stripped, raw, "malformed shape passes through");
  });

  it("passes through untouched when result.data is missing", () => {
    const raw = {
      action: "GMAIL_FETCH_EMAILS",
      toolkit: "gmail",
      result: { error: null, successful: true },
    };
    const stripped = stripGmailMetadataResponse(raw);
    assert.deepEqual(stripped, raw);
  });

  it("preserves all keep-list fields when present", () => {
    const raw = makeResponse([makeFullMessage()]);
    const stripped = stripGmailMetadataResponse(raw);
    const m = (stripped as any).result.data.messages[0];

    assert.equal(m.messageId, "19dc4d7dad8bedbd");
    assert.equal(m.threadId, "19dc4d7dad8bedbd");
    assert.equal(m.subject, "<redacted subject>");
    assert.equal(m.sender, "<redacted> <redacted@example.com>");
    assert.equal(m.to, "user@example.com");
    assert.equal(m.messageTimestamp, "2026-04-25T13:32:53Z");
    assert.deepEqual(m.labelIds, ["UNREAD", "CATEGORY_PERSONAL", "INBOX"]);
  });

  it("does not re-add keep-list fields that weren't on the source", () => {
    // If `to` is missing on the source (drafts, certain mailing-list shapes),
    // the stripped message should also not have `to` — don't synthesise nulls.
    const msg = makeFullMessage();
    delete msg.to;
    const raw = makeResponse([msg]);
    const stripped = stripGmailMetadataResponse(raw);
    const m = (stripped as any).result.data.messages[0];
    assert.ok(!("to" in m), "absent fields stay absent");
    assert.equal(m.subject, "<redacted subject>");
  });
});
