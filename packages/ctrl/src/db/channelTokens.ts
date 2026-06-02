// channel_tokens DB helpers — the shared per-channel bearer-token surface.
//
// Split out from routes/channel_tokens.ts so the helpers can be unit-tested
// in isolation (same posture as alfredJournal.ts). The route module imports
// these helpers; the auth path imports `validateChannelToken` to swap a raw
// bearer for the row.
//
// Schema lives in migrations/0003_channel_tokens.sql. These functions are
// the documented contract for everything else — the route, the auth path,
// the future Paperclip migration when its keys re-home onto this table.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ulid } from "./ulid.js";

export interface ChannelTokenRow {
  id: string;
  channel: string;
  token_hash: string;
  label: string | null;
  scope_json: string | null;
  created_at: number;
  last_used_at: number | null;
  last_used_ip: string | null;
  rotated_from: string | null;
  revoked_at: number | null;
}

/** Public-safe view of a token row — never includes `token_hash`. The raw
 *  token plaintext is shown ONCE at mint and not stored anywhere. */
export interface ChannelTokenMeta {
  id: string;
  channel: string;
  label: string | null;
  scope: Record<string, unknown> | null;
  created_at: number;
  last_used_at: number | null;
  last_used_ip: string | null;
  rotated_from: string | null;
  revoked_at: number | null;
}

function rowToMeta(r: ChannelTokenRow): ChannelTokenMeta {
  let scope: Record<string, unknown> | null = null;
  if (r.scope_json) {
    try {
      const parsed = JSON.parse(r.scope_json);
      scope = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      scope = null;
    }
  }
  return {
    id: r.id,
    channel: r.channel,
    label: r.label,
    scope,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    last_used_ip: r.last_used_ip,
    rotated_from: r.rotated_from,
    revoked_at: r.revoked_at,
  };
}

/** sha256(raw) → lowercase hex. The only one-way function between a raw
 *  token and the row that authorises it. */
export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Token shapes per channel. Each channel picks its own prefix so a leaked
 *  token is recognisable at-a-glance in logs (`ha_…` is HA, `pcp_…` is
 *  Paperclip, etc.). 24 random bytes → 48 hex chars → 192 bits of entropy. */
function generateRawToken(channel: string): string {
  const prefix = channel === "ha-conversation" || channel === "ha-voice"
    ? "ha_"
    : channel === "paperclip-heartbeat"
      ? "pcp_"
      : "ct_"; // generic fall-back for unknown channels
  const random = crypto.randomBytes(24).toString("hex");
  return `${prefix}${random}`;
}

export interface MintResult {
  /** The raw token — shown to the caller ONCE and never retrievable again. */
  raw: string;
  /** The persisted row, sans token_hash, in public-safe shape. */
  meta: ChannelTokenMeta;
}

/** Mint a new token for `channel`. Optional `label` and `scope` are
 *  channel-specific metadata that ride along on the row. The raw token is
 *  returned to the caller exactly once; from this point on only the
 *  sha256 hash exists in the DB. */
export function mintChannelToken(
  db: DatabaseSync,
  fields: {
    channel: string;
    label?: string | null;
    scope?: Record<string, unknown> | null;
    rotated_from?: string | null;
  },
): MintResult {
  const id = ulid();
  const raw = generateRawToken(fields.channel);
  const token_hash = hashToken(raw);
  const created_at = Date.now();
  const scope_json = fields.scope ? JSON.stringify(fields.scope) : null;
  const label = fields.label ?? null;
  const rotated_from = fields.rotated_from ?? null;

  db.prepare(
    `INSERT INTO channel_tokens
       (id, channel, token_hash, label, scope_json,
        created_at, last_used_at, last_used_ip,
        rotated_from, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
  ).run(id, fields.channel, token_hash, label, scope_json, created_at, rotated_from);

  const row = db
    .prepare("SELECT * FROM channel_tokens WHERE id = ?")
    .get(id) as ChannelTokenRow;
  return { raw, meta: rowToMeta(row) };
}

/** List active (non-revoked) tokens for a channel, newest first. Public-safe
 *  view — never includes token_hash. */
export function listChannelTokens(
  db: DatabaseSync,
  channel: string,
  opts: { includeRevoked?: boolean } = {},
): ChannelTokenMeta[] {
  const sql = opts.includeRevoked
    ? `SELECT * FROM channel_tokens
         WHERE channel = ?
         ORDER BY created_at DESC, id DESC`
    : `SELECT * FROM channel_tokens
         WHERE channel = ? AND revoked_at IS NULL
         ORDER BY created_at DESC, id DESC`;
  const rows = db.prepare(sql).all(channel) as ChannelTokenRow[];
  return rows.map(rowToMeta);
}

/** Get one token row by id. Returns the public-safe view. */
export function getChannelTokenMeta(
  db: DatabaseSync,
  id: string,
): ChannelTokenMeta | null {
  const row = db
    .prepare("SELECT * FROM channel_tokens WHERE id = ?")
    .get(id) as ChannelTokenRow | undefined;
  return row ? rowToMeta(row) : null;
}

/** Revoke a token by id. Idempotent: revoking a revoked token is a no-op
 *  but reports back the row. Returns null if no such id. */
export function revokeChannelToken(
  db: DatabaseSync,
  id: string,
): ChannelTokenMeta | null {
  const existing = db
    .prepare("SELECT * FROM channel_tokens WHERE id = ?")
    .get(id) as ChannelTokenRow | undefined;
  if (!existing) return null;
  if (existing.revoked_at === null) {
    db.prepare(
      "UPDATE channel_tokens SET revoked_at = ? WHERE id = ?",
    ).run(Date.now(), id);
  }
  const row = db
    .prepare("SELECT * FROM channel_tokens WHERE id = ?")
    .get(id) as ChannelTokenRow;
  return rowToMeta(row);
}

/** Authentication path: swap a raw bearer for the row that authorises it
 *  on the given channel. On match, side-effect: bump `last_used_at` and
 *  `last_used_ip`. Returns null on no match / revoked. */
export function validateChannelToken(
  db: DatabaseSync,
  channel: string,
  rawToken: string,
  opts: { ip?: string | null } = {},
): ChannelTokenMeta | null {
  if (!rawToken) return null;
  const token_hash = hashToken(rawToken);
  const row = db
    .prepare(
      `SELECT * FROM channel_tokens
         WHERE channel = ? AND token_hash = ? AND revoked_at IS NULL
         LIMIT 1`,
    )
    .get(channel, token_hash) as ChannelTokenRow | undefined;
  if (!row) return null;

  db.prepare(
    "UPDATE channel_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?",
  ).run(Date.now(), opts.ip ?? null, row.id);

  const fresh = db
    .prepare("SELECT * FROM channel_tokens WHERE id = ?")
    .get(row.id) as ChannelTokenRow;
  return rowToMeta(fresh);
}

/** Rotate a token: mint a new one in the same channel that points at the
 *  old via `rotated_from`. Does NOT revoke the old token automatically —
 *  the caller decides when to revoke (typically after the new token is
 *  installed on the consuming side). Returns { raw, meta } for the new
 *  token. */
export function rotateChannelToken(
  db: DatabaseSync,
  oldId: string,
): MintResult | null {
  const old = db
    .prepare("SELECT * FROM channel_tokens WHERE id = ?")
    .get(oldId) as ChannelTokenRow | undefined;
  if (!old) return null;
  let scope: Record<string, unknown> | null = null;
  if (old.scope_json) {
    try {
      const parsed = JSON.parse(old.scope_json);
      scope = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      scope = null;
    }
  }
  return mintChannelToken(db, {
    channel: old.channel,
    label: old.label,
    scope,
    rotated_from: oldId,
  });
}
