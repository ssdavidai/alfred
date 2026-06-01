// channelIdentity — per-(profile, channel_kind) display_name + avatar lib.
//
// Backed by the `channel_identity` table added in
// 0018_channel_identity.sql. Pure DB+fs lib — no HTTP. The HTTP surface
// (routes/channel_identity.ts) is the only place that translates these
// helper errors into ApiError statuses; Lane IV consumes
// resolveChannelIdentity() from here directly.
//
// Side-effect contract:
//   * upsert + delete are the only writers
//   * resolveChannelIdentity() is side-effect-free — safe inside a hot send loop
//   * delete unlinks the avatar file from disk if a path was stored
//
// Reserved / archived guards:
//   * A profile with is_reserved=1 (the four seeded infra rows main / workers
//     / heavy / codex-builder) is for infrastructure — channel identities for
//     the principal-facing channels live on user-facing profiles only.
//     PUT/DELETE on a reserved profile returns 409 from the route layer.
//   * A profile with archived_at IS NOT NULL is soft-deleted; new identity
//     writes against it are nonsensical and also 409.
//
// File layout for avatars:
//   <HERMES_PROFILE_BASE_DIR>/<slug>/avatars/<channel_kind>.<ext>
// where ext is derived from the upload mime (image/png → png, etc).

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  HERMES_PROFILE_BASE_DIR,
  getProfile,
  KNOWN_CHANNEL_KINDS,
} from "./agentProfiles.js";

export type ResolvedChannelIdentity = {
  display_name: string | null;
  avatar_path: string | null;
  avatar_mime: string | null;
};

export interface ChannelIdentityRow {
  channel_kind: string;
  display_name: string | null;
  avatar_path: string | null;
  avatar_mime: string | null;
  updated_at: string;
}

export interface UpsertChannelIdentityInput {
  display_name?: string | null;
  avatar_path?: string | null;
  avatar_mime?: string | null;
}

/** Allowed avatar mime types — matches the route's multipart validator. */
export const ALLOWED_AVATAR_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** Map an avatar mime to a filesystem extension. */
export function avatarExtForMime(mime: string): string | null {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

/** Path the route writes / deletes for an avatar. */
export function avatarPathFor(slug: string, channel_kind: string, ext: string): string {
  return path.join(
    HERMES_PROFILE_BASE_DIR(),
    slug,
    "avatars",
    `${channel_kind}.${ext}`,
  );
}

/** Throw if the channel kind is not in the KNOWN_CHANNEL_KINDS allowlist. */
export function assertKnownChannelKind(kind: string): void {
  if (!KNOWN_CHANNEL_KINDS.has(kind)) {
    throw new Error(
      `channel_kind '${kind}' is not a known channel (allowed: ${[...KNOWN_CHANNEL_KINDS].sort().join(", ")})`,
    );
  }
}

/**
 * Guard: profile must exist, must NOT be reserved, must NOT be archived.
 * 404 on missing, 409 on reserved/archived (the route layer maps these by
 * Error message prefix). Returns the profile row on success.
 */
export function assertWritableIdentityProfile(
  db: DatabaseSync,
  slug: string,
): void {
  const p = getProfile(db, slug);
  if (!p) {
    throw new Error(`profile '${slug}' not found`);
  }
  if (p.is_reserved) {
    throw new Error(`profile '${slug}' is reserved`);
  }
  if (p.archived_at != null) {
    throw new Error(`profile '${slug}' is archived`);
  }
}

interface Row {
  channel_kind: string;
  display_name: string | null;
  avatar_path: string | null;
  avatar_mime: string | null;
  updated_at: string;
}

function _row2obj(r: Row): ChannelIdentityRow {
  return {
    channel_kind: r.channel_kind,
    display_name: r.display_name,
    avatar_path: r.avatar_path,
    avatar_mime: r.avatar_mime,
    updated_at: r.updated_at,
  };
}

/**
 * Side-effect-free lookup — the only entry-point Lane IV consumes. Returns
 * `null` iff no row exists for that (slug, kind). Does NOT read the
 * filesystem; `avatar_path` is whatever the DB row stored.
 */
export function resolveChannelIdentity(
  db: DatabaseSync,
  profile_slug: string,
  channel_kind: string,
): ResolvedChannelIdentity | null {
  const row = db
    .prepare(
      `SELECT display_name, avatar_path, avatar_mime
       FROM channel_identity
       WHERE profile_slug = ? AND channel_kind = ?`,
    )
    .get(profile_slug, channel_kind) as
    | {
        display_name: string | null;
        avatar_path: string | null;
        avatar_mime: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    display_name: row.display_name,
    avatar_path: row.avatar_path,
    avatar_mime: row.avatar_mime,
  };
}

/** List every identity row for one profile, sorted by channel_kind. */
export function listChannelIdentities(
  db: DatabaseSync,
  profile_slug: string,
): ChannelIdentityRow[] {
  const rows = db
    .prepare(
      `SELECT channel_kind, display_name, avatar_path, avatar_mime, updated_at
       FROM channel_identity
       WHERE profile_slug = ?
       ORDER BY channel_kind ASC`,
    )
    .all(profile_slug) as Row[];
  return rows.map(_row2obj);
}

/** Get one identity row; null if none. */
export function getChannelIdentity(
  db: DatabaseSync,
  profile_slug: string,
  channel_kind: string,
): ChannelIdentityRow | null {
  const row = db
    .prepare(
      `SELECT channel_kind, display_name, avatar_path, avatar_mime, updated_at
       FROM channel_identity
       WHERE profile_slug = ? AND channel_kind = ?`,
    )
    .get(profile_slug, channel_kind) as Row | undefined;
  return row ? _row2obj(row) : null;
}

/**
 * Upsert one (profile, channel_kind) row. Merges with existing fields:
 * passing `undefined` for a field leaves it untouched; passing `null`
 * clears it. The caller (route) MUST have validated the profile is
 * writable + the kind is known + at least one field is non-empty.
 */
export function upsertChannelIdentity(
  db: DatabaseSync,
  profile_slug: string,
  channel_kind: string,
  input: UpsertChannelIdentityInput,
): ChannelIdentityRow {
  const existing = getChannelIdentity(db, profile_slug, channel_kind);
  const next_display_name =
    input.display_name === undefined
      ? (existing?.display_name ?? null)
      : input.display_name;
  const next_avatar_path =
    input.avatar_path === undefined
      ? (existing?.avatar_path ?? null)
      : input.avatar_path;
  const next_avatar_mime =
    input.avatar_mime === undefined
      ? (existing?.avatar_mime ?? null)
      : input.avatar_mime;
  // Atomic upsert — the PK enforces one row per (profile_slug, channel_kind).
  db.prepare(
    `INSERT INTO channel_identity
       (profile_slug, channel_kind, display_name, avatar_path, avatar_mime, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(profile_slug, channel_kind) DO UPDATE
       SET display_name = excluded.display_name,
           avatar_path  = excluded.avatar_path,
           avatar_mime  = excluded.avatar_mime,
           updated_at   = datetime('now')`,
  ).run(
    profile_slug,
    channel_kind,
    next_display_name,
    next_avatar_path,
    next_avatar_mime,
  );
  const row = getChannelIdentity(db, profile_slug, channel_kind);
  if (!row) {
    throw new Error(
      `channel_identity '${profile_slug}/${channel_kind}' not found after upsert`,
    );
  }
  return row;
}

/**
 * Delete the (profile, channel_kind) row + unlink any avatar file the row
 * referenced. Returns true if a row was removed, false if there was nothing
 * to delete. File unlink is best-effort — a missing file does not error.
 */
export function deleteChannelIdentity(
  db: DatabaseSync,
  profile_slug: string,
  channel_kind: string,
): boolean {
  const existing = getChannelIdentity(db, profile_slug, channel_kind);
  if (!existing) return false;
  db.prepare(
    `DELETE FROM channel_identity
     WHERE profile_slug = ? AND channel_kind = ?`,
  ).run(profile_slug, channel_kind);
  if (existing.avatar_path) {
    try {
      fs.unlinkSync(existing.avatar_path);
    } catch {
      /* best-effort — file might already be gone */
    }
  }
  return true;
}
