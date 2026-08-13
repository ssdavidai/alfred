// Suppression rate card — fixed per-item rate for NAR accounting (#563, item 5).
// Placed in Lane I: ctrl owns the audit table where rate changes are logged.
// DEFAULT = 0.5 min/item (30 s). Deliberately low — a defensible small number
// beats an impressive one. 307 items × 5 min (model guess) = 25 h invented;
// 307 × 0.5 = 2.5 h, arguable in one sentence. To raise it, argue with this
// comment first, then explain the rationale in the commit message.
// SCOPE: suppression only. CONSUMERS: nightly recap + Attention Statement (future).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendAudit } from "./state.js";

export const DEFAULT_RATE_MINUTES_PER_ITEM = 0.5;
const OVERRIDE_FILE = "suppression-rate-card.json";
const STATE_FILE    = "suppression-rate-card-state.json";

export interface LoadedRateCard {
  rate_minutes_per_item: number;
  source: "default" | "override";
  override_path: string | null;
}

function dataDir(opts?: { dataDir?: string }): string {
  return opts?.dataDir ?? (process.env.ALFRED_DATA_DIR ?? "/alfred-data");
}

/**
 * Load the effective rate card.
 * An absent override file is normal. A malformed or invalid one THROWS —
 * silently ignoring it means someone believes a rate is in effect that is not.
 */
export function loadRateCard(opts?: { dataDir?: string }): LoadedRateCard {
  const d = dataDir(opts);
  const op = path.join(d, OVERRIDE_FILE);
  if (!fs.existsSync(op)) {
    return { rate_minutes_per_item: DEFAULT_RATE_MINUTES_PER_ITEM, source: "default", override_path: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(op, "utf-8"));
  } catch (err) {
    throw new Error(`[suppression-rate-card] override at ${op} is not valid JSON: ${err}`);
  }
  if (!parsed || typeof parsed !== "object" || !("minutes_per_item" in parsed)) {
    throw new Error(`[suppression-rate-card] override must be a JSON object with a "minutes_per_item" key`);
  }
  const rate = (parsed as Record<string, unknown>).minutes_per_item;
  if (typeof rate !== "number" || !isFinite(rate) || rate < 0) {
    throw new Error(`[suppression-rate-card] minutes_per_item must be a non-negative finite number; got ${JSON.stringify(rate)}`);
  }
  return { rate_minutes_per_item: rate, source: "override", override_path: op };
}

export function hashRateCard(c: LoadedRateCard): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ rate: c.rate_minutes_per_item, source: c.source }))
    .digest("hex").slice(0, 16);
}

function readHash(d: string): string | null {
  try { const p = JSON.parse(fs.readFileSync(path.join(d, STATE_FILE), "utf-8")); return typeof p?.hash === "string" ? p.hash : null; } catch { return null; }
}

function writeHash(d: string, hash: string): void {
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, STATE_FILE), tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ hash, recorded_at: new Date().toISOString() }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, p);
}

/**
 * Load the rate card and write an audit row when the rate has changed since
 * the last persisted state. Idempotent on unchanged repeat calls.
 */
export function getRateCard(opts?: { dataDir?: string }): LoadedRateCard {
  const d = dataDir(opts);
  const loaded = loadRateCard({ dataDir: d });
  const hash = hashRateCard(loaded);
  const prev = readHash(d);
  if (hash !== prev) {
    appendAudit({
      action_type: "suppression_rate_card_change",
      actor: "alfred",
      source: "suppression_rate_card",
      summary: prev === null
        ? `suppression rate card initialised: ${loaded.rate_minutes_per_item} min/item (${loaded.source})`
        : `suppression rate card changed to ${loaded.rate_minutes_per_item} min/item (${loaded.source})`,
      payload: { rate_minutes_per_item: loaded.rate_minutes_per_item, source: loaded.source, hash, previous_hash: prev },
    });
    writeHash(d, hash);
  }
  return loaded;
}
