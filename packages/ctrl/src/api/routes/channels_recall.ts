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
//   POST /api/v1/channels/recall/api-key                  — persist a validated key (PR3a)
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
// API-key persistence: PR3a (this commit) adds
// POST /api/v1/channels/recall/api-key as the operator-only setter that
// round-trips the key against Recall, then writes it to BOTH stores:
//
//   1. Vaultwarden (canonical) — via the existing vault-cli sidecar, as
//      a Login item named "Recall API Key" with `region` in notes. This
//      is the durable source of truth; vault-init re-reads it into the
//      host .env on tenant boot.
//   2. /opt/alfred/.env (immediate) — atomic write via tempfile + rename
//      using credentials.ts's patchEnv() helper. Skips the wait for the
//      next vault-init cycle so the new key is hot the moment ctrl-api
//      restarts.
//
// Then the route triggers `docker compose restart ctrl-api alfred-learn`
// in the background so the new key takes effect immediately. Mirrors
// the Telegram channel persistence pattern (telegram.ts:548), with the
// /opt/alfred/.env write borrowed from the OpenAI key flow
// (credentials.ts:patchEnv) — except the .env write here is atomic (tmp
// + rename) per Sir's PR brief.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, ApiError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { dockerComposeCmd, COMPOSE_DIR } from "../helpers.js";
import { requireOperatorBearer } from "../auth.js";
import type { DatabaseSync } from "node:sqlite";
// === Recall PR5: in-meeting voice ===
// PR5 ships the active half of Recall — bots that SPEAK into the meeting
// in response to the wake word and via the operator's manual CTA. The
// realtime subscriber (recall_realtime.ts) owns the WS to Recall's
// per-bot transcript stream + the dispatch to voice-bridge. Persona
// constraint enforced in voice-bridge/recall-meeting-context.ts: the
// bot speaks AS ALFRED, never as the principal.
import {
  subscribeBotRealtime,
  stopBotRealtime,
  subscribeTranscriptStream,
  speakIntoMeeting,
  renderTtsToBase64,
  persistTranscriptEvent,
  writeSseFrame,
  _recallRealtimeInternals,
  type TranscriptStreamFrame,
} from "./recall_realtime.js";
// === end Recall PR5 ===

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
  // Expose key_first6 + api_key_set so the /channels card can render
  // the rotation row ("first 6 chars …") without ever round-tripping
  // the full value. PR3a adds this; the field was previously absent.
  const apiKey = process.env.RECALL_API_KEY?.trim() ?? "";
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
    api_key_set: apiKey.length > 0,
    api_key_first6: apiKey.length > 0 ? apiKey.slice(0, 6) : null,
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

// ── api-key persistence helpers (PR3a) ────────────────────────────────────
//
// The persist path has four steps:
//   1. round-trip-validate via validateRecallKey() above (NEVER trust a
//      paste);
//   2. upsert a "Recall API Key" Login item in Vaultwarden through the
//      vault-cli sidecar (canonical store);
//   3. atomically merge RECALL_API_KEY + RECALL_REGION into the compose
//      .env at ${COMPOSE_DIR}/.env via tempfile + rename (so a crash
//      mid-write leaves the old .env untouched);
//   4. restart ctrl-api and alfred-learn via `docker compose restart` so
//      the new env takes effect immediately. Background; do not block
//      the response.
//
// Idempotence: if the *same* key value is already in the .env on disk
// AND already on file in Vaultwarden, the route returns
// `{ok, idempotent: true}` without writing or restarting anything.
//
// Concurrency: a process-local lock serialises the persistence path so
// two concurrent calls cannot double-restart. A second concurrent
// caller waits for the first to finish, then re-checks idempotence.

const VAULT_CLI_URL = process.env.VAULT_CLI_URL || "http://vault-cli:8087";
const RECALL_VAULT_ITEM_NAME = "Recall API Key";
const RECALL_ENV_PATH = `${COMPOSE_DIR}/.env`;
const RECALL_RESTART_SERVICES = ["ctrl-api", "alfred-learn"] as const;
const RECALL_RESTART_ETA_SECONDS = 30;

// In-process serialiser. Awaited by every persistence call so two
// requests landing simultaneously cannot both validate-then-restart
// (the second would no-op via idempotence once it sees the first
// caller's write).
let _persistLock: Promise<void> = Promise.resolve();

async function withPersistLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _persistLock;
  let release!: () => void;
  _persistLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

// ── vault-cli sidecar helpers (mirrors telegram.ts:97-184) ───────────────

interface BwEnvelope {
  success?: boolean;
  data?: unknown;
  message?: string;
}

async function _bwFetch(
  p: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${VAULT_CLI_URL}${p}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

function _bwUnwrap(
  body: unknown,
): { ok: true; data: unknown } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "vault-cli returned non-JSON body" };
  }
  const env = body as BwEnvelope;
  if (env.success === false) {
    return { ok: false, message: env.message ?? "vault-cli error" };
  }
  if (env.success === true && "data" in env) return { ok: true, data: env.data };
  return { ok: true, data: body };
}

async function findRecallVaultItem(): Promise<
  { id: string; password: string | null; notes: string | null } | null
> {
  const r = await _bwFetch(
    `/list/object/items?search=${encodeURIComponent(RECALL_VAULT_ITEM_NAME)}`,
  );
  if (r.status >= 500) throw new Error(`vault-cli unreachable (HTTP ${r.status})`);
  const u = _bwUnwrap(r.body);
  if (!u.ok) throw new Error(u.message);
  const data = u.data as Record<string, unknown> | unknown[];
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>).data)
      ? ((data as Record<string, unknown>).data as unknown[])
      : [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const it = raw as Record<string, unknown>;
    if (typeof it.name !== "string") continue;
    if (it.name.toLowerCase() !== RECALL_VAULT_ITEM_NAME.toLowerCase()) continue;
    const login =
      typeof it.login === "object" && it.login !== null
        ? (it.login as Record<string, unknown>)
        : null;
    const password = login && typeof login.password === "string" ? login.password : null;
    const notes = typeof it.notes === "string" ? it.notes : null;
    return { id: typeof it.id === "string" ? it.id : "", password, notes };
  }
  return null;
}

/** Upsert the Recall API Key item. Notes carries the region so vault-init
 *  can re-derive RECALL_REGION on next boot without an extra item. */
async function upsertRecallVaultItem(key: string, region: string): Promise<void> {
  const existing = await findRecallVaultItem();
  const notes =
    `Recall.ai API key for the meeting-bot channel (#113). ` +
    `Region: ${region}. Source of truth — vault-init reads this back ` +
    `into RECALL_API_KEY and RECALL_REGION on tenant boot.`;
  if (existing && existing.id) {
    const cur = await _bwFetch(`/object/item/${existing.id}`);
    const curU = _bwUnwrap(cur.body);
    if (!curU.ok) throw new Error(curU.message);
    const existingItem = (curU.data as Record<string, unknown>).data ?? curU.data;
    const e = existingItem as Record<string, unknown>;
    const existingLogin =
      typeof e.login === "object" && e.login !== null
        ? ({ ...(e.login as Record<string, unknown>) } as Record<string, unknown>)
        : { username: null, password: null, uris: [] };
    existingLogin.password = key;
    const merged = {
      ...e,
      name: RECALL_VAULT_ITEM_NAME,
      notes,
      login: existingLogin,
    };
    const r = await _bwFetch(`/object/item/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(merged),
    });
    const u = _bwUnwrap(r.body);
    if (!u.ok) throw new Error(u.message);
    return;
  }
  const payload = {
    type: 1,
    name: RECALL_VAULT_ITEM_NAME,
    notes,
    folderId: null,
    favorite: false,
    reprompt: 0,
    login: {
      username: null,
      password: key,
      uris: [{ uri: "https://recall.ai/", match: null }],
    },
  };
  const r = await _bwFetch("/object/item", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const u = _bwUnwrap(r.body);
  if (!u.ok) throw new Error(u.message);
}

/** Read the current .env into a {key: value} map. Missing file → {}. */
function readEnvFile(envPath: string): Record<string, string> {
  let content = "";
  try {
    content = fs.readFileSync(envPath, "utf-8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

/** Surgically update RECALL_API_KEY + RECALL_REGION in the compose .env,
 *  preserving all comments / blank lines / ordering / unrelated keys.
 *  Writes atomically: tmp file in the same directory + rename. On
 *  success the .env.next file no longer exists; on a crashed write the
 *  old .env is untouched and the orphan tmp is cleaned up by the next
 *  successful write (we look for and unlink any prior tmp before
 *  starting). */
function atomicPatchEnv(
  envPath: string,
  updates: Record<string, string>,
): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(envPath, "utf-8").split("\n");
  } catch {
    lines = [];
  }
  const remaining = new Map(Object.entries(updates));
  const result = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return line;
    const eq = t.indexOf("=");
    if (eq < 0) return line;
    const k = t.slice(0, eq).trim();
    if (!remaining.has(k)) return line;
    const v = remaining.get(k)!;
    remaining.delete(k);
    return `${k}=${v}`;
  });
  for (const [k, v] of remaining) {
    result.push(`${k}=${v}`);
  }
  const content = result.join("\n");
  const final = content.endsWith("\n") ? content : content + "\n";

  // Atomic write — tmp file in the SAME directory (rename across
  // filesystems isn't atomic). Mode 0o600 so a stray reader can't shoulder
  // the secret between the rename and the next docker compose restart.
  const dir = path.dirname(envPath);
  const tmp = path.join(dir, ".env.next");
  // Clean up any orphan from a previous crashed write.
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* swallow ENOENT */
  }
  fs.writeFileSync(tmp, final, { mode: 0o600 });
  fs.renameSync(tmp, envPath);
}

/** Fire-and-forget restart of ctrl-api + alfred-learn. We do NOT await:
 *  restarting ctrl-api will tear down the very HTTP connection we're
 *  serving the response on, so blocking the response on the restart
 *  guarantees the caller never sees a 200. Background it.
 *
 *  Best-effort logging. The /status route can read the live key from
 *  process.env to confirm the restart landed. */
function restartForRecallKey(): void {
  // Sequential so we don't contend with health checks. alfred-learn
  // first (no callers depend on it staying up), then ctrl-api (this
  // terminates our own connection — by which point the response is
  // already written).
  (async () => {
    for (const svc of RECALL_RESTART_SERVICES) {
      try {
        await dockerComposeCmd(["restart", svc]);
      } catch (err) {
        console.error(`[recall/api-key] restart of ${svc} failed:`, err);
      }
    }
  })();
}

/** Mask an API key down to its first 6 chars + "…". Used in log lines
 *  and the response envelope. We never echo the full value. */
function keyFirst6(key: string): string {
  return key.slice(0, 6);
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

// === Recall PR5: in-meeting voice ===
/** Extract the per-bot Recall realtime WS URL from a webhook payload.
 *  Recall surfaces the URL on a small handful of event shapes (create
 *  ack + `bot.in_meeting` follow-on); we tolerate three known nesting
 *  shapes plus a flat top-level for forward-compat. Returns null when
 *  no URL is present — caller leaves the existing realtime_url alone. */
export function extractRealtimeUrl(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.realtime_url === "string") return p.realtime_url;
  if (typeof p.recall_url === "string") return p.recall_url;
  const data = p.data;
  if (typeof data === "object" && data !== null) {
    const d = data as Record<string, unknown>;
    if (typeof d.realtime_url === "string") return d.realtime_url;
    if (typeof d.recall_url === "string") return d.recall_url;
    const bot = d.bot;
    if (typeof bot === "object" && bot !== null) {
      const bo = bot as Record<string, unknown>;
      if (typeof bo.realtime_url === "string") return bo.realtime_url;
      const rt = bo.realtime_endpoint;
      if (typeof rt === "object" && rt !== null) {
        const e = rt as Record<string, unknown>;
        if (typeof e.url === "string") return e.url;
      }
    }
  }
  return null;
}
// === end Recall PR5 ===

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
  // PR3a — persistence helpers, exported for the corresponding test.
  atomicPatchEnv,
  readEnvFile,
  findRecallVaultItem,
  upsertRecallVaultItem,
  withPersistLock,
  keyFirst6,
  // === Recall PR5: in-meeting voice ===
  extractRealtimeUrl,
  // Re-exposed so tests don't have to import recall_realtime.js separately.
  realtime: _recallRealtimeInternals,
  // === end Recall PR5 ===
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

  // POST /api/v1/channels/recall/api-key
  //
  // Operator-only setter (#113 PR3a). The /channels Recall card calls
  // this AFTER /validate-key returns {ok:true}, with the same key. We:
  //   1. round-trip-validate AGAIN against Recall (never trust a
  //      "validate already happened" claim from a caller);
  //   2. upsert "Recall API Key" in Vaultwarden via vault-cli;
  //   3. atomically merge RECALL_API_KEY + RECALL_REGION into
  //      ${COMPOSE_DIR}/.env via tempfile + rename;
  //   4. background-restart ctrl-api + alfred-learn so the new env is
  //      picked up immediately. (alfred-learn calls recall.ai through
  //      ctrl-api, but RECALL_API_KEY can also leak into its own env in
  //      future workflows, hence the explicit restart.)
  //
  // The response envelope NEVER carries the key. `key_first6` is the
  // operator-visible fingerprint; everything else is a description of
  // what was written. 502s during validation or vault write short-circuit
  // BEFORE any .env mutation so a half-applied write is impossible.
  //
  // Idempotence: if the same key + region are already in the .env AND
  // the vault item already holds the same password, we return
  // `{ok:true, idempotent:true}` without restart. A re-paste of the
  // same key from the card is therefore free.
  //
  // Concurrency: a process-local lock guarantees two parallel calls
  // serialise. The second caller observes the first's write and
  // idempotence-noops; no double restart.
  addRoute(
    "POST",
    "/api/v1/channels/recall/api-key",
    async ({ req, res, body }) => {
      // Operator-only — voice-bridge / channel-token bearers get 403.
      requireOperatorBearer(req);

      const b = (body ?? {}) as { api_key?: unknown; region?: unknown };
      if (typeof b.api_key !== "string" || b.api_key.trim().length === 0) {
        throw new ValidationError("api_key (non-empty string) is required");
      }
      const key = b.api_key.trim();

      // Region defaults to the configured value (the singleton row's
      // region) when missing. Validated against the same allowlist as
      // validate-key + PATCH /config.
      let region: string;
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
          region = "us-east-1";
        }
      }

      const first6 = keyFirst6(key);

      // Serialise the whole persist+restart sequence so a second
      // concurrent caller can't double-restart.
      const result = await withPersistLock(async () => {
        // ── 1. Round-trip-validate against Recall ─────────────────────
        const outcome = await validateRecallKey(key, region);
        if (!outcome.ok) {
          // Differentiate Recall's auth failure from a network blip. A
          // 401 from Recall lands as `outcome.reason = "Recall rejected
          // the API key"` — surface verbatim so the card renders Recall's
          // own language. We map auth failures to 401 and everything
          // else (timeouts / 502s / DNS / etc.) to 502. NEVER persist.
          const reason = outcome.reason ?? "Recall rejected the API key";
          const isAuth = /reject|invalid/i.test(reason);
          throw new ApiError(
            isAuth ? 401 : 502,
            isAuth ? "RECALL_AUTH_FAILED" : "RECALL_UNREACHABLE",
            reason,
          );
        }

        // ── 2. Check idempotence — same key + region already on file? ─
        const envOnDisk = readEnvFile(RECALL_ENV_PATH);
        const sameEnvKey = envOnDisk.RECALL_API_KEY === key;
        const sameEnvRegion = envOnDisk.RECALL_REGION === region;
        let sameVault = false;
        try {
          const existing = await findRecallVaultItem();
          sameVault = Boolean(
            existing && existing.password === key,
          );
        } catch (err) {
          // Vault read failure on the idempotence-check path is non-fatal
          // — we just fall through to the write path, which has its own
          // error handling.
          console.warn(
            `[recall/api-key] vault idempotence-check failed (key ${first6}…): ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        if (sameEnvKey && sameEnvRegion && sameVault) {
          return {
            envelope: {
              ok: true,
              idempotent: true,
              region,
              key_first6: first6,
              persisted_to: [] as string[],
              restarted: [] as string[],
              eta_seconds: 0,
            },
            shouldRestart: false,
          };
        }

        // ── 3. Vaultwarden upsert (canonical) ────────────────────────
        try {
          await upsertRecallVaultItem(key, region);
        } catch (err) {
          // Hard fail — vault is the canonical store. We have NOT
          // written to .env yet, so the system is still consistent.
          throw new ApiError(
            502,
            "VAULT_WRITE_FAILED",
            err instanceof Error ? err.message : String(err),
          );
        }

        // ── 4. Atomic .env write (immediate) ─────────────────────────
        try {
          atomicPatchEnv(RECALL_ENV_PATH, {
            RECALL_API_KEY: key,
            RECALL_REGION: region,
          });
        } catch (err) {
          throw new ApiError(
            500,
            "ENV_WRITE_FAILED",
            err instanceof Error ? err.message : String(err),
          );
        }

        // Update our own process.env so subsequent reads inside this
        // ctrl-api invocation (until the restart lands) see the new key.
        process.env.RECALL_API_KEY = key;
        process.env.RECALL_REGION = region;

        // Log with the prefix only — never the full value.
        console.log(
          `[recall/api-key] persisted key ${first6}… region=${region} ` +
            `(vaultwarden + .env). Restarting ${RECALL_RESTART_SERVICES.join(", ")}.`,
        );

        return {
          envelope: {
            ok: true,
            region,
            key_first6: first6,
            persisted_to: ["vaultwarden", ".env"],
            restarted: [...RECALL_RESTART_SERVICES],
            eta_seconds: RECALL_RESTART_ETA_SECONDS,
          },
          shouldRestart: true,
        };
      });

      // Send the response BEFORE kicking the restart — restarting
      // ctrl-api tears down this socket.
      sendJson(res, 200, result.envelope);
      if (result.shouldRestart) {
        restartForRecallKey();
      }
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

  // === Recall PR5: in-meeting voice ===
  // The active half of Recall: bots can SPEAK into the meeting in
  // response to the wake word + via the operator's manual CTA. The
  // realtime subscriber that drives the wake-word path lives in
  // recall_realtime.ts; these routes give the dashboard + MCP the verbs
  // to mute, unmute, speak, and stream the live transcript.
  //
  // Persona constraint (Sir explicit, 2026-05-29 evening):
  // The bot in the meeting speaks AS ALFRED — the RP butler persona
  // assembled in voice-bridge/src/recall-meeting-context.ts —
  // and NEVER impersonates the principal. The /respond route below
  // renders the operator's text through OpenAI TTS using config-
  // dot-openaiVoice (Alfred's voice, the same one the phone path uses).

  // POST /api/v1/channels/recall/bots/:bot_id/respond
  //
  // Manual TTS — accepts `{text, voice?}` body, renders the text through
  // OpenAI TTS, then uploads the audio to Recall's output_audio
  // endpoint. The text is persisted as a `response` transcript event so
  // it shows up in the SSE stream + the post-meeting transcript.
  addRoute(
    "POST",
    "/api/v1/channels/recall/bots/:bot_id/respond",
    async ({ res, body, params }) => {
      const botId = params.bot_id;
      if (!botId || botId.length > 200) {
        throw new ValidationError("bot_id must be a non-empty string ≤200 chars");
      }
      const b = (body ?? {}) as { text?: unknown; voice?: unknown };
      if (typeof b.text !== "string" || b.text.trim().length === 0) {
        throw new ValidationError("text (non-empty string) is required");
      }
      const text = b.text.trim().slice(0, 1000);
      const voice =
        typeof b.voice === "string" && b.voice.trim().length > 0
          ? b.voice.trim().slice(0, 64)
          : undefined;
      const db = getStateDb();
      const row = db
        .prepare(`SELECT id, status, muted FROM recall_bot WHERE id = ?`)
        .get(botId) as { id: string; status: string; muted: number } | undefined;
      if (!row) {
        throw new ApiError(404, "NOT_FOUND", `bot ${botId} not found`);
      }
      if (row.status === "done" || row.status === "fail") {
        throw new ApiError(
          409,
          "BOT_TERMINAL",
          `bot ${botId} is no longer in the meeting`,
        );
      }
      let rendered: { audio_base64: string; sample_rate: number; format: string };
      try {
        rendered = await renderTtsToBase64(text, { voice });
      } catch (err) {
        throw new ApiError(
          502,
          "TTS_FAILED",
          err instanceof Error ? err.message : String(err),
        );
      }
      try {
        await speakIntoMeeting(botId, rendered.audio_base64, {
          kind: rendered.format === "wav" ? "audio/wav" : "audio/pcm",
          sampleRate: rendered.sample_rate,
        });
      } catch (err) {
        throw new ApiError(
          502,
          "RECALL_UPLOAD_FAILED",
          err instanceof Error ? err.message : String(err),
        );
      }
      // speaker label is "Alfred" — never the principal — to match the
      // persona constraint (the voice in the meeting IS Alfred, so the
      // transcript ledger attributes responses to Alfred).
      persistTranscriptEvent(db, botId, "response", text, { speaker: "Alfred" });
      sendJson(res, 200, {
        ok: true,
        bot_id: botId,
        text,
        bytes: Buffer.from(rendered.audio_base64, "base64").length,
      });
    },
  );

  // POST /api/v1/channels/recall/bots/:bot_id/{mute,unmute}
  //
  // Toggle the in-meeting voice OFF/ON. The wake-word detector still
  // runs while muted (we keep the audit trail) but Alfred won't speak.
  // The detector emits a `wake_word_hit` SSE event regardless, so the
  // operator can see whether the meeting is summoning Alfred even
  // while muted.
  for (const verb of ["mute", "unmute"] as const) {
    const muteFlag = verb === "mute" ? 1 : 0;
    addRoute(
      "POST",
      `/api/v1/channels/recall/bots/:bot_id/${verb}`,
      async ({ res, params }) => {
        const botId = params.bot_id;
        if (!botId || botId.length > 200) {
          throw new ValidationError(
            "bot_id must be a non-empty string ≤200 chars",
          );
        }
        const db = getStateDb();
        const row = db
          .prepare(`SELECT id, status FROM recall_bot WHERE id = ?`)
          .get(botId) as { id: string; status: string } | undefined;
        if (!row) {
          throw new ApiError(404, "NOT_FOUND", `bot ${botId} not found`);
        }
        db.prepare(`UPDATE recall_bot SET muted = ? WHERE id = ?`).run(
          muteFlag,
          botId,
        );
        sendJson(res, 200, {
          ok: true,
          bot_id: botId,
          muted: muteFlag === 1,
        });
      },
    );
  }

  // GET /api/v1/channels/recall/bots/:bot_id/transcript-stream
  //
  // Server-Sent Events: live transcript fragments + wake-word hits +
  // Alfred's responses for ONE bot. The dashboard consumes this via
  // EventSource; one connection per browser tab is fine.
  //
  // On open we replay the last 20 persisted fragments so a refreshed
  // tab shows context, then switch to live emission.
  addRoute(
    "GET",
    "/api/v1/channels/recall/bots/:bot_id/transcript-stream",
    async ({ res, params }) => {
      const botId = params.bot_id;
      if (!botId || botId.length > 200) {
        throw new ValidationError(
          "bot_id must be a non-empty string ≤200 chars",
        );
      }
      const db = getStateDb();
      const row = db
        .prepare(`SELECT id FROM recall_bot WHERE id = ?`)
        .get(botId) as { id: string } | undefined;
      if (!row) {
        throw new ApiError(404, "NOT_FOUND", `bot ${botId} not found`);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const recent = db
        .prepare(
          `SELECT kind, speaker, text, ts_ms, meeting_ms
             FROM recall_transcript_event
            WHERE bot_id = ?
            ORDER BY id DESC
            LIMIT 20`,
        )
        .all(botId) as Array<{
        kind: string;
        speaker: string | null;
        text: string;
        ts_ms: number;
        meeting_ms: number | null;
      }>;
      for (const r of recent.reverse()) {
        const k = r.kind as TranscriptStreamFrame["kind"];
        writeSseFrame(res as unknown as { write: (chunk: string) => void }, {
          kind: k,
          speaker: r.speaker,
          text: r.text,
          ts_ms: r.ts_ms,
          meeting_ms: r.meeting_ms,
        });
      }
      // Heartbeat — every 25s send a `:keepalive` comment to keep
      // intermediaries from killing the connection. `.unref()` so the
      // timer doesn't keep the node event loop alive in tests (or in
      // process shutdown).
      const hb = setInterval(() => {
        try {
          res.write(`: keepalive ${Date.now()}\n\n`);
        } catch {
          /* swallow */
        }
      }, 25_000);
      if (typeof (hb as { unref?: () => void }).unref === "function") {
        (hb as { unref: () => void }).unref();
      }
      const unsubscribe = subscribeTranscriptStream(botId, (frame) => {
        try {
          writeSseFrame(res as unknown as { write: (chunk: string) => void }, frame);
        } catch {
          /* swallow */
        }
      });
      const close = () => {
        clearInterval(hb);
        unsubscribe();
        try {
          res.end();
        } catch {
          /* swallow */
        }
      };
      (res as unknown as { on: (e: string, fn: () => void) => void }).on(
        "close",
        close,
      );
    },
  );

  // GET /api/v1/channels/recall/bots/:bot_id/transcript
  //
  // Polling companion to the SSE transcript-stream — returns the last
  // 100 fragments as a JSON list. Sized for the SaaS proxy + the live-
  // bots UI's 2-second poll cadence; SSE remains the lower-latency
  // path for clients that can hit ctrl-api directly.
  addRoute(
    "GET",
    "/api/v1/channels/recall/bots/:bot_id/transcript",
    async ({ res, params, query }) => {
      const botId = params.bot_id;
      if (!botId || botId.length > 200) {
        throw new ValidationError(
          "bot_id must be a non-empty string ≤200 chars",
        );
      }
      const sinceRaw = query.get("since_id");
      const sinceId = sinceRaw ? Number.parseInt(sinceRaw, 10) : 0;
      const db = getStateDb();
      const rows = db
        .prepare(
          `SELECT id, kind, speaker, text, ts_ms, meeting_ms
             FROM recall_transcript_event
            WHERE bot_id = ? AND id > ?
            ORDER BY id ASC
            LIMIT 100`,
        )
        .all(botId, Number.isFinite(sinceId) ? sinceId : 0) as Array<{
        id: number;
        kind: string;
        speaker: string | null;
        text: string;
        ts_ms: number;
        meeting_ms: number | null;
      }>;
      const botRow = db
        .prepare(
          `SELECT wake_word_triggers, muted FROM recall_bot WHERE id = ?`,
        )
        .get(botId) as
        | { wake_word_triggers: number; muted: number }
        | undefined;
      sendJson(res, 200, {
        bot_id: botId,
        wake_word_triggers: botRow?.wake_word_triggers ?? 0,
        muted: botRow?.muted === 1,
        events: rows,
      });
    },
  );

  // POST /api/v1/voice-bridge/recall-turn
  //
  // Internal endpoint: voice-bridge can call this synchronously to push
  // a wake-word turn directly into ctrl-api. This is the inverse of the
  // realtime path — used when the bridge is the driver (e.g. an MCP
  // tool, a scheduled "speak into Sir's standup" cron) and ctrl-api is
  // the speaker. The realtime subscriber uses the bridge as the
  // synchronous reply path; THIS route lets the bridge push a turn
  // independently. Auth: VOICE_BRIDGE_ALLOWLIST in auth.ts gates the
  // scoped voice-bridge bearer to this route.
  addRoute(
    "POST",
    "/api/v1/voice-bridge/recall-turn",
    async ({ res, body }) => {
      const b = (body ?? {}) as {
        bot_id?: unknown;
        text?: unknown;
        voice?: unknown;
      };
      if (typeof b.bot_id !== "string" || b.bot_id.trim().length === 0) {
        throw new ValidationError("bot_id (non-empty string) is required");
      }
      if (typeof b.text !== "string" || b.text.trim().length === 0) {
        throw new ValidationError("text (non-empty string) is required");
      }
      const botId = b.bot_id.trim();
      const text = b.text.trim().slice(0, 1000);
      const voice =
        typeof b.voice === "string" && b.voice.trim().length > 0
          ? b.voice.trim().slice(0, 64)
          : undefined;
      const db = getStateDb();
      const row = db
        .prepare(`SELECT id, status FROM recall_bot WHERE id = ?`)
        .get(botId) as { id: string; status: string } | undefined;
      if (!row) throw new ApiError(404, "NOT_FOUND", `bot ${botId} not found`);
      if (row.status === "done" || row.status === "fail") {
        throw new ApiError(
          409,
          "BOT_TERMINAL",
          `bot ${botId} is no longer in the meeting`,
        );
      }
      const rendered = await renderTtsToBase64(text, { voice });
      await speakIntoMeeting(botId, rendered.audio_base64, {
        kind: rendered.format === "wav" ? "audio/wav" : "audio/pcm",
        sampleRate: rendered.sample_rate,
      });
      persistTranscriptEvent(db, botId, "response", text, { speaker: "Alfred" });
      sendJson(res, 200, { ok: true, bot_id: botId, text });
    },
  );
  // === end Recall PR5 ===
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
      // === Recall PR5: in-meeting voice ===
      // On `in_meeting` we subscribe to the per-bot real-time WS; on a
      // terminal status we drop the WS + any SSE listeners. The
      // realtime_url column is populated either by the create-bot
      // response or by a follow-on webhook event that carries
      // `realtime_url` — we surface it here best-effort. Subscribe is
      // fire-and-forget; the subscriber owns its own reconnect loop.
      const realtimeUrl = extractRealtimeUrl(payload);
      if (realtimeUrl && result.bot_id) {
        db.prepare(
          `UPDATE recall_bot SET realtime_url = COALESCE(realtime_url, ?) WHERE id = ?`,
        ).run(realtimeUrl, result.bot_id);
      }
      if (result.bot_id && result.new_status === "in_meeting") {
        void subscribeBotRealtime(result.bot_id);
      } else if (
        result.bot_id &&
        (result.new_status === "done" ||
          result.new_status === "fail" ||
          result.new_status === "leaving")
      ) {
        stopBotRealtime(result.bot_id);
      }
      // === end Recall PR5 ===
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
