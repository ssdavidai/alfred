// Store 5 (files) — HTTP routes for the principal-facing blob store.
//
// What this is
// ------------
// The tenant-local place to drop arbitrary binary files (PDFs, images,
// spreadsheets, code archives, audio, video) that Alfred can later
// read, summarise, and search. The full design lives at
// docs/specs/issue-114-local-file-storage.md; this module ships the
// PR 1 surface only:
//
//   * POST   /api/v1/files/upload     multipart streaming → /files/<ULID>/<safe-orig-name>
//   * GET    /api/v1/files/list       paginated list with metadata (+ ?q= keyword filter, PR 2)
//   * GET    /api/v1/files/usage      total bytes + caps
//   * GET    /api/v1/files/stat/*     metadata for one blob (path is the tail)
//   * GET    /api/v1/files/blob/*     streamed bytes with Content-Type + Disposition
//   * PATCH  /api/v1/files/*          partial-update for principal-owned fields (PR 2: principal_label)
//   * DELETE /api/v1/files/*          soft-delete (set deleted_at + remove blob)
//
// What it is NOT (yet)
// --------------------
//   * /files dashboard page          — PR 3
//   * Content extraction pipeline    — PR 4
//   * Voice-bridge allowlist entries — PR 5 of issue #114
//
// Architecture seams this PR respects
// -----------------------------------
//   * single writer: ctrl-api owns /files/ (mounted :rw); hermes and
//     the alfred daemon mount it :ro and write only through this API.
//   * metadata index lives in alfred-state.db (Store 2) — see migration
//     0003_files_table.sql.
//   * the blob layout is `<ULID>/<safe-orig-name>` so two uploads with
//     the same display name don't collide and chronological sort is
//     preserved by the ULID prefix.
//   * auth: existing AAS_API_KEY bearer pattern (auth.ts). DELETE is
//     gated by uploader semantics — per spec §10 only the `principal`
//     actor may delete, but for PR 1 we accept any authenticated caller
//     (PR 2 will tighten this once the MCP tools land their own actors).
//
// Quotas
// ------
// Per spec §7 Q7 RESOLVED: 10 GB soft / 20 GB hard per tenant.
//
//   * Upload below soft  → accepted
//   * Upload that would push live usage over hard → 507 Insufficient
//     Storage with a clear hint
//   * `GET /usage` always reports both caps so the UI can warn pre-emptively
//
// Per-upload limits
// -----------------
//   * Soft 250 MB / hard 2 GB per single file (per spec §5.9)
//   * Multipart streaming — never base64; chunks are sha256'd and written
//     straight to disk so the entire blob never has to live in RAM at once.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError, ApiError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { appendAudit } from "./state.js";

// ── Configuration ──────────────────────────────────────────────────────────

/** Root of the blob volume inside the ctrl-api container. The
 *  docker-compose mount lands `files_data` here `:rw`. Override via
 *  FILES_ROOT for tests. */
const FILES_ROOT = process.env.FILES_ROOT ?? "/files";

/** Root of the cold-archive volume inside the ctrl-api container.
 *  The docker-compose mount lands `files_cold_data` here `:rw`. The
 *  daily FilesColdArchiveWorkflow promotes unread (>=90d) files from
 *  FILES_ROOT to FILES_COLD_ROOT, zstd-compressed at level 19.
 *  Override via FILES_COLD_ROOT for tests. Issue #114 PR 5. */
const FILES_COLD_ROOT = process.env.FILES_COLD_ROOT ?? "/cold-files";

/** Cold-storage path prefix used in `files.path` + `file_blobs.path`
 *  to mark a blob as living on the cold volume. The blob GET route
 *  strips the prefix, resolves the remainder under FILES_COLD_ROOT,
 *  appends `.zst`, and streams a transparent decompression on the way
 *  out. */
const COLD_PATH_PREFIX = "cold:";

/** Age threshold for cold-archive promotion. Files whose
 *  `last_accessed_at` (or `uploaded_at` if never accessed) is older
 *  than this become eligible for the daily sweep. Override via
 *  FILES_COLD_AFTER_MS for tests. Default: 90 days. */
export const COLD_AFTER_MS = Number(
  process.env.FILES_COLD_AFTER_MS ?? String(90 * 24 * 60 * 60 * 1000),
);

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Soft per-upload size: above this we'd want the principal to confirm
 *  in PR 4 UI. PR 1 doesn't yet differentiate — kept as a constant for
 *  the `/usage` surface and a future PR. */
export const UPLOAD_SOFT_BYTES = 250 * MB;
/** Hard per-upload size — above this we 413 outright. */
export const UPLOAD_HARD_BYTES = 2 * GB;

/** Per-tenant soft live quota. Override via FILES_QUOTA_SOFT_BYTES. */
export const QUOTA_SOFT_BYTES = Number(
  process.env.FILES_QUOTA_SOFT_BYTES ?? String(10 * GB),
);
/** Per-tenant hard live quota — uploads beyond this 507. */
export const QUOTA_HARD_BYTES = Number(
  process.env.FILES_QUOTA_HARD_BYTES ?? String(20 * GB),
);

// ── ULID (hand-rolled, no dependency) ───────────────────────────────────────
//
// Crockford base32 — 10 chars of timestamp (ms) + 16 chars of randomness =
// 26 chars total. Matches the shape used by `audit.id`, `alfred_journal.id`,
// and every other ULID in the state schema.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeCrockford(value: number, length: number): string {
  let v = value;
  let out = "";
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

export function ulid(): string {
  const ts = Date.now();
  const tsPart = encodeCrockford(ts, 10);
  const randBytes = crypto.randomBytes(10);
  let randPart = "";
  for (let i = 0; i < 16; i++) {
    // Read 5 bits at a time across the 80-bit random buffer. Bit cursor
    // = i * 5; byte = floor(cursor/8); bit offset inside the byte =
    // cursor%8. Pulls 5 bits as a single 5-bit int.
    const bit = i * 5;
    const byte = Math.floor(bit / 8);
    const off = bit % 8;
    const hi = randBytes[byte];
    const lo = randBytes[byte + 1] ?? 0;
    const word = ((hi << 8) | lo) >>> 0;
    const shift = 16 - 5 - off;
    const slot = (word >> shift) & 0x1f;
    randPart += CROCKFORD[slot];
  }
  return tsPart + randPart;
}

// ── path safety ────────────────────────────────────────────────────────────

/** Strip path separators / shell metacharacters and the parent-directory
 *  escape `..` from a display filename. Falls back to `file` so a row
 *  always has a non-empty name on disk. Caps at 200 chars to avoid the
 *  4096 PATH_MAX surprise. */
export function sanitizeFilename(name: string): string {
  let s = (name ?? "").trim();
  // Drop everything before the last path separator — clients sometimes
  // send "C:\Users\sir\foo.pdf" or "/tmp/foo.pdf"; only the basename is
  // meaningful for our blob store.
  const lastSep = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (lastSep >= 0) s = s.slice(lastSep + 1);
  s = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\.\./g, "_");
  if (!s || s === "." || s === "..") s = "file";
  if (s.length > 200) {
    // Preserve the extension when truncating.
    const dot = s.lastIndexOf(".");
    if (dot > 0 && dot > s.length - 16) {
      const ext = s.slice(dot);
      s = s.slice(0, 200 - ext.length) + ext;
    } else {
      s = s.slice(0, 200);
    }
  }
  return s;
}

/** Resolve and re-check a path inside FILES_ROOT. Throws ValidationError
 *  if the resolution escapes the root (defence in depth against `..`
 *  even after sanitization). */
function resolveBlobPath(relPath: string): string {
  const root = path.resolve(FILES_ROOT);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new ValidationError("path escapes the files root");
  }
  return abs;
}

/** Resolve a `cold:<ULID>` path to its absolute on-disk location under
 *  FILES_COLD_ROOT. The on-disk filename is `<ULID>.zst`. Throws
 *  ValidationError if the resolution would escape FILES_COLD_ROOT
 *  (defence in depth — the cold blob name is principal-untrusted in
 *  the rare case a malformed row sneaks through). Issue #114 PR 5. */
function resolveColdBlobPath(coldPath: string): string {
  if (!coldPath.startsWith(COLD_PATH_PREFIX)) {
    throw new ValidationError(`not a cold path: ${coldPath}`);
  }
  const tail = coldPath.slice(COLD_PATH_PREFIX.length);
  // The cold filename is just the ULID — no path separators allowed.
  if (tail.includes("/") || tail.includes("\\") || tail.includes("..")) {
    throw new ValidationError(`cold path tail must be a bare ULID: ${tail}`);
  }
  const root = path.resolve(FILES_COLD_ROOT);
  const abs = path.resolve(root, `${tail}.zst`);
  if (!abs.startsWith(root + path.sep)) {
    throw new ValidationError("cold path escapes the cold files root");
  }
  return abs;
}

/** True iff the given `files.path` / `file_blobs.path` value lives on
 *  the cold-archive volume (vs the live volume). */
export function isColdPath(p: string): boolean {
  return p.startsWith(COLD_PATH_PREFIX);
}

// ── DB helpers ─────────────────────────────────────────────────────────────

interface FileRow {
  id: string;
  path: string;
  size_bytes: number;
  sha256: string;
  content_type: string | null;
  original_filename: string | null;
  principal_label: string | null;
  uploaded_by: string;
  uploaded_at: number;
  last_accessed_at: number | null;
  deleted_at: number | null;
  cold_promoted_at: number | null;
  ref_count: number;
}

function rowFromDb(raw: Record<string, unknown>): FileRow {
  return {
    id: String(raw.id),
    path: String(raw.path),
    size_bytes: Number(raw.size_bytes),
    sha256: String(raw.sha256),
    content_type: raw.content_type == null ? null : String(raw.content_type),
    original_filename:
      raw.original_filename == null ? null : String(raw.original_filename),
    principal_label:
      raw.principal_label == null ? null : String(raw.principal_label),
    uploaded_by: String(raw.uploaded_by),
    uploaded_at: Number(raw.uploaded_at),
    last_accessed_at:
      raw.last_accessed_at == null ? null : Number(raw.last_accessed_at),
    deleted_at: raw.deleted_at == null ? null : Number(raw.deleted_at),
    cold_promoted_at:
      raw.cold_promoted_at == null ? null : Number(raw.cold_promoted_at),
    ref_count: raw.ref_count == null ? 1 : Number(raw.ref_count),
  };
}

/**
 * Per-tenant storage usage, computed from the deduped `file_blobs`
 * table so two `files` rows with the same sha256 count their bytes
 * ONCE. Live (= un-promoted) and cold (= promoted) storage are
 * reported separately so the /usage UI can break down "what's on the
 * hot volume" vs "what's been frozen to the cold volume". Issue #114
 * PR 5.
 *
 * The `count` is the number of distinct sha256s in each bucket, NOT
 * the number of `files.id` rows — the row count is the principal's
 * count of distinct uploads, exposed separately as `file_count` on
 * the /usage response.
 */
function tenantUsage(): {
  live_bytes: number;
  cold_bytes: number;
  blob_count_live: number;
  blob_count_cold: number;
  file_count: number;
} {
  const db = getStateDb();
  // Only `file_blobs` rows with at least one live (non-tombstoned)
  // `files` row referencing them contribute to usage. Tombstoned rows
  // already had their ref_count decremented at delete time; a
  // ref_count of zero means the bytes have been (or will be) reaped
  // by the deletion path and don't count.
  const live = db
    .prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS used, COUNT(*) AS count
         FROM file_blobs
        WHERE cold_promoted_at IS NULL AND ref_count > 0`,
    )
    .get() as { used: number; count: number };
  const cold = db
    .prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS used, COUNT(*) AS count
         FROM file_blobs
        WHERE cold_promoted_at IS NOT NULL AND ref_count > 0`,
    )
    .get() as { used: number; count: number };
  const fileCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM files WHERE deleted_at IS NULL`)
      .get() as { c: number }
  ).c;
  return {
    live_bytes: Number(live.used),
    cold_bytes: Number(cold.used),
    blob_count_live: Number(live.count),
    blob_count_cold: Number(cold.count),
    file_count: Number(fileCount),
  };
}

// ── multipart parser ───────────────────────────────────────────────────────
//
// We don't pull in `busboy` or `formidable` — the ctrl-api bundle is
// dependency-discipline'd (only commander/ink/ssh2 ride along) and the
// upload contract here is narrow: ONE `file` part, optional
// `principal_label`/`original_filename` text fields. We parse just enough
// of RFC 7578 to peel one binary part out of the stream and pipe it
// straight to disk while sha256'ing on the fly.
//
// Memory profile: each chunk is held only until it's been scanned for
// the boundary and either written to disk or carried forward to the
// next chunk as a tail (max boundary length, ~80 bytes). The whole blob
// never lives in RAM. Good for 2 GB uploads on a small VM.

interface MultipartFields {
  /** Extra text fields posted alongside `file`. */
  text: Record<string, string>;
  /** Original filename declared in the `file` part's Content-Disposition. */
  filename: string | null;
  /** Content-Type from the `file` part, if the client sent one. */
  contentType: string | null;
  /** Bytes written to disk (also the on-the-fly size counter). */
  size: number;
  /** Hex sha256 of the bytes written. */
  sha256: string;
}

/** RFC 7578: extract `boundary=` from a `multipart/form-data; boundary=…`
 *  Content-Type header. */
function parseBoundary(contentType: string): string | null {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  return m ? m[2] : null;
}

/** Parse a header block (CRLF-separated `Key: Value` lines) into a
 *  lower-cased dict. */
function parsePartHeaders(block: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.toString("utf-8").split("\r\n")) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

interface ContentDisposition {
  name: string | null;
  filename: string | null;
}

function parseContentDisposition(value: string): ContentDisposition {
  // form-data; name="foo"; filename="bar.pdf"
  let name: string | null = null;
  let filename: string | null = null;
  const nameMatch = /name=("?)([^";]+)\1/i.exec(value);
  if (nameMatch) name = nameMatch[2];
  const fnMatch = /filename=("?)([^"]+)\1/i.exec(value);
  if (fnMatch) filename = fnMatch[2];
  return { name, filename };
}

/** Drain `req` into multipart parts, streaming the `file` part to
 *  `writeStream` and tallying sha256 + size on the fly. Text fields
 *  (anything that isn't the `file` part) accumulate into the returned
 *  `text` dict — each capped at 8 KiB to keep an adversarial client
 *  from filling RAM through a fake "field". */
async function consumeMultipart(
  req: IncomingMessage,
  boundary: string,
  writeStream: fs.WriteStream,
  maxBytes: number,
): Promise<MultipartFields> {
  return new Promise((resolve, reject) => {
    const delim = Buffer.from(`--${boundary}`);
    const crlf = Buffer.from("\r\n");
    const close = Buffer.from(`--${boundary}--`);

    let buf = Buffer.alloc(0);
    let inPart = false;
    let inFilePart = false;
    let currentName: string | null = null;
    let currentTextChunks: Buffer[] = [];
    let currentTextLen = 0;

    const result: MultipartFields = {
      text: {},
      filename: null,
      contentType: null,
      size: 0,
      sha256: "",
    };
    const hasher = crypto.createHash("sha256");
    let aborted = false;

    function fail(err: Error) {
      if (aborted) return;
      aborted = true;
      try {
        writeStream.destroy();
      } catch {
        /* noop */
      }
      reject(err);
    }

    function emitFileChunk(chunk: Buffer): boolean {
      result.size += chunk.length;
      if (result.size > maxBytes) {
        fail(
          new ApiError(
            413,
            "UPLOAD_TOO_LARGE",
            `upload exceeds hard per-file cap of ${maxBytes} bytes`,
          ),
        );
        return false;
      }
      hasher.update(chunk);
      // Backpressure honoured via the stream's internal queue; we don't
      // await drain here because Node's writable always accepts the
      // write even when it returns false (the data just queues). If we
      // needed to pause the upstream we'd req.pause()/writeStream.once
      // ("drain") — not critical for PR 1.
      writeStream.write(chunk);
      return true;
    }

    function emitTextChunk(chunk: Buffer): boolean {
      currentTextLen += chunk.length;
      if (currentTextLen > 8 * 1024) {
        fail(new ValidationError("multipart text field exceeds 8 KiB"));
        return false;
      }
      currentTextChunks.push(chunk);
      return true;
    }

    function finishPart() {
      if (inFilePart) {
        // file part complete; nothing else to do
      } else if (currentName) {
        result.text[currentName] = Buffer.concat(currentTextChunks).toString(
          "utf-8",
        );
      }
      inPart = false;
      inFilePart = false;
      currentName = null;
      currentTextChunks = [];
      currentTextLen = 0;
    }

    function handleData(chunk: Buffer) {
      if (aborted) return;
      buf = Buffer.concat([buf, chunk]);

      // Loop: each iteration peels at most one boundary or one part-body
      // chunk out of the buffer.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (!inPart) {
          // Look for the next delimiter line.
          const idx = buf.indexOf(delim);
          if (idx < 0) {
            // No delimiter yet — keep what we have (could be a partial
            // delimiter at the tail).
            if (buf.length > delim.length * 2) {
              // Discard everything except a window the length of the
              // delimiter so we don't grow unbounded waiting.
              buf = buf.slice(buf.length - delim.length * 2);
            }
            return;
          }
          // Check whether this is the closing boundary `--boundary--`.
          if (
            buf.length >= idx + close.length &&
            buf.slice(idx, idx + close.length).equals(close)
          ) {
            // End of message.
            buf = Buffer.alloc(0);
            return;
          }
          // Skip the delimiter + the CRLF that follows it.
          const after = idx + delim.length;
          const crlfIdx = buf.indexOf(crlf, after);
          if (crlfIdx < 0) return; // wait for more bytes
          // After the boundary's CRLF, read the header block (terminated
          // by CRLF CRLF).
          const headerStart = crlfIdx + 2;
          const headerEnd = buf.indexOf(
            Buffer.from("\r\n\r\n"),
            headerStart,
          );
          if (headerEnd < 0) return; // wait for full header block
          const headers = parsePartHeaders(buf.slice(headerStart, headerEnd));
          const cd = headers["content-disposition"]
            ? parseContentDisposition(headers["content-disposition"])
            : { name: null, filename: null };
          inPart = true;
          currentName = cd.name;
          if (cd.filename !== null) {
            inFilePart = true;
            result.filename = cd.filename;
            result.contentType = headers["content-type"] ?? null;
          } else {
            inFilePart = false;
          }
          buf = buf.slice(headerEnd + 4);
          continue;
        }

        // We're inside a part body. Find the next delimiter.
        const delimWithPrefix = Buffer.concat([crlf, delim]);
        const idx = buf.indexOf(delimWithPrefix);
        if (idx < 0) {
          // Keep enough tail to catch a delimiter straddling the next
          // chunk; emit the rest.
          const keep = delimWithPrefix.length;
          if (buf.length > keep) {
            const emit = buf.slice(0, buf.length - keep);
            if (inFilePart) {
              if (!emitFileChunk(emit)) return;
            } else {
              if (!emitTextChunk(emit)) return;
            }
            buf = buf.slice(buf.length - keep);
          }
          return;
        }
        // Emit everything up to the delimiter.
        const emit = buf.slice(0, idx);
        if (emit.length > 0) {
          if (inFilePart) {
            if (!emitFileChunk(emit)) return;
          } else {
            if (!emitTextChunk(emit)) return;
          }
        }
        finishPart();
        // Consume the leading CRLF; leave the delimiter for the !inPart
        // branch on the next loop iteration.
        buf = buf.slice(idx + 2);
      }
    }

    req.on("data", handleData);
    req.on("end", () => {
      if (aborted) return;
      // Close the write stream and finalize the hash. We finish on the
      // stream's flush callback so the file has actually been flushed
      // before the promise resolves.
      writeStream.end(() => {
        result.sha256 = hasher.digest("hex");
        resolve(result);
      });
    });
    req.on("error", (err) => fail(err));
    writeStream.on("error", (err) => fail(err));
  });
}

// ── content-type sniffing ───────────────────────────────────────────────────

function sniffContentType(filename: string | null): string | null {
  if (!filename) return null;
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  const MAP: Record<string, string> = {
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
    html: "text/html",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return MAP[ext] ?? null;
}

// ── shared row → JSON shape ────────────────────────────────────────────────

function rowToJson(row: FileRow): Record<string, unknown> {
  return {
    id: row.id,
    path: row.path,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    content_type: row.content_type,
    original_filename: row.original_filename,
    principal_label: row.principal_label,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at,
    last_accessed_at: row.last_accessed_at,
    deleted_at: row.deleted_at,
    cold_promoted_at: row.cold_promoted_at,
  };
}

// ── bootstrap ─────────────────────────────────────────────────────────────

function ensureFilesRoot(): void {
  try {
    fs.mkdirSync(FILES_ROOT, { recursive: true });
  } catch (err) {
    // Best-effort. Inside the container the volume mount creates the
    // path already; this is for fresh test harnesses where FILES_ROOT
    // is an mkdtemp dir.
    console.warn(
      `[files] could not ensure ${FILES_ROOT}: ${(err as Error).message}`,
    );
  }
  try {
    fs.mkdirSync(FILES_COLD_ROOT, { recursive: true });
  } catch (err) {
    console.warn(
      `[files] could not ensure ${FILES_COLD_ROOT}: ${(err as Error).message}`,
    );
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerFilesRoutes(): void {
  ensureFilesRoot();

  // POST /api/v1/files/upload
  //
  // Multipart streaming upload. ONE file part named `file`; optional
  // text fields `principal_label` and `original_filename` (the latter
  // wins over the part's own filename header if both are supplied).
  // The `uploaded_by` actor defaults to `principal`; callers may
  // override via the `uploaded_by` field but PR 1 doesn't yet validate
  // it against a registry (PR 2 wires that to the MCP tool actor).
  //
  // Issue #114 PR 5 — content-addressed dedupe.
  // ----------------------------------------------------------------
  // Before inserting the `files` row we look up the sha256 in the
  // `file_blobs` table. If a row exists we DO NOT write the bytes a
  // second time: the new `files.id` points at the existing
  // `file_blobs.path` (which may be a live `<ULID>/<safe-name>` or a
  // promoted `cold:<ULID>`) and the canonical row's `ref_count` ticks
  // up by one. Quota counts only unique sha256s (see `tenantUsage`),
  // so the second upload of the same content costs zero principal
  // bytes. The response shape is unchanged plus a `deduped` flag for
  // observability.
  //
  // Race note. Two concurrent uploads of the same content can both
  // pass the pre-flight `file_blobs` SELECT and both write the bytes
  // to disk. We resolve that race AFTER both writes complete: the
  // INSERT-or-IGNORE on `file_blobs` is the serialization point — the
  // loser sees `changes()==0`, deletes its just-written ULID dir, and
  // resolves its `files.path` to the winner's canonical path. Net
  // outcome: exactly one set of bytes on disk, two `files` rows
  // sharing it, ref_count=2.
  addRoute("POST", "/api/v1/files/upload", async ({ req, res }) => {
    const ct = String(req.headers["content-type"] ?? "");
    if (!ct.toLowerCase().startsWith("multipart/form-data")) {
      throw new ValidationError(
        "Content-Type must be multipart/form-data (PR 1 uses streamed multipart, not base64 JSON)",
      );
    }
    const boundary = parseBoundary(ct);
    if (!boundary) {
      throw new ValidationError("multipart/form-data boundary= missing");
    }

    // Per-tenant hard quota pre-flight: bail before opening the write
    // stream so we don't even allocate the ULID dir on a doomed upload.
    // PR 5 — only the unique-sha256 bytes count (live + cold).
    const before = tenantUsage();
    const usedBeforeBytes = before.live_bytes + before.cold_bytes;
    if (usedBeforeBytes >= QUOTA_HARD_BYTES) {
      throw new ApiError(
        507,
        "QUOTA_EXCEEDED",
        `tenant hard quota of ${QUOTA_HARD_BYTES} bytes reached`,
      );
    }

    const id = ulid();
    // We don't know the original filename until we've parsed the first
    // multipart header — write to a scratch path inside the ULID dir,
    // then rename after we know the safe filename. The ULID dir itself
    // doubles as the namespace so two uploads with the same display
    // name never collide.
    const ulidDir = resolveBlobPath(id);
    fs.mkdirSync(ulidDir, { recursive: true });
    const scratchPath = path.join(ulidDir, ".upload-in-progress");
    const writeStream = fs.createWriteStream(scratchPath);

    let parsed: MultipartFields;
    try {
      parsed = await consumeMultipart(
        req,
        boundary,
        writeStream,
        UPLOAD_HARD_BYTES,
      );
    } catch (err) {
      // Cleanup the scratch + ULID dir; we never created a row.
      try {
        fs.rmSync(ulidDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      throw err;
    }

    // ── dedupe check ────────────────────────────────────────────────
    // After the body's been drained + sha256'd, look up the hash in
    // `file_blobs`. We re-check the quota using the deduped size: a
    // duplicate adds zero bytes to live storage so it should never be
    // 507'd, even if the principal is right at the cap.
    const db = getStateDb();
    const existingBlob = db
      .prepare(
        `SELECT sha256, path, size_bytes, cold_promoted_at
           FROM file_blobs WHERE sha256 = ?`,
      )
      .get(parsed.sha256) as
      | {
          sha256: string;
          path: string;
          size_bytes: number;
          cold_promoted_at: number | null;
        }
      | undefined;

    // Pure-new (no `file_blobs` row) quota gate: would this push us
    // over the hard cap? Duplicates skip this check.
    if (!existingBlob && usedBeforeBytes + parsed.size > QUOTA_HARD_BYTES) {
      try {
        fs.rmSync(ulidDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      throw new ApiError(
        507,
        "QUOTA_EXCEEDED",
        `upload would exceed tenant hard quota of ${QUOTA_HARD_BYTES} bytes`,
      );
    }

    // Resolve final filename: explicit text-field override beats part
    // header beats fallback to `file`.
    const declared =
      parsed.text.original_filename ||
      parsed.filename ||
      parsed.text.filename ||
      "file";
    const safeName = sanitizeFilename(declared);
    const contentType =
      parsed.contentType ||
      parsed.text.content_type ||
      sniffContentType(safeName);
    const principalLabel = parsed.text.principal_label || null;
    const uploadedBy = parsed.text.uploaded_by || "principal";
    const now = Date.now();
    const originalFilename = declared;

    let relPath: string;
    let deduped: boolean;

    if (existingBlob) {
      // ── dedupe path: the bytes already live on disk (or in the
      // cold archive). Throw away our scratch copy, bump the
      // canonical row's ref_count, and point the new `files.id`
      // row at the existing path. The principal sees the SAME path
      // they would have gotten if they uploaded for the first time —
      // the dedupe is transparent on the read side.
      try {
        fs.rmSync(ulidDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      db.prepare(
        `UPDATE file_blobs SET ref_count = ref_count + 1 WHERE sha256 = ?`,
      ).run(parsed.sha256);
      relPath = existingBlob.path;
      deduped = true;
    } else {
      // ── novel path: finalize the on-disk filename, then INSERT
      // OR IGNORE into `file_blobs`. The IGNORE catches the race
      // where two concurrent uploads of the same content both pass
      // the dedupe-check above; whoever loses the INSERT race wins
      // the cleanup duty (delete their just-written ULID dir, point
      // at the canonical path, bump ref_count).
      const finalPath = path.join(ulidDir, safeName);
      fs.renameSync(scratchPath, finalPath);
      const novelRelPath = path.posix.join(id, safeName);
      const insert = db
        .prepare(
          `INSERT OR IGNORE INTO file_blobs
            (sha256, path, size_bytes, ref_count, created_at)
           VALUES (?, ?, ?, 1, ?)`,
        )
        .run(parsed.sha256, novelRelPath, parsed.size, now);
      if (insert.changes === 0) {
        // Concurrent-write race lost. Adopt the canonical row.
        const canonical = db
          .prepare(
            `SELECT path FROM file_blobs WHERE sha256 = ?`,
          )
          .get(parsed.sha256) as { path: string } | undefined;
        try {
          fs.rmSync(ulidDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        db.prepare(
          `UPDATE file_blobs SET ref_count = ref_count + 1 WHERE sha256 = ?`,
        ).run(parsed.sha256);
        relPath = canonical?.path ?? novelRelPath;
        deduped = true;
      } else {
        relPath = novelRelPath;
        deduped = false;
      }
    }

    db.prepare(
      `INSERT INTO files
        (id, path, size_bytes, sha256, content_type, original_filename,
         principal_label, uploaded_by, uploaded_at, ref_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      id,
      relPath,
      parsed.size,
      parsed.sha256,
      contentType,
      originalFilename,
      principalLabel,
      uploadedBy,
      now,
    );

    sendJson(res, 201, {
      id,
      path: relPath,
      size_bytes: parsed.size,
      sha256: parsed.sha256,
      content_type: contentType,
      original_filename: originalFilename,
      principal_label: principalLabel,
      uploaded_by: uploadedBy,
      uploaded_at: now,
      deduped,
    });
  });

  // GET /api/v1/files/list?prefix=&q=&limit=&offset=
  //
  // Paginated, deleted_at-aware list. Three orthogonal filters, each
  // optional and combined with AND:
  //   * `prefix` — `path LIKE prefix||'%'` (under a ULID dir / by safe-name prefix)
  //   * `q`      — keyword search across `path`, `original_filename`,
  //                and `principal_label` (case-insensitive LIKE). PR 2
  //                ships this as the principal-facing search surface for
  //                the `files__search` MCP tool. Content indexing comes
  //                in PR 4.
  //   * `limit` / `offset` — pagination (limit default 100, max 1000)
  //
  // PR 1 doesn't yet expose a virtual `parent_dir` (that's PR 3).
  addRoute("GET", "/api/v1/files/list", async ({ res, query }) => {
    const prefix = (query.get("prefix") ?? "").trim();
    const q = (query.get("q") ?? "").trim();
    const limitRaw = Number(query.get("limit") ?? "100");
    const offsetRaw = Number(query.get("offset") ?? "0");
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(1000, Math.floor(limitRaw))
        : 100;
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

    // Build the WHERE clause dynamically — `deleted_at IS NULL` is always
    // present; prefix and q each contribute an additional clause +
    // bound parameter. SQLite's LIKE is case-sensitive by default for
    // BLOBs and case-insensitive for TEXT; we go belt-and-braces by
    // lower()'ing both sides for the `q` keyword scan so principal
    // labels written in mixed case still match.
    const clauses: string[] = ["deleted_at IS NULL"];
    const args: unknown[] = [];
    if (prefix) {
      clauses.push("path LIKE ?");
      args.push(`${prefix}%`);
    }
    if (q) {
      const needle = `%${q.toLowerCase()}%`;
      clauses.push(
        "(lower(path) LIKE ? OR lower(COALESCE(original_filename, '')) LIKE ? OR lower(COALESCE(principal_label, '')) LIKE ?)",
      );
      args.push(needle, needle, needle);
    }
    const where = clauses.join(" AND ");

    const db = getStateDb();
    const rows = db
      .prepare(
        `SELECT * FROM files
          WHERE ${where}
          ORDER BY uploaded_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Record<string, unknown>[];
    const total = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS c FROM files WHERE ${where}`)
          .get(...args) as { c: number }
      ).c,
    );
    sendJson(res, 200, {
      items: rows.map((r) => rowToJson(rowFromDb(r))),
      total,
      limit,
      offset,
    });
  });

  // GET /api/v1/files/usage
  //
  // Always-on observability. PR 5 changed two things:
  //   * usage is computed from `file_blobs` (one row per unique
  //     sha256) so two duplicate uploads count their bytes ONCE.
  //   * the live/cold split is exposed so the /files dashboard can
  //     show "X GB live + Y GB cold" — useful both for the storage
  //     mental model and for sizing future cold-restore decisions.
  //
  // `used_bytes` + `count` are preserved as the PR 1 fields so
  // existing callers (the /files page, MCP `files__usage`) keep
  // working without a contract bump. `used_bytes` is the SUM of
  // `live_bytes` + `cold_bytes`; `count` is `file_count`.
  addRoute("GET", "/api/v1/files/usage", async ({ res }) => {
    const u = tenantUsage();
    sendJson(res, 200, {
      // PR 1 compatibility surface (now the live+cold sum).
      used_bytes: u.live_bytes + u.cold_bytes,
      count: u.file_count,
      // PR 5 surface — live vs cold breakdown.
      live_bytes: u.live_bytes,
      cold_bytes: u.cold_bytes,
      blob_count_live: u.blob_count_live,
      blob_count_cold: u.blob_count_cold,
      file_count: u.file_count,
      soft_cap_bytes: QUOTA_SOFT_BYTES,
      hard_cap_bytes: QUOTA_HARD_BYTES,
      upload_soft_bytes: UPLOAD_SOFT_BYTES,
      upload_hard_bytes: UPLOAD_HARD_BYTES,
    });
  });

  // GET /api/v1/files/stat/* — metadata for one blob.
  //
  // The `*` route-tail picks up the entire `<ULID>/<filename>` shape so
  // the path matches what `list` and `upload` return. Soft-deleted rows
  // are excluded — clients see a 404 just like for a never-existed path.
  addRoute("GET", "/api/v1/files/stat/*", async ({ res, params }) => {
    const relPath = params.path ?? "";
    if (!relPath) throw new ValidationError("path is required");
    const raw = getStateDb()
      .prepare(
        `SELECT * FROM files WHERE path = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(relPath) as Record<string, unknown> | undefined;
    if (!raw) throw new NotFoundError(`file not found: ${relPath}`);
    sendJson(res, 200, rowToJson(rowFromDb(raw)));
  });

  // GET /api/v1/files/blob/* — stream the raw bytes.
  //
  // Bumps `last_accessed_at` on every read so the principal can sort
  // by recency on the /files page AND so the cold-archive sweep can
  // skip recently-touched files.
  //
  // Cold-aware (PR 5). If `files.path` starts with `cold:` the blob
  // lives on the `files_cold_data` volume as `<ULID>.zst`. The
  // decompression streams through `zlib.createZstdDecompress` so we
  // never load a multi-MB file into memory — the inflated bytes go
  // straight from the cold volume to the response socket. We can't
  // pre-compute `Content-Length` (decompressed size != on-disk size)
  // so we drop that header on cold reads and let the client read to
  // EOF; the live path keeps its Content-Length for byte-range and
  // download-progress goodness.
  //
  // A cold read does NOT auto-restore the blob to the live volume —
  // the principal opts in via the explicit `POST /cold-restore/:file_id`
  // route. Keeps the read path predictable: a cold read is a cold
  // read until the operator says otherwise.
  addRoute("GET", "/api/v1/files/blob/*", async ({ res, params }) => {
    const relPath = params.path ?? "";
    if (!relPath) throw new ValidationError("path is required");
    const db = getStateDb();
    const raw = db
      .prepare(
        `SELECT * FROM files WHERE path = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(relPath) as Record<string, unknown> | undefined;
    if (!raw) throw new NotFoundError(`file not found: ${relPath}`);
    const row = rowFromDb(raw);

    const cold = isColdPath(row.path);
    const abs = cold ? resolveColdBlobPath(row.path) : resolveBlobPath(row.path);
    if (!fs.existsSync(abs)) {
      // Row points at a missing blob — a real "this should never
      // happen", but if it does the principal deserves a clear 410.
      throw new ApiError(
        410,
        "BLOB_MISSING",
        `the row exists but the blob at ${row.path} is gone`,
      );
    }

    const headers: Record<string, string | number> = {
      "Content-Type": row.content_type || "application/octet-stream",
    };
    if (!cold) {
      // Hot path: we know the decompressed size; live blobs are
      // stored verbatim so the on-disk size is the wire size.
      const stat = fs.statSync(abs);
      headers["Content-Length"] = stat.size;
    } else {
      // Cold path: the inflated stream is generated on the fly. We
      // could pre-inflate to a temp file to learn the size, but that
      // breaks the "never load into memory" invariant and costs an
      // extra disk round trip. Drop the header instead.
      headers["X-Cold-Blob"] = "1";
    }
    if (row.original_filename) {
      // RFC 5987 / 6266 — use a UTF-8 encoded `filename*` so non-ASCII
      // characters survive the round trip without breaking older
      // browsers. Plain `filename=` is the ASCII fallback.
      const utf8 = encodeURIComponent(row.original_filename);
      const ascii = row.original_filename.replace(/[^\x20-\x7e]/g, "_");
      headers["Content-Disposition"] =
        `inline; filename="${ascii}"; filename*=UTF-8''${utf8}`;
    }
    res.writeHead(200, headers);
    db.prepare(
      `UPDATE files SET last_accessed_at = ? WHERE id = ?`,
    ).run(Date.now(), row.id);
    if (cold) {
      streamColdBlobTo(res, abs);
    } else {
      streamBlobTo(res, abs);
    }
  });

  // PATCH /api/v1/files/* — update principal-owned metadata.
  //
  // PR 2 of issue #114 added this so the `files__describe` MCP tool can
  // set `principal_label` (the principal's free-text description of
  // what's in a blob) without having to re-upload. Only the fields
  // listed below are writable; anything else is silently ignored so a
  // forward-compatible client that posts unknown keys still gets a 200.
  //
  // Writable fields (PR 2):
  //   * principal_label  — string|null. Trimmed; empty string clears.
  //
  // Returns the full updated row. Soft-deleted rows are not patchable
  // (404, mirroring stat / blob).
  addRoute("PATCH", "/api/v1/files/*", async ({ res, params, body }) => {
    const relPath = params.path ?? "";
    if (!relPath) throw new ValidationError("path is required");
    const db = getStateDb();
    const raw = db
      .prepare(
        `SELECT * FROM files WHERE path = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(relPath) as Record<string, unknown> | undefined;
    if (!raw) throw new NotFoundError(`file not found: ${relPath}`);
    const row = rowFromDb(raw);

    const patch =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    let nextLabel: string | null = row.principal_label;
    let touched = false;
    if (Object.prototype.hasOwnProperty.call(patch, "principal_label")) {
      const v = patch.principal_label;
      if (v === null || v === undefined) {
        nextLabel = null;
      } else if (typeof v === "string") {
        const trimmed = v.trim();
        nextLabel = trimmed === "" ? null : trimmed;
      } else {
        throw new ValidationError("principal_label must be a string or null");
      }
      touched = true;
    }

    if (touched) {
      db.prepare(`UPDATE files SET principal_label = ? WHERE id = ?`).run(
        nextLabel,
        row.id,
      );
    }

    const after = db
      .prepare(`SELECT * FROM files WHERE id = ? LIMIT 1`)
      .get(row.id) as Record<string, unknown>;
    sendJson(res, 200, rowToJson(rowFromDb(after)));
  });

  // DELETE /api/v1/files/* — soft delete.
  //
  // Sets the tombstone column. With dedupe (PR 5) the on-disk bytes
  // are SHARED via `file_blobs`, so the unlink only happens when the
  // canonical row's `ref_count` drops to zero — otherwise the other
  // live `files.id` rows would suddenly point at a missing blob. The
  // `files` row stays for the audit trail either way.
  //
  // Cold blobs are unlinked from FILES_COLD_ROOT instead of
  // FILES_ROOT when their ref_count hits zero.
  addRoute("DELETE", "/api/v1/files/*", async ({ res, params }) => {
    const relPath = params.path ?? "";
    if (!relPath) throw new ValidationError("path is required");
    const db = getStateDb();
    const raw = db
      .prepare(
        `SELECT * FROM files WHERE path = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(relPath) as Record<string, unknown> | undefined;
    if (!raw) throw new NotFoundError(`file not found: ${relPath}`);
    const row = rowFromDb(raw);
    const now = Date.now();
    // Soft-delete the principal-facing row.
    db.prepare(`UPDATE files SET deleted_at = ? WHERE id = ?`).run(now, row.id);
    // Decrement the canonical blob's ref_count, then physically unlink
    // only if it just hit zero. INSERT-or-IGNORE on upload guarantees
    // exactly one `file_blobs` row per sha256, so this UPDATE +
    // SELECT is race-free under SQLite's per-statement atomicity.
    db.prepare(
      `UPDATE file_blobs SET ref_count = ref_count - 1 WHERE sha256 = ?`,
    ).run(row.sha256);
    const blob = db
      .prepare(
        `SELECT path, ref_count, cold_promoted_at
           FROM file_blobs WHERE sha256 = ?`,
      )
      .get(row.sha256) as
      | { path: string; ref_count: number; cold_promoted_at: number | null }
      | undefined;
    if (blob && blob.ref_count <= 0) {
      // Last reference dropped — reap the on-disk bytes + the
      // canonical row. The ULID dir (live) or `<ULID>.zst` file
      // (cold) is unlinked best-effort; the SQL state is the source
      // of truth.
      try {
        if (isColdPath(blob.path)) {
          const abs = resolveColdBlobPath(blob.path);
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } else {
          const abs = resolveBlobPath(blob.path);
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
          // The ULID parent dir was the upload-namespace wrapper;
          // remove it too if it's empty. Best-effort: a concurrent
          // mkdir would race here harmlessly.
          const parentDir = path.dirname(abs);
          try {
            fs.rmdirSync(parentDir);
          } catch {
            /* dir not empty / not ours / etc — fine. */
          }
        }
      } catch (err) {
        console.warn(
          `[files] could not unlink ${blob.path}: ${(err as Error).message}`,
        );
      }
      db.prepare(`DELETE FROM file_blobs WHERE sha256 = ?`).run(row.sha256);
    }
    appendAudit({
      action_type: "files_soft_delete",
      actor: "principal",
      source: "ctrl-api",
      target_path: row.path,
      target_kind: "file",
      subject_ref: row.id,
      summary: `soft-deleted file ${row.original_filename ?? row.path}`,
      payload: { id: row.id, sha256: row.sha256, size_bytes: row.size_bytes },
    });
    sendJson(res, 200, { id: row.id, path: row.path, deleted_at: now });
  });

  // GET /api/v1/files/describe/* — rich metadata getter (issue #114 Lane D₁).
  //
  // Unlike `stat`, `describe` ALWAYS returns the row even if soft-deleted,
  // and includes a `summary` slot for the (not-yet-shipped) extraction
  // pipeline. The principal-facing fields are projected to a compact shape
  // that mirrors the Lane D₁ MCP tool contract:
  //
  //   { id, name, path, size_bytes, mime, principal_label, summary,
  //     created_at, updated_at, alfred_read_at, deleted_at }
  //
  // Where:
  //   * `name`           ← original_filename
  //   * `mime`           ← content_type
  //   * `created_at`     ← uploaded_at (ms)
  //   * `updated_at`     ← max(uploaded_at, last_accessed_at) (ms)
  //   * `alfred_read_at` ← last_accessed_at (ms or null)
  //   * `summary`        ← null today; populated when the extraction
  //                        pipeline lands (#114 PR §13 PR5).
  //
  // Soft-deleted rows return 200 with `deleted_at` populated so the
  // principal can ask Alfred "did I delete that file last week?" and get
  // a sensible answer instead of a 404.
  addRoute("GET", "/api/v1/files/describe/*", async ({ res, params }) => {
    const relPath = params.path ?? "";
    if (!relPath) throw new ValidationError("path is required");
    const raw = getStateDb()
      .prepare(`SELECT * FROM files WHERE path = ? LIMIT 1`)
      .get(relPath) as Record<string, unknown> | undefined;
    if (!raw) throw new NotFoundError(`file not found: ${relPath}`);
    const row = rowFromDb(raw);
    const updatedAt =
      row.last_accessed_at != null && row.last_accessed_at > row.uploaded_at
        ? row.last_accessed_at
        : row.uploaded_at;
    sendJson(res, 200, {
      id: row.id,
      name: row.original_filename,
      path: row.path,
      size_bytes: row.size_bytes,
      mime: row.content_type,
      principal_label: row.principal_label,
      summary: null,
      created_at: row.uploaded_at,
      updated_at: updatedAt,
      alfred_read_at: row.last_accessed_at,
      deleted_at: row.deleted_at,
    });
  });

  // POST /api/v1/files/:file_id/move — rename or move a file (issue #114 Lane D₁).
  //
  // Body: { path: "<new-relative-path>" } where `<new-relative-path>` is
  // either:
  //   * a bare basename ("better-name.pdf") — keeps the existing ULID dir
  //     and re-points the on-disk file under it, OR
  //   * a full "<ULID>/<safe-name>" pair — moves to a different ULID dir.
  //
  // Path sanitization mirrors upload: directory traversal is rejected
  // (resolveBlobPath catches `..`), the filename is sanitized via the
  // existing sanitizeFilename helper, and the on-disk file is renamed
  // atomically with fs.renameSync. The `files.path` column is updated
  // in lockstep.
  //
  // Dedupe interaction. If the row's sha256 has `ref_count > 1` (another
  // upload has dedupe-pointed at the same blob), we DON'T rename the
  // on-disk file — that would break the other references. Instead we
  // 409 with a clear hint that the principal should `delete` + re-upload
  // under the new name. The path in `files.path` stays canonical to the
  // shared blob.
  //
  // Cold-promoted blobs are also refused with 409 — the cold filename is
  // the ULID + .zst suffix and changing it would desync the file_blobs
  // pointer. Operator-only `cold-restore` first, then move.
  //
  // Returns the full row (post-rename) under the same shape `stat` uses.
  addRoute("POST", "/api/v1/files/:file_id/move", async ({ res, params, body }) => {
    const fileId = params.file_id ?? "";
    if (!fileId) throw new ValidationError("file_id is required");
    const db = getStateDb();
    const raw = db
      .prepare(`SELECT * FROM files WHERE id = ? AND deleted_at IS NULL LIMIT 1`)
      .get(fileId) as Record<string, unknown> | undefined;
    if (!raw) throw new NotFoundError(`file not found: ${fileId}`);
    const row = rowFromDb(raw);

    const patch =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const requestedRaw = patch.path;
    if (typeof requestedRaw !== "string" || !requestedRaw.trim()) {
      throw new ValidationError("body.path is required (non-empty string)");
    }
    const requested = requestedRaw.trim().replace(/^\/+/, "");
    if (requested.includes("..")) {
      throw new ValidationError("path may not contain `..`");
    }

    // Cold + shared-blob refuse paths.
    if (isColdPath(row.path)) {
      throw new ApiError(
        409,
        "COLD_BLOB",
        "cannot move a cold-archived file; restore it first with POST /cold-restore/:file_id",
      );
    }
    const blobRow = db
      .prepare(`SELECT ref_count, path FROM file_blobs WHERE sha256 = ?`)
      .get(row.sha256) as { ref_count: number; path: string } | undefined;
    if (blobRow && blobRow.ref_count > 1) {
      throw new ApiError(
        409,
        "SHARED_BLOB",
        `cannot move a file whose bytes are shared via dedupe (ref_count=${blobRow.ref_count}); delete + re-upload under the new name instead`,
      );
    }

    // Resolve the requested path. Two shapes:
    //   - basename only: keep the existing ULID dir, change the filename
    //   - "<ULID>/<name>": full path (allows moving across ULID dirs)
    const slashIdx = requested.indexOf("/");
    let newRelPath: string;
    let newOriginalFilename = row.original_filename;
    if (slashIdx < 0) {
      // basename-only: preserve the row's current ULID dir.
      const currentUlid = row.path.split("/")[0];
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(currentUlid)) {
        throw new ApiError(
          500,
          "INVALID_CURRENT_PATH",
          `existing path does not start with a ULID: ${row.path}`,
        );
      }
      const safeName = sanitizeFilename(requested);
      newRelPath = path.posix.join(currentUlid, safeName);
      newOriginalFilename = requested;
    } else {
      const [reqUlid, ...rest] = requested.split("/");
      const tail = rest.join("/");
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(reqUlid)) {
        throw new ValidationError(
          `path's first segment must be a 26-char ULID (got ${reqUlid})`,
        );
      }
      const safeName = sanitizeFilename(tail || "file");
      newRelPath = path.posix.join(reqUlid, safeName);
      newOriginalFilename = tail || row.original_filename;
    }

    if (newRelPath === row.path) {
      // No-op. Return the existing row unchanged.
      sendJson(res, 200, rowToJson(row));
      return;
    }

    // Collision check: another live row must not already own the target path.
    const collision = db
      .prepare(
        `SELECT id FROM files WHERE path = ? AND deleted_at IS NULL AND id != ? LIMIT 1`,
      )
      .get(newRelPath, row.id) as { id: string } | undefined;
    if (collision) {
      throw new ApiError(
        409,
        "PATH_TAKEN",
        `another file already lives at ${newRelPath}`,
      );
    }

    // Rename the bytes on disk. Create the destination ULID dir if it
    // doesn't exist (only possible on the cross-ULID move shape).
    const oldAbs = resolveBlobPath(row.path);
    const newAbs = resolveBlobPath(newRelPath);
    if (!fs.existsSync(oldAbs)) {
      throw new ApiError(
        410,
        "BLOB_MISSING",
        `the row exists but the blob at ${row.path} is gone`,
      );
    }
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    fs.renameSync(oldAbs, newAbs);

    // Reap the source ULID dir if it's now empty (basename-only moves
    // keep the same dir, so this is mostly a cross-ULID move concern).
    const oldDir = path.dirname(oldAbs);
    if (oldDir !== path.dirname(newAbs)) {
      try {
        fs.rmdirSync(oldDir);
      } catch {
        /* dir not empty / not ours — fine. */
      }
    }

    // Update the canonical blob path + the per-file row in a single tx.
    db.exec("BEGIN");
    try {
      db.prepare(`UPDATE file_blobs SET path = ? WHERE sha256 = ?`).run(
        newRelPath,
        row.sha256,
      );
      db.prepare(
        `UPDATE files SET path = ?, original_filename = ? WHERE id = ?`,
      ).run(newRelPath, newOriginalFilename, row.id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      // Best-effort: swap the file back so the DB and disk agree.
      try {
        fs.renameSync(newAbs, oldAbs);
      } catch {
        /* if this fails the operator must reconcile by hand */
      }
      throw err;
    }

    appendAudit({
      action_type: "files_move",
      actor: "principal",
      source: "ctrl-api",
      target_path: newRelPath,
      target_kind: "file",
      subject_ref: row.id,
      summary: `moved file ${row.path} → ${newRelPath}`,
      changes: { path: { from: row.path, to: newRelPath } },
      payload: {
        id: row.id,
        sha256: row.sha256,
        original_filename_from: row.original_filename,
        original_filename_to: newOriginalFilename,
      },
    });

    const after = db
      .prepare(`SELECT * FROM files WHERE id = ? LIMIT 1`)
      .get(row.id) as Record<string, unknown>;
    sendJson(res, 200, rowToJson(rowFromDb(after)));
  });

  // POST /api/v1/files/:file_id/purge — hard delete (issue #114 Lane D₁).
  //
  // The principal-facing "permanently empty the recycle bin" surface.
  // Refuses to purge a row that is NOT already soft-deleted — the
  // soft-delete step is a deliberate two-stage gate (one click to send
  // to recycle bin, a second to flush) and the MCP tool mirrors that
  // shape.
  //
  // Behaviour:
  //   * 409 PURGE_REQUIRES_SOFT_DELETE if the row's `deleted_at IS NULL`.
  //   * 404 if the id doesn't exist at all.
  //   * 200 + `{id, path, purged_at}` on success.
  //
  // On success the `files` row is DELETED outright (the principal said
  // "really, get rid of it"). The audit row stays — the audit ledger
  // outlives the file. If the file's sha256 was the last reference and
  // its bytes are still on-disk (we soft-delete with ref_count
  // bookkeeping, so this is the common case), the bytes are unlinked
  // and the `file_blobs` row deleted too. If the bytes are shared
  // (ref_count > 1 — possible when a duplicate upload pointed at the
  // same canonical blob), the on-disk bytes stay and only the
  // per-file row vanishes.
  addRoute("POST", "/api/v1/files/:file_id/purge", async ({ res, params }) => {
    const fileId = params.file_id ?? "";
    if (!fileId) throw new ValidationError("file_id is required");
    const db = getStateDb();
    const raw = db
      .prepare(`SELECT * FROM files WHERE id = ? LIMIT 1`)
      .get(fileId) as Record<string, unknown> | undefined;
    if (!raw) throw new NotFoundError(`file not found: ${fileId}`);
    const row = rowFromDb(raw);
    if (row.deleted_at == null) {
      throw new ApiError(
        409,
        "PURGE_REQUIRES_SOFT_DELETE",
        "the file must be soft-deleted (DELETE /api/v1/files/<path>) before it can be purged",
      );
    }

    // Drop the principal-facing row.
    db.prepare(`DELETE FROM files WHERE id = ?`).run(row.id);

    // Reap the on-disk bytes IFF this row was holding the last reference.
    // The soft-delete path already decremented ref_count; the canonical
    // row may have been removed entirely (ref_count == 0 → DELETE FROM
    // file_blobs in the soft-delete handler). If it's still around with
    // ref_count > 0 the bytes are shared and we leave them alone.
    const blob = db
      .prepare(
        `SELECT path, ref_count, cold_promoted_at FROM file_blobs WHERE sha256 = ?`,
      )
      .get(row.sha256) as
      | { path: string; ref_count: number; cold_promoted_at: number | null }
      | undefined;
    if (blob && blob.ref_count <= 0) {
      try {
        if (isColdPath(blob.path)) {
          const abs = resolveColdBlobPath(blob.path);
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } else {
          const abs = resolveBlobPath(blob.path);
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
          const parentDir = path.dirname(abs);
          try {
            fs.rmdirSync(parentDir);
          } catch {
            /* dir not empty / not ours — fine. */
          }
        }
      } catch (err) {
        console.warn(
          `[files] purge: could not unlink ${blob.path}: ${(err as Error).message}`,
        );
      }
      db.prepare(`DELETE FROM file_blobs WHERE sha256 = ?`).run(row.sha256);
    }

    const purgedAt = Date.now();
    appendAudit({
      action_type: "files_purge",
      actor: "principal",
      source: "ctrl-api",
      target_path: row.path,
      target_kind: "file",
      subject_ref: row.id,
      summary: `hard-deleted file ${row.original_filename ?? row.path}`,
      payload: {
        id: row.id,
        sha256: row.sha256,
        size_bytes: row.size_bytes,
        soft_deleted_at: row.deleted_at,
      },
    });
    sendJson(res, 200, { id: row.id, path: row.path, purged_at: purgedAt });
  });

  // GET /api/v1/files/cold-candidates?older_than_ms=…
  //
  // Operator-facing list of files eligible for cold promotion (issue
  // #114 PR 5). A row is a candidate when:
  //
  //   * `deleted_at IS NULL`              (not tombstoned)
  //   * `cold_promoted_at IS NULL`        (not already promoted)
  //   * `COALESCE(last_accessed_at, uploaded_at) < now - older_than_ms`
  //
  // The `older_than_ms` query arg defaults to COLD_AFTER_MS (90d). The
  // daily FilesColdArchiveWorkflow consumes this surface, then loops
  // POST /cold-promote/:file_id for each row.
  //
  // We deliberately project the per-file row (not the canonical
  // `file_blobs` row) — multiple `files.id` rows can share a sha256
  // via dedupe, and the workflow needs the per-row id to address the
  // promote endpoint. The activity de-dupes on the workflow side.
  addRoute("GET", "/api/v1/files/cold-candidates", async ({ res, query }) => {
    const olderRaw = Number(
      query.get("older_than_ms") ?? String(COLD_AFTER_MS),
    );
    const olderThanMs =
      Number.isFinite(olderRaw) && olderRaw >= 0 ? olderRaw : COLD_AFTER_MS;
    const limitRaw = Number(query.get("limit") ?? "500");
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(5000, Math.floor(limitRaw))
        : 500;
    const cutoff = Date.now() - olderThanMs;
    const rows = getStateDb()
      .prepare(
        `SELECT * FROM files
          WHERE deleted_at IS NULL
            AND cold_promoted_at IS NULL
            AND COALESCE(last_accessed_at, uploaded_at) < ?
          ORDER BY COALESCE(last_accessed_at, uploaded_at) ASC
          LIMIT ?`,
      )
      .all(cutoff, limit) as Record<string, unknown>[];
    sendJson(res, 200, {
      cutoff_ms: cutoff,
      older_than_ms: olderThanMs,
      items: rows.map((r) => rowToJson(rowFromDb(r))),
      total: rows.length,
    });
  });

  // POST /api/v1/files/cold-promote/:file_id
  //
  // Move ONE file from the live volume to the cold volume. Steps:
  //
  //   1. Look up the row + canonical `file_blobs` row by file_id.
  //   2. Refuse if the blob is already cold, or if the row is
  //      tombstoned, or if the live file is missing on disk.
  //   3. Stream the live bytes through `zlib.createZstdCompress` at
  //      level 19 into a temp file under FILES_COLD_ROOT. (We use a
  //      temp + rename so a crash mid-promote never leaves a
  //      half-written cold blob.)
  //   4. Atomically swap: update `file_blobs.path` to `cold:<ULID>`
  //      + `cold_promoted_at`, then update every live `files` row
  //      that shares the sha256 to the cold path + `cold_promoted_at`
  //      stamp, then unlink the live bytes.
  //
  // If step 4's DB write fails the temp file is cleaned up. If the
  // unlink fails after the DB update the next sweep will skip the
  // row (`cold_promoted_at IS NOT NULL`) and the orphan can be reaped
  // by ops. Better that than rolling back the DB and re-promoting on
  // every sweep tick.
  addRoute("POST", "/api/v1/files/cold-promote/:file_id", async ({ res, params }) => {
    const fileId = params.file_id ?? "";
    if (!fileId) throw new ValidationError("file_id is required");
    const db = getStateDb();
    const raw = db
      .prepare(`SELECT * FROM files WHERE id = ? LIMIT 1`)
      .get(fileId) as Record<string, unknown> | undefined;
    if (!raw) throw new NotFoundError(`file not found: ${fileId}`);
    const row = rowFromDb(raw);
    if (row.deleted_at != null) {
      throw new ApiError(
        409,
        "TOMBSTONED",
        `cannot promote a tombstoned file: ${fileId}`,
      );
    }
    const blob = db
      .prepare(`SELECT * FROM file_blobs WHERE sha256 = ?`)
      .get(row.sha256) as
      | {
          sha256: string;
          path: string;
          size_bytes: number;
          ref_count: number;
          created_at: number;
          cold_promoted_at: number | null;
        }
      | undefined;
    if (!blob) {
      throw new ApiError(
        410,
        "BLOB_INDEX_MISSING",
        `file_blobs row missing for sha256 ${row.sha256}`,
      );
    }
    if (blob.cold_promoted_at != null || isColdPath(blob.path)) {
      // Already cold — idempotent no-op. Update the per-file row's
      // cold_promoted_at + path in case it's drifted (the canonical
      // blob is the source of truth).
      db.prepare(
        `UPDATE files SET path = ?, cold_promoted_at = ? WHERE sha256 = ? AND deleted_at IS NULL`,
      ).run(blob.path, blob.cold_promoted_at ?? Date.now(), row.sha256);
      sendJson(res, 200, {
        id: row.id,
        sha256: row.sha256,
        path: blob.path,
        cold_promoted_at: blob.cold_promoted_at,
        already_cold: true,
      });
      return;
    }
    const liveAbs = resolveBlobPath(blob.path);
    if (!fs.existsSync(liveAbs)) {
      throw new ApiError(
        410,
        "BLOB_MISSING",
        `the blob at ${blob.path} is gone (cannot promote)`,
      );
    }
    // Derive the cold-volume ULID from the live path's first segment.
    // The live path layout is `<ULID>/<safe-name>`; reuse the same
    // ULID as the cold filename so the relationship is auditable.
    const liveUlid = blob.path.split("/")[0];
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(liveUlid)) {
      throw new ApiError(
        500,
        "INVALID_LIVE_PATH",
        `live path does not start with a ULID: ${blob.path}`,
      );
    }
    const coldRelPath = `${COLD_PATH_PREFIX}${liveUlid}`;
    const coldFinalAbs = path.join(FILES_COLD_ROOT, `${liveUlid}.zst`);
    const coldTempAbs = `${coldFinalAbs}.in-progress`;

    // Stream zstd-compress live → temp file. createZstdCompress is
    // a Transform stream, so `pipeline(read, compress, write)` keeps
    // the data flowing chunk-by-chunk; nothing ever lives fully in
    // memory.
    const readStream = fs.createReadStream(liveAbs);
    const compressor = (zlib as unknown as {
      createZstdCompress: (opts?: unknown) => NodeJS.ReadWriteStream;
      constants: Record<string, number>;
    }).createZstdCompress({
      params: {
        // Level 19 is the strong-ratio knob; cold writes are
        // one-shot so CPU spend is fine.
        [(zlib as unknown as { constants: Record<string, number> }).constants
          .ZSTD_c_compressionLevel ?? 0]: 19,
      },
    });
    const writeStream = fs.createWriteStream(coldTempAbs);
    try {
      await pipeline(readStream, compressor, writeStream);
    } catch (err) {
      try {
        if (fs.existsSync(coldTempAbs)) fs.unlinkSync(coldTempAbs);
      } catch {
        /* best-effort */
      }
      throw new ApiError(
        500,
        "COMPRESS_FAILED",
        `zstd compression failed: ${(err as Error).message}`,
      );
    }
    fs.renameSync(coldTempAbs, coldFinalAbs);

    const promotedAt = Date.now();
    const compressedSize = fs.statSync(coldFinalAbs).size;
    // Atomic DB swap.
    db.exec("BEGIN");
    try {
      db.prepare(
        `UPDATE file_blobs
            SET path = ?, cold_promoted_at = ?
          WHERE sha256 = ?`,
      ).run(coldRelPath, promotedAt, row.sha256);
      db.prepare(
        `UPDATE files
            SET path = ?, cold_promoted_at = ?
          WHERE sha256 = ? AND deleted_at IS NULL`,
      ).run(coldRelPath, promotedAt, row.sha256);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      try {
        if (fs.existsSync(coldFinalAbs)) fs.unlinkSync(coldFinalAbs);
      } catch {
        /* best-effort */
      }
      throw err;
    }
    // Unlink the live bytes + the now-empty ULID dir. Best-effort
    // after the DB has been flipped — if these fail the cold side is
    // already authoritative.
    try {
      fs.unlinkSync(liveAbs);
      const parentDir = path.dirname(liveAbs);
      try {
        fs.rmdirSync(parentDir);
      } catch {
        /* dir not empty / not ours / etc — fine. */
      }
    } catch (err) {
      console.warn(
        `[files] cold-promote: could not unlink live ${liveAbs}: ${(err as Error).message}`,
      );
    }
    sendJson(res, 200, {
      id: row.id,
      sha256: row.sha256,
      path: coldRelPath,
      cold_promoted_at: promotedAt,
      live_bytes: blob.size_bytes,
      cold_bytes: compressedSize,
      compression_ratio: blob.size_bytes
        ? Number((blob.size_bytes / compressedSize).toFixed(3))
        : null,
    });
  });

  // POST /api/v1/files/cold-restore/:file_id
  //
  // Manually pull a file BACK to the live volume — the inverse of
  // cold-promote. Steps mirror the promotion path: decompress the
  // cold blob into a live temp file, then atomically flip the SQL
  // path back to the live ULID layout and unlink the cold copy.
  //
  // This is operator-only; the read path (GET /blob/*) intentionally
  // does NOT auto-restore on access so cold-promoted files stay cold
  // until the operator explicitly opts in.
  addRoute("POST", "/api/v1/files/cold-restore/:file_id", async ({ res, params }) => {
    const fileId = params.file_id ?? "";
    if (!fileId) throw new ValidationError("file_id is required");
    const db = getStateDb();
    const raw = db
      .prepare(`SELECT * FROM files WHERE id = ? LIMIT 1`)
      .get(fileId) as Record<string, unknown> | undefined;
    if (!raw) throw new NotFoundError(`file not found: ${fileId}`);
    const row = rowFromDb(raw);
    if (row.deleted_at != null) {
      throw new ApiError(
        409,
        "TOMBSTONED",
        `cannot restore a tombstoned file: ${fileId}`,
      );
    }
    const blob = db
      .prepare(`SELECT * FROM file_blobs WHERE sha256 = ?`)
      .get(row.sha256) as
      | { sha256: string; path: string; size_bytes: number; cold_promoted_at: number | null }
      | undefined;
    if (!blob) {
      throw new ApiError(
        410,
        "BLOB_INDEX_MISSING",
        `file_blobs row missing for sha256 ${row.sha256}`,
      );
    }
    if (!isColdPath(blob.path)) {
      // Already live — idempotent no-op.
      sendJson(res, 200, {
        id: row.id,
        sha256: row.sha256,
        path: blob.path,
        cold_promoted_at: null,
        already_live: true,
      });
      return;
    }
    const coldAbs = resolveColdBlobPath(blob.path);
    if (!fs.existsSync(coldAbs)) {
      throw new ApiError(
        410,
        "BLOB_MISSING",
        `the cold blob at ${blob.path} is gone (cannot restore)`,
      );
    }
    const coldUlid = blob.path.slice(COLD_PATH_PREFIX.length);
    // Reconstruct the live path by reusing the file's original name
    // from the principal-facing row. If `original_filename` is null
    // (a rare debug case), fall back to "file" — sanitize either way.
    const safeName = sanitizeFilename(row.original_filename ?? "file");
    const liveRelPath = path.posix.join(coldUlid, safeName);
    const liveUlidDir = resolveBlobPath(coldUlid);
    fs.mkdirSync(liveUlidDir, { recursive: true });
    const liveFinalAbs = path.join(liveUlidDir, safeName);
    const liveTempAbs = `${liveFinalAbs}.in-progress`;

    const readStream = fs.createReadStream(coldAbs);
    const decompressor = (zlib as unknown as {
      createZstdDecompress: (opts?: unknown) => NodeJS.ReadWriteStream;
    }).createZstdDecompress();
    const writeStream = fs.createWriteStream(liveTempAbs);
    try {
      await pipeline(readStream, decompressor, writeStream);
    } catch (err) {
      try {
        if (fs.existsSync(liveTempAbs)) fs.unlinkSync(liveTempAbs);
      } catch {
        /* best-effort */
      }
      throw new ApiError(
        500,
        "DECOMPRESS_FAILED",
        `zstd decompression failed: ${(err as Error).message}`,
      );
    }
    fs.renameSync(liveTempAbs, liveFinalAbs);

    db.exec("BEGIN");
    try {
      db.prepare(
        `UPDATE file_blobs
            SET path = ?, cold_promoted_at = NULL
          WHERE sha256 = ?`,
      ).run(liveRelPath, row.sha256);
      db.prepare(
        `UPDATE files
            SET path = ?, cold_promoted_at = NULL
          WHERE sha256 = ? AND deleted_at IS NULL`,
      ).run(liveRelPath, row.sha256);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      try {
        if (fs.existsSync(liveFinalAbs)) fs.unlinkSync(liveFinalAbs);
      } catch {
        /* best-effort */
      }
      throw err;
    }
    try {
      fs.unlinkSync(coldAbs);
    } catch (err) {
      console.warn(
        `[files] cold-restore: could not unlink cold ${coldAbs}: ${(err as Error).message}`,
      );
    }
    sendJson(res, 200, {
      id: row.id,
      sha256: row.sha256,
      path: liveRelPath,
      cold_promoted_at: null,
      restored_bytes: blob.size_bytes,
    });
  });
}

// ── private: blob stream (split out for the tests + future PR 2 reuse) ─────

function streamBlobTo(res: ServerResponse, abs: string): void {
  const rs = fs.createReadStream(abs);
  rs.on("error", (err) => {
    // We've already sent headers; the most we can do is end the
    // response. The principal will see a short read, which is fine
    // for the 410-equivalent path.
    console.error(`[files] blob read error: ${(err as Error).message}`);
    try {
      res.end();
    } catch {
      /* noop */
    }
  });
  rs.pipe(res);
}

/** Stream the contents of a cold-archived `<ULID>.zst` blob to the
 *  response, decompressing on the fly. The read + decompress + write
 *  pipeline keeps everything chunked — the inflated bytes never sit
 *  in a Node buffer at full size, so 100 MB cold reads stay within
 *  the same memory budget as a 100 KB one. Issue #114 PR 5. */
function streamColdBlobTo(res: ServerResponse, abs: string): void {
  const rs = fs.createReadStream(abs);
  const decompressor = (zlib as unknown as {
    createZstdDecompress: (opts?: unknown) => NodeJS.ReadWriteStream;
  }).createZstdDecompress();
  rs.on("error", (err) => {
    console.error(`[files] cold blob read error: ${(err as Error).message}`);
    try {
      res.end();
    } catch {
      /* noop */
    }
  });
  decompressor.on("error", (err) => {
    console.error(
      `[files] cold blob decompress error: ${(err as Error).message}`,
    );
    try {
      res.end();
    } catch {
      /* noop */
    }
  });
  rs.pipe(decompressor).pipe(res);
}
