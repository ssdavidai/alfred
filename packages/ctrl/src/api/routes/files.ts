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
//   * GET    /api/v1/files/list       paginated list with metadata
//   * GET    /api/v1/files/usage      total bytes + caps
//   * GET    /api/v1/files/stat/*     metadata for one blob (path is the tail)
//   * GET    /api/v1/files/blob/*     streamed bytes with Content-Type + Disposition
//   * DELETE /api/v1/files/*          soft-delete (set deleted_at + remove blob)
//
// What it is NOT (yet)
// --------------------
//   * MCP `files__*` tools           — PR 2 of issue #114
//   * /files dashboard page          — PR 3
//   * Content extraction pipeline    — PR 4
//   * Voice-bridge allowlist entries — PR 6 (deferred to keep PR 1 small)
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
import type { IncomingMessage, ServerResponse } from "node:http";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError, ApiError } from "../errors.js";
import { getStateDb } from "../../db/state.js";

// ── Configuration ──────────────────────────────────────────────────────────

/** Root of the blob volume inside the ctrl-api container. The
 *  docker-compose mount lands `files_data` here `:rw`. Override via
 *  FILES_ROOT for tests. */
const FILES_ROOT = process.env.FILES_ROOT ?? "/files";

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
  };
}

function liveUsage(): { used_bytes: number; count: number } {
  const row = getStateDb()
    .prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS used, COUNT(*) AS count
       FROM files WHERE deleted_at IS NULL`,
    )
    .get() as { used: number; count: number };
  return { used_bytes: Number(row.used), count: Number(row.count) };
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
    const before = liveUsage();
    if (before.used_bytes >= QUOTA_HARD_BYTES) {
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

    // Post-write quota check: if the upload's tail pushes us past the
    // hard cap, refuse + clean up. (We allow temporarily exceeding the
    // soft cap; the principal sees that in `/usage`.)
    if (before.used_bytes + parsed.size > QUOTA_HARD_BYTES) {
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
    const finalPath = path.join(ulidDir, safeName);
    fs.renameSync(scratchPath, finalPath);

    const relPath = path.posix.join(id, safeName);
    const contentType =
      parsed.contentType ||
      parsed.text.content_type ||
      sniffContentType(safeName);
    const principalLabel = parsed.text.principal_label || null;
    const uploadedBy = parsed.text.uploaded_by || "principal";
    const now = Date.now();

    // The principal-facing `original_filename` is `declared` — the
    // explicit text-field override beats the multipart part's own
    // filename header, mirroring the precedence we used for the
    // on-disk safe-name above. Otherwise an uploader who passes both
    // would see the row carry the part header (which they treat as
    // a transport detail) instead of the value they intended.
    const originalFilename = declared;

    getStateDb()
      .prepare(
        `INSERT INTO files
          (id, path, size_bytes, sha256, content_type, original_filename,
           principal_label, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    });
  });

  // GET /api/v1/files/list?prefix=&limit=&offset=
  //
  // Paginated, deleted_at-aware list. `prefix` is matched on the path
  // column with `LIKE prefix||'%'` — clients can list under a ULID dir
  // or filter by safe-name prefix, but PR 1 doesn't yet expose a
  // virtual `parent_dir` (that's PR 3).
  addRoute("GET", "/api/v1/files/list", async ({ res, query }) => {
    const prefix = (query.get("prefix") ?? "").trim();
    const limitRaw = Number(query.get("limit") ?? "100");
    const offsetRaw = Number(query.get("offset") ?? "0");
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(1000, Math.floor(limitRaw))
        : 100;
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

    const db = getStateDb();
    let rows: Record<string, unknown>[];
    let total: number;
    if (prefix) {
      const like = `${prefix}%`;
      rows = db
        .prepare(
          `SELECT * FROM files
            WHERE deleted_at IS NULL AND path LIKE ?
            ORDER BY uploaded_at DESC
            LIMIT ? OFFSET ?`,
        )
        .all(like, limit, offset) as Record<string, unknown>[];
      total = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM files
                WHERE deleted_at IS NULL AND path LIKE ?`,
            )
            .get(like) as { c: number }
        ).c,
      );
    } else {
      rows = db
        .prepare(
          `SELECT * FROM files
            WHERE deleted_at IS NULL
            ORDER BY uploaded_at DESC
            LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as Record<string, unknown>[];
      total = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM files WHERE deleted_at IS NULL`,
            )
            .get() as { c: number }
        ).c,
      );
    }
    sendJson(res, 200, {
      items: rows.map((r) => rowToJson(rowFromDb(r))),
      total,
      limit,
      offset,
    });
  });

  // GET /api/v1/files/usage
  //
  // Always-on observability. Reports the live total + count + both
  // caps so the dashboard can decide when to show a warning band.
  addRoute("GET", "/api/v1/files/usage", async ({ res }) => {
    const u = liveUsage();
    sendJson(res, 200, {
      used_bytes: u.used_bytes,
      count: u.count,
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
  // by recency in PR 3.
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
    const abs = resolveBlobPath(row.path);
    if (!fs.existsSync(abs)) {
      // Row points at a missing blob — a real "this should never
      // happen", but if it does the principal deserves a clear 410.
      throw new ApiError(
        410,
        "BLOB_MISSING",
        `the row exists but the blob at ${row.path} is gone`,
      );
    }
    const stat = fs.statSync(abs);
    const headers: Record<string, string | number> = {
      "Content-Type": row.content_type || "application/octet-stream",
      "Content-Length": stat.size,
    };
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
    streamBlobTo(res, abs);
  });

  // DELETE /api/v1/files/* — soft delete.
  //
  // Sets the tombstone column and unlinks the on-disk blob (the row
  // and the ULID dir stay for the audit trail). PR 2 will tighten the
  // ACL to "only the principal actor"; PR 1 accepts any authenticated
  // caller.
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
    const abs = resolveBlobPath(row.path);
    const now = Date.now();
    db.prepare(`UPDATE files SET deleted_at = ? WHERE id = ?`).run(now, row.id);
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (err) {
      console.warn(
        `[files] could not unlink ${abs}: ${(err as Error).message}`,
      );
    }
    sendJson(res, 200, { id: row.id, path: row.path, deleted_at: now });
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
