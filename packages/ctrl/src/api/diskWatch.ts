import fs from "node:fs";
import path from "node:path";
import { statfs } from "node:fs/promises";
import { getStateDb } from "../db/state.js";
import { indexVaultWrite } from "../db/vaultIndex.js";
import { invalidateVaultCachesForType } from "./vaultCache.js";

export type DiskAlertLevel = "ok" | "warn" | "page" | "unknown";
export interface DiskInfo { disk_total_bytes: number | null; disk_free_bytes: number | null; disk_used_pct: number | null; disk_alert_level: DiskAlertLevel; disk_alert_warn_pct: number; disk_alert_page_pct: number }
type StatFs = { blocks: number | bigint; bfree: number | bigint; bsize: number | bigint };
type Deps = { sample?: () => Promise<DiskInfo>; recentWarn?: (since: string) => boolean; card?: (d: DiskInfo, now: Date) => string | Promise<string>; audit?: (d: DiskInfo, card: string, now: Date) => void | Promise<void>; pageActive?: () => boolean; auditPage?: (d: DiskInfo, active: boolean, now: Date) => void | Promise<void>; notify?: (d: DiskInfo) => Promise<void>; now?: () => Date };

function envPct(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

export function diskThresholds(): { warn: number; page: number } {
  return { warn: envPct("DISK_ALERT_WARN_PCT", 80), page: envPct("DISK_ALERT_PAGE_PCT", 90) };
}

export async function sampleDiskUsage(
  statfsFn: (p: string, options: { bigint: true }) => Promise<StatFs> = statfs as any,
): Promise<DiskInfo> {
  const dbPath = process.env.STATE_DB_PATH ?? path.join(process.cwd(), "data", "alfred-state.db");
  const s = await statfsFn(path.dirname(dbPath), { bigint: true });
  const blocks = Number(s.blocks), free = Number(s.bfree), size = Number(s.bsize);
  if (!(blocks > 0) || !(free >= 0) || !(size > 0)) throw new Error("invalid statfs result");
  const used = ((blocks - free) / blocks) * 100;
  const { warn, page } = diskThresholds();
  return { disk_total_bytes: blocks * size, disk_free_bytes: free * size, disk_used_pct: used, disk_alert_level: used >= page ? "page" : used >= warn ? "warn" : "ok", disk_alert_warn_pct: warn, disk_alert_page_pct: page };
}

export async function getDiskInfo(): Promise<DiskInfo> {
  try { return await sampleDiskUsage(); }
  catch { const { warn, page } = diskThresholds(); return { disk_total_bytes: null, disk_free_bytes: null, disk_used_pct: null, disk_alert_level: "unknown", disk_alert_warn_pct: warn, disk_alert_page_pct: page }; }
}

const VAULT = process.env.VAULT_PATH ?? "/vault";
async function mintCard(d: DiskInfo, now: Date): Promise<string> {
  const id = `disk-pressure-${now.toISOString().replace(/[:.]/g, "-")}`;
  const rel = `needs_attention/${id}.md`, dir = path.join(VAULT, "needs_attention");
  fs.mkdirSync(dir, { recursive: true });
  const pct = d.disk_used_pct!.toFixed(1);
  fs.writeFileSync(path.join(VAULT, rel), `---\ntype: needs_attention\nstatus: pending\ncreated: ${JSON.stringify(now.toISOString())}\naction_what: ${JSON.stringify(`Free disk space; usage is ${pct}%`)}\nsuggested_actor: principal\ntarget_kind: system\ndecision_reason: disk_pressure\ndisplay_headline: ${JSON.stringify(`Disk usage is ${pct}%`)}\nreasoning: ${JSON.stringify(`Disk usage crossed the ${d.disk_alert_warn_pct}% warning threshold. Remove unneeded data before services fail.`)}\n---\n\nDisk pressure was detected on the filesystem containing alfred-state.db.\n`, { flag: "wx" });
  indexVaultWrite(rel);
  invalidateVaultCachesForType("needs_attention");
  // Validate through the canonical attention reader. Once the principal acts
  // on this record, those routes also mint the normal decision mirror.
  const { readNeedsAttention } = await import("./routes/attention.js");
  const rec = readNeedsAttention(id);
  if (!rec) throw new Error(`failed to mint readable needs-attention card ${rel}`);
  return rec.path;
}

async function auditWarning(d: DiskInfo, card: string, now: Date): Promise<void> {
  const { appendAudit } = await import("./routes/state.js");
  appendAudit({ ts: now.toISOString(), action_type: "disk_pressure_warning", actor: "alfred", source: "disk_watch", target_path: card, target_kind: "needs_attention", summary: `Disk usage reached ${d.disk_used_pct!.toFixed(1)}%`, payload: d }, { strict: true });
}

function recentAudit(since: string): boolean {
  return Boolean(getStateDb().prepare("SELECT 1 FROM audit WHERE action_type = 'disk_pressure_warning' AND ts >= ? LIMIT 1").get(since));
}

function pageAlertActive(): boolean {
  const row = getStateDb().prepare(
    "SELECT action_type FROM audit WHERE action_type IN ('disk_pressure_page', 'disk_pressure_page_cleared') ORDER BY ts DESC, rowid DESC LIMIT 1",
  ).get() as { action_type: string } | undefined;
  return row?.action_type === "disk_pressure_page";
}

async function auditPageTransition(d: DiskInfo, active: boolean, now: Date): Promise<void> {
  const { appendAudit } = await import("./routes/state.js");
  appendAudit({
    ts: now.toISOString(),
    action_type: active ? "disk_pressure_page" : "disk_pressure_page_cleared",
    actor: "alfred",
    source: "disk_watch",
    target_kind: "system",
    summary: active
      ? `Critical disk notification sent at ${d.disk_used_pct!.toFixed(1)}% usage`
      : `Disk usage fell below the page threshold at ${d.disk_used_pct!.toFixed(1)}%`,
    payload: d,
  }, { strict: true });
}

function recentCard(since: string): string | null {
  const dir = path.join(VAULT, "needs_attention"), cutoff = Date.parse(since);
  try {
    const file = fs.readdirSync(dir).find((f) => f.startsWith("disk-pressure-") && f.endsWith(".md") && fs.statSync(path.join(dir, f)).mtimeMs >= cutoff);
    return file ? `needs_attention/${file}` : null;
  } catch { return null; }
}

async function notifyPage(d: DiskInfo): Promise<void> {
  const port = process.env.AAS_PORT ?? "3100";
  const resp = await fetch(`http://127.0.0.1:${port}/api/v1/notifications`, { method: "POST", headers: { Authorization: `Bearer ${process.env.AAS_API_KEY ?? ""}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: `Critical disk pressure: ${d.disk_used_pct!.toFixed(1)}% used (page threshold ${d.disk_alert_page_pct}%). Free disk space now to prevent an outage.`, urgency: "high", source_kind: "system", source_ref: "disk-pressure", source_headline: "Critical disk pressure" }), signal: AbortSignal.timeout(75_000) });
  if (!resp.ok) throw new Error(`notification returned ${resp.status}`);
}

// Kept for the existing test API. Crossing state is intentionally durable in
// state.db, so a process reset must not re-arm a page notification.
export function _resetDiskWatchForTests(): void {}

export async function runDiskWatch(deps: Deps = {}): Promise<DiskInfo> {
  const d = await (deps.sample ?? getDiskInfo)();
  if (d.disk_alert_level === "unknown") return d;
  const now = (deps.now ?? (() => new Date()))();
  let warningError: unknown;
  try {
    if (d.disk_alert_level !== "ok") {
      const since = new Date(now.getTime() - 86_400_000).toISOString();
      if (!(deps.recentWarn ?? recentAudit)(since)) {
        const card = deps.card
          ? await deps.card(d, now)
          : recentCard(since) ?? await mintCard(d, now);
        await (deps.audit ?? auditWarning)(d, card, now);
      }
    }
  } catch (err) { warningError = err; }
  const pageWasActive = (deps.pageActive ?? pageAlertActive)();
  if (d.disk_alert_level === "page" && !pageWasActive) {
    await (deps.notify ?? notifyPage)(d);
    await (deps.auditPage ?? auditPageTransition)(d, true, now);
  } else if (d.disk_alert_level !== "page" && pageWasActive) {
    await (deps.auditPage ?? auditPageTransition)(d, false, now);
  }
  if (warningError) throw warningError;
  return d;
}
