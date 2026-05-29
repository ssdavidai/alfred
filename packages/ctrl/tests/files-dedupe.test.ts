// /api/v1/files/* — PR 5 dedupe surface (issue #114).
//
// PR 5 adds:
//
//   * `file_blobs` table — one row per UNIQUE sha256, with ref_count.
//   * Upload route looks up the sha256 BEFORE writing to disk; on
//     hit, the bytes are not re-written and the response is flagged
//     `deduped: true`.
//   * DELETE decrements ref_count; the physical blob (+ ULID dir) is
//     unlinked only when the count hits zero.
//   * /usage reports a deduped total (live + cold) computed from
//     `file_blobs`, not the `files.size_bytes` SUM.
//
// We exercise everything through the same matchRoute + handleError
// shim as files-routes.test.ts (PR 1/PR 2), with the test bootstrap
// pinned to an mkdtemp data dir so the on-disk state stays
// hermetic.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── one-shot env wiring ────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "files-dedupe-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.SQLITE_VEC_PATH = "";
const FILES_ROOT = path.join(tmp, "files");
const FILES_COLD_ROOT = path.join(tmp, "cold-files");
process.env.FILES_ROOT = FILES_ROOT;
process.env.FILES_COLD_ROOT = FILES_COLD_ROOT;
// Tight quota so the quota-exceeded test below stays fast.
process.env.FILES_QUOTA_HARD_BYTES = String(1024 * 1024);
process.env.FILES_QUOTA_SOFT_BYTES = String(512 * 1024);

// ── module imports (after env is set) ──────────────────────────────────────

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerFilesRoutes } = await import("../src/api/routes/files.js");
const { getStateDb } = await import("../src/db/state.js");
registerFilesRoutes();

// ── invokeRoute helper (mirrors files-routes.test.ts) ─────────────────────

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

  let req: IncomingMessage;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = String(v);
  }
  if (opts.rawBodyChunks && opts.rawBodyChunks.length > 0) {
    const ptIn = new PassThrough();
    for (const c of opts.rawBodyChunks) ptIn.write(c);
    ptIn.end();
    req = Object.assign(ptIn, {
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
  await finished;
  const rawBody = Buffer.concat(bodyChunks);
  let payload: any = null;
  if (
    rawBody.length > 0 &&
    (rawBody[0] === 0x7b || rawBody[0] === 0x5b)
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

function buildMultipart(
  fileContent: Buffer,
  fileFilename: string,
  fileMime: string,
  textFields: Record<string, string> = {},
): { boundary: string; body: Buffer } {
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
  return await invokeRoute("POST", "/api/v1/files/upload", {
    headers: {
      "content-type": `multipart/form-data; boundary=${mp.boundary}`,
      "content-length": String(mp.body.length),
    },
    rawBodyChunks: [mp.body],
  });
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("/api/v1/files/* — PR 5 dedupe", () => {
  before(() => {
    getStateDb();
  });

  beforeEach(() => {
    const db = getStateDb();
    db.exec("DELETE FROM files");
    db.exec("DELETE FROM file_blobs");
    for (const root of [FILES_ROOT, FILES_COLD_ROOT]) {
      if (fs.existsSync(root)) {
        for (const entry of fs.readdirSync(root)) {
          try {
            fs.rmSync(path.join(root, entry), { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
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

  it("two uploads of the same bytes share one path + ref_count=2 + deduped flag", async () => {
    const content = Buffer.from("identical payload — should dedupe");
    const r1 = await uploadBlob("first.bin", content);
    assert.equal(r1.status, 201);
    assert.equal(r1.payload.deduped, false, "first upload is novel");
    const r2 = await uploadBlob("second.bin", content);
    assert.equal(r2.status, 201);
    assert.equal(r2.payload.deduped, true, "second upload sees the dedupe");
    // Same on-disk path returned.
    assert.equal(r2.payload.path, r1.payload.path);
    // Distinct file_ids.
    assert.notEqual(r2.payload.id, r1.payload.id);
    // Same sha256.
    assert.equal(r2.payload.sha256, r1.payload.sha256);
    // file_blobs row carries ref_count=2.
    const blob = getStateDb()
      .prepare(`SELECT ref_count, path FROM file_blobs WHERE sha256 = ?`)
      .get(r1.payload.sha256) as { ref_count: number; path: string };
    assert.equal(blob.ref_count, 2);
    assert.equal(blob.path, r1.payload.path);
    // Only ONE on-disk blob exists.
    const ulidDirs = fs
      .readdirSync(FILES_ROOT)
      .filter((d) => !d.startsWith("."));
    assert.equal(ulidDirs.length, 1, "dedupe must not write the bytes twice");
  });

  it("deleting one of two duplicate files keeps the blob alive for the other", async () => {
    const content = Buffer.from("byte-share");
    const r1 = await uploadBlob("a.bin", content);
    const r2 = await uploadBlob("b.bin", content);
    assert.equal(r2.payload.deduped, true);

    // Delete the first.
    const del = await invokeRoute("DELETE", `/api/v1/files/${r1.payload.path}`);
    assert.equal(del.status, 200);

    // file_blobs row still here, ref_count == 1.
    const blob = getStateDb()
      .prepare(`SELECT ref_count FROM file_blobs WHERE sha256 = ?`)
      .get(r1.payload.sha256) as { ref_count: number };
    assert.equal(blob.ref_count, 1);

    // Disk blob still present — the second file is readable via /blob/*.
    const blobResp = await invokeRoute(
      "GET",
      `/api/v1/files/blob/${r2.payload.path}`,
    );
    assert.equal(blobResp.status, 200);
    assert.equal(blobResp.rawBody.toString(), content.toString());
  });

  it("deleting both duplicates physically removes the blob + file_blobs row", async () => {
    const content = Buffer.from("doomed-shared");
    const r1 = await uploadBlob("a.bin", content);
    const r2 = await uploadBlob("b.bin", content);
    const absPath = path.join(FILES_ROOT, r1.payload.path);
    assert.ok(fs.existsSync(absPath));

    const del1 = await invokeRoute(
      "DELETE",
      `/api/v1/files/${r1.payload.path}`,
    );
    assert.equal(del1.status, 200);
    assert.ok(fs.existsSync(absPath), "still here after first delete");

    const del2 = await invokeRoute(
      "DELETE",
      `/api/v1/files/${r2.payload.path}`,
    );
    assert.equal(del2.status, 200);
    assert.equal(
      fs.existsSync(absPath),
      false,
      "physically gone after both refs dropped",
    );
    // file_blobs row gone too.
    const blob = getStateDb()
      .prepare(`SELECT * FROM file_blobs WHERE sha256 = ?`)
      .get(r1.payload.sha256) as Record<string, unknown> | undefined;
    assert.equal(blob, undefined);
  });

  it("/usage counts unique sha256s — duplicates don't double up", async () => {
    const a = Buffer.from("unique-a-payload");
    const b = Buffer.from("unique-b-payload-larger-x");
    await uploadBlob("a.bin", a);
    await uploadBlob("dup-of-a.bin", a); // dedupe
    await uploadBlob("b.bin", b);

    const usage = await invokeRoute("GET", "/api/v1/files/usage");
    assert.equal(usage.status, 200);
    // Two unique sha256s — used_bytes = a.length + b.length.
    assert.equal(usage.payload.used_bytes, a.length + b.length);
    assert.equal(usage.payload.live_bytes, a.length + b.length);
    assert.equal(usage.payload.cold_bytes, 0);
    // Three principal-facing files.
    assert.equal(usage.payload.file_count, 3);
    // Two distinct live blobs.
    assert.equal(usage.payload.blob_count_live, 2);
    assert.equal(usage.payload.blob_count_cold, 0);
  });

  it("dedupes on sha256 even when content_type differs between uploads", async () => {
    const content = Buffer.from("same-bytes-different-ct");
    const r1 = await uploadBlob("doc.txt", content, "text/plain");
    const r2 = await uploadBlob(
      "doc.octet",
      content,
      "application/octet-stream",
    );
    assert.equal(r2.payload.deduped, true);
    assert.equal(r2.payload.path, r1.payload.path);
    // Each `files` row keeps its declared content_type — dedupe is
    // about the bytes, not the metadata.
    assert.equal(r1.payload.content_type, "text/plain");
    assert.equal(r2.payload.content_type, "application/octet-stream");
  });

  it("concurrent uploads of the same bytes — only one disk write, exactly one file_blobs row", async () => {
    // Fire 5 uploads of the same content with Promise.all. The race
    // resolution path inside the upload handler must pick exactly one
    // winner; the other 4 must dedupe to the canonical path.
    const content = Buffer.from(`race-${crypto.randomBytes(16).toString("hex")}`);
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => uploadBlob(`r${i}.bin`, content)),
    );
    for (const r of results) {
      assert.equal(r.status, 201);
    }
    // Exactly one file_blobs row, ref_count=5.
    const blobs = getStateDb()
      .prepare(`SELECT sha256, ref_count, path FROM file_blobs`)
      .all() as { sha256: string; ref_count: number; path: string }[];
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].ref_count, 5);
    // All 5 `files.id` rows share the same canonical path.
    const distinctPaths = new Set(results.map((r) => r.payload.path));
    assert.equal(distinctPaths.size, 1);
    // Exactly one ULID dir survived (the rest were cleaned up).
    const ulidDirs = fs
      .readdirSync(FILES_ROOT)
      .filter((d) => !d.startsWith("."));
    assert.equal(
      ulidDirs.length,
      1,
      "race resolution must leave exactly one set of bytes on disk",
    );
  });

  it("tombstoned files don't block dedupe of a new upload of the same bytes", async () => {
    // Upload once, delete it, upload again — the new upload should
    // see no `file_blobs` row (it's been reaped) and write fresh
    // bytes with deduped=false.
    const content = Buffer.from("zombie-resurrect-me");
    const r1 = await uploadBlob("v1.bin", content);
    const del = await invokeRoute("DELETE", `/api/v1/files/${r1.payload.path}`);
    assert.equal(del.status, 200);
    // Blob row should be gone (ref_count went to 0 on the only
    // outstanding reference).
    const before = getStateDb()
      .prepare(`SELECT * FROM file_blobs WHERE sha256 = ?`)
      .get(r1.payload.sha256) as Record<string, unknown> | undefined;
    assert.equal(before, undefined);
    // Re-upload: should be novel, not deduped.
    const r2 = await uploadBlob("v2.bin", content);
    assert.equal(r2.status, 201);
    assert.equal(r2.payload.deduped, false);
    // file_blobs has a fresh row with ref_count=1.
    const after = getStateDb()
      .prepare(`SELECT ref_count FROM file_blobs WHERE sha256 = ?`)
      .get(r1.payload.sha256) as { ref_count: number };
    assert.equal(after.ref_count, 1);
  });

  it("dedupe upload skips the hard-quota check (dup adds zero bytes)", async () => {
    // Tight quota: 1 MiB hard. Fill with 600 KiB unique content,
    // then re-upload the same 600 KiB — total live remains 600 KiB,
    // so the second upload must succeed even though `used + size`
    // (612K + 612K) would naively blow the cap.
    const fat = Buffer.alloc(600 * 1024, "z");
    const r1 = await uploadBlob("fat.bin", fat);
    assert.equal(r1.status, 201);
    const r2 = await uploadBlob("fat-dup.bin", fat);
    assert.equal(
      r2.status,
      201,
      "dedupe must skip the post-write quota check",
    );
    assert.equal(r2.payload.deduped, true);
  });

  it("ref_count on `files` rows always inserts as 1 (per-row tracker)", async () => {
    const content = Buffer.from("per-row-counter");
    const r1 = await uploadBlob("a.bin", content);
    const r2 = await uploadBlob("b.bin", content);
    const rows = getStateDb()
      .prepare(`SELECT ref_count FROM files WHERE id IN (?, ?)`)
      .all(r1.payload.id, r2.payload.id) as { ref_count: number }[];
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(
        r.ref_count,
        1,
        "files.ref_count is per-row (the SHA-level ref count lives on file_blobs)",
      );
    }
  });

  it("blob-level usage is reported separately for live and cold buckets", async () => {
    const a = Buffer.from("aaa-live");
    const b = Buffer.from("bbb-live-larger");
    await uploadBlob("a.bin", a);
    const rB = await uploadBlob("b.bin", b);

    // Pre-promotion: both blobs are live.
    let usage = await invokeRoute("GET", "/api/v1/files/usage");
    assert.equal(usage.payload.live_bytes, a.length + b.length);
    assert.equal(usage.payload.cold_bytes, 0);
    assert.equal(usage.payload.blob_count_live, 2);

    // Promote b → cold.
    const promote = await invokeRoute(
      "POST",
      `/api/v1/files/cold-promote/${rB.payload.id}`,
    );
    assert.equal(promote.status, 200);
    assert.ok(promote.payload.cold_promoted_at);

    // Post-promotion: a is live, b is cold; total bytes unchanged in
    // the principal's view but the buckets split.
    usage = await invokeRoute("GET", "/api/v1/files/usage");
    assert.equal(usage.payload.live_bytes, a.length);
    assert.equal(usage.payload.cold_bytes, b.length);
    assert.equal(usage.payload.blob_count_live, 1);
    assert.equal(usage.payload.blob_count_cold, 1);
  });

  it("dedupe response shape is forward-compatible with the PR 1 surface", async () => {
    // Every existing field that PR 1 / PR 2 callers depend on must
    // still be present (the dashboard reads them, the MCP tools
    // wrap them). PR 5 only ADDS `deduped` + `cold_promoted_at`.
    const r = await uploadBlob("forward-compat.bin", Buffer.from("hello"));
    const required = [
      "id",
      "path",
      "size_bytes",
      "sha256",
      "content_type",
      "original_filename",
      "principal_label",
      "uploaded_by",
      "uploaded_at",
      "deduped",
    ];
    for (const k of required) {
      assert.ok(k in r.payload, `response is missing ${k}`);
    }
    assert.equal(typeof r.payload.deduped, "boolean");
  });
});
