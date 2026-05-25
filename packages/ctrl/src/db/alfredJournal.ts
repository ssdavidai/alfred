// alfred_journal DB helpers — the one-Alfred continuity layer.
//
// Split out from routes/alfredJournal.ts so the helpers can be unit-tested in
// isolation: importing the routes module pulls in server.ts and (transitively)
// streams.ts, which mkdir's /alfred-data/streams at import time. That side
// effect is fine in the container but a hard blocker in tests.
//
// The DB shape itself lives in migrations/0002_alfred_journal.sql. These
// functions are the only callers and are the documented contract for
// everything else (the Hermes hook, the outbound webhook delivery path, the
// dashboard journal viewer).

import type { DatabaseSync } from "node:sqlite";
import { ulid } from "./ulid.js";

function nowIso(): string {
  return new Date().toISOString();
}

export type Direction = "outbound" | "inbound";
export type Status = "pending" | "delivered" | "failed" | "received";

export interface JournalEntry {
  id: string;
  ts: string;
  principal_id: string | null;
  channel: string;
  chat_id: string;
  direction: Direction;
  message: string;
  source_kind: string | null;
  source_ref: string | null;
  hermes_session_id: string | null;
  hermes_profile: string | null;
  status: Status;
  delivery_error: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface RawJournalRow {
  id: string;
  ts: string;
  principal_id: string | null;
  channel: string;
  chat_id: string;
  direction: string;
  message: string;
  source_kind: string | null;
  source_ref: string | null;
  hermes_session_id: string | null;
  hermes_profile: string | null;
  status: string;
  delivery_error: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEntry(r: RawJournalRow): JournalEntry {
  let metadata: Record<string, unknown> | null = null;
  if (r.metadata) {
    try {
      const parsed = JSON.parse(r.metadata);
      metadata = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      metadata = null;
    }
  }
  return {
    id: r.id,
    ts: r.ts,
    principal_id: r.principal_id,
    channel: r.channel,
    chat_id: r.chat_id,
    direction: r.direction as Direction,
    message: r.message,
    source_kind: r.source_kind,
    source_ref: r.source_ref,
    hermes_session_id: r.hermes_session_id,
    hermes_profile: r.hermes_profile,
    status: r.status as Status,
    delivery_error: r.delivery_error,
    metadata,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Look up the principal_id for a (channel, chat_id) pair. Returns null if no
 * binding exists yet — the hook can still proceed (per-channel context),
 * just without cross-channel reach.
 */
export function resolvePrincipal(
  db: DatabaseSync,
  channel: string,
  chatId: string,
): string | null {
  const row = db
    .prepare(
      "SELECT principal_id FROM alfred_principal_channel WHERE channel = ? AND chat_id = ?",
    )
    .get(channel, chatId) as { principal_id?: string } | undefined;
  return row?.principal_id ?? null;
}

/**
 * Bind (channel, chat_id) → principal_id. Idempotent (INSERT OR REPLACE
 * is explicit because SQLite's default for a composite PK collision is to
 * error, which would surprise callers).
 */
export function bindPrincipalChannel(
  db: DatabaseSync,
  channel: string,
  chatId: string,
  principalId: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO alfred_principal_channel
       (channel, chat_id, principal_id, added_at)
     VALUES (?, ?, ?, ?)`,
  ).run(channel, chatId, principalId, nowIso());
}

/**
 * Append one entry. The shape is wide because every caller wants different
 * subsets — by-keyword args + a clear default for status.
 *
 * Auto-resolves principal_id from the (channel, chat_id) binding if the
 * caller didn't pass one explicitly — so every outbound on home auto-binds
 * chat_id=432094090 → 'owner' on first write, and later inbound lookups
 * find it.
 */
export function appendJournal(
  db: DatabaseSync,
  fields: {
    channel: string;
    chat_id: string;
    direction: Direction;
    message: string;
    source_kind?: string | null;
    source_ref?: string | null;
    hermes_session_id?: string | null;
    hermes_profile?: string | null;
    status?: Status;
    delivery_error?: string | null;
    metadata?: Record<string, unknown> | null;
    principal_id?: string | null;
  },
): JournalEntry {
  const id = ulid();
  const ts = nowIso();
  const principalId =
    fields.principal_id ?? resolvePrincipal(db, fields.channel, fields.chat_id);
  const metadataJson = fields.metadata ? JSON.stringify(fields.metadata) : null;

  db.prepare(
    `INSERT INTO alfred_journal
       (id, ts, principal_id, channel, chat_id, direction, message,
        source_kind, source_ref, hermes_session_id, hermes_profile,
        status, delivery_error, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ts,
    principalId,
    fields.channel,
    fields.chat_id,
    fields.direction,
    fields.message,
    fields.source_kind ?? null,
    fields.source_ref ?? null,
    fields.hermes_session_id ?? null,
    fields.hermes_profile ?? null,
    fields.status ?? "delivered",
    fields.delivery_error ?? null,
    metadataJson,
    ts,
    ts,
  );

  const row = db
    .prepare("SELECT * FROM alfred_journal WHERE id = ?")
    .get(id) as RawJournalRow;
  return rowToEntry(row);
}

/**
 * Window policy for the pre_gateway_dispatch hook: most-recent first, capped
 * by both N and a recency hours threshold. Both bounds matter — without N a
 * chatty user can blow main's context window; without `within_hours` an
 * inactive user gets ancient context with no relevance.
 *
 * `principal_id` takes precedence over (channel, chat_id) when set, so a
 * Telegram inbound from a paired-elsewhere Slack-Sir gets cross-channel
 * memory. Phase 3.
 */
export function queryRecentJournal(
  db: DatabaseSync,
  scope:
    | { principal_id: string }
    | { channel: string; chat_id: string },
  opts: { limit?: number; within_hours?: number } = {},
): JournalEntry[] {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 20));
  const withinHours = Math.max(0.1, opts.within_hours ?? 24);
  const cutoff = new Date(Date.now() - withinHours * 3600 * 1000).toISOString();

  let rows: RawJournalRow[];
  if ("principal_id" in scope) {
    rows = db
      .prepare(
        `SELECT * FROM alfred_journal
           WHERE principal_id = ?
             AND ts >= ?
           ORDER BY ts DESC, rowid DESC
           LIMIT ?`,
      )
      .all(scope.principal_id, cutoff, limit) as RawJournalRow[];
  } else {
    rows = db
      .prepare(
        `SELECT * FROM alfred_journal
           WHERE channel = ? AND chat_id = ?
             AND ts >= ?
           ORDER BY ts DESC, rowid DESC
           LIMIT ?`,
      )
      .all(scope.channel, scope.chat_id, cutoff, limit) as RawJournalRow[];
  }
  return rows.map(rowToEntry);
}

/**
 * Mark a pending outbound entry as delivered (or failed). Used by the
 * Pattern-A outbound delivery path once the Hermes webhook callback returns
 * with the actual bytes Sir saw + whether delivery succeeded.
 */
export function markJournalDelivered(
  db: DatabaseSync,
  id: string,
  fields: {
    status: "delivered" | "failed";
    delivery_error?: string | null;
    message?: string; // the bytes Sir actually got, if different from pending
    hermes_session_id?: string | null;
  },
): JournalEntry | null {
  const updates: string[] = ["status = ?", "updated_at = ?"];
  const params: (string | null)[] = [fields.status, nowIso()];
  if (fields.delivery_error !== undefined) {
    updates.push("delivery_error = ?");
    params.push(fields.delivery_error);
  }
  if (fields.message !== undefined) {
    updates.push("message = ?");
    params.push(fields.message);
  }
  if (fields.hermes_session_id !== undefined) {
    updates.push("hermes_session_id = ?");
    params.push(fields.hermes_session_id);
  }
  params.push(id);
  db.prepare(
    `UPDATE alfred_journal SET ${updates.join(", ")} WHERE id = ?`,
  ).run(...params);

  const row = db
    .prepare("SELECT * FROM alfred_journal WHERE id = ?")
    .get(id) as RawJournalRow | undefined;
  return row ? rowToEntry(row) : null;
}
