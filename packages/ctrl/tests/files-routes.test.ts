// /api/v1/files/* — PR 1 of issue #114.
//
// What's under test
// -----------------
// Store 5 (files) HTTP routes — the principal-facing blob store that
// replaces the cramped vault-inbox base64 path. The PR 1 surface:
//
//   * POST   /api/v1/files/upload     multipart streaming → /files/<ULID>/<name>
//   * GET    /api/v1/files/list       paginated metadata list
//   * GET    /api/v1/files/usage      bytes + caps
//   * GET    /api/v1/files/stat/*     metadata-only
//   * GET    /api/v1/files/blob/*     streamed bytes
//   * DELETE /api/v1/files/*          soft-delete (tombstone + unlink)
//
// We exercise the handlers directly via matchRoute + a handleError
// shim — same posture as channels_paperclip.test.ts — so thrown
// ApiErrors land as JSON envelopes rather than bubbling up into the
// test runner. The state.db handle lives in an mkdtemp dir; the
// blob root (FILES_ROOT) also lives in mkdtemp so the test never
// touches /files on the host.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── one-shot env wiring ────────────────────────────────────────────────────
//
// Must happen before `state.ts` (and therefore migrate.ts) is loaded —
// the module cache opens alfred-state.db at first import. Using mkdtemp
// matches the discipline channels_paperclip.test.ts uses.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "files-routes-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.SQLITE_VEC_PATH = "";
const FILES_ROOT = path.join(tmp, "files");
process.env.FILES_ROOT = FILES_ROOT;
// Tight quota for the quota-exceeded test (override at the top so it
// applies on first module import). 1 MiB hard, 512 KiB soft — comfortably
// above the 32-byte sample blobs the other tests upload.
process.env.FILES_QUOTA_HARD_BYTES = String(1024 * 1024);
process.env.FILES_QUOTA_SOFT_BYTES = String(512 * 1024);
// #114 Lane B — disable the fire-and-forget FileExtractionWorkflow
// trigger. The test harness has no temporal CLI to dispatch to; the
// catch-and-warn would log noisily on every upload assertion. The
// trigger is unit-tested separately in the extraction.test.ts file.
process.env.FILES_EXTRACTION_ENABLED = "false";

// ── module imports (after env is set) ──────────────────────────────────────

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerFilesRoutes, sanitizeFilename, ulid } = await import(
  "../src/api/routes/files.js"
);
const { getStateDb } = await import("../src/db/state.js");
registerFilesRoutes();

// ── invokeRoute helper — mirrors channels_paperclip.test.ts ───────────────

type InvokeOpts = {
  body?: unknown;
  headers?: Record<string, string>;
  rawBodyChunks?: Buffer[];
  url?: string;
};

async function invokeRoute(
  method: string,
  routePath: string,
  opts: InvokeOpts = {},
): Promise<{
  status: number;
  payload: any;
  rawBody: Buffer;
  headers: Record<string, string | number>;
}> {
  const matched = matchRoute(method, routePath);
  assert.ok(matched, `${method} ${routePath} must be registered`);
  let status = 0;
  const bodyChunks: Buffer[] = [];
  const responseHeaders: Record<string, string | number> = {};

  // Build the response as a real PassThrough so fs.createReadStream
  // can .pipe(res) without exploding on missing writable internals
  // (the blob GET route streams the bytes back). The PassThrough also
  // doubles as the byte sink the test reads to assert what got sent.
  const pt = new PassThrough();
  pt.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
  const finished = new Promise<void>((resolve) => {
    pt.on("end", () => resolve());
    pt.on("finish", () => resolve());
  });
  const res = Object.assign(pt, {
    statusCode: 0,
    setHeader(k: string, v: string | number) {
      responseHeaders[k] = v;
    },
    writeHead(code: number, hdrs?: Record<string, string | number>) {
      status = code;
      (res as any).statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) responseHeaders[k] = v;
      }
      return res;
    },
  }) as unknown as ServerResponse & PassThrough;

  // Build a fake IncomingMessage. For multipart uploads the test
  // supplies rawBodyChunks; we wrap them in a PassThrough so the
  // handler's `req.on("data") / req.on("end")` listeners fire as
  // they would over the wire.
  let req: IncomingMessage;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = String(v);
  }
  if (opts.rawBodyChunks && opts.rawBodyChunks.length > 0) {
    const pt = new PassThrough();
    for (const c of opts.rawBodyChunks) pt.write(c);
    pt.end();
    req = Object.assign(pt, {
      method,
      url: opts.url ?? routePath,
      headers,
    }) as unknown as IncomingMessage;
  } else {
    req = {
      method,
      url: opts.url ?? routePath,
      headers,
      on() {
        return req;
      },
      once() {
        return req;
      },
    } as unknown as IncomingMessage;
  }

  // Parse query string from opts.url if provided.
  let query = new URLSearchParams();
  if (opts.url && opts.url.includes("?")) {
    query = new URLSearchParams(opts.url.slice(opts.url.indexOf("?") + 1));
  }

  try {
    await matched.handler({
      req,
      res,
      params: matched.params,
      body: opts.body,
      query,
    });
  } catch (err) {
    handleError(res, err);
  }
  // The blob route .pipe()s a file ReadStream into res and returns
  // before the pipe settles. JSON routes call res.end() synchronously
  // inside sendJson, so `finished` resolves on the next tick. In both
  // cases the route — not the harness — is what ends the response;
  // we just wait for whichever path the route picked to flush.
  await finished;
  const rawBody = Buffer.concat(bodyChunks);
  // Try to parse JSON; if the route streamed binary back, leave payload
  // null and trust the rawBody / status assertions instead.
  let payload: any = null;
  if (
    rawBody.length > 0 &&
    (rawBody[0] === 0x7b || rawBody[0] === 0x5b /* { or [ */)
  ) {
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      payload = null;
    }
  }
  return { status, payload, rawBody, headers: responseHeaders };
}

// ── multipart helper ──────────────────────────────────────────────────────
//
// Build a single-part multipart/form-data body keyed `file`, plus
// optional text fields. Returns the boundary header value + the raw
// byte buffer the handler will see on the wire.

interface MultipartBuilder {
  boundary: string;
  body: Buffer;
}

function buildMultipart(
  fileContent: Buffer,
  fileFilename: string,
  fileMime: string,
  textFields: Record<string, string> = {},
): MultipartBuilder {
  const boundary = `----alfred-test-${crypto.randomBytes(8).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(textFields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf-8"));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${name}"\r\n\r\n`,
        "utf-8",
      ),
    );
    chunks.push(Buffer.from(value, "utf-8"));
    chunks.push(Buffer.from("\r\n", "utf-8"));
  }
  chunks.push(Buffer.from(`--${boundary}\r\n`, "utf-8"));
  chunks.push(
    Buffer.from(
      `Content-Disposition: form-data; name="file"; filename="${fileFilename}"\r\n`,
      "utf-8",
    ),
  );
  chunks.push(Buffer.from(`Content-Type: ${fileMime}\r\n\r\n`, "utf-8"));
  chunks.push(fileContent);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"));
  return { boundary, body: Buffer.concat(chunks) };
}

async function uploadBlob(
  filename: string,
  content: Buffer,
  mime = "application/octet-stream",
  fields: Record<string, string> = {},
): Promise<any> {
  const mp = buildMultipart(content, filename, mime, fields);
  const r = await invokeRoute("POST", "/api/v1/files/upload", {
    headers: {
      "content-type": `multipart/form-data; boundary=${mp.boundary}`,
      "content-length": String(mp.body.length),
    },
    rawBodyChunks: [mp.body],
  });
  return r;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("/api/v1/files/* — PR 1", () => {
  before(() => {
    // Boot the state.db handle so the schema + migration are applied.
    getStateDb();
  });

  beforeEach(() => {
    // Clear the files + file_blobs tables + the on-disk blobs between
    // tests so each case sees a quiet starting state. (PR 5 added the
    // file_blobs companion table that holds the actual size totals
    // for /usage.)
    const db = getStateDb();
    db.exec("DELETE FROM files");
    db.exec("DELETE FROM file_blobs");
    if (fs.existsSync(FILES_ROOT)) {
      for (const entry of fs.readdirSync(FILES_ROOT)) {
        try {
          fs.rmSync(path.join(FILES_ROOT, entry), {
            recursive: true,
            force: true,
          });
        } catch {
          /* best-effort */
        }
      }
    }
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  describe("ULID + sanitizeFilename helpers", () => {
    it("ulid() returns 26 chars of Crockford base32", () => {
      const id = ulid();
      assert.equal(id.length, 26);
      assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it("ulid() is monotonically increasing-ish (timestamp-prefixed)", () => {
      const a = ulid();
      // Force a 1 ms tick to make the prefix comparison stable.
      const sleep = (ms: number) =>
        new Promise((r) => setTimeout(r, ms));
      return sleep(2).then(() => {
        const b = ulid();
        // The first 10 chars are the timestamp portion; b's must be
        // ≥ a's so a `ORDER BY id` works for chronological sort.
        assert.ok(b.slice(0, 10) >= a.slice(0, 10));
      });
    });

    it("sanitizeFilename strips path separators and ..", () => {
      assert.equal(
        sanitizeFilename("/etc/passwd"),
        "passwd",
        "leading / drops directory",
      );
      assert.equal(
        sanitizeFilename("..\\..\\evil.exe"),
        "evil.exe",
        "windows-style \\.. drops directory",
      );
      assert.equal(
        sanitizeFilename("normal-name.pdf"),
        "normal-name.pdf",
        "ordinary names pass through",
      );
      assert.equal(
        sanitizeFilename(""),
        "file",
        "empty input falls back to file",
      );
      assert.equal(
        sanitizeFilename("with*illegal?chars.txt"),
        "with_illegal_chars.txt",
        "shell metacharacters are replaced",
      );
    });
  });

  describe("POST /upload", () => {
    it("400 when Content-Type isn't multipart/form-data", async () => {
      const r = await invokeRoute("POST", "/api/v1/files/upload", {
        headers: { "content-type": "application/json" },
        body: { foo: "bar" },
      });
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    });

    it("stores a blob and inserts a row", async () => {
      const content = Buffer.from("hello, files store");
      const r = await uploadBlob("hello.txt", content, "text/plain");
      assert.equal(r.status, 201);
      assert.ok(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(r.payload.id));
      assert.equal(r.payload.size_bytes, content.length);
      assert.equal(r.payload.original_filename, "hello.txt");
      assert.equal(r.payload.uploaded_by, "principal");
      assert.equal(r.payload.content_type, "text/plain");
      // sha256 matches the actual content.
      assert.equal(
        r.payload.sha256,
        crypto.createHash("sha256").update(content).digest("hex"),
      );
      // Row landed in the DB.
      const row = getStateDb()
        .prepare(`SELECT * FROM files WHERE id = ?`)
        .get(r.payload.id) as any;
      assert.ok(row);
      assert.equal(row.size_bytes, content.length);
      // Blob landed on disk under <ULID>/<safe-name>.
      const absPath = path.join(FILES_ROOT, r.payload.path);
      assert.ok(fs.existsSync(absPath), "blob written to disk");
      assert.equal(fs.readFileSync(absPath).toString(), "hello, files store");
    });

    it("respects principal_label, original_filename, uploaded_by fields", async () => {
      const r = await uploadBlob(
        "raw-name.bin",
        Buffer.from("xx"),
        "application/octet-stream",
        {
          principal_label: "Q3 contract preview",
          original_filename: "q3-contract.pdf",
          uploaded_by: "chore:digest",
        },
      );
      assert.equal(r.status, 201);
      assert.equal(r.payload.principal_label, "Q3 contract preview");
      assert.equal(r.payload.original_filename, "q3-contract.pdf");
      assert.equal(r.payload.uploaded_by, "chore:digest");
      // The on-disk path should reflect the principal-supplied
      // original_filename (sanitized), not the multipart-part filename.
      const tail = r.payload.path.split("/").pop();
      assert.equal(tail, "q3-contract.pdf");
    });

    it("507 QUOTA_EXCEEDED when the upload would blow the hard cap", async () => {
      // FILES_QUOTA_HARD_BYTES = 1 MiB; one 600 KiB upload fits, the
      // next DISTINCT-CONTENT 600 KiB pushes us over. PR 5 dedupes by
      // sha256 so the bytes have to be different — use Buffer.alloc
      // with two different fill characters.
      const first = Buffer.alloc(600 * 1024, "a");
      const second = Buffer.alloc(600 * 1024, "b");
      const r1 = await uploadBlob("first.bin", first, "application/octet-stream");
      assert.equal(r1.status, 201);
      const r2 = await uploadBlob("second.bin", second, "application/octet-stream");
      assert.equal(r2.status, 507);
      assert.equal(r2.payload.error.code, "QUOTA_EXCEEDED");
      // Verify the failed upload's scratch dir was cleaned up.
      const entries = fs.readdirSync(FILES_ROOT);
      assert.equal(
        entries.length,
        1,
        "only the first upload's ULID dir survives",
      );
    });
  });

  describe("GET /list + GET /usage", () => {
    it("returns the upload in the list + usage matches", async () => {
      const content = Buffer.from("list-me");
      const up = await uploadBlob("doc.txt", content, "text/plain");
      assert.equal(up.status, 201);
      const list = await invokeRoute("GET", "/api/v1/files/list", {
        url: "/api/v1/files/list",
      });
      assert.equal(list.status, 200);
      assert.equal(list.payload.total, 1);
      assert.equal(list.payload.items[0].id, up.payload.id);
      assert.equal(list.payload.items[0].size_bytes, content.length);

      const usage = await invokeRoute("GET", "/api/v1/files/usage");
      assert.equal(usage.status, 200);
      assert.equal(usage.payload.used_bytes, content.length);
      assert.equal(usage.payload.count, 1);
      assert.equal(
        usage.payload.hard_cap_bytes,
        Number(process.env.FILES_QUOTA_HARD_BYTES),
      );
    });

    it("limit + offset paginates", async () => {
      for (let i = 0; i < 3; i++) {
        await uploadBlob(`item-${i}.txt`, Buffer.from(`#${i}`), "text/plain");
      }
      const page1 = await invokeRoute("GET", "/api/v1/files/list", {
        url: "/api/v1/files/list?limit=2&offset=0",
      });
      assert.equal(page1.status, 200);
      assert.equal(page1.payload.total, 3);
      assert.equal(page1.payload.items.length, 2);
      const page2 = await invokeRoute("GET", "/api/v1/files/list", {
        url: "/api/v1/files/list?limit=2&offset=2",
      });
      assert.equal(page2.payload.items.length, 1);
    });
  });

  describe("GET /stat/*", () => {
    it("returns the row for an existing path", async () => {
      const up = await uploadBlob(
        "stat-target.bin",
        Buffer.from("xx"),
        "application/octet-stream",
      );
      const stat = await invokeRoute(
        "GET",
        `/api/v1/files/stat/${up.payload.path}`,
      );
      assert.equal(stat.status, 200);
      assert.equal(stat.payload.id, up.payload.id);
      assert.equal(stat.payload.path, up.payload.path);
      assert.equal(stat.payload.size_bytes, 2);
    });

    it("404 for a missing path", async () => {
      const stat = await invokeRoute(
        "GET",
        "/api/v1/files/stat/01HFAKEULIDFAKEULIDFAKEUL/nope.bin",
      );
      assert.equal(stat.status, 404);
      assert.equal(stat.payload.error.code, "NOT_FOUND");
    });
  });

  describe("DELETE /*", () => {
    it("soft-deletes the row and unlinks the blob", async () => {
      const up = await uploadBlob(
        "to-delete.txt",
        Buffer.from("byebye"),
        "text/plain",
      );
      const absPath = path.join(FILES_ROOT, up.payload.path);
      assert.ok(fs.existsSync(absPath), "blob exists before delete");

      const del = await invokeRoute(
        "DELETE",
        `/api/v1/files/${up.payload.path}`,
      );
      assert.equal(del.status, 200);
      assert.equal(del.payload.id, up.payload.id);
      assert.ok(typeof del.payload.deleted_at === "number");

      // Blob is gone from disk.
      assert.equal(
        fs.existsSync(absPath),
        false,
        "blob removed after soft-delete",
      );
      // Row is still in the DB but with deleted_at set.
      const row = getStateDb()
        .prepare(`SELECT * FROM files WHERE id = ?`)
        .get(up.payload.id) as any;
      assert.ok(row);
      assert.ok(row.deleted_at);
      // The list no longer returns the row.
      const list = await invokeRoute("GET", "/api/v1/files/list");
      assert.equal(list.payload.total, 0);
      // Usage no longer counts it.
      const usage = await invokeRoute("GET", "/api/v1/files/usage");
      assert.equal(usage.payload.used_bytes, 0);
      assert.equal(usage.payload.count, 0);
    });

    it("404 when the path doesn't exist", async () => {
      const del = await invokeRoute(
        "DELETE",
        "/api/v1/files/01HFAKEULIDFAKEULIDFAKEUL/nope.bin",
      );
      assert.equal(del.status, 404);
    });
  });

  // ─── PR 2 additions: ?q= search + PATCH /* for principal_label ─────────────
  //
  // The MCP `files__search` tool funnels through GET /list?q=…; the MCP
  // `files__describe` tool funnels through PATCH /*. Both are exercised
  // through the same matchRoute + handleError shim as PR 1.

  describe("GET /list?q= (PR 2)", () => {
    it("filters by keyword across path, original_filename, and principal_label", async () => {
      await uploadBlob(
        "alpha.txt",
        Buffer.from("a"),
        "text/plain",
        { original_filename: "alpha.txt" },
      );
      await uploadBlob(
        "beta.txt",
        Buffer.from("b"),
        "text/plain",
        {
          original_filename: "beta.txt",
          principal_label: "Q3 contract preview",
        },
      );
      await uploadBlob(
        "gamma.bin",
        Buffer.from("g"),
        "application/octet-stream",
        { original_filename: "gamma.bin" },
      );

      // Hit on original_filename
      let r = await invokeRoute("GET", "/api/v1/files/list", {
        url: "/api/v1/files/list?q=alpha",
      });
      assert.equal(r.status, 200);
      assert.equal(r.payload.total, 1);
      assert.equal(r.payload.items[0].original_filename, "alpha.txt");

      // Hit on principal_label
      r = await invokeRoute("GET", "/api/v1/files/list", {
        url: "/api/v1/files/list?q=contract",
      });
      assert.equal(r.payload.total, 1);
      assert.equal(r.payload.items[0].principal_label, "Q3 contract preview");

      // Case-insensitive
      r = await invokeRoute("GET", "/api/v1/files/list", {
        url: "/api/v1/files/list?q=CONTRACT",
      });
      assert.equal(r.payload.total, 1);

      // No hit
      r = await invokeRoute("GET", "/api/v1/files/list", {
        url: "/api/v1/files/list?q=zzz-nothing",
      });
      assert.equal(r.payload.total, 0);
    });
  });

  describe("PATCH /* — principal_label (PR 2)", () => {
    it("sets principal_label on an existing row", async () => {
      const up = await uploadBlob("notes.md", Buffer.from("n"), "text/markdown");
      assert.equal(up.status, 201);
      const patch = await invokeRoute(
        "PATCH",
        `/api/v1/files/${up.payload.path}`,
        { body: { principal_label: "Sir's reading-list notes" } },
      );
      assert.equal(patch.status, 200);
      assert.equal(
        patch.payload.principal_label,
        "Sir's reading-list notes",
      );
      // DB-side
      const row = getStateDb()
        .prepare(`SELECT principal_label FROM files WHERE id = ?`)
        .get(up.payload.id) as { principal_label: string };
      assert.equal(row.principal_label, "Sir's reading-list notes");
    });

    it("clearing principal_label with empty string nulls the column", async () => {
      const up = await uploadBlob(
        "notes.md",
        Buffer.from("n"),
        "text/markdown",
        { principal_label: "old" },
      );
      const patch = await invokeRoute(
        "PATCH",
        `/api/v1/files/${up.payload.path}`,
        { body: { principal_label: "" } },
      );
      assert.equal(patch.status, 200);
      assert.equal(patch.payload.principal_label, null);
    });

    it("PATCH on a missing path returns 404", async () => {
      const patch = await invokeRoute(
        "PATCH",
        "/api/v1/files/01HFAKEULIDFAKEULIDFAKEUL/nope.bin",
        { body: { principal_label: "x" } },
      );
      assert.equal(patch.status, 404);
    });

    it("PATCH ignores unknown fields (forward-compatible)", async () => {
      const up = await uploadBlob("u.txt", Buffer.from("u"), "text/plain");
      const patch = await invokeRoute(
        "PATCH",
        `/api/v1/files/${up.payload.path}`,
        { body: { future_field: "ignored", principal_label: "k" } },
      );
      assert.equal(patch.status, 200);
      assert.equal(patch.payload.principal_label, "k");
    });
  });

  describe("GET /blob/*", () => {
    it("streams the bytes back with the right Content-Type", async () => {
      const content = Buffer.from("blob-content-here");
      const up = await uploadBlob("blob.bin", content, "application/x-test");
      assert.equal(up.status, 201);
      // Sanity: the blob landed where the row claims.
      const absUploaded = path.join(FILES_ROOT, up.payload.path);
      assert.ok(
        fs.existsSync(absUploaded),
        `blob must exist on disk at ${absUploaded}`,
      );
      assert.equal(fs.readFileSync(absUploaded).toString(), content.toString());
      const blob = await invokeRoute(
        "GET",
        `/api/v1/files/blob/${up.payload.path}`,
      );
      assert.equal(blob.status, 200);
      assert.equal(blob.headers["Content-Type"], "application/x-test");
      assert.equal(blob.headers["Content-Length"], content.length);
      assert.ok(
        String(blob.headers["Content-Disposition"] ?? "").includes("blob.bin"),
      );
      // The raw body matches.
      assert.equal(blob.rawBody.toString(), content.toString());
      // last_accessed_at was bumped.
      const row = getStateDb()
        .prepare(`SELECT last_accessed_at FROM files WHERE id = ?`)
        .get(up.payload.id) as { last_accessed_at: number };
      assert.ok(row.last_accessed_at && row.last_accessed_at > 0);
    });
  });

  // ── Lane D₁ routes (#114): describe / move / purge ────────────────────────
  //
  // The three routes the MCP `describe` / `move` / `hard_delete` tools
  // wrap. We exercise the happy-path shape, the move's two address modes
  // (basename vs full path), and the purge's two-stage gate (refuse on a
  // live row, accept on a soft-deleted row).

  describe("GET /describe/* (Lane D₁ metadata-getter)", () => {
    it("returns the rich-metadata projection for a live row", async () => {
      const up = await uploadBlob(
        "contract.pdf",
        Buffer.from("pdf-bytes"),
        "application/pdf",
        { principal_label: "Q3 Acme contract" },
      );
      const desc = await invokeRoute(
        "GET",
        `/api/v1/files/describe/${up.payload.path}`,
      );
      assert.equal(desc.status, 200);
      assert.equal(desc.payload.id, up.payload.id);
      assert.equal(desc.payload.name, "contract.pdf");
      assert.equal(desc.payload.mime, "application/pdf");
      assert.equal(desc.payload.size_bytes, "pdf-bytes".length);
      assert.equal(desc.payload.principal_label, "Q3 Acme contract");
      // `summary` and `alfred_read_at` are populated by Lane B's
      // FileExtractionWorkflow; null in tests where the workflow can't
      // reach docker.
      assert.equal(typeof desc.payload.created_at, "number");
      assert.equal(typeof desc.payload.updated_at, "number");
      assert.equal(desc.payload.deleted_at, null);
    });

    it("ALSO returns soft-deleted rows (with deleted_at populated)", async () => {
      const up = await uploadBlob(
        "vanishing.txt",
        Buffer.from("bye"),
        "text/plain",
      );
      const del = await invokeRoute("DELETE", `/api/v1/files/${up.payload.path}`);
      assert.equal(del.status, 200);
      // stat would 404 on this path — describe returns 200 with deleted_at set.
      const desc = await invokeRoute(
        "GET",
        `/api/v1/files/describe/${up.payload.path}`,
      );
      assert.equal(desc.status, 200);
      assert.ok(desc.payload.deleted_at, "deleted_at must be populated");
    });

    it("returns 404 for an unknown path", async () => {
      const desc = await invokeRoute(
        "GET",
        "/api/v1/files/describe/01HFAKEULIDFAKEULIDFAKEUL/nope.bin",
      );
      assert.equal(desc.status, 404);
    });
  });

  describe("POST /:file_id/move (Lane D₁)", () => {
    it("basename-only move renames the file in place and updates the row", async () => {
      const up = await uploadBlob(
        "draft.md",
        Buffer.from("hello"),
        "text/markdown",
      );
      const move = await invokeRoute(
        "POST",
        `/api/v1/files/${up.payload.id}/move`,
        { body: { path: "final.md" } },
      );
      assert.equal(move.status, 200);
      const expectedUlid = up.payload.path.split("/")[0];
      assert.equal(move.payload.path, `${expectedUlid}/final.md`);
      assert.equal(move.payload.original_filename, "final.md");
      // On-disk file moved.
      const absNew = path.join(FILES_ROOT, expectedUlid, "final.md");
      assert.ok(fs.existsSync(absNew), `new path must exist on disk`);
      const absOld = path.join(FILES_ROOT, expectedUlid, "draft.md");
      assert.ok(!fs.existsSync(absOld), `old path must be gone`);
      // file_blobs.path tracks the move.
      const blob = getStateDb()
        .prepare(`SELECT path FROM file_blobs WHERE sha256 = ?`)
        .get(up.payload.sha256) as { path: string };
      assert.equal(blob.path, `${expectedUlid}/final.md`);
      // Audit row written.
      const audit = getStateDb()
        .prepare(
          `SELECT * FROM audit WHERE subject_ref = ? AND action_type = 'files_move' LIMIT 1`,
        )
        .get(up.payload.id) as { id: string; target_path: string } | undefined;
      assert.ok(audit, "audit row must exist for files_move");
      assert.equal(audit.target_path, `${expectedUlid}/final.md`);
    });

    it("404s on an unknown file_id", async () => {
      const move = await invokeRoute(
        "POST",
        "/api/v1/files/01HFAKEULIDFAKEULIDFAKEUL/move",
        { body: { path: "x.txt" } },
      );
      assert.equal(move.status, 404);
    });

    it("400s on missing body.path", async () => {
      const up = await uploadBlob(
        "a.txt",
        Buffer.from("a"),
        "text/plain",
      );
      const move = await invokeRoute(
        "POST",
        `/api/v1/files/${up.payload.id}/move`,
        { body: {} },
      );
      assert.equal(move.status, 400);
    });

    it("rejects `..` traversal", async () => {
      const up = await uploadBlob(
        "b.txt",
        Buffer.from("b"),
        "text/plain",
      );
      const move = await invokeRoute(
        "POST",
        `/api/v1/files/${up.payload.id}/move`,
        { body: { path: "../escape.txt" } },
      );
      assert.equal(move.status, 400);
    });

    it("409s when the bytes are shared via dedupe (ref_count > 1)", async () => {
      // Two identical uploads → dedupe → ref_count = 2 on the canonical blob.
      const content = Buffer.from("dupe-content");
      const up1 = await uploadBlob("a.bin", content, "application/octet-stream");
      const up2 = await uploadBlob("b.bin", content, "application/octet-stream");
      // Sanity: dedupe happened.
      const blob = getStateDb()
        .prepare(`SELECT ref_count FROM file_blobs WHERE sha256 = ?`)
        .get(up1.payload.sha256) as { ref_count: number };
      assert.equal(blob.ref_count, 2, "PR 5 dedupe must have set ref_count = 2");
      const move = await invokeRoute(
        "POST",
        `/api/v1/files/${up2.payload.id}/move`,
        { body: { path: "renamed.bin" } },
      );
      assert.equal(move.status, 409);
      assert.equal(move.payload.error.code, "SHARED_BLOB");
    });
  });

  describe("POST /:file_id/purge (Lane D₁ hard-delete)", () => {
    it("refuses to purge a live (non-soft-deleted) row with 409", async () => {
      const up = await uploadBlob(
        "still-here.txt",
        Buffer.from("alive"),
        "text/plain",
      );
      const purge = await invokeRoute(
        "POST",
        `/api/v1/files/${up.payload.id}/purge`,
      );
      assert.equal(purge.status, 409);
      assert.equal(purge.payload.error.code, "PURGE_REQUIRES_SOFT_DELETE");
      // Row still there.
      const row = getStateDb()
        .prepare(`SELECT id FROM files WHERE id = ?`)
        .get(up.payload.id);
      assert.ok(row, "row must still exist after a refused purge");
    });

    it("purges a soft-deleted row, removes it from the DB, and writes an audit row", async () => {
      const up = await uploadBlob(
        "doomed.txt",
        Buffer.from("doomed"),
        "text/plain",
      );
      // Soft-delete first.
      const del = await invokeRoute(
        "DELETE",
        `/api/v1/files/${up.payload.path}`,
      );
      assert.equal(del.status, 200);
      // Now purge.
      const purge = await invokeRoute(
        "POST",
        `/api/v1/files/${up.payload.id}/purge`,
      );
      assert.equal(purge.status, 200);
      assert.equal(purge.payload.id, up.payload.id);
      assert.ok(purge.payload.purged_at, "purged_at must be populated");
      // Row is gone outright.
      const row = getStateDb()
        .prepare(`SELECT id FROM files WHERE id = ?`)
        .get(up.payload.id);
      assert.equal(row, undefined, "row must be gone after purge");
      // Audit row was written.
      const audit = getStateDb()
        .prepare(
          `SELECT * FROM audit WHERE subject_ref = ? AND action_type = 'files_purge' LIMIT 1`,
        )
        .get(up.payload.id) as { id: string; summary: string } | undefined;
      assert.ok(audit, "audit row must exist for files_purge");
    });

    it("404s on an unknown file_id", async () => {
      const purge = await invokeRoute(
        "POST",
        "/api/v1/files/01HFAKEULIDFAKEULIDFAKEUL/purge",
      );
      assert.equal(purge.status, 404);
    });
  });

  // ─── #114 Lane B — extraction surface ────────────────────────────────────
  //
  // The FileExtractionWorkflow runs out-of-process and PATCHes back
  // here. These tests cover the route shape: what shapes are accepted
  // on the wire, how the row reflects after a stamp, the soft-delete
  // tombstone guard, the cap enforcement, and the operator re-fire
  // entry point. The fire-and-forget trigger itself is short-circuited
  // by FILES_EXTRACTION_ENABLED=false at the top of this file.

  describe("PATCH /:file_id/extraction — Lane B", () => {
    it("stamps alfred_read_at + summary on a fresh row", async () => {
      const up = await uploadBlob(
        "contract.txt",
        Buffer.from("contract body"),
        "text/plain",
      );
      assert.equal(up.status, 201);
      // Default columns are null at upload time.
      assert.equal(up.payload.alfred_read_at ?? null, null);
      assert.equal(up.payload.summary ?? null, null);
      assert.equal(up.payload.extraction_error ?? null, null);

      const patch = await invokeRoute(
        "PATCH",
        `/api/v1/files/${up.payload.id}/extraction`,
        {
          body: {
            alfred_read_at: 1717000000000,
            summary: "A short contract draft — one paragraph.",
            extraction_error: null,
          },
        },
      );
      assert.equal(patch.status, 200);
      assert.equal(patch.payload.alfred_read_at, 1717000000000);
      assert.equal(
        patch.payload.summary,
        "A short contract draft — one paragraph.",
      );
      assert.equal(patch.payload.extraction_error, null);
      // The list-row carries the same shape.
      const list = await invokeRoute("GET", "/api/v1/files/list");
      const listed = list.payload.items.find((r: any) => r.id === up.payload.id);
      assert.ok(listed, "row should appear in /list");
      assert.equal(listed.alfred_read_at, 1717000000000);
      assert.equal(listed.summary, "A short contract draft — one paragraph.");
    });

    it("stamps extraction_error on a failure path", async () => {
      const up = await uploadBlob("img.bin", Buffer.from("img"), "image/png");
      const patch = await invokeRoute(
        "PATCH",
        `/api/v1/files/${up.payload.id}/extraction`,
        {
          body: {
            alfred_read_at: null,
            summary: null,
            extraction_error: "unsupported_mime",
          },
        },
      );
      assert.equal(patch.status, 200);
      assert.equal(patch.payload.alfred_read_at, null);
      assert.equal(patch.payload.summary, null);
      assert.equal(patch.payload.extraction_error, "unsupported_mime");
    });

    it("rejects a tombstoned file with 409", async () => {
      const up = await uploadBlob("tomb.txt", Buffer.from("t"), "text/plain");
      // Soft-delete.
      const del = await invokeRoute(
        "DELETE",
        `/api/v1/files/${up.payload.path}`,
      );
      assert.equal(del.status, 200);
      const patch = await invokeRoute(
        "PATCH",
        `/api/v1/files/${up.payload.id}/extraction`,
        { body: { summary: "should not land" } },
      );
      assert.equal(patch.status, 409);
    });

    it("404s on an unknown file_id", async () => {
      const patch = await invokeRoute(
        "PATCH",
        "/api/v1/files/01HNOSUCHFILE000000000000/extraction",
        { body: { summary: "x" } },
      );
      assert.equal(patch.status, 404);
    });

    it("rejects a summary above the 4 KiB cap with 400", async () => {
      const up = await uploadBlob("big.txt", Buffer.from("big"), "text/plain");
      const huge = "x".repeat(4100);
      const patch = await invokeRoute(
        "PATCH",
        `/api/v1/files/${up.payload.id}/extraction`,
        { body: { summary: huge } },
      );
      assert.equal(patch.status, 400);
    });

    it("partial PATCH leaves untouched columns alone", async () => {
      const up = await uploadBlob("p.txt", Buffer.from("p"), "text/plain");
      // First, stamp a success.
      await invokeRoute(
        "PATCH",
        `/api/v1/files/${up.payload.id}/extraction`,
        {
          body: {
            alfred_read_at: 1717111111111,
            summary: "first summary",
            extraction_error: null,
          },
        },
      );
      // Then, send a partial PATCH that only sets extraction_error —
      // summary should survive.
      const patch = await invokeRoute(
        "PATCH",
        `/api/v1/files/${up.payload.id}/extraction`,
        { body: { extraction_error: "stamp_failed" } },
      );
      assert.equal(patch.status, 200);
      assert.equal(patch.payload.summary, "first summary");
      assert.equal(patch.payload.extraction_error, "stamp_failed");
      assert.equal(patch.payload.alfred_read_at, 1717111111111);
    });
  });

  describe("POST /:file_id/extract — Lane B operator re-fire", () => {
    it("returns 202 and clears any prior extraction_error", async () => {
      const up = await uploadBlob("r.txt", Buffer.from("r"), "text/plain");
      // First stamp an error to verify it gets cleared.
      await invokeRoute(
        "PATCH",
        `/api/v1/files/${up.payload.id}/extraction`,
        { body: { extraction_error: "summariser_failed" } },
      );
      const refire = await invokeRoute(
        "POST",
        `/api/v1/files/${up.payload.id}/extract`,
      );
      assert.equal(refire.status, 202);
      assert.equal(refire.payload.ok, true);
      assert.equal(refire.payload.file_id, up.payload.id);
      // The error column is back to null even though the trigger is
      // disabled in this test (the route clears it eagerly).
      const row = getStateDb()
        .prepare(`SELECT extraction_error FROM files WHERE id = ?`)
        .get(up.payload.id) as { extraction_error: string | null };
      assert.equal(row.extraction_error, null);
    });

    it("rejects a tombstoned file with 409", async () => {
      const up = await uploadBlob("rt.txt", Buffer.from("rt"), "text/plain");
      await invokeRoute("DELETE", `/api/v1/files/${up.payload.path}`);
      const refire = await invokeRoute(
        "POST",
        `/api/v1/files/${up.payload.id}/extract`,
      );
      assert.equal(refire.status, 409);
    });
  });
});
