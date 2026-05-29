// Auto-snapshot before destructive verbs — Tier 4 contract (#115/#158 PR1).
//
// Sir locked YES on 2026-05-29 to "auto-snapshot before
// core_restart + core_update + addon_install + integration_add". This
// helper is the load-bearing implementation — every PR6/PR7 destructive
// verb calls `triggerBackupBeforeAction(action, decision_ref)` before
// firing the upstream HA mutation. The returned backup id is included in
// the route's response so the caller can show the user "I snapshotted
// before doing X — backup id <id>" in the audit trail.
//
// Mechanics
// ---------
// 1. Calls HA WS `backup/generate` via the long-lived ha_ws_client with a
//    deterministic name `alfred-pre-{action}-{ts}` so the principal can
//    later find it in HA's backup list.
// 2. Records `(ulid, ha_backup_id, action, decision_ref, ts)` in the
//    state.db `ha_backup_ref` table (migration 0011).
// 3. Returns `{id, ha_backup_id, name}` so the caller can mention it in
//    the response payload.
//
// Errors
// ------
// If `backup/generate` fails, we propagate the error — the destructive
// verb MUST NOT run on an unbackupped HA. A real-tenant scenario where
// the backup fails is rare but real (no disk space, supervisor down on
// Container HA, etc.); the caller hears 502 and surfaces it as a Desk
// card "I tried to update HA core, but the backup failed".
//
// Test mode
// ---------
// `HA_SNAPSHOT_DRY_RUN=1` short-circuits the WS call and stubs the
// returned ha_backup_id as `dry-run-<ulid>` so unit tests can exercise
// the route flow without a fake HA server.

import { getStateDb } from "../../db/state.js";
import { ulid } from "../../db/ulid.js";
import { getHaWsClient } from "./ha_ws_client.js";

const BACKUP_TIMEOUT_MS = 60_000; // backups can be slow; HA's own backup
                                  // generation routinely runs 30-90s on
                                  // even a small Hue/Z-Wave install.

export interface HaBackupRecord {
  id: string;             // our ulid
  ha_backup_id: string;   // HA's id (or 'dry-run-<ulid>' in test mode)
  name: string;           // alfred-pre-<action>-<ts>
  triggered_by: string;
  decision_ref: string | null;
  ts: string;             // ISO8601
}

function backupName(action: string): string {
  // 'YYYYMMDDTHHMMSS' — drop `-`, `:`, `.`, keep T as the date/time separator.
  const ts = new Date()
    .toISOString()
    .replace(/[-:.]/g, "")
    .slice(0, 15);
  const safeAction = action.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `alfred-pre-${safeAction}-${ts}`;
}

function persistBackupRef(args: {
  ha_backup_id: string;
  triggered_by: string;
  decision_ref: string | null;
}): HaBackupRecord {
  const id = ulid();
  const ts = new Date().toISOString();
  getStateDb()
    .prepare(
      `INSERT INTO ha_backup_ref (id, ha_backup_id, triggered_by, decision_ref, ts)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, args.ha_backup_id, args.triggered_by, args.decision_ref, ts);
  return {
    id,
    ha_backup_id: args.ha_backup_id,
    name: "", // back-filled by caller
    triggered_by: args.triggered_by,
    decision_ref: args.decision_ref,
    ts,
  };
}

/**
 * Triggers an HA snapshot, records it in `ha_backup_ref`, returns the
 * id pair so the caller can include the backup name + id in their
 * response payload.
 *
 * @param action       — the verb that triggered the snapshot, e.g.
 *                       'ha__core_restart'. Recorded in `triggered_by`
 *                       so we can audit "every snapshot Alfred made
 *                       before doing X".
 * @param decision_ref — the Desk decision id the destructive verb is
 *                       running under; NULL only for non-decision
 *                       triggers like explicit user requests.
 */
export async function triggerBackupBeforeAction(
  action: string,
  decision_ref: string | null,
): Promise<HaBackupRecord> {
  const name = backupName(action);
  if (process.env.HA_SNAPSHOT_DRY_RUN === "1") {
    const haBackupId = `dry-run-${ulid()}`;
    const rec = persistBackupRef({
      ha_backup_id: haBackupId,
      triggered_by: action,
      decision_ref,
    });
    rec.name = name;
    return rec;
  }
  const client = getHaWsClient();
  let result: unknown;
  try {
    result = await client.wsCall("backup/generate", { name }, BACKUP_TIMEOUT_MS);
  } catch (err) {
    throw new Error(
      `auto-snapshot before ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // HA's `backup/generate` returns `{slug: '<id>', ...}` on success.
  // We accept either `slug` or `backup_id` — releases have varied the
  // field name; both are recorded as the ha_backup_id.
  const r = (result ?? {}) as Record<string, unknown>;
  const haBackupId =
    (typeof r.slug === "string" && r.slug) ||
    (typeof r.backup_id === "string" && r.backup_id) ||
    (typeof r.id === "string" && r.id) ||
    "";
  if (!haBackupId) {
    throw new Error(
      `auto-snapshot before ${action} returned no backup id (got ${JSON.stringify(result)})`,
    );
  }
  const rec = persistBackupRef({
    ha_backup_id: haBackupId,
    triggered_by: action,
    decision_ref,
  });
  rec.name = name;
  return rec;
}

/**
 * List all snapshots Alfred has made — used by the Desk / audit ledger.
 * `limit` defaults to 50; `since` filters by `ts >= since`.
 */
export function listBackupRefs(opts: {
  limit?: number;
  since?: string;
} = {}): HaBackupRecord[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  if (opts.since) {
    return getStateDb()
      .prepare(
        `SELECT id, ha_backup_id, triggered_by, decision_ref, ts
         FROM ha_backup_ref WHERE ts >= ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(opts.since, limit) as HaBackupRecord[];
  }
  return getStateDb()
    .prepare(
      `SELECT id, ha_backup_id, triggered_by, decision_ref, ts
       FROM ha_backup_ref ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as HaBackupRecord[];
}
