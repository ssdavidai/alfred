// Audit-table retention (#380).
//
// The audit table grows monotonically — nothing ever pruned it. Live on
// home (2026-08-01): 341,699 rows, of which 129,876 came from ONE resolved
// incident (the 2026-06/07 recover_stuck_dispatching runaway, capped by
// #282, all rows `source='decision_router.recovery'`). The ts-ordered read
// path stays fast, but any aggregate view (GROUP BY action_type) paid a
// 1.45s full scan on a 608 MB db.
//
// Policy:
//   * Incident purge — `decision_router.recovery` rows are recovery-loop
//     bookkeeping from a resolved incident; they carry no principal-facing
//     history. Deleted outright when older than the standing window.
//   * Standing retention — audit rows older than AUDIT_RETENTION_DAYS
//     (default 180) are deleted at boot. The four-store contract (§5)
//     assigns the >90d forensic tail to the cold archive (Phase 3);
//     180d here is deliberately conservative so this sweep never
//     pre-empts that design.
//
// Runs once per boot, right after getStateDb() — the same
// single-writer-owns-maintenance posture as the ingest TTL sweep.

import { getStateDb } from "./state.js";

const DEFAULT_RETENTION_DAYS = 180;

export interface AuditRetentionResult {
  incident_rows_deleted: number;
  aged_rows_deleted: number;
  retention_days: number;
}

export function sweepAuditRetention(
  now: Date = new Date(),
): AuditRetentionResult {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  let days = parseInt(raw ?? "", 10);
  if (!Number.isFinite(days) || days < 30) days = DEFAULT_RETENTION_DAYS;

  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const db = getStateDb();

  // Incident bookkeeping: prune on the SAME window as everything else —
  // recent recovery rows stay visible for operators, the 130k-row
  // historical bloat (all >2 weeks old at time of writing, and far past
  // any operational use) goes as soon as it ages past the window. To
  // reclaim it immediately on an existing tenant, set
  // AUDIT_RETENTION_DAYS=30 for one boot.
  const incident = db
    .prepare(
      "DELETE FROM audit WHERE source = 'decision_router.recovery' AND ts < ?",
    )
    .run(cutoff);

  const aged = db.prepare("DELETE FROM audit WHERE ts < ?").run(cutoff);

  const result: AuditRetentionResult = {
    incident_rows_deleted: Number(incident.changes ?? 0),
    aged_rows_deleted: Number(aged.changes ?? 0),
    retention_days: days,
  };
  if (result.incident_rows_deleted || result.aged_rows_deleted) {
    console.log(
      `[audit-retention] deleted incident=${result.incident_rows_deleted} ` +
        `aged=${result.aged_rows_deleted} (window ${days}d)`,
    );
  }
  return result;
}
