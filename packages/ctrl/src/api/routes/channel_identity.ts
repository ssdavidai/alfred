// channel_identity — per-(profile, channel_kind) display_name + avatar HTTP.
//
// Companion to routes/profiles.ts. Route map:
//   GET    /api/v1/agent-profiles/:slug/channel-identities
//   GET    /api/v1/agent-profiles/:slug/channel-identities/:kind
//   PUT    /api/v1/agent-profiles/:slug/channel-identities/:kind
//   DELETE /api/v1/agent-profiles/:slug/channel-identities/:kind
//
// PUT is multipart/form-data only. The text field `display_name` is
// optional; the binary field `avatar` is optional (image/png|jpeg|webp,
// ≤2 MB). At least one of the two must be present.
//
// JSON GET endpoints stay JSON. Errors:
//   404 — unknown slug or (GET-one) no identity row
//   409 — slug is reserved or archived
//   400 — unknown channel_kind, no fields supplied, avatar too large, wrong mime
//   422 — display_name > 64 chars OR contains newlines

import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { addRoute } from "../server.js";
import {
  sendJson,
  ValidationError,
  NotFoundError,
  ConflictError,
  ApiError,
} from "../errors.js";
import { getStateDb } from "../../db/state.js";
import {
  KNOWN_CHANNEL_KINDS,
  HERMES_PROFILE_BASE_DIR,
  getProfile,
} from "../../db/agentProfiles.js";
import {
  ALLOWED_AVATAR_MIMES,
  assertKnownChannelKind,
  assertWritableIdentityProfile,
  avatarExtForMime,
  avatarPathFor,
  deleteChannelIdentity,
  getChannelIdentity,
  listChannelIdentities,
  upsertChannelIdentity,
} from "../../db/channelIdentity.js";

const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const DISPLAY_NAME_MAX = 64;

/** Map helper-thrown Errors to the right ApiError subclass. */
function _classifyIdentity(err: unknown): never {
  if (err instanceof ApiError) throw err;
  if (!(err instanceof Error)) throw err as Error;
  const m = err.message;
  if (m.startsWith("profile '") && m.endsWith("not found")) {
    throw new NotFoundError(m);
  }
  if (m.includes("is reserved") || m.includes("is archived")) {
    throw new ConflictError(m);
  }
  if (m.includes("not a known channel")) {
    throw new ValidationError(m);
  }
  throw new ValidationError(m);
}

// ── multipart parser ───────────────────────────────────────────────────────
//
// Tuned for the small-payload case: an avatar ≤ 2 MB and one short text
// field. Drains the whole body into RAM (bounded by AVATAR_MAX_BYTES * 2
// for headroom), then peels parts off. Streamed-to-disk parsing lives in
// routes/files.ts for the multi-GB upload path; we don't need that here.

interface MultipartPart {
  name: string;
  filename: string | null;
  contentType: string | null;
  data: Buffer;
}

function parseBoundary(contentType: string): string | null {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  return m ? m[2] : null;
}

function parseContentDisposition(value: string): {
  name: string | null;
  filename: string | null;
} {
  let name: string | null = null;
  let filename: string | null = null;
  const nameMatch = /name=("?)([^";]+)\1/i.exec(value);
  if (nameMatch) name = nameMatch[2];
  const fnMatch = /filename=("?)([^"]*)\1/i.exec(value);
  if (fnMatch) filename = fnMatch[2];
  return { name, filename };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(
          new ApiError(
            400,
            "UPLOAD_TOO_LARGE",
            `multipart payload exceeds ${maxBytes} bytes`,
          ),
        );
        try {
          req.destroy();
        } catch {
          /* noop */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function splitParts(body: Buffer, boundary: string): MultipartPart[] {
  const delim = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from("\r\n\r\n");
  const parts: MultipartPart[] = [];

  // Find every delimiter position.
  const positions: number[] = [];
  let from = 0;
  while (true) {
    const idx = body.indexOf(delim, from);
    if (idx < 0) break;
    positions.push(idx);
    from = idx + delim.length;
  }
  // We need at least the opening + closing delimiter.
  if (positions.length < 2) return parts;
  for (let i = 0; i < positions.length - 1; i++) {
    // Each part begins right after a delimiter+CRLF and ends right before
    // the next \r\n--boundary.
    const startBoundary = positions[i];
    const partStart = startBoundary + delim.length;
    // Skip the CRLF after the boundary
    let afterCrlf = partStart;
    if (
      body.length >= afterCrlf + 2 &&
      body[afterCrlf] === 0x0d &&
      body[afterCrlf + 1] === 0x0a
    ) {
      afterCrlf += 2;
    } else if (
      body.length >= afterCrlf + 2 &&
      body[afterCrlf] === 0x2d &&
      body[afterCrlf + 1] === 0x2d
    ) {
      // closing delimiter at this position — done
      break;
    } else {
      // unexpected — skip
      continue;
    }
    // End of this part: right before the next \r\n--boundary.
    const nextBoundary = positions[i + 1];
    // Strip the \r\n that precedes the next boundary.
    let partEnd = nextBoundary;
    if (
      partEnd >= 2 &&
      body[partEnd - 2] === 0x0d &&
      body[partEnd - 1] === 0x0a
    ) {
      partEnd -= 2;
    }
    // Header / body split.
    const headerEnd = body.indexOf(headerSep, afterCrlf);
    if (headerEnd < 0 || headerEnd > partEnd) continue;
    const headerBlock = body.slice(afterCrlf, headerEnd).toString("utf-8");
    const data = body.slice(headerEnd + headerSep.length, partEnd);
    // Parse headers.
    let name: string | null = null;
    let filename: string | null = null;
    let contentType: string | null = null;
    for (const line of headerBlock.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const k = line.slice(0, colon).trim().toLowerCase();
      const v = line.slice(colon + 1).trim();
      if (k === "content-disposition") {
        const cd = parseContentDisposition(v);
        name = cd.name;
        filename = cd.filename;
      } else if (k === "content-type") {
        contentType = v;
      }
    }
    if (!name) continue;
    parts.push({ name, filename, contentType, data });
  }
  return parts;
}

// ── route registration ─────────────────────────────────────────────────────

export function registerChannelIdentityRoutes(): void {
  const db = getStateDb;

  // GET list — one row per kind for this profile.
  addRoute(
    "GET",
    "/api/v1/agent-profiles/:slug/channel-identities",
    async ({ res, params }) => {
      try {
        const slug = params.slug;
        const profile = getProfile(db(), slug);
        if (!profile) throw new NotFoundError(`profile '${slug}' not found`);
        const identities = listChannelIdentities(db(), slug);
        sendJson(res, 200, { identities });
      } catch (err) {
        _classifyIdentity(err);
      }
    },
  );

  // GET one — 404 if there's no row for this (slug, kind).
  addRoute(
    "GET",
    "/api/v1/agent-profiles/:slug/channel-identities/:kind",
    async ({ res, params }) => {
      try {
        const slug = params.slug;
        const kind = params.kind;
        const profile = getProfile(db(), slug);
        if (!profile) throw new NotFoundError(`profile '${slug}' not found`);
        assertKnownChannelKind(kind);
        const row = getChannelIdentity(db(), slug, kind);
        if (!row) {
          throw new NotFoundError(
            `channel_identity for profile '${slug}' kind '${kind}' not found`,
          );
        }
        sendJson(res, 200, row);
      } catch (err) {
        _classifyIdentity(err);
      }
    },
  );

  // PUT — multipart/form-data upsert. Accepts `display_name` (text, optional)
  // and `avatar` (file, optional). At least one must be present.
  addRoute(
    "PUT",
    "/api/v1/agent-profiles/:slug/channel-identities/:kind",
    async ({ req, res, params }) => {
      try {
        const slug = params.slug;
        const kind = params.kind;

        // Lookup + guards (404, 409, 400 — in that order).
        const profile = getProfile(db(), slug);
        if (!profile) throw new NotFoundError(`profile '${slug}' not found`);
        if (profile.is_reserved) {
          throw new ConflictError(`profile '${slug}' is reserved`);
        }
        if (profile.archived_at != null) {
          throw new ConflictError(`profile '${slug}' is archived`);
        }
        assertKnownChannelKind(kind);

        // Multipart parse.
        const ct = String(req.headers["content-type"] ?? "");
        if (!ct.toLowerCase().startsWith("multipart/form-data")) {
          throw new ValidationError(
            "Content-Type must be multipart/form-data",
          );
        }
        const boundary = parseBoundary(ct);
        if (!boundary) {
          throw new ValidationError("multipart/form-data boundary= missing");
        }
        // Generous outer cap so a too-large avatar still surfaces our 400.
        const raw = await readBody(req, AVATAR_MAX_BYTES + 32 * 1024);
        const parts = splitParts(raw, boundary);

        let display_name: string | null | undefined;
        let avatar_bytes: Buffer | null = null;
        let avatar_mime: string | null = null;
        for (const p of parts) {
          if (p.name === "display_name") {
            // Treat empty-string as "clear it" — but PUT semantics require
            // at least one non-empty field, so check below.
            display_name = p.data.toString("utf-8");
          } else if (p.name === "avatar") {
            // An empty file part (e.g. user submitted with no file selected)
            // is silently ignored — treat as not provided.
            if (p.data.length > 0) {
              avatar_bytes = p.data;
              avatar_mime = p.contentType;
            }
          }
        }

        // At least one of {display_name, avatar} must be present + non-empty.
        const has_display_name =
          display_name !== undefined && display_name.trim().length > 0;
        const has_avatar = avatar_bytes != null;
        if (!has_display_name && !has_avatar) {
          throw new ValidationError(
            "at least one of {display_name, avatar} is required",
          );
        }

        // Validate display_name shape.
        let final_display_name: string | undefined;
        if (has_display_name) {
          const trimmed = display_name!.trim();
          if (trimmed.includes("\n") || trimmed.includes("\r")) {
            throw new ApiError(
              422,
              "DISPLAY_NAME_INVALID",
              "display_name must not contain newlines",
            );
          }
          if (trimmed.length > DISPLAY_NAME_MAX) {
            throw new ApiError(
              422,
              "DISPLAY_NAME_TOO_LONG",
              `display_name exceeds ${DISPLAY_NAME_MAX} characters`,
            );
          }
          final_display_name = trimmed;
        }

        // Validate avatar shape.
        let final_avatar_path: string | undefined;
        let final_avatar_mime: string | undefined;
        if (has_avatar) {
          if (avatar_bytes!.length > AVATAR_MAX_BYTES) {
            throw new ValidationError(
              `avatar exceeds ${AVATAR_MAX_BYTES} bytes`,
            );
          }
          if (!avatar_mime || !ALLOWED_AVATAR_MIMES.has(avatar_mime)) {
            throw new ValidationError(
              `avatar mime '${avatar_mime ?? "<missing>"}' not allowed (image/png|image/jpeg|image/webp)`,
            );
          }
          const ext = avatarExtForMime(avatar_mime);
          if (!ext) {
            throw new ValidationError(`avatar mime '${avatar_mime}' not allowed`);
          }
          // Replace any prior avatar (regardless of ext) with the new one.
          const existing = getChannelIdentity(db(), slug, kind);
          if (existing?.avatar_path && existing.avatar_path !== avatarPathFor(slug, kind, ext)) {
            try {
              fs.unlinkSync(existing.avatar_path);
            } catch {
              /* best-effort */
            }
          }
          const dest = avatarPathFor(slug, kind, ext);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          // Write to tmp + rename for atomicity.
          const tmp = dest + ".tmp";
          fs.writeFileSync(tmp, avatar_bytes!, { mode: 0o644 });
          fs.renameSync(tmp, dest);
          final_avatar_path = dest;
          final_avatar_mime = avatar_mime;
        }

        assertWritableIdentityProfile(db(), slug);
        const row = upsertChannelIdentity(db(), slug, kind, {
          display_name: final_display_name,
          avatar_path: final_avatar_path,
          avatar_mime: final_avatar_mime,
        });
        sendJson(res, 200, row);
      } catch (err) {
        _classifyIdentity(err);
      }
    },
  );

  // DELETE — drop the row + unlink avatar file. 204 on success; 404 if no
  // row existed. Reserved/archived profile → 409 (so the UI sees the same
  // surface as PUT).
  addRoute(
    "DELETE",
    "/api/v1/agent-profiles/:slug/channel-identities/:kind",
    async ({ res, params }) => {
      try {
        const slug = params.slug;
        const kind = params.kind;
        const profile = getProfile(db(), slug);
        if (!profile) throw new NotFoundError(`profile '${slug}' not found`);
        if (profile.is_reserved) {
          throw new ConflictError(`profile '${slug}' is reserved`);
        }
        if (profile.archived_at != null) {
          throw new ConflictError(`profile '${slug}' is archived`);
        }
        assertKnownChannelKind(kind);
        const removed = deleteChannelIdentity(db(), slug, kind);
        if (!removed) {
          throw new NotFoundError(
            `channel_identity for profile '${slug}' kind '${kind}' not found`,
          );
        }
        // 204 No Content — same idiom file delete uses.
        res.statusCode = 204;
        res.end();
      } catch (err) {
        _classifyIdentity(err);
      }
    },
  );

  // Suppress unused-import warning when tests don't exercise HERMES_PROFILE_BASE_DIR
  // directly — the avatarPathFor helper consumes it transitively.
  void HERMES_PROFILE_BASE_DIR;
  void KNOWN_CHANNEL_KINDS;
}
