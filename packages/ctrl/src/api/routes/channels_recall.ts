// /api/v1/channels/recall/* — Recall.ai channel routes (#113 PR2 + PR4).
//
// Recall.ai replaces the retired Vexa stack (#113 PR1) as the per-meeting
// bot transport. Everything Sir needs to configure — API key, region, bot
// name, announcements, auto-join policy, calendar source, cost ceiling,
// per-meeting cap, respond mode, wake word, active-bot management,
// webhook delivery test, cost-alert thresholds — lives on the /channels
// Recall card. **The principal never visits recall.ai.**
//
// This file ships the ctrl-api half of the card-driven contract per spec
// §5.1.1, plus the inbound Svix-signed webhook target per spec §5.4.
// The 7+ outbound routes are bearer-authed via the global AAS_API_KEY
// gate (same as every other /channels/* route except the webhook target).
//
// Surface:
//
//   POST /api/v1/channels/recall/validate-key            — paste+round-trip test
//   GET  /api/v1/channels/recall/config                  — current dials
//   PATCH /api/v1/channels/recall/config                 — update dials
//   GET  /api/v1/channels/recall/usage                   — month-to-date rollup
//   GET  /api/v1/channels/recall/bots/active             — non-terminal bots
//   POST /api/v1/channels/recall/bots                    — dispatch a bot (PR4)
//   DELETE /api/v1/channels/recall/bots/:bot_id          — mid-meeting terminate
//   POST /api/v1/channels/recall/bots/:bot_id/leave      — graceful leave (PR4)
//   POST /api/v1/channels/recall/webhook-test            — synthetic delivery
//   POST /api/v1/webhooks/recall                         — Svix-signed inbound
//
// Persistence: state.db tables recall_config / recall_bot / recall_event
// (migration 0007_recall.sql). The card-side surface (PR3a/PR3b) reads
// these via the GET routes; the alfred-learn dispatcher (PR4) writes
// recall_bot rows when it creates a bot; this file owns the row updates
// driven by inbound webhooks.
//
// API-key persistence: validation only round-trips the key against
// Recall — it does NOT persist. The /channels card POST handler (PR3a)
// is responsible for writing RECALL_API_KEY into the host .env once
// validation succeeds, mirroring the paperclip POST /api-key pattern.
// PR3a + PR3b own the operator-facing key paste; PR2 stops at validate.

import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, ApiError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import type { DatabaseSync } from "node:sqlite";

// ── Recall API endpoint helpers ───────────────────────────────────────────

const RECALL_REGION_HOSTS: Record<string, string> = {
  "us-east-1": "https://us-east-1.recall.ai",
  "us-west-2": "https://us-west-2.recall.ai",
  "eu-central-1": "https://eu-central-1.recall.ai",
  "ap-northeast-1": "https://ap-northeast-1.recall.ai",
};

const VALID_REGIONS = Object.keys(RECALL_REGION_HOSTS);
const VALID_AUTO_JOIN_POLICIES = ["off", "principal_attendee", "all"] as const;
const VALID_CALENDAR_SOURCES = ["composio", "recall_v2"] as const;
const VALID_RESPOND_MODES = ["off", "on_mention", "always"] as const;

function recallBaseUrl(region: string): string {
  return RECALL_REGION_HOSTS[region] ?? RECALL_REGION_HOSTS["us-east-1"];
}

// ── meeting URL validation ────────────────────────────────────────────────
//
// PR4 — POST /bots accepts a meeting URL the dispatcher (alfred-learn)
// or the card pulled out of a calendar event. We confirm the URL is
// shaped like one of the three platforms Recall actually supports
// today: Zoom, Google Meet, Microsoft Teams. Anything else gets a 400
// so a stray "join here" link in a description doesn't try to spin
// up a bot Recall would refuse anyway.
//
// Patterns are deliberately loose — Recall does the canonical
// resolution (e.g. zoom.us/j/... with a passcode encoded into the
// link). We only confirm the host *family* matches one of the three.
const MEETING_HOST_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "zoom", re: /\b(?:[a-z0-9-]+\.)?zoom\.(?:us|com)\b/i },
  { name: "meet", re: /\bmeet\.google\.com\b/i },
  { name: "teams", re: /\bteams\.(?:microsoft|live)\.com\b/i },
];

interface MeetingUrlInfo {
  platform: "zoom" | "meet" | "teams";
  normalized: string;
}

export function classifyMeetingUrl(url: string): MeetingUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  for (const { name, re } of MEETING_HOST_PATTERNS) {
    if (re.test(parsed.host)) {
      return {
        platform: name as MeetingUrlInfo["platform"],
        normalized: parsed.toString(),
      };
    }
  }
  return null;
}

// ── recall_config row helpers ─────────────────────────────────────────────
//
// The row is a singleton at id=1. On first read we lazily insert a row
// with all defaults from the migration's column definitions. The
// migration intentionally does NOT pre-seed the row so the
// `updated_at` value is honest about when the operator first looked at
// it.

interface RecallConfigRow {
  id: number;
  region: string;
  bot_name: string;
  announces_on_join: number;
  auto_join_policy: string;
  calendar_source: string;
  monthly_hours_cap: number;
  leave_after_minutes: number;
  respond_mode: string;
  wake_word: string;
  cost_alert_thresholds_json: string;
  updated_at: number;
}

function getOrSeedConfig(db: DatabaseSync): RecallConfigRow {
  const row = db
    .prepare("SELECT * FROM recall_config WHERE id = 1")
    .get() as RecallConfigRow | undefined;
  if (row) return row;
  const now = Date.now();
  db.prepare(
    `INSERT INTO recall_config (id, updated_at) VALUES (1, ?)`,
  ).run(now);
  const seeded = db
    .prepare("SELECT * FROM recall_config WHERE id = 1")
    .get() as RecallConfigRow;
  return seeded;
}

function rowToApiConfig(row: RecallConfigRow): Record<string, unknown> {
  let thresholds: number[] = [80, 100];
  try {
    const parsed = JSON.parse(row.cost_alert_thresholds_json);
    if (
      Array.isArray(parsed) &&
      parsed.every((x) => typeof x === "number" && Number.isFinite(x))
    ) {
      thresholds = parsed;
    }
  } catch {
    // Fall back to the default — never reject a row on a corrupted JSON
    // field; the operator can re-PATCH to fix it.
  }
  return {
    region: row.region,
    bot_name: row.bot_name,
    announces_on_join: row.announces_on_join === 1,
    auto_join_policy: row.auto_join_policy,
    calendar_source: row.calendar_source,
    monthly_hours_cap: row.monthly_hours_cap,
    leave_after_minutes: row.leave_after_minutes,
    respond_mode: row.respond_mode,
    wake_word: row.wake_word,
    cost_alert_thresholds: thresholds,
    updated_at: row.updated_at,
  };
}

// ── PATCH config body validation ──────────────────────────────────────────

interface ConfigPatch {
  region?: string;
  bot_name?: string;
  announces_on_join?: boolean;
  auto_join_policy?: string;
  calendar_source?: string;
  monthly_hours_cap?: number;
  leave_after_minutes?: number;
  respond_mode?: string;
  wake_word?: string;
  cost_alert_thresholds?: number[];
}

function parseConfigPatch(raw: unknown): ConfigPatch {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  const out: ConfigPatch = {};

  if (b.region !== undefined) {
    if (typeof b.region !== "string" || !VALID_REGIONS.includes(b.region)) {
      throw new ValidationError(
        `region must be one of: ${VALID_REGIONS.join(", ")}`,
      );
    }
    out.region = b.region;
  }
  if (b.bot_name !== undefined) {
    if (typeof b.bot_name !== "string" || b.bot_name.length === 0) {
      throw new ValidationError("bot_name must be a non-empty string");
    }
    if (b.bot_name.length > 200) {
      throw new ValidationError("bot_name must be ≤200 chars");
    }
    out.bot_name = b.bot_name;
  }
  if (b.announces_on_join !== undefined) {
    if (typeof b.announces_on_join !== "boolean") {
      throw new ValidationError("announces_on_join must be a boolean");
    }
    out.announces_on_join = b.announces_on_join;
  }
  if (b.auto_join_policy !== undefined) {
    if (
      typeof b.auto_join_policy !== "string" ||
      !VALID_AUTO_JOIN_POLICIES.includes(
        b.auto_join_policy as (typeof VALID_AUTO_JOIN_POLICIES)[number],
      )
    ) {
      throw new ValidationError(
        `auto_join_policy must be one of: ${VALID_AUTO_JOIN_POLICIES.join(", ")}`,
      );
    }
    out.auto_join_policy = b.auto_join_policy;
  }
  if (b.calendar_source !== undefined) {
    if (
      typeof b.calendar_source !== "string" ||
      !VALID_CALENDAR_SOURCES.includes(
        b.calendar_source as (typeof VALID_CALENDAR_SOURCES)[number],
      )
    ) {
      throw new ValidationError(
        `calendar_source must be one of: ${VALID_CALENDAR_SOURCES.join(", ")}`,
      );
    }
    out.calendar_source = b.calendar_source;
  }
  if (b.monthly_hours_cap !== undefined) {
    if (
      typeof b.monthly_hours_cap !== "number" ||
      !Number.isInteger(b.monthly_hours_cap) ||
      b.monthly_hours_cap < 0 ||
      b.monthly_hours_cap > 10_000
    ) {
      throw new ValidationError(
        "monthly_hours_cap must be an integer between 0 and 10000",
      );
    }
    out.monthly_hours_cap = b.monthly_hours_cap;
  }
  if (b.leave_after_minutes !== undefined) {
    if (
      typeof b.leave_after_minutes !== "number" ||
      !Number.isInteger(b.leave_after_minutes) ||
      b.leave_after_minutes < 1 ||
      b.leave_after_minutes > 1440
    ) {
      throw new ValidationError(
        "leave_after_minutes must be an integer between 1 and 1440",
      );
    }
    out.leave_after_minutes = b.leave_after_minutes;
  }
  if (b.respond_mode !== undefined) {
    if (
      typeof b.respond_mode !== "string" ||
      !VALID_RESPOND_MODES.includes(
        b.respond_mode as (typeof VALID_RESPOND_MODES)[number],
      )
    ) {
      throw new ValidationError(
        `respond_mode must be one of: ${VALID_RESPOND_MODES.join(", ")}`,
      );
    }
    out.respond_mode = b.respond_mode;
  }
  if (b.wake_word !== undefined) {
    if (typeof b.wake_word !== "string" || b.wake_word.length === 0) {
      throw new ValidationError("wake_word must be a non-empty string");
    }
    if (b.wake_word.length > 64) {
      throw new ValidationError("wake_word must be ≤64 chars");
    }
    out.wake_word = b.wake_word;
  }
  if (b.cost_alert_thresholds !== undefined) {
    if (
      !Array.isArray(b.cost_alert_thresholds) ||
      b.cost_alert_thresholds.length === 0 ||
      b.cost_alert_thresholds.length > 16 ||
      !b.cost_alert_thresholds.every(
        (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000,
      )
    ) {
      throw new ValidationError(
        "cost_alert_thresholds must be a non-empty array of finite numbers in [0,1000]",
      );
    }
    out.cost_alert_thresholds = (b.cost_alert_thresholds as number[]).slice();
  }
  if (Object.keys(out).length === 0) {
    throw new ValidationError("patch body has no recognised fields");
  }
  return out;
}

// ── validate-key handler — round-trip against Recall ───────────────────────

interface ValidateKeyOutcome {
  ok: boolean;
  account?: Record<string, unknown>;
  reason?: string;
}

/** Round-trip an API key against Recall's read-only list-bots endpoint.
 *  We use `/api/v1/bot/?limit=1` (the documented list path) because it
 *  is read-only, requires no payload, and 401s on a bad key. We do NOT
 *  persist the key on success — the /channels card POST handler (PR3a)
 *  owns that. */
async function validateRecallKey(
  apiKey: string,
  region: string,
): Promise<ValidateKeyOutcome> {
  const base = recallBaseUrl(region);
  const url = `${base}/api/v1/bot/?limit=1`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, reason: "Recall rejected the API key" };
  }
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 200);
    } catch {
      /* swallow */
    }
    return {
      ok: false,
      reason: `Recall returned HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`,
    };
  }
  // 200 OK. The list-bots endpoint returns `{results:[…]}` but doesn't
  // surface account metadata; that's fine — the validation signal is the
  // status code itself. Surface the count for the card to render
  // "validated · N bots on file" if it wants.
  let count: number | null = null;
  try {
    const json = (await resp.json()) as Record<string, unknown>;
    if (typeof json.count === "number") count = json.count;
    else if (Array.isArray(json.results)) count = json.results.length;
  } catch {
    /* swallow */
  }
  return {
    ok: true,
    account: { region, bots_known: count },
  };
}

// ── usage rollup ──────────────────────────────────────────────────────────

interface UsageRow {
  this_month_hours: number;
  monthly_hours_cap: number;
  bot_count_active: number;
}

function computeUsage(db: DatabaseSync, cap: number): UsageRow {
  // First of the current month, UTC. Recall bills bot-time per real
  // minute the bot is in a meeting; we approximate from joined_at→left_at
  // for completed bots in the current month, plus joined_at→now for
  // in-flight bots. Anything without a joined_at doesn't count yet.
  const now = new Date();
  const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nowMs = Date.now();

  const completed = db
    .prepare(
      `SELECT COALESCE(SUM(left_at - joined_at), 0) AS ms
         FROM recall_bot
        WHERE joined_at IS NOT NULL
          AND left_at IS NOT NULL
          AND joined_at >= ?`,
    )
    .get(startOfMonth) as { ms: number } | undefined;

  const inflight = db
    .prepare(
      `SELECT COALESCE(SUM(? - joined_at), 0) AS ms
         FROM recall_bot
        WHERE joined_at IS NOT NULL
          AND left_at IS NULL
          AND status NOT IN ('done','fail')
          AND joined_at >= ?`,
    )
    .get(nowMs, startOfMonth) as { ms: number } | undefined;

  const active = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM recall_bot
        WHERE status NOT IN ('done','fail')`,
    )
    .get() as { n: number };

  const totalMs = (completed?.ms ?? 0) + (inflight?.ms ?? 0);
  // Round to two decimal places.
  const hours = Math.round((totalMs / 3_600_000) * 100) / 100;

  return {
    this_month_hours: hours,
    monthly_hours_cap: cap,
    bot_count_active: active.n,
  };
}

// ── inbound webhook signature verification ─────────────────────────────────
//
// Recall delivers webhooks via Svix. Svix's signed-content format is
// identical to the Standard-Webhooks scheme already used by the Composio
// webhook (composioWebhook.ts:99-150):
//
//   svix-id:        <ulid-ish string>
//   svix-timestamp: <unix-seconds>
//   svix-signature: v1,<base64-hmac>   (space-separated for multi-key rotation)
//
// signing string:  `${id}.${ts}.${rawBody}`
// algorithm:       HMAC-SHA-256, base64-encoded
// secret prefix:   "whsec_" + base64 (sometimes raw)
//
// The header names Recall actually emits are `svix-id` / `svix-timestamp`
// / `svix-signature`; some setups proxy them as the equivalent
// `webhook-*` headers. We accept either.

interface SvixVerifyResult {
  ok: boolean;
  reason: string;
}

function headerString(
  h: string | string[] | undefined,
): string | null {
  if (!h) return null;
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v !== "string" || v.length === 0) return null;
  return v;
}

function pickSvixHeaders(
  headers: Record<string, string | string[] | undefined>,
): { id: string | null; ts: string | null; sig: string | null } {
  return {
    id:
      headerString(headers["svix-id"]) ?? headerString(headers["webhook-id"]),
    ts:
      headerString(headers["svix-timestamp"]) ??
      headerString(headers["webhook-timestamp"]),
    sig:
      headerString(headers["svix-signature"]) ??
      headerString(headers["webhook-signature"]),
  };
}

function verifySvixSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): SvixVerifyResult {
  const { id, ts, sig } = pickSvixHeaders(headers);
  if (!id || !ts || !sig) {
    return { ok: false, reason: "missing svix-id / svix-timestamp / svix-signature" };
  }
  // Replay window: ±5 minutes. The timestamp itself isn't a secret; reject
  // early so the HMAC work doesn't happen on stale deliveries.
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "svix-timestamp is not a number" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > 300) {
    return { ok: false, reason: "svix-timestamp outside ±5min replay window" };
  }

  const secretBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf-8");

  const signed = Buffer.concat([
    Buffer.from(`${id}.${ts}.`, "utf-8"),
    rawBody,
  ]);
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signed)
    .digest("base64");

  // Header is space-separated "v1,<sig> v1,<sig2> ..." — any match wins.
  for (const part of sig.split(" ")) {
    const eq = part.indexOf(",");
    if (eq < 0) continue;
    const version = part.slice(0, eq).trim();
    const received = part.slice(eq + 1).trim();
    if (version !== "v1") continue;
    const aBuf = Buffer.from(expected);
    const bBuf = Buffer.from(received);
    if (aBuf.length !== bBuf.length) continue;
    try {
      if (crypto.timingSafeEqual(aBuf, bBuf)) {
        return { ok: true, reason: "svix signature verified" };
      }
    } catch {
      /* length mismatch already filtered; ignore */
    }
  }
  return { ok: false, reason: "no svix signature matched" };
}

// ── webhook event → recall_bot status mapping ──────────────────────────────
//
// Recall fires lifecycle events with `event` (or `type`) like
// "bot.joining_call", "bot.in_call_recording", "bot.call_ended",
// "bot.done", "bot.fatal", plus per-output events like
// "transcript.done". We tolerate the synonyms and surface a small set
// of status transitions on the parent row.

const TERMINAL_STATES = new Set(["done", "fail"]);

function statusFromEvent(eventType: string): string | null {
  const t = eventType.toLowerCase();
  if (/joining|join_call|joining_call/.test(t)) return "joining";
  if (/in_(call|meeting)|recording|joined/.test(t)) return "in_meeting";
  if (/leaving/.test(t)) return "leaving";
  if (/done$|call_ended|finished/.test(t)) return "done";
  if (/fail|fatal|error/.test(t)) return "fail";
  return null;
}

/** Pluck the bot id out of a Recall webhook payload. Recall's V2 webhooks
 *  put it under `data.bot.id` or `data.bot_id`; older shapes use `bot_id`
 *  at the top level. Returns null on the shape we don't recognise. */
function extractBotId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.bot_id === "string") return p.bot_id;
  const data = p.data;
  if (typeof data === "object" && data !== null) {
    const d = data as Record<string, unknown>;
    if (typeof d.bot_id === "string") return d.bot_id;
    const bot = d.bot;
    if (typeof bot === "object" && bot !== null) {
      const bo = bot as Record<string, unknown>;
      if (typeof bo.id === "string") return bo.id;
    }
  }
  return null;
}

function extractEventType(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.event === "string") return p.event;
  if (typeof p.type === "string") return p.type;
  // V3-ish shape: metadata.event_type
  const meta = p.metadata;
  if (typeof meta === "object" && meta !== null) {
    const m = meta as Record<string, unknown>;
    if (typeof m.event_type === "string") return m.event_type;
  }
  return null;
}

function extractTranscriptUrl(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const data = p.data;
  if (typeof data === "object" && data !== null) {
    const d = data as Record<string, unknown>;
    if (typeof d.transcript_url === "string") return d.transcript_url;
    const transcript = d.transcript;
    if (typeof transcript === "object" && transcript !== null) {
      const tr = transcript as Record<string, unknown>;
      if (typeof tr.url === "string") return tr.url;
      if (typeof tr.download_url === "string") return tr.download_url;
    }
  }
  return null;
}

/** Persist one verified webhook event. Transactional: the recall_event
 *  row + any recall_bot.status update land together so a crashed
 *  ctrl-api never produces an event row without its row-update side
 *  effect (or vice versa). */
function persistWebhookEvent(
  db: DatabaseSync,
  payload: unknown,
  eventAtMs: number,
): { event_type: string; bot_id: string | null; new_status: string | null } {
  const eventType = extractEventType(payload) ?? "unknown";
  const botId = extractBotId(payload);
  const newStatus = statusFromEvent(eventType);
  const transcriptUrl = extractTranscriptUrl(payload);

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO recall_event (bot_id, event_type, event_at, payload_json)
         VALUES (?, ?, ?, ?)`,
    ).run(botId, eventType, eventAtMs, JSON.stringify(payload));

    if (botId && newStatus) {
      // Read current row so we (a) only update bots we know about, (b)
      // never regress from a terminal state, (c) keep the joined_at /
      // left_at columns coherent.
      const existing = db
        .prepare(
          `SELECT status, joined_at, left_at FROM recall_bot WHERE id = ?`,
        )
        .get(botId) as
        | { status: string; joined_at: number | null; left_at: number | null }
        | undefined;
      if (existing && !TERMINAL_STATES.has(existing.status)) {
        const joinedAt =
          newStatus === "in_meeting" && existing.joined_at === null
            ? eventAtMs
            : existing.joined_at;
        const leftAt =
          TERMINAL_STATES.has(newStatus) && existing.left_at === null
            ? eventAtMs
            : existing.left_at;
        const nextTranscriptUrl = transcriptUrl ?? null;
        db.prepare(
          `UPDATE recall_bot
              SET status         = ?,
                  joined_at      = ?,
                  left_at        = ?,
                  transcript_url = COALESCE(?, transcript_url)
            WHERE id = ?`,
        ).run(newStatus, joinedAt, leftAt, nextTranscriptUrl, botId);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { event_type: eventType, bot_id: botId, new_status: newStatus };
}

// Exported for tests so they can directly drive the persistence layer
// without spinning through HTTP. NOT part of the wire surface.
export const _recallInternals = {
  validateRecallKey,
  verifySvixSignature,
  persistWebhookEvent,
  computeUsage,
  getOrSeedConfig,
  statusFromEvent,
  parseConfigPatch,
  classifyMeetingUrl,
};

// ── Routes ────────────────────────────────────────────────────────────────

export function registerChannelsRecallRoutes(): void {
  // POST /api/v1/channels/recall/validate-key
  //
  // Card-side paste flow: the operator pastes a candidate API key into
  // the /channels Recall card; the card calls this route to confirm the
  // key works against Recall before writing it anywhere durable.
  // The route NEVER persists; PR3a handles persistence in a separate
  // POST after this validation succeeds.
  addRoute(
    "POST",
    "/api/v1/channels/recall/validate-key",
    async ({ res, body }) => {
      const b = (body ?? {}) as { api_key?: unknown; region?: unknown };
      if (typeof b.api_key !== "string" || b.api_key.trim().length === 0) {
        throw new ValidationError("api_key (non-empty string) is required");
      }
      const key = b.api_key.trim();
      // Region is optional; default to the configured value (or 'us-east-1').
      let region = "us-east-1";
      if (b.region !== undefined) {
        if (typeof b.region !== "string" || !VALID_REGIONS.includes(b.region)) {
          throw new ValidationError(
            `region must be one of: ${VALID_REGIONS.join(", ")}`,
          );
        }
        region = b.region;
      } else {
        try {
          const cfg = getOrSeedConfig(getStateDb());
          region = cfg.region;
        } catch {
          /* default region is fine */
        }
      }
      const outcome = await validateRecallKey(key, region);
      // Always 200 — the {ok:false, reason} envelope tells the card what
      // to render. Tossing a non-2xx here would force the card to also
      // handle a generic error page on what's a normal "wrong key" path.
      sendJson(res, 200, outcome);
    },
  );

  // GET /api/v1/channels/recall/config
  addRoute("GET", "/api/v1/channels/recall/config", async ({ res }) => {
    const db = getStateDb();
    const row = getOrSeedConfig(db);
    sendJson(res, 200, rowToApiConfig(row));
  });

  // PATCH /api/v1/channels/recall/config
  addRoute(
    "PATCH",
    "/api/v1/channels/recall/config",
    async ({ res, body }) => {
      const patch = parseConfigPatch(body);
      const db = getStateDb();
      // Make sure the row exists.
      getOrSeedConfig(db);
      const fields: string[] = [];
      const values: unknown[] = [];
      if (patch.region !== undefined) {
        fields.push("region = ?");
        values.push(patch.region);
      }
      if (patch.bot_name !== undefined) {
        fields.push("bot_name = ?");
        values.push(patch.bot_name);
      }
      if (patch.announces_on_join !== undefined) {
        fields.push("announces_on_join = ?");
        values.push(patch.announces_on_join ? 1 : 0);
      }
      if (patch.auto_join_policy !== undefined) {
        fields.push("auto_join_policy = ?");
        values.push(patch.auto_join_policy);
      }
      if (patch.calendar_source !== undefined) {
        fields.push("calendar_source = ?");
        values.push(patch.calendar_source);
      }
      if (patch.monthly_hours_cap !== undefined) {
        fields.push("monthly_hours_cap = ?");
        values.push(patch.monthly_hours_cap);
      }
      if (patch.leave_after_minutes !== undefined) {
        fields.push("leave_after_minutes = ?");
        values.push(patch.leave_after_minutes);
      }
      if (patch.respond_mode !== undefined) {
        fields.push("respond_mode = ?");
        values.push(patch.respond_mode);
      }
      if (patch.wake_word !== undefined) {
        fields.push("wake_word = ?");
        values.push(patch.wake_word);
      }
      if (patch.cost_alert_thresholds !== undefined) {
        fields.push("cost_alert_thresholds_json = ?");
        values.push(JSON.stringify(patch.cost_alert_thresholds));
      }
      fields.push("updated_at = ?");
      values.push(Date.now());
      const sql = `UPDATE recall_config SET ${fields.join(", ")} WHERE id = 1`;
      db.prepare(sql).run(...values);
      const row = getOrSeedConfig(db);
      sendJson(res, 200, rowToApiConfig(row));
    },
  );

  // GET /api/v1/channels/recall/usage
  addRoute("GET", "/api/v1/channels/recall/usage", async ({ res }) => {
    const db = getStateDb();
    const cfg = getOrSeedConfig(db);
    const usage = computeUsage(db, cfg.monthly_hours_cap);
    sendJson(res, 200, usage);
  });

  // GET /api/v1/channels/recall/bots/active
  addRoute(
    "GET",
    "/api/v1/channels/recall/bots/active",
    async ({ res }) => {
      const db = getStateDb();
      const rows = db
        .prepare(
          `SELECT id, calendar_event_id, meeting_url, status,
                  created_at, joined_at, left_at, transcript_url
             FROM recall_bot
            WHERE status NOT IN ('done','fail')
            ORDER BY created_at DESC
            LIMIT 100`,
        )
        .all() as Array<{
        id: string;
        calendar_event_id: string | null;
        meeting_url: string | null;
        status: string;
        created_at: number;
        joined_at: number | null;
        left_at: number | null;
        transcript_url: string | null;
      }>;
      sendJson(res, 200, { bots: rows });
    },
  );

  // POST /api/v1/channels/recall/bots — dispatch a Recall bot (#113 PR4).
  //
  // Body: { meeting_url: string, bot_name?: string,
  //         calendar_event_id?: string, scheduled_join_time?: string }
  //
  // Posts to Recall's POST /api/v2/bot create-bot endpoint with the
  // configured bot_name, recording_config defaults, and an optional
  // `join_at` if `scheduled_join_time` is in the future. The full
  // Recall payload is persisted verbatim into recall_bot.json so we can
  // re-derive any field later (transcript URL surfacing, etc.) without a
  // migration.
  //
  // Two consumers:
  //   1. The alfred-learn RecallDispatcherWorkflow (PR4) walks the
  //      principal's calendar and POSTs here for each policy-passing
  //      meeting.
  //   2. The /channels Recall card's manual "Send bot now" button
  //      (PR3a) POSTs here with just the meeting URL.
  //
  // Idempotence: if the request carries `calendar_event_id` and a
  // recall_bot row already exists for it in a non-terminal state, we
  // 200 the existing row instead of creating a second Recall bot. The
  // dispatcher uses this as its dedupe surface; the card's manual path
  // bypasses it (no calendar_event_id sent).
  addRoute(
    "POST",
    "/api/v1/channels/recall/bots",
    async ({ res, body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      if (typeof b.meeting_url !== "string" || b.meeting_url.trim().length === 0) {
        throw new ValidationError("meeting_url (non-empty string) is required");
      }
      const meetingInfo = classifyMeetingUrl(b.meeting_url);
      if (!meetingInfo) {
        throw new ValidationError(
          "meeting_url must point at zoom.us, meet.google.com, or teams.microsoft.com",
        );
      }
      let calendarEventId: string | null = null;
      if (b.calendar_event_id !== undefined && b.calendar_event_id !== null) {
        if (
          typeof b.calendar_event_id !== "string" ||
          b.calendar_event_id.length > 256
        ) {
          throw new ValidationError(
            "calendar_event_id must be a string ≤256 chars",
          );
        }
        calendarEventId = b.calendar_event_id.trim() || null;
      }
      let scheduledJoinTime: string | null = null;
      if (b.scheduled_join_time !== undefined && b.scheduled_join_time !== null) {
        if (typeof b.scheduled_join_time !== "string") {
          throw new ValidationError(
            "scheduled_join_time must be an ISO 8601 string",
          );
        }
        const ts = Date.parse(b.scheduled_join_time);
        if (!Number.isFinite(ts)) {
          throw new ValidationError(
            "scheduled_join_time must be a valid ISO 8601 datetime",
          );
        }
        scheduledJoinTime = new Date(ts).toISOString();
      }
      const apiKey = process.env.RECALL_API_KEY?.trim();
      if (!apiKey) {
        throw new ApiError(
          503,
          "NOT_CONFIGURED",
          "RECALL_API_KEY is not set on this tenant",
        );
      }
      const db = getStateDb();
      const cfg = getOrSeedConfig(db);

      // Idempotence on calendar_event_id — if the dispatcher already
      // created a bot for this meeting, return the existing row.
      if (calendarEventId) {
        const existing = db
          .prepare(
            `SELECT id, status, json
               FROM recall_bot
              WHERE calendar_event_id = ?
                AND status NOT IN ('done','fail')
              ORDER BY created_at DESC
              LIMIT 1`,
          )
          .get(calendarEventId) as
          | { id: string; status: string; json: string }
          | undefined;
        if (existing) {
          sendJson(res, 200, {
            bot_id: existing.id,
            status: existing.status,
            recall_url: null,
            note: "existing bot for this calendar_event_id",
          });
          return;
        }
      }

      const botName =
        typeof b.bot_name === "string" && b.bot_name.trim().length > 0
          ? b.bot_name.trim().slice(0, 200)
          : cfg.bot_name;

      const recallBody: Record<string, unknown> = {
        meeting_url: meetingInfo.normalized,
        bot_name: botName,
        recording_config: {
          transcript: { provider: { meeting_captions: {} } },
        },
      };
      if (scheduledJoinTime) {
        recallBody.join_at = scheduledJoinTime;
      }

      const base = recallBaseUrl(cfg.region);
      const url = `${base}/api/v2/bot`;
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Token ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(recallBody),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        // Never include the API key in the surfaced message — only the
        // request error.
        throw new ApiError(
          502,
          "RECALL_UNREACHABLE",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!resp.ok) {
        let detail = "";
        try {
          detail = (await resp.text()).slice(0, 200);
        } catch {
          /* swallow */
        }
        // Prefix-only key fingerprint for log correlation; the key
        // itself never leaves the env.
        const keyPrefix = apiKey.slice(0, 6);
        console.warn(
          `[recall] create-bot HTTP ${resp.status} (key ${keyPrefix}…): ${detail}`,
        );
        throw new ApiError(
          resp.status === 401 || resp.status === 403 ? 503 : 502,
          resp.status === 401 || resp.status === 403
            ? "NOT_CONFIGURED"
            : "RECALL_REJECTED",
          `Recall returned HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`,
        );
      }
      let payload: Record<string, unknown> = {};
      try {
        payload = (await resp.json()) as Record<string, unknown>;
      } catch {
        // Recall returned 2xx with a non-JSON body. Treat as a soft
        // failure — we have no bot_id to persist.
        throw new ApiError(
          502,
          "RECALL_REJECTED",
          "Recall returned a non-JSON success body",
        );
      }
      const botId =
        typeof payload.id === "string"
          ? payload.id
          : typeof payload.bot_id === "string"
            ? payload.bot_id
            : null;
      if (!botId) {
        throw new ApiError(
          502,
          "RECALL_REJECTED",
          "Recall response did not include a bot id",
        );
      }
      const recallUrl =
        typeof payload.recording_url === "string"
          ? payload.recording_url
          : typeof payload.url === "string"
            ? payload.url
            : null;
      const now = Date.now();
      db.prepare(
        `INSERT INTO recall_bot (id, calendar_event_id, meeting_url, status, created_at, json)
           VALUES (?, ?, ?, 'requested', ?, ?)`,
      ).run(
        botId,
        calendarEventId,
        meetingInfo.normalized,
        now,
        JSON.stringify(payload),
      );
      sendJson(res, 200, {
        bot_id: botId,
        status: "requested",
        recall_url: recallUrl,
      });
    },
  );

  // POST /api/v1/channels/recall/bots/:bot_id/leave — graceful leave (#113 PR4).
  //
  // Semantically identical to the DELETE route (Recall's API exposes
  // exactly one "remove bot from call" verb) but matches the spec's
  // POST-leave wording and gives the dispatcher / card a verb that
  // reads naturally in their own code paths ("send bot home" vs
  // "delete bot").
  addRoute(
    "POST",
    "/api/v1/channels/recall/bots/:bot_id/leave",
    async ({ res, params }) => {
      const botId = params.bot_id;
      if (!botId || botId.length > 200) {
        throw new ValidationError("bot_id must be a non-empty string ≤200 chars");
      }
      const apiKey = process.env.RECALL_API_KEY?.trim();
      if (!apiKey) {
        throw new ApiError(
          503,
          "NOT_CONFIGURED",
          "RECALL_API_KEY is not set on this tenant",
        );
      }
      const db = getStateDb();
      const cfg = getOrSeedConfig(db);
      const base = recallBaseUrl(cfg.region);
      const url = `${base}/api/v1/bot/${encodeURIComponent(botId)}/`;
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: `Token ${apiKey}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        throw new ApiError(
          502,
          "RECALL_UNREACHABLE",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (resp.status === 404) {
        db.prepare(
          `UPDATE recall_bot
              SET status = 'done',
                  left_at = COALESCE(left_at, ?)
            WHERE id = ? AND status NOT IN ('done','fail')`,
        ).run(Date.now(), botId);
        sendJson(res, 200, {
          ok: true,
          bot_id: botId,
          status: "done",
          note: "Recall reported 404; local row marked done",
        });
        return;
      }
      if (!resp.ok) {
        let detail = "";
        try {
          detail = (await resp.text()).slice(0, 200);
        } catch {
          /* swallow */
        }
        throw new ApiError(
          502,
          "RECALL_REJECTED",
          `Recall returned HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`,
        );
      }
      const now = Date.now();
      db.prepare(
        `UPDATE recall_bot
            SET status = CASE WHEN status IN ('done','fail') THEN status ELSE 'leaving' END,
                left_at = COALESCE(left_at, ?)
          WHERE id = ?`,
      ).run(now, botId);
      sendJson(res, 200, { ok: true, bot_id: botId, status: "leaving" });
    },
  );

  // DELETE /api/v1/channels/recall/bots/:bot_id — mid-meeting terminate.
  //
  // Calls Recall's DELETE /api/v1/bot/<id>/ to instruct the bot to leave,
  // then flips the local row's status to "leaving". The bot.left / bot.done
  // webhook will eventually arrive and drive the row to a terminal state.
  // Surfaces the upstream HTTP status so the card can render a useful
  // error if Recall rejected the request (e.g. unknown bot id, expired
  // session).
  addRoute(
    "DELETE",
    "/api/v1/channels/recall/bots/:bot_id",
    async ({ res, params }) => {
      const botId = params.bot_id;
      if (!botId || botId.length > 200) {
        throw new ValidationError("bot_id must be a non-empty string ≤200 chars");
      }
      const apiKey = process.env.RECALL_API_KEY?.trim();
      if (!apiKey) {
        throw new ApiError(
          503,
          "NOT_CONFIGURED",
          "RECALL_API_KEY is not set on this tenant",
        );
      }
      const db = getStateDb();
      const cfg = getOrSeedConfig(db);
      const base = recallBaseUrl(cfg.region);
      const url = `${base}/api/v1/bot/${encodeURIComponent(botId)}/`;
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: `Token ${apiKey}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        throw new ApiError(
          502,
          "RECALL_UNREACHABLE",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (resp.status === 404) {
        // Bot is gone on Recall's side — mark local row terminal too so
        // the card's active list refreshes cleanly.
        db.prepare(
          `UPDATE recall_bot
              SET status = 'done',
                  left_at = COALESCE(left_at, ?)
            WHERE id = ? AND status NOT IN ('done','fail')`,
        ).run(Date.now(), botId);
        sendJson(res, 200, {
          ok: true,
          bot_id: botId,
          status: "done",
          note: "Recall reported 404; local row marked done",
        });
        return;
      }
      if (!resp.ok) {
        let detail = "";
        try {
          detail = (await resp.text()).slice(0, 200);
        } catch {
          /* swallow */
        }
        throw new ApiError(
          502,
          "RECALL_REJECTED",
          `Recall returned HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`,
        );
      }
      const now = Date.now();
      db.prepare(
        `UPDATE recall_bot
            SET status = CASE WHEN status IN ('done','fail') THEN status ELSE 'leaving' END,
                left_at = COALESCE(left_at, ?)
          WHERE id = ?`,
      ).run(now, botId);
      sendJson(res, 200, { ok: true, bot_id: botId, status: "leaving" });
    },
  );

  // POST /api/v1/channels/recall/webhook-test
  //
  // Fire a synthetic webhook into our own /api/v1/webhooks/recall endpoint
  // (signed with the locally-configured RECALL_WEBHOOK_SECRET) so the card
  // can prove the inbound delivery path works end-to-end. Same posture as
  // channels_paperclip's /test — POST to ourselves on 127.0.0.1:AAS_PORT.
  addRoute(
    "POST",
    "/api/v1/channels/recall/webhook-test",
    async ({ res }) => {
      const secret = process.env.RECALL_WEBHOOK_SECRET ?? "";
      if (!secret) {
        throw new ApiError(
          503,
          "NOT_CONFIGURED",
          "RECALL_WEBHOOK_SECRET is not set on this tenant",
        );
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const eventId = `evt-test-${nowSec}`;
      const synthetic = {
        event: "bot.synthetic_test",
        data: {
          bot_id: `bot-test-${nowSec}`,
          timestamp: new Date().toISOString(),
        },
      };
      const rawBody = Buffer.from(JSON.stringify(synthetic), "utf-8");
      const secretBytes = secret.startsWith("whsec_")
        ? Buffer.from(secret.slice("whsec_".length), "base64")
        : Buffer.from(secret, "utf-8");
      const signed = Buffer.concat([
        Buffer.from(`${eventId}.${nowSec}.`, "utf-8"),
        rawBody,
      ]);
      const v1 = crypto
        .createHmac("sha256", secretBytes)
        .update(signed)
        .digest("base64");

      const host = process.env.AAS_HOST ?? "127.0.0.1";
      const port = process.env.AAS_PORT ?? "3100";
      const url = `http://${host}:${port}/api/v1/webhooks/recall`;
      const t0 = Date.now();
      let upstream: Response;
      try {
        upstream = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "svix-id": eventId,
            "svix-timestamp": String(nowSec),
            "svix-signature": `v1,${v1}`,
          },
          body: rawBody,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const latencyMs = Date.now() - t0;
      let bodyText = "";
      try {
        bodyText = await upstream.text();
      } catch {
        bodyText = "";
      }
      sendJson(res, 200, {
        ok: upstream.ok,
        status: upstream.status,
        latency_ms: latencyMs,
        sample_response: bodyText.slice(0, 200),
      });
    },
  );
}

// ── Inbound webhook (separate registrar so server.ts can mark its path
//    isPublic + isRawBody alongside Composio's). ────────────────────────────

export function registerRecallWebhookRoute(): void {
  // POST /api/v1/webhooks/recall — Svix-signed inbound.
  //
  // The route receives the raw bytes (server.ts whitelists this path on
  // isRawBody so we get Buffer in `body`, not parsed JSON). We verify the
  // svix-* headers against RECALL_WEBHOOK_SECRET, parse the body as JSON
  // ONLY after the HMAC check, and persist the event into recall_event +
  // update the parent recall_bot row in one transaction.
  //
  // 200 vs 4xx policy (mirrors composioWebhook):
  //   * missing/bad signature                → 401 (Recall retries — fine)
  //   * unrecognised payload shape           → 200 + WARN (don't trigger storm)
  //   * unknown bot_id                       → 200 (we may have GC'd the row)
  //   * persistence failed                   → 502 (Recall retries)
  addRoute("POST", "/api/v1/webhooks/recall", async ({ req, res, body }) => {
    const secret = process.env.RECALL_WEBHOOK_SECRET ?? "";
    if (!secret) {
      // Loud failure — without the secret we cannot verify, and silently
      // accepting would let anyone on the public internet shove rows into
      // recall_event.
      throw new ApiError(
        503,
        "NOT_CONFIGURED",
        "RECALL_WEBHOOK_SECRET is not set on this tenant",
      );
    }
    // server.ts marks this path as isRawBody → body is a Buffer.
    const rawBody =
      body instanceof Buffer
        ? body
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {}), "utf-8");

    const verify = verifySvixSignature(rawBody, req.headers, secret);
    if (!verify.ok) {
      throw new ApiError(401, "AUTH_FAILED", verify.reason);
    }
    // Parse JSON after the HMAC check passes.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      // Recall sent a body shape we can't parse; 200 + WARN so the
      // delivery isn't retried in a storm. We can never persist this.
      console.warn(
        "[recall-webhook] verified but un-parseable JSON body",
        rawBody.toString("utf-8").slice(0, 200),
      );
      sendJson(res, 200, { ok: true, noop: "unparseable JSON body" });
      return;
    }
    try {
      const db = getStateDb();
      const result = persistWebhookEvent(db, payload, Date.now());
      sendJson(res, 200, {
        ok: true,
        event_type: result.event_type,
        bot_id: result.bot_id,
        new_status: result.new_status,
      });
    } catch (err) {
      console.error(
        "[recall-webhook] persistence failed:",
        err instanceof Error ? err.message : String(err),
      );
      throw new ApiError(
        502,
        "PERSIST_FAILED",
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}
