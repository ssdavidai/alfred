// /api/v1/files/* — PR 5 cold-archive surface (issue #114).
//
// PR 5 adds three routes:
//
//   * GET  /api/v1/files/cold-candidates       — operator list of
//     files eligible for cold promotion (un-accessed for >= 90 days).
//   * POST /api/v1/files/cold-promote/:file_id — compress + move to
//     the cold volume; atomically flips file_blobs.path to `cold:<ULID>`.
//   * POST /api/v1/files/cold-restore/:file_id — decompress + move
//     back to the live volume.
//
// And mutates GET /blob/* so a `cold:` row is served via transparent
// streamed zstd decompression. A read of a cold file bumps
// last_accessed_at but does NOT auto-restore — that's an explicit op.
//
// We exercise the routes through the same matchRoute + handleError
// shim as files-routes.test.ts. The 90-day threshold is dialed all
// the way down via FILES_COLD_AFTER_MS so we can manufacture
// candidates without time-travel.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── one-shot env wiring ────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "files-cold-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.SQLITE_VEC_PATH = "";
const FILES_ROOT = path.join(tmp, "files");
const FILES_COLD_ROOT = path.join(tmp, "cold-files");
process.env.FILES_ROOT = FILES_ROOT;
process.env.FILES_COLD_ROOT = FILES_COLD_ROOT;
// Tiny age threshold so we can hand-stamp a row's last_accessed_at
// to "1 hour ago" and have it land in the candidates set.
process.env.FILES_COLD_AFTER_MS = String(60 * 60 * 1000); // 1h
process.env.FILES_QUOTA_HARD_BYTES = String(50 * 1024 * 1024);
process.env.FILES_QUOTA_SOFT_BYTES = String(25 * 1024 * 1024);

// ── module imports ────────────────────────────────────────────────────────

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerFilesRoutes } = await import("../src/api/routes/files.js");
const { getStateDb } = await import("../src/db/state.js");
registerFilesRoutes();

// ── invokeRoute helper ────────────────────────────────────────────────────

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

/** Hand-stamp a `files` row's last_accessed_at so the cold sweep
 *  picks it up. We use 2 hours ago vs the 1-hour FILES_COLD_AFTER_MS
 *  test threshold so there's a clear margin. */
function ageRow(id: string, msAgo = 2 * 60 * 60 * 1000): void {
  const old = Date.now() - msAgo;
  getStateDb()
    .prepare(
      `UPDATE files SET last_accessed_at = ?, uploaded_at = ? WHERE id = ?`,
    )
    .run(old, old, id);
}

// ── observed compression ratios are tracked for the PR summary ────────────
const ratiosObserved: number[] = [];

// ── tests ──────────────────────────────────────────────────────────────────

describe("/api/v1/files/* — PR 5 cold archive", () => {
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
            fs.rmSync(path.join(root, entry), {
              recursive: true,
              force: true,
            });
          } catch {
            /* best-effort */
          }
        }
      }
    }
  });

  after(() => {
    if (ratiosObserved.length > 0) {
      const avg =
        ratiosObserved.reduce((s, r) => s + r, 0) / ratiosObserved.length;
      // Observability for the PR body — printed to stdout so the
      // operator running these tests can eyeball the level-19 ZSTD
      // payoff on the test fixtures.
      // eslint-disable-next-line no-console
      console.log(
        `[files-cold-archive] observed compression ratio: avg=${avg.toFixed(2)}x across ${ratiosObserved.length} samples`,
      );
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("cold-candidates returns ONLY files older than the threshold", async () => {
    const fresh = await uploadBlob("fresh.txt", Buffer.from("just-now"));
    const old = await uploadBlob("old.txt", Buffer.from("from-the-archives"));
    ageRow(old.payload.id); // 2h ago, > 1h threshold

    const r = await invokeRoute("GET", "/api/v1/files/cold-candidates", {
      url: "/api/v1/files/cold-candidates",
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 1);
    assert.equal(r.payload.items[0].id, old.payload.id);
    // The fresh upload must not appear.
    assert.equal(
      r.payload.items.find((it: any) => it.id === fresh.payload.id),
      undefined,
    );
  });

  it("cold-promote compresses + writes to cold volume + unlinks live", async () => {
    // Use a highly-compressible payload so the level-19 ratio is
    // meaningful (the small-payload baseline ratio is ~0.6x because
    // zstd's frame header costs more than the input saves).
    const content = Buffer.alloc(64 * 1024, "z"); // 64 KB of 'z'
    const up = await uploadBlob("zeros.bin", content);
    const liveAbs = path.join(FILES_ROOT, up.payload.path);
    assert.ok(fs.existsSync(liveAbs), "live blob present pre-promote");

    const promote = await invokeRoute(
      "POST",
      `/api/v1/files/cold-promote/${up.payload.id}`,
    );
    assert.equal(promote.status, 200);
    assert.ok(promote.payload.cold_promoted_at);
    assert.ok(promote.payload.path.startsWith("cold:"));

    // The compressed file landed under FILES_COLD_ROOT as `<ULID>.zst`.
    const ulid = promote.payload.path.slice("cold:".length);
    const coldAbs = path.join(FILES_COLD_ROOT, `${ulid}.zst`);
    assert.ok(fs.existsSync(coldAbs), "compressed blob on cold volume");

    // Live blob is gone.
    assert.equal(
      fs.existsSync(liveAbs),
      false,
      "live bytes unlinked after promote",
    );

    // Compression ratio is reported. A 64KB run of 'z' compresses
    // dramatically — record + a sanity check on the ratio.
    assert.ok(promote.payload.compression_ratio > 1);
    ratiosObserved.push(promote.payload.compression_ratio);
  });

  it("GET /blob/* on a cold file serves transparently decompressed bytes", async () => {
    const content = Buffer.from(
      "hello cold archive — please decompress me on the fly",
    );
    const up = await uploadBlob("cold-read.txt", content, "text/plain");
    await invokeRoute("POST", `/api/v1/files/cold-promote/${up.payload.id}`);

    // The path on the row is now `cold:<ULID>`; the dashboard / MCP
    // tool / principal hits the SAME blob route.
    const row = getStateDb()
      .prepare(`SELECT path FROM files WHERE id = ?`)
      .get(up.payload.id) as { path: string };
    assert.ok(row.path.startsWith("cold:"));

    const blob = await invokeRoute(
      "GET",
      `/api/v1/files/blob/${row.path}`,
    );
    assert.equal(blob.status, 200);
    assert.equal(blob.rawBody.toString(), content.toString());
    // Cold reads drop the Content-Length header (we don't know the
    // inflated size up front) and add an X-Cold-Blob breadcrumb.
    assert.equal(blob.headers["X-Cold-Blob"], "1");
    assert.equal(blob.headers["Content-Length"], undefined);
    // Content-Type still flows through.
    assert.equal(blob.headers["Content-Type"], "text/plain");
  });

  it("cold read bumps last_accessed_at without auto-restoring", async () => {
    const content = Buffer.from("read-me-cold");
    const up = await uploadBlob("read-cold.bin", content);
    await invokeRoute("POST", `/api/v1/files/cold-promote/${up.payload.id}`);

    const before = getStateDb()
      .prepare(`SELECT last_accessed_at, path FROM files WHERE id = ?`)
      .get(up.payload.id) as { last_accessed_at: number; path: string };
    const beforeStamp = before.last_accessed_at;
    const beforePath = before.path;
    assert.ok(beforePath.startsWith("cold:"));

    // Force a 2 ms gap so the new stamp is strictly greater.
    await new Promise((r) => setTimeout(r, 2));

    const blob = await invokeRoute(
      "GET",
      `/api/v1/files/blob/${beforePath}`,
    );
    assert.equal(blob.status, 200);

    const after = getStateDb()
      .prepare(`SELECT last_accessed_at, path FROM files WHERE id = ?`)
      .get(up.payload.id) as { last_accessed_at: number; path: string };
    assert.ok(after.last_accessed_at > beforeStamp, "stamp bumped on read");
    // Path stays `cold:` — read MUST NOT auto-restore.
    assert.equal(after.path, beforePath, "cold read does not auto-restore");
  });

  it("cold-restore explicitly pulls a cold blob back to live", async () => {
    const content = Buffer.from(
      "restore me — should land back under <ULID>/<safe-name>",
    );
    const up = await uploadBlob("restore-me.txt", content, "text/plain");
    const promote = await invokeRoute(
      "POST",
      `/api/v1/files/cold-promote/${up.payload.id}`,
    );
    assert.equal(promote.status, 200);

    const restore = await invokeRoute(
      "POST",
      `/api/v1/files/cold-restore/${up.payload.id}`,
    );
    assert.equal(restore.status, 200);
    assert.equal(restore.payload.cold_promoted_at, null);
    assert.equal(
      restore.payload.path.startsWith("cold:"),
      false,
      "restored path must be live, not cold:",
    );

    // The live volume now has the bytes back; the cold volume entry
    // is gone.
    const liveAbs = path.join(FILES_ROOT, restore.payload.path);
    assert.ok(fs.existsSync(liveAbs));
    assert.equal(fs.readFileSync(liveAbs).toString(), content.toString());

    const coldEntries = fs.existsSync(FILES_COLD_ROOT)
      ? fs.readdirSync(FILES_COLD_ROOT)
      : [];
    assert.equal(
      coldEntries.length,
      0,
      "cold volume must be clean after restore",
    );

    // file_blobs.cold_promoted_at cleared.
    const blob = getStateDb()
      .prepare(
        `SELECT cold_promoted_at, path FROM file_blobs WHERE sha256 = ?`,
      )
      .get(up.payload.sha256) as {
      cold_promoted_at: number | null;
      path: string;
    };
    assert.equal(blob.cold_promoted_at, null);
    assert.equal(blob.path.startsWith("cold:"), false);
  });

  it("/usage breaks down live_bytes vs cold_bytes after promotion", async () => {
    const a = Buffer.alloc(8 * 1024, "a");
    const b = Buffer.alloc(8 * 1024, "b");
    const rA = await uploadBlob("a.bin", a);
    const rB = await uploadBlob("b.bin", b);

    // Both live to start.
    let usage = await invokeRoute("GET", "/api/v1/files/usage");
    assert.equal(usage.payload.live_bytes, a.length + b.length);
    assert.equal(usage.payload.cold_bytes, 0);

    // Promote A.
    const promote = await invokeRoute(
      "POST",
      `/api/v1/files/cold-promote/${rA.payload.id}`,
    );
    assert.equal(promote.status, 200);
    ratiosObserved.push(promote.payload.compression_ratio);

    usage = await invokeRoute("GET", "/api/v1/files/usage");
    assert.equal(usage.payload.live_bytes, b.length);
    assert.equal(usage.payload.cold_bytes, a.length);
    assert.equal(usage.payload.blob_count_live, 1);
    assert.equal(usage.payload.blob_count_cold, 1);
    // The PR-1 compatibility surface still works (live + cold total).
    assert.equal(usage.payload.used_bytes, a.length + b.length);
    // file_count is the unchanged principal-facing row count.
    assert.equal(usage.payload.file_count, 2);
    // Use rB to silence the unused-warning.
    assert.ok(rB.payload.id);
  });

  it("cold-promote on an already-cold file is an idempotent no-op", async () => {
    const content = Buffer.from("already-cold");
    const up = await uploadBlob("c.bin", content);
    const first = await invokeRoute(
      "POST",
      `/api/v1/files/cold-promote/${up.payload.id}`,
    );
    assert.equal(first.status, 200);
    const second = await invokeRoute(
      "POST",
      `/api/v1/files/cold-promote/${up.payload.id}`,
    );
    assert.equal(second.status, 200);
    assert.equal(second.payload.already_cold, true);
    // Cold volume still has exactly one `.zst` file.
    const coldEntries = fs.readdirSync(FILES_COLD_ROOT);
    assert.equal(coldEntries.length, 1);
  });

  it("cold-candidates respects older_than_ms override (for unit tests + custom sweeps)", async () => {
    const fresh = await uploadBlob("fresh.txt", Buffer.from("now"));
    const slightlyOld = await uploadBlob(
      "old.txt",
      Buffer.from("five-min-old"),
    );
    // Mark slightlyOld as 5 minutes old; default threshold (1h env)
    // wouldn't pick it up.
    const fiveMin = 5 * 60 * 1000;
    getStateDb()
      .prepare(`UPDATE files SET last_accessed_at = ? WHERE id = ?`)
      .run(Date.now() - fiveMin - 1000, slightlyOld.payload.id);

    // Default threshold (1h) — nothing.
    let r = await invokeRoute("GET", "/api/v1/files/cold-candidates", {
      url: "/api/v1/files/cold-candidates",
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 0);

    // Lower the threshold to 1 minute — picks up slightlyOld but
    // not fresh.
    r = await invokeRoute("GET", "/api/v1/files/cold-candidates", {
      url: `/api/v1/files/cold-candidates?older_than_ms=${60 * 1000}`,
    });
    assert.equal(r.payload.total, 1);
    assert.equal(r.payload.items[0].id, slightlyOld.payload.id);
    assert.notEqual(r.payload.items[0].id, fresh.payload.id);
  });

  it("decompressed cold bytes match the originally-uploaded bytes (round trip)", async () => {
    // Random binary payload — proves the round trip is byte-accurate
    // (not just utf-8-accurate).
    const content = crypto.randomBytes(32 * 1024); // 32 KB random
    const up = await uploadBlob("rand.bin", content);
    const promote = await invokeRoute(
      "POST",
      `/api/v1/files/cold-promote/${up.payload.id}`,
    );
    assert.equal(promote.status, 200);
    // Random bytes don't compress well; ratio likely <1.0. Record
    // anyway — important to show level-19 doesn't WORSEN dramatically.
    ratiosObserved.push(promote.payload.compression_ratio);

    const row = getStateDb()
      .prepare(`SELECT path FROM files WHERE id = ?`)
      .get(up.payload.id) as { path: string };
    const blob = await invokeRoute("GET", `/api/v1/files/blob/${row.path}`);
    assert.equal(blob.status, 200);
    assert.equal(blob.rawBody.length, content.length);
    assert.ok(blob.rawBody.equals(content), "round-trip is byte-exact");

    // Sanity-check we used the zstd codec: read the on-disk file +
    // verify the zstd magic number (0x28B52FFD little-endian).
    const ulid = row.path.slice("cold:".length);
    const coldAbs = path.join(FILES_COLD_ROOT, `${ulid}.zst`);
    const head = fs.readFileSync(coldAbs).slice(0, 4);
    assert.equal(head[0], 0x28, "zstd magic byte 0");
    assert.equal(head[1], 0xb5, "zstd magic byte 1");
    assert.equal(head[2], 0x2f, "zstd magic byte 2");
    assert.equal(head[3], 0xfd, "zstd magic byte 3");
  });

  it("cold-promote refuses to promote a tombstoned file", async () => {
    const up = await uploadBlob("ghost.bin", Buffer.from("ghost"));
    const del = await invokeRoute(
      "DELETE",
      `/api/v1/files/${up.payload.path}`,
    );
    assert.equal(del.status, 200);
    const promote = await invokeRoute(
      "POST",
      `/api/v1/files/cold-promote/${up.payload.id}`,
    );
    assert.equal(promote.status, 409);
    assert.equal(promote.payload.error.code, "TOMBSTONED");
    // Use `zlib` to silence the unused-import warning at the top.
    assert.equal(typeof (zlib as any).createZstdCompress, "function");
  });
});
