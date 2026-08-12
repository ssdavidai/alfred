// hermesCronJournal.ts — GH #418 read-side reconciler for Hermes cron outbounds.
// Tails Hermes state.db (mode=ro) for cron sessions with --deliver and mirrors
// their final stop-message into alfred_journal. Idempotent on hermes_session_id.
// 48h window, 50-session cap. Degrades on schema changes (log + skip, no throw).
import { DatabaseSync } from "node:sqlite";
import type { DatabaseSync as DbType } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { appendJournal } from "./alfredJournal.js";

const HERMES_CONFIG_DIR = process.env.HERMES_CONFIG_DIR ?? "/hermes-state/profiles";
const WINDOW_HOURS = 48, BATCH_CAP = 50;

export interface ReconcileResult {
  journaled: number; skipped: number; window_hours: number; batch_cap: number;
}
interface Job { id: string; name: string; deliver: string; origin?: { platform?: string; chat_id?: string } }
function parseCronJobId(sid: string): string | null {
  if (!sid.startsWith("cron_")) return null;
  const p = sid.split("_");
  return p.length >= 4 ? p[1] : null;
}
function resolveTarget(job: Job): { channel: string; chatId: string } | null {
  if (!job.deliver) return null;
  if (job.deliver === "origin") {
    const p = job.origin?.platform, c = job.origin?.chat_id;
    return (p && c) ? { channel: p, chatId: c } : null;
  }
  const sep = job.deliver.indexOf(":");
  if (sep > 0) { const ch = job.deliver.slice(0, sep), id = job.deliver.slice(sep + 1); if (ch && id) return { channel: ch, chatId: id }; }
  return null;
}
function readDeliveringJobs(configDir: string, profile: string): Map<string, Job> {
  const result = new Map<string, Job>();
  let raw: string;
  try { raw = fs.readFileSync(path.join(configDir, profile, "cron", "jobs.json"), "utf-8"); }
  catch { return result; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return result; }
  const arr = (parsed && typeof parsed === "object" && Array.isArray((parsed as any).jobs))
    ? (parsed as any).jobs as unknown[] : [];
  for (const j of arr) {
    if (!j || typeof j !== "object") continue;
    const o = j as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    const name = typeof o.name === "string" ? o.name : "";
    const deliver = typeof o.deliver === "string" ? o.deliver.trim() : "";
    if (!id || !deliver) continue;
    const origin = o.origin && typeof o.origin === "object"
      ? (o.origin as { platform?: string; chat_id?: string }) : undefined;
    result.set(id, { id, name, deliver, origin });
  }
  return result;
}
export function reconcileCronOutbounds(
  alfredDb: DbType, configDir = HERMES_CONFIG_DIR, profile = "main",
): ReconcileResult {
  const result: ReconcileResult =
    { journaled: 0, skipped: 0, window_hours: WINDOW_HOURS, batch_cap: BATCH_CAP };
  const jobs = readDeliveringJobs(configDir, profile);
  if (jobs.size === 0) return result;
  const dbPath = path.join(configDir, profile, "state.db");
  if (!fs.existsSync(dbPath)) return result;
  let hermesSdb: DbType;
  try { hermesSdb = new DatabaseSync(`file:${dbPath}?mode=ro`); }
  catch (e) { console.warn("[cron-journal] open hermes state.db:", e); return result; }
  const cutoff = Date.now() / 1000 - WINDOW_HOURS * 3600;
  let sessions: Array<{ id: string }>;
  try {
    sessions = hermesSdb.prepare(
      `SELECT id FROM sessions WHERE source='cron' AND ended_at IS NOT NULL
       AND started_at>=? ORDER BY started_at DESC LIMIT ?`,
    ).all(cutoff, BATCH_CAP) as Array<{ id: string }>;
  } catch (e) {
    console.warn("[cron-journal] sessions query:", e);
    hermesSdb.close(); return result;
  }
  for (const { id: sid } of sessions) {
    const jobId = parseCronJobId(sid);
    if (!jobId) continue;
    const job = jobs.get(jobId);
    if (!job) continue;
    const target = resolveTarget(job);
    if (!target) continue;
    const dup = alfredDb.prepare(
      `SELECT id FROM alfred_journal WHERE source_kind='cron' AND hermes_session_id=? LIMIT 1`,
    ).get(sid) as { id?: string } | undefined;
    if (dup?.id) { result.skipped++; continue; }
    let msg: { content: string } | undefined;
    try {
      msg = hermesSdb.prepare(
        `SELECT content FROM messages WHERE session_id=? AND role='assistant'
         AND finish_reason='stop' AND content IS NOT NULL ORDER BY timestamp DESC LIMIT 1`,
      ).get(sid) as { content: string } | undefined;
    } catch (e) {
      console.warn("[cron-journal] messages query for", sid, ":", e); continue;
    }
    if (!msg?.content?.trim()) continue;
    appendJournal(alfredDb, {
      channel: target.channel, chat_id: target.chatId,
      direction: "outbound", message: msg.content,
      source_kind: "cron", source_ref: job.name,
      hermes_session_id: sid, hermes_profile: profile,
      status: "delivered", metadata: { cron_job_id: jobId, cron_job_name: job.name },
    });
    result.journaled++;
  }
  hermesSdb.close();
  return result;
}
