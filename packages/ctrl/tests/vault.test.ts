import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks — must be registered before any import of code that uses them
// ---------------------------------------------------------------------------

// Configurable execFile behavior (docker exec calls from vault write routes)
let execFileStdout = '{"ok":true}';
const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as Function;
  cb(null, execFileStdout, "");
});

mock.module("node:child_process", {
  namedExports: {
    execFile: execFileFn,
    spawn: mock.fn(() => ({ stderr: { on: mock.fn() }, stdin: { write: mock.fn(), end: mock.fn() }, on: mock.fn() })),
  },
});

// Configurable fs behavior
const mkdirFn = mock.fn(async () => undefined);
const writeFileFn = mock.fn(async () => undefined);
const readFileSyncFn = mock.fn((_path: string) => "");
const writeFileSyncFn = mock.fn(() => {});
const readdirSyncFn = mock.fn(() => [] as any[]);

const mkdirSyncFn = mock.fn();
const existsSyncFn = mock.fn(() => false);
const statSyncFn = mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false }));
const unlinkSyncFn = mock.fn();
const renameSyncFn = mock.fn();
const appendFileSyncFn = mock.fn();
const openSyncFn = mock.fn(() => 0);
const readSyncFn = mock.fn(() => 0);
const closeSyncFn = mock.fn();
const createReadStreamFn = mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() }));

const fsMock = {
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
  readdirSync: readdirSyncFn,
  mkdirSync: mkdirSyncFn,
  existsSync: existsSyncFn,
  statSync: statSyncFn,
  unlinkSync: unlinkSyncFn,
  renameSync: renameSyncFn,
  appendFileSync: appendFileSyncFn,
  openSync: openSyncFn,
  readSync: readSyncFn,
  closeSync: closeSyncFn,
  createReadStream: createReadStreamFn,
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mkdirFn, writeFile: writeFileFn },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: readFileSyncFn,
    writeFileSync: writeFileSyncFn,
    readdirSync: readdirSyncFn,
    mkdirSync: mkdirSyncFn,
    existsSync: existsSyncFn,
    statSync: statSyncFn,
    unlinkSync: unlinkSyncFn,
    renameSync: renameSyncFn,
    appendFileSync: appendFileSyncFn,
    openSync: openSyncFn,
    readSync: readSyncFn,
    closeSync: closeSyncFn,
    createReadStream: createReadStreamFn,
    Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  },
});

// ---------------------------------------------------------------------------
// Server setup — dynamic import after mocks are in place
// ---------------------------------------------------------------------------

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => { raw += c.toString(); });
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, data: raw }); }
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/vault/schema", () => {
  it("returns known_types and status_by_type", async () => {
    const { status, data } = await req("GET", "/api/v1/vault/schema");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.known_types), "known_types should be an array");
    assert.ok(data.known_types.includes("note"), "should include 'note'");
    assert.ok(data.known_types.includes("task"), "should include 'task'");
    assert.ok(typeof data.status_by_type === "object", "status_by_type should be an object");
  });
});

describe("GET /api/v1/vault/list/:type", () => {
  it("returns 200 with empty results for a valid type", async () => {
    readdirSyncFn.mock.mockImplementation(() => []);
    const { status, data } = await req("GET", "/api/v1/vault/list/note");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.results));
    assert.strictEqual(data.count, 0);
  });

  it("returns 400 for an unknown type", async () => {
    const { status, data } = await req("GET", "/api/v1/vault/list/foobar_unknown");
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("Unknown vault type"));
  });
});

describe("POST /api/v1/vault/records", () => {
  it("returns 400 when type is missing", async () => {
    const { status, data } = await req("POST", "/api/v1/vault/records", { name: "Test" });
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("type and name are required"));
  });

  it("returns 400 when name is missing", async () => {
    const { status, data } = await req("POST", "/api/v1/vault/records", { type: "note" });
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("type and name are required"));
  });

  it("writes file and returns 201 when content is provided", async () => {
    mkdirFn.mock.resetCalls();
    writeFileFn.mock.resetCalls();
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "note",
      name: "my-note",
      content: "---\ntype: note\n---\nHello",
    });
    assert.strictEqual(status, 201);
    assert.ok(typeof data.path === "string", "should return a path");
    assert.strictEqual(mkdirFn.mock.callCount(), 1, "mkdir should be called once");
    assert.strictEqual(writeFileFn.mock.callCount(), 1, "writeFile should be called once");
  });
});

describe("GET /api/v1/vault/records/* (path traversal)", () => {
  it("returns 400 for a path traversal attempt", async () => {
    const { status, data } = await req("GET", "/api/v1/vault/records/..%2Fetc%2Fpasswd");
    assert.strictEqual(status, 400);
    assert.ok(
      data.error.message.includes("traversal") || data.error.message.includes("Absolute"),
      `expected traversal error, got: ${data.error.message}`
    );
  });
});

describe("PATCH /api/v1/vault/records/*", () => {
  it("calls dockerExec and returns 200", async () => {
    execFileStdout = '{"updated":true}';
    execFileFn.mock.resetCalls();
    const { status, data } = await req(
      "PATCH",
      "/api/v1/vault/records/note/test-record.md",
      { set: { status: "active" } }
    );
    assert.strictEqual(status, 200);
    assert.ok(execFileFn.mock.callCount() >= 1, "execFile should be called");
    assert.deepStrictEqual(data, { updated: true });
  });
});

describe("DELETE /api/v1/vault/records/*", () => {
  it("calls dockerExec and returns 200", async () => {
    execFileStdout = '{"deleted":true}';
    execFileFn.mock.resetCalls();
    const { status, data } = await req("DELETE", "/api/v1/vault/records/note/test-record.md");
    assert.strictEqual(status, 200);
    assert.ok(execFileFn.mock.callCount() >= 1, "execFile should be called");
    assert.deepStrictEqual(data, { deleted: true });
  });
});

describe("POST /api/v1/vault/inbox (binary upload + media routing)", () => {
  // A 1x1 transparent PNG
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
  // MD5 is used only to assert byte-perfect write
  const PNG_MD5 = crypto.createHash("md5").update(PNG_BYTES).digest("hex");

  it("decodes base64 content to raw bytes on disk", async () => {
    writeFileSyncFn.mock.resetCalls();
    appendFileSyncFn.mock.resetCalls();

    const { status, data } = await req("POST", "/api/v1/vault/inbox", {
      filename: "pixel.png",
      content: PNG_BASE64,
      encoding: "base64",
    });

    assert.strictEqual(status, 201);
    assert.strictEqual(data.filename, "pixel.png");
    assert.strictEqual(data.binary, true);

    // First writeFileSync call should be the file write — with raw Buffer bytes
    const firstCall = writeFileSyncFn.mock.calls[0];
    assert.ok(firstCall, "writeFileSync should have been called");
    const writtenPath = firstCall.arguments[0] as string;
    const writtenBuf = firstCall.arguments[1] as Buffer;
    assert.ok(writtenPath.endsWith("/inbox/pixel.png"), `path was ${writtenPath}`);
    assert.ok(Buffer.isBuffer(writtenBuf), "content must be written as a Buffer (raw bytes)");
    const md5 = crypto.createHash("md5").update(writtenBuf).digest("hex");
    assert.strictEqual(md5, PNG_MD5, "on-disk bytes must match input md5");
    assert.strictEqual(writtenBuf.length, PNG_BYTES.length);
  });

  it("emits a media stream event for image uploads", async () => {
    writeFileSyncFn.mock.resetCalls();
    appendFileSyncFn.mock.resetCalls();

    const { status, data } = await req("POST", "/api/v1/vault/inbox", {
      filename: "shot.png",
      content: PNG_BASE64,
      encoding: "base64",
    });

    assert.strictEqual(status, 201);
    assert.strictEqual(data.media_type, "image");
    assert.ok(typeof data.media_event_id === "string" && data.media_event_id.length > 0);

    // At least one appendFileSync call should carry a media stream event JSON
    const mediaCalls = appendFileSyncFn.mock.calls.filter((c) => {
      const line = c.arguments[1];
      return typeof line === "string" && line.includes('"stream_type":"media"');
    });
    assert.ok(mediaCalls.length >= 1, "expected a stream event with stream_type=media");
    const line = mediaCalls[0].arguments[1] as string;
    const evt = JSON.parse(line.trim());
    assert.strictEqual(evt.stream_type, "media");
    assert.strictEqual(evt.file_name, "shot.png");
    assert.ok(String(evt.file_path).endsWith("/vault/inbox/shot.png"));
  });

  it("does NOT emit a media event for plain text uploads", async () => {
    writeFileSyncFn.mock.resetCalls();
    appendFileSyncFn.mock.resetCalls();

    const { status, data } = await req("POST", "/api/v1/vault/inbox", {
      filename: "note.md",
      content: "# hello\n",
    });

    assert.strictEqual(status, 201);
    assert.strictEqual(data.media_type, undefined);
    const mediaCalls = appendFileSyncFn.mock.calls.filter((c) => {
      const line = c.arguments[1];
      return typeof line === "string" && line.includes('"stream_type":"media"');
    });
    assert.strictEqual(mediaCalls.length, 0, ".md files should not trigger media routing");
  });

  it("does NOT emit a media event for .txt uploads (falls through to curator)", async () => {
    writeFileSyncFn.mock.resetCalls();
    appendFileSyncFn.mock.resetCalls();

    const { status, data } = await req("POST", "/api/v1/vault/inbox", {
      filename: "plain.txt",
      content: "just some text\n",
    });

    assert.strictEqual(status, 201);
    assert.strictEqual(data.media_type, undefined);
    const mediaCalls = appendFileSyncFn.mock.calls.filter((c) => {
      const line = c.arguments[1];
      return typeof line === "string" && line.includes('"stream_type":"media"');
    });
    assert.strictEqual(mediaCalls.length, 0, ".txt files should not trigger media routing");
  });

  it("does NOT emit a media event for extensions outside learn's supported set (.flac)", async () => {
    writeFileSyncFn.mock.resetCalls();
    appendFileSyncFn.mock.resetCalls();

    const { status, data } = await req("POST", "/api/v1/vault/inbox", {
      filename: "song.flac",
      content: Buffer.from([0x66, 0x4c, 0x61, 0x43]).toString("base64"),
      encoding: "base64",
    });

    assert.strictEqual(status, 201);
    assert.strictEqual(data.media_type, undefined);
    const mediaCalls = appendFileSyncFn.mock.calls.filter((c) => {
      const line = c.arguments[1];
      return typeof line === "string" && line.includes('"stream_type":"media"');
    });
    assert.strictEqual(mediaCalls.length, 0, ".flac is not in learn's supported set — should not route as media");
  });

  it("handles bulk upload with mixed media and text", async () => {
    writeFileSyncFn.mock.resetCalls();
    appendFileSyncFn.mock.resetCalls();

    const { status, data } = await req("POST", "/api/v1/vault/inbox/bulk", {
      files: [
        { filename: "a.png", content: PNG_BASE64, encoding: "base64" },
        { filename: "b.md", content: "hi" },
      ],
    });

    assert.strictEqual(status, 201);
    assert.strictEqual(data.filenames.length, 2);
    const pngEntry = data.files.find((f: any) => f.filename === "a.png");
    const mdEntry = data.files.find((f: any) => f.filename === "b.md");
    assert.strictEqual(pngEntry.media_type, "image");
    assert.strictEqual(pngEntry.binary, true);
    assert.strictEqual(mdEntry.media_type, undefined);
    assert.strictEqual(mdEntry.binary, false);
  });
});

describe("GET /api/v1/vault/records/* — YAML plain-scalar continuation (#611)", () => {
  // python-frontmatter (used by `alfred vault edit`) wraps long unquoted
  // string values across multiple indented lines (YAML plain-scalar
  // folding). The pre-fix ctrl-api parser only kept the first line,
  // silently truncating descriptions at ~68-80 chars. Regression tests
  // pin the parser to fold indented continuations back together with
  // a single space.

  it("reassembles a description that wraps across multiple indented lines", async () => {
    const content = [
      "---",
      "created: 2026-04-24 06:06:16.439419+00:00",
      "description: Erste Agentic Coding Makerspace program—your February-prepared proposal",
      "  accepted 2026-04-18—requires IT security kickoff to initiate 12-week training for",
      "  20–30 Erste Bank developers in compliant agentic coding harnesses using GitHub Copilot.",
      "  Involves Peti and Alexa; leverages GitHub and Microsoft. Originates from Omi's 2026-04-17",
      "  conversation affirming Copilot as safe compliance choice.",
      "name: organize IT security kickoff",
      "status: todo",
      "type: task",
      "---",
      "",
    ].join("\n");
    readFileSyncFn.mock.mockImplementationOnce(() => content);

    const { status, data } = await req(
      "GET",
      "/api/v1/vault/records/task/1828ac84-organize-it-security-kickoff.md",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(
      data.frontmatter.description,
      "Erste Agentic Coding Makerspace program—your February-prepared proposal accepted 2026-04-18—requires IT security kickoff to initiate 12-week training for 20–30 Erste Bank developers in compliant agentic coding harnesses using GitHub Copilot. Involves Peti and Alexa; leverages GitHub and Microsoft. Originates from Omi's 2026-04-17 conversation affirming Copilot as safe compliance choice.",
    );
    // Sibling fields after the multi-line scalar must parse normally.
    assert.strictEqual(data.frontmatter.name, "organize IT security kickoff");
    assert.strictEqual(data.frontmatter.status, "todo");
    assert.strictEqual(data.frontmatter.type, "task");
  });

  it("preserves short single-line descriptions verbatim", async () => {
    const content = [
      "---",
      "description: Short single-line description.",
      "name: Simple task",
      "type: task",
      "---",
      "",
    ].join("\n");
    readFileSyncFn.mock.mockImplementationOnce(() => content);

    const { status, data } = await req(
      "GET",
      "/api/v1/vault/records/task/simple.md",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.frontmatter.description, "Short single-line description.");
    assert.strictEqual(data.frontmatter.name, "Simple task");
  });

  it("does not fold list items into the preceding scalar", async () => {
    // A long description followed immediately by a list field must
    // not eat the list items into the description.
    const content = [
      "---",
      "description: This description wraps across two lines and",
      "  ends at the indented continuation before the list.",
      "related_matters:",
      "- matter/example.md",
      "- matter/other.md",
      "name: wrap-then-list",
      "type: task",
      "---",
      "",
    ].join("\n");
    readFileSyncFn.mock.mockImplementationOnce(() => content);

    const { status, data } = await req(
      "GET",
      "/api/v1/vault/records/task/wrap-then-list.md",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(
      data.frontmatter.description,
      "This description wraps across two lines and ends at the indented continuation before the list.",
    );
    assert.deepStrictEqual(data.frontmatter.related_matters, [
      "matter/example.md",
      "matter/other.md",
    ]);
    assert.strictEqual(data.frontmatter.name, "wrap-then-list");
  });

  it("handles descriptions containing opening braces and curly brackets", async () => {
    // Per YAML 1.2 (and python-frontmatter / PyYAML), a plain scalar
    // that begins with `{` is ambiguous with a flow mapping, so PyYAML
    // emits such values single-quoted. The regression the old regex
    // parser lucked into (treating a leading `{` as part of a plain
    // scalar) is not spec-conformant — js-yaml correctly requires the
    // author to quote. This test pins the spec-compliant shape that
    // python-frontmatter actually produces when `emits` is re-serialised.
    const content = [
      "---",
      "description: 'The clerk emits JSON like {\"description\": \"...\"} — this",
      "  wrapped line contains a literal } character mid-sentence and must",
      "  survive the fold without corruption.'",
      "name: brace-test",
      "type: task",
      "---",
      "",
    ].join("\n");
    readFileSyncFn.mock.mockImplementationOnce(() => content);

    const { status, data } = await req(
      "GET",
      "/api/v1/vault/records/task/brace-test.md",
    );
    assert.strictEqual(status, 200);
    assert.ok(
      data.frontmatter.description.includes('JSON like {"description": "..."}'),
      "inline { and } must be preserved",
    );
    assert.ok(
      data.frontmatter.description.includes("literal } character mid-sentence"),
      "continuation with a literal } must fold intact",
    );
  });

  it("closes plain-scalar folding when a new top-level key appears", async () => {
    // Non-indented lines (0-column) that match `key: ...` must end the
    // fold, not be treated as continuation.
    const content = [
      "---",
      "description: Line one of the scalar that",
      "  wraps once into a second line.",
      "status: todo",
      "name: boundary-test",
      "type: task",
      "---",
      "",
    ].join("\n");
    readFileSyncFn.mock.mockImplementationOnce(() => content);

    const { status, data } = await req(
      "GET",
      "/api/v1/vault/records/task/boundary-test.md",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(
      data.frontmatter.description,
      "Line one of the scalar that wraps once into a second line.",
    );
    assert.strictEqual(data.frontmatter.status, "todo");
    assert.strictEqual(data.frontmatter.name, "boundary-test");
  });

  it("still folds a quoted multi-line string (single-quoted)", async () => {
    // Existing behaviour for single-quoted multi-line strings must keep
    // working. PyYAML uses single-quoted blocks when the value contains
    // special characters (timestamps etc.); truncation of those would
    // be a separate regression.
    const content = [
      "---",
      "updated: '2026-04-24T07:46:24Z'",
      "description: 'A single-quoted string that",
      "  wraps across a line break.'",
      "name: quoted-wrap",
      "type: task",
      "---",
      "",
    ].join("\n");
    readFileSyncFn.mock.mockImplementationOnce(() => content);

    const { status, data } = await req(
      "GET",
      "/api/v1/vault/records/task/quoted-wrap.md",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.frontmatter.updated, "2026-04-24T07:46:24Z");
    assert.strictEqual(
      data.frontmatter.description,
      "A single-quoted string that wraps across a line break.",
    );
  });
});

describe("GET /api/v1/vault/records/* — plain-scalar type coercion (bool / null)", () => {
  // Regression for 2026-04-24 cascade: ctrl-api was returning YAML bool
  // values as strings ("false" / "true"), so Python consumers reading
  // `fm.get("archived")` saw the truthy string "false" and took the
  // archive-cascade branch, silently archiving hundreds of active
  // Rapali tasks. Fixed by coercing unquoted plain scalars to their
  // typed form.

  it("returns archived: false as a JS boolean, not the string 'false'", async () => {
    const content = [
      "---",
      "archived: false",
      "archived_at: ''",
      "archived_reason: ''",
      "name: a real active task",
      "type: task",
      "---",
      "",
    ].join("\n");
    readFileSyncFn.mock.mockImplementationOnce(() => content);

    const { status, data } = await req(
      "GET",
      "/api/v1/vault/records/task/active-task.md",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.frontmatter.archived, false);
    assert.strictEqual(typeof data.frontmatter.archived, "boolean");
    // Truthy-falsy assertion that specifically guards plane_sync's path
    assert.ok(!data.frontmatter.archived, "archived:false must be falsy");
  });

  it("returns archived: true as a JS boolean, not the string 'true'", async () => {
    const content = [
      "---",
      "archived: true",
      "name: archived task",
      "type: task",
      "---",
      "",
    ].join("\n");
    readFileSyncFn.mock.mockImplementationOnce(() => content);

    const { status, data } = await req(
      "GET",
      "/api/v1/vault/records/task/archived-task.md",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.frontmatter.archived, true);
    assert.strictEqual(typeof data.frontmatter.archived, "boolean");
  });

  // NOTE: `null`/`~` tokens are intentionally mapped to the empty string
  // by parseFrontmatter (legacy contract: downstream consumers expect
  // "" for missing optional fields, not JS null). Type coercion of
  // booleans flows through js-yaml natively.

  it("preserves QUOTED true/false as strings", async () => {
    // An author who wrote archived: "false" meant the literal string,
    // not a boolean — don't second-guess them.
    const content = [
      "---",
      "archived: 'false'",
      "name: quoted-false",
      "type: task",
      "---",
      "",
    ].join("\n");
    readFileSyncFn.mock.mockImplementationOnce(() => content);

    const { status, data } = await req(
      "GET",
      "/api/v1/vault/records/task/quoted-false.md",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.frontmatter.archived, "false");
    assert.strictEqual(typeof data.frontmatter.archived, "string");
  });

  it("does not coerce string values that merely contain 'true'/'false'", async () => {
    const content = [
      "---",
      "name: truefalse-in-name",
      "description: This task says true things and false things",
      "type: task",
      "---",
      "",
    ].join("\n");
    readFileSyncFn.mock.mockImplementationOnce(() => content);

    const { status, data } = await req(
      "GET",
      "/api/v1/vault/records/task/truefalse.md",
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.frontmatter.name, "truefalse-in-name");
    assert.strictEqual(
      data.frontmatter.description,
      "This task says true things and false things",
    );
  });
});

describe("emitStreamEvent reserved-key filtering", () => {
  it("ignores reserved keys passed via extra and preserves generated values", async () => {
    appendFileSyncFn.mock.resetCalls();
    const { emitStreamEvent } = await import("../src/api/routes/streams.js");

    const event = emitStreamEvent({
      stream_id: "system-inbox",
      stream_type: "media",
      source_ref: "inbox:real.png",
      summary: "real summary",
      extra: {
        // Reserved — must be filtered out
        id: "spoofed-id",
        stream_id: "spoofed-stream",
        stream_type: "spoofed-type",
        tenant_id: "spoofed-tenant",
        received_at: "1999-01-01T00:00:00Z",
        source_ref: "spoofed:source",
        raw: { spoofed: true },
        summary: "spoofed summary",
        // Non-reserved — must be preserved
        file_name: "real.png",
        custom_field: "ok",
      },
    });

    assert.notStrictEqual(event.id, "spoofed-id");
    assert.strictEqual(event.stream_id, "system-inbox");
    assert.strictEqual(event.stream_type, "media");
    assert.strictEqual(event.source_ref, "inbox:real.png");
    assert.strictEqual(event.summary, "real summary");
    assert.notStrictEqual(event.received_at, "1999-01-01T00:00:00Z");
    assert.notDeepStrictEqual(event.raw, { spoofed: true });
    // @ts-expect-error — dynamic extra field
    assert.strictEqual(event.file_name, "real.png");
    // @ts-expect-error — dynamic extra field
    assert.strictEqual(event.custom_field, "ok");
  });
});
