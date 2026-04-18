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
