// GET /api/v1/attention/statement?month=YYYY-MM — NAR statement. Issue #570.
// Read-only except one audit row when the rate table changes. Timezone: UTC.
// voice-call-transcript outbound counted as interruption (cannot tell Alfred-placed
// from principal-placed; under-counting is the dishonest direction).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { ulid } from "../../db/ulid.js";
import { DEFAULT_RATES, computeNarStatement, type RateTable, type DecisionCounts } from "../../db/nar.js";

const DATA_DIR = process.env.ALFRED_DATA_DIR ?? "/alfred-data";
const RATES_FILE = path.join(DATA_DIR, "nar-rates.json");

function loadRates(): RateTable {
  try { return { ...DEFAULT_RATES, ...(JSON.parse(fs.readFileSync(RATES_FILE, "utf-8")) ?? {}) } as RateTable; }
  catch { return { ...DEFAULT_RATES }; }
}
function ratesHash(r: RateTable): string {
  const rec = r as unknown as Record<string, unknown>, s: Record<string, unknown> = {};
  for (const k of Object.keys(rec).sort()) s[k] = rec[k];
  return crypto.createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16);
}
function ensureRateAudit(rates: RateTable): void {
  const db = getStateDb(), hash = ratesHash(rates);
  const last = db.prepare(
    `SELECT payload_json FROM audit WHERE action_type='nar_rate_change' ORDER BY ts DESC LIMIT 1`)
    .get() as { payload_json: string } | undefined;
  const prev = last ? ((JSON.parse(last.payload_json ?? "{}") as { hash?: string }).hash ?? null) : null;
  if (prev === hash) return;
  db.prepare(`INSERT INTO audit (id,ts,action_type,actor,summary,payload_json,mode) VALUES (?,?,?,?,?,?,?)`)
    .run(ulid(), new Date().toISOString(), "nar_rate_change", "system",
      `NAR rate table changed (hash ${hash})`, JSON.stringify({ hash, rates }), "live");
}
function parseMonth(raw: string | null): { start: string; end: string; label: string } {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) throw new ValidationError("month must be YYYY-MM (e.g. 2026-07)");
  const [y, m] = raw.split("-").map(Number);
  if (m < 1 || m > 12) throw new ValidationError("month must be 01–12");
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { start: `${raw}-01T00:00:00.000Z`, end: `${next}-01T00:00:00.000Z`, label: raw };
}

export function registerAttentionStatementRoutes(): void {
  addRoute("GET", "/api/v1/attention/statement", async ({ res, query }) => {
    const { start, end, label } = parseMonth(query.get("month"));
    const rates = loadRates();
    ensureRateAudit(rates);
    const db = getStateDb();

    const journalRows = db.prepare(
      `SELECT ts FROM alfred_journal WHERE direction='inbound' AND source_kind='ha-conversation-turn'
         AND ts >= ? AND ts < ? ORDER BY ts ASC`)
      .all(start, end) as { ts: string }[];

    const decisionRows = db.prepare(
      `SELECT ts, payload_json FROM audit WHERE action_type='decision' AND actor='principal'
         AND ts >= ? AND ts < ?`)
      .all(start, end) as { ts: string; payload_json: string | null }[];

    const counts: DecisionCounts = { noise: 0, done: 0, delegate: 0, defer: 0, take_mine: 0 };
    const decisionTs: Date[] = [];
    for (const row of decisionRows) {
      decisionTs.push(new Date(row.ts));
      const intent = row.payload_json
        ? ((JSON.parse(row.payload_json) as { intent?: string }).intent ?? "") : "";
      if      (intent === "noise")     counts.noise++;
      else if (intent === "done")      counts.done++;
      else if (intent === "delegate")  counts.delegate++;
      else if (intent === "defer")     counts.defer++;
      else if (intent === "take_mine") counts.take_mine++;
      // unrecognised intent → zero displaced (conservative; does not inflate NAR)
    }
    // ha-conversation-reply is solicited (excluded). cron + system + voice-call-transcript counted.
    const { c: interruptionCount } = db.prepare(
      `SELECT COUNT(*) as c FROM alfred_journal WHERE direction='outbound'
         AND source_kind IN ('cron','system','voice-call-transcript') AND ts >= ? AND ts < ?`)
      .get(start, end) as { c: number };

    const allTs = [...journalRows.map((r) => new Date(r.ts)), ...decisionTs]
      .sort((a, b) => a.getTime() - b.getTime());
    sendJson(res, 200, computeNarStatement(label, counts, allTs, interruptionCount, rates));
  });
}
