// #416 — schedule-time dedup for announce:true agent-task spawns.
//
// Extracted from routes/agents.ts so tests can import the pure helpers
// without pulling the route module's import-time side effects (it mkdirs
// /alfred-data/streams at load, which EACCES's in the CI sandbox).
//
// spawn_alfred_task -> POST /api/v1/agents/main/task creates a fresh Hermes
// cron per call with zero idempotency (its own doc: "NOT idempotent —
// calling twice schedules two runs"). On 2026-08-04 the main agent fired
// three announce:true spawns to the same Slack channel in 15 minutes for
// one request -> three duplicate messages (parent #415).
import crypto from "node:crypto";

export const ANNOUNCE_DEDUP_WINDOW_MS = (() => {
  const raw = parseInt(process.env.ANNOUNCE_DEDUP_WINDOW_SECONDS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 600_000; // 10 min
})();

const _announceDedup = new Map<string, { at: number; job: string }>();

export function _resetAnnounceDedupForTests(): void {
  _announceDedup.clear();
}

/** Strip volatile bits so a retried research reply collapses onto its first
 *  attempt: timestamps, uuids, ULIDs, long digit runs. */
export function normalizeTask(task: string): string {
  return task
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "") // ISO timestamps
    .replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/g, "") // uuids
    .replace(/\b[0-9a-hjkmnp-tv-z]{26}\b/g, "") // ULIDs
    .replace(/\d{5,}/g, "") // long digit runs
    .replace(/\s+/g, " ")
    .trim();
}

export function announceDedupKey(
  channel: string,
  to: string | undefined,
  task: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`${channel} ${to ?? ""} ${normalizeTask(task)}`)
    .digest("hex")
    .slice(0, 24);
}

/** Returns the existing job name if a matching announce was scheduled within
 *  the window, else null (and records this one). Prunes expired entries. */
export function checkAnnounceDedup(key: string, job: string): string | null {
  const now = Date.now();
  for (const [k, v] of _announceDedup) {
    if (now - v.at > ANNOUNCE_DEDUP_WINDOW_MS) _announceDedup.delete(k);
  }
  const hit = _announceDedup.get(key);
  if (hit && now - hit.at <= ANNOUNCE_DEDUP_WINDOW_MS) return hit.job;
  _announceDedup.set(key, { at: now, job });
  return null;
}
