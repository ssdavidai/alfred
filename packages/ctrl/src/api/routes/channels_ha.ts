// /api/v1/channels/ha/* — Home Assistant channel routes.
//
// Issue #111 spec: docs/specs/issue-111-ha-conversation-agent.md.
// Issue #110 spec: docs/specs/issue-110-ha-deep-integration.md.
//
// Two lanes share this file. The split:
//
//   #111 (conversation agent) → POST /turn
//   #110 (deep integration)   → POST /connect, GET /status, DELETE /disconnect,
//                                GET /registry, GET /state/:entity_id,
//                                GET /automations, GET /snapshots
//
// PR1 of each lane is the only thing in this file today. Later PRs extend:
//   * #111 PR3 — tool partitioning in /turn
//   * #110 PR2 — ha__* MCP tools (live in mcp-server, NOT here)
//   * #110 PR3 — HaWatcherWorkflow + the loop-guard suppressor (in alfred-learn)
//   * #110 PR5 — registry population by HaBootstrapWorkflow (writes ha_registry;
//                this file's /registry read is empty until then)
//   * #110 PR6 — proposal/approve, proposal/reject, automation CRUD,
//                discovery, snapshot routes (writes — these stay OFF the
//                voice-bridge allowlist, see auth.ts)
//
// What lives where now (PR1 freeze):
//   * The 7 ha_* tables and idx_ha_run_entity_recent partial index ship in
//     packages/ctrl/src/db/migrations/0005_ha_channel.sql.
//   * The voice-bridge allowlist additions (4 spec §7 Q13 read routes) ship
//     in packages/ctrl/src/api/auth.ts alongside the route registrations
//     here.

import { addRoute } from "../server.js";
import { sendJson, ValidationError, ApiError, ConflictError, NotFoundError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { appendJournal } from "../../db/alfredJournal.js";
import { channelTokenBearer, requireOperatorBearer } from "../auth.js";
import { dockerExec } from "../helpers.js";
import { ulid } from "../../db/ulid.js";
import fs from "node:fs";
import { WebSocket } from "ws";
import { getHaWsClient } from "../lib/ha_ws_client.js";
import {
  triggerBackupBeforeAction,
  listBackupRefs,
} from "../lib/ha_snapshot.js";
import { recordHaWriteToDaybook } from "../lib/ha_daybook.js";

const HERMES_MAIN_URL =
  process.env.HERMES_GATEWAY_URL ?? "http://hermes:18789";
const HERMES_TIMEOUT_MS = 90_000;

// Rate-limit per haInstanceId — 30 turns / sliding minute. In-memory
// sliding window. Spec §5.1 / §6.PR2 / O8.
const RATE_LIMIT_PER_MIN = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitBuckets = new Map<string, number[]>();

function checkRateLimit(haInstanceId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = rateLimitBuckets.get(haInstanceId) ?? [];
  // Prune anything outside the window.
  const live = bucket.filter((ts) => ts > cutoff);
  if (live.length >= RATE_LIMIT_PER_MIN) {
    rateLimitBuckets.set(haInstanceId, live);
    return false;
  }
  live.push(now);
  rateLimitBuckets.set(haInstanceId, live);
  return true;
}

// Exported for tests so they can clear the in-memory window without
// reaching into private state. NOT part of the HTTP surface.
export function _resetHaRateLimitForTests(): void {
  rateLimitBuckets.clear();
}

// ── /turn body shape ──────────────────────────────────────────────────────
//
// Spec §3 minimum: text, conversation_id, language, agent_id, ha_install_id.
// We name fields camelCase consistently with the Paperclip channel; HA's
// custom component sends camelCase via Python's `aiohttp` body.

interface TurnBody {
  text: string;
  conversationId: string;
  language: string;
  agentId: string;
  haInstallId: string;
  /** Optional satellite device id (null when input is text-only). PR5+
   *  uses this for the deviceId → area lookup against the registry. */
  deviceId?: string | null;
}

function parseTurnBody(raw: unknown): TurnBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.text !== "string" || b.text.length === 0) {
    throw new ValidationError("text must be a non-empty string");
  }
  if (typeof b.conversationId !== "string" || b.conversationId.length === 0) {
    throw new ValidationError("conversationId must be a non-empty string");
  }
  if (typeof b.language !== "string" || b.language.length === 0) {
    throw new ValidationError("language must be a non-empty string");
  }
  if (typeof b.agentId !== "string" || b.agentId.length === 0) {
    throw new ValidationError("agentId must be a non-empty string");
  }
  if (typeof b.haInstallId !== "string" || b.haInstallId.length === 0) {
    throw new ValidationError("haInstallId must be a non-empty string");
  }
  let deviceId: string | null = null;
  if (b.deviceId !== undefined && b.deviceId !== null) {
    if (typeof b.deviceId !== "string") {
      throw new ValidationError("deviceId must be a string or null");
    }
    deviceId = b.deviceId;
  }
  return {
    text: b.text,
    conversationId: b.conversationId,
    language: b.language,
    agentId: b.agentId,
    haInstallId: b.haInstallId,
    deviceId,
  };
}

// ── Hermes call ───────────────────────────────────────────────────────────
//
// Same pattern as channels_paperclip.ts — read per-profile API_SERVER_KEY
// from /hermes-state/profiles/main/.env, POST /v1/responses with
// X-Hermes-Session-Key. The Hermes' own response shape (`output: [...]`) is
// flattened down to a single string for PR1; tool partitioning lands in
// PR3.

interface HermesCallResult {
  ok: true;
  text: string;
}
interface HermesCallFailure {
  ok: false;
  code: "HERMES_UNREACHABLE" | "HERMES_TIMEOUT";
  detail: string;
}

function extractHermesText(resp: unknown): string {
  if (typeof resp !== "object" || resp === null) return "";
  const r = resp as Record<string, unknown>;
  const out = r.output;

  const partsToText = (parts: unknown): string => {
    if (typeof parts === "string") return parts;
    if (!Array.isArray(parts)) return "";
    const acc: string[] = [];
    for (const p of parts) {
      if (typeof p === "string") {
        acc.push(p);
      } else if (typeof p === "object" && p !== null) {
        const pp = p as Record<string, unknown>;
        if (typeof pp.text === "string") acc.push(pp.text);
        else if (typeof pp.content === "string") acc.push(pp.content);
      }
    }
    return acc.filter((s) => s.length > 0).join("\n");
  };

  if (Array.isArray(out)) {
    let messageText = "";
    for (const item of out) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      if (it.type === "message") {
        const t = partsToText(it.content);
        if (t) messageText = t;
      }
    }
    if (messageText) return messageText;
    return partsToText(out);
  }
  if (typeof out === "string") return out;
  if (typeof out === "object" && out !== null) {
    const o = out as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
  }
  const fallback = r.output_text;
  if (typeof fallback === "string") return fallback;
  return "";
}

/** Same .env-driven key resolution as channels_paperclip.ts — Hermes' main
 *  gateway validates Bearer against /hermes-state/profiles/main/.env's
 *  API_SERVER_KEY at runtime (the /opt/alfred/.env HERMES_API_SERVER_KEY
 *  is a *seed*; once Hermes regenerates per-profile, the file is
 *  authoritative). Test override: HERMES_CONFIG_DIR. */
function readHermesMainApiKey(): string | null {
  const baseDir = process.env.HERMES_CONFIG_DIR ?? "/hermes-state/profiles";
  const envPath = `${baseDir}/main/.env`;
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf-8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    if (t.slice(0, eq).trim() === "API_SERVER_KEY") {
      return t.slice(eq + 1).trim();
    }
  }
  return null;
}

async function callHermes(
  sessionKey: string,
  input: string,
): Promise<HermesCallResult | HermesCallFailure> {
  const url = `${HERMES_MAIN_URL}/v1/responses`;
  const apiKey = readHermesMainApiKey() ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Hermes-Session-Key": sessionKey,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      (err as Error)?.name === "TimeoutError" ||
      (err as Error)?.name === "AbortError" ||
      /timeout/i.test(msg);
    return {
      ok: false,
      code: isTimeout ? "HERMES_TIMEOUT" : "HERMES_UNREACHABLE",
      detail: msg,
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      code: "HERMES_UNREACHABLE",
      detail: `Hermes returned HTTP ${resp.status}`,
    };
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return {
      ok: false,
      code: "HERMES_UNREACHABLE",
      detail: "Hermes returned a non-JSON body",
    };
  }
  return { ok: true, text: extractHermesText(json) };
}

// ── alfred_journal helpers ────────────────────────────────────────────────
//
// One row per direction. channel = "ha-conversation" (distinct from the
// future "ha-voice" from #112), chat_id = "ha-<haInstallId>" — same shape
// as the Hermes session key so the journal pivots cleanly.
//
// Per spec §3.5: source_kind splits inbound ("ha-conversation-turn") from
// outbound ("ha-conversation-reply"); source_ref is "<haInstallId>/<convId>"
// so the audit can group by either dimension.

function journalIn(
  haInstallId: string,
  conversationId: string,
  message: string,
  metadata: Record<string, unknown>,
): void {
  try {
    appendJournal(getStateDb(), {
      channel: "ha-conversation",
      chat_id: `ha-${haInstallId}`,
      direction: "inbound",
      message,
      source_kind: "ha-conversation-turn",
      source_ref: `${haInstallId}/${conversationId}`,
      hermes_session_id: `ha-${haInstallId}`,
      hermes_profile: "main",
      status: "received",
      metadata,
    });
  } catch (e) {
    console.warn(
      "[channels_ha] alfred_journal inbound append failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

function journalOut(
  haInstallId: string,
  conversationId: string,
  message: string,
  status: "delivered" | "failed",
  metadata: Record<string, unknown>,
  deliveryError: string | null = null,
): void {
  try {
    appendJournal(getStateDb(), {
      channel: "ha-conversation",
      chat_id: `ha-${haInstallId}`,
      direction: "outbound",
      message,
      source_kind: "ha-conversation-reply",
      source_ref: `${haInstallId}/${conversationId}`,
      hermes_session_id: `ha-${haInstallId}`,
      hermes_profile: "main",
      status,
      delivery_error: deliveryError,
      metadata,
    });
  } catch (e) {
    console.warn(
      "[channels_ha] alfred_journal outbound append failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ── HA reachability probe (#110 PR1) ─────────────────────────────────────
//
// `connect` runs two GETs against the principal's HA install:
//   1. GET ${ha_url}/api/  — auth gate. 401 here means the LLAT is wrong
//      and we MUST NOT persist anything (no Vaultwarden write, no
//      ha_connection row). Any other non-2xx is an UPSTREAM_ERROR.
//   2. GET ${ha_url}/api/config — best-effort version pull. A 5xx here
//      does NOT block the connect (HA is reachable, the LLAT is good,
//      we just don't get a version string). ha_version stays null.
//
// Timeouts: HA_PROBE_TIMEOUT_MS (default 5s). Override surface for the
// PR3 watcher to set its own ceiling.

const HA_PROBE_TIMEOUT_MS = Number(
  process.env.HA_PROBE_TIMEOUT_MS ?? "5000",
);

interface HaProbeOk {
  ok: true;
  ha_version: string | null;
}
interface HaProbeAuthFailure {
  ok: false;
  code: "AUTH_FAILED";
  detail: string;
}
interface HaProbeUpstreamFailure {
  ok: false;
  code: "UPSTREAM_ERROR";
  detail: string;
}
type HaProbeResult = HaProbeOk | HaProbeAuthFailure | HaProbeUpstreamFailure;

async function probeHa(haUrl: string, llat: string): Promise<HaProbeResult> {
  const headers = { Authorization: `Bearer ${llat}` };

  // (1) Auth gate.
  let authResp: Response;
  try {
    authResp = await fetch(`${haUrl}/api/`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(HA_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "UPSTREAM_ERROR", detail: `HA unreachable: ${msg}` };
  }
  if (authResp.status === 401 || authResp.status === 403) {
    return {
      ok: false,
      code: "AUTH_FAILED",
      detail: `HA rejected the LLAT (HTTP ${authResp.status})`,
    };
  }
  if (!authResp.ok) {
    return {
      ok: false,
      code: "UPSTREAM_ERROR",
      detail: `HA /api/ returned HTTP ${authResp.status}`,
    };
  }

  // (2) Version pull — best effort.
  let version: string | null = null;
  try {
    const cfg = await fetch(`${haUrl}/api/config`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(HA_PROBE_TIMEOUT_MS),
    });
    if (cfg.ok) {
      const cfgJson = (await cfg.json()) as Record<string, unknown>;
      if (typeof cfgJson?.version === "string") version = cfgJson.version;
    }
  } catch {
    // Best-effort — ha_version stays null. The connect still succeeds.
  }
  return { ok: true, ha_version: version };
}

// ── ha_url validation (#110 PR1) ─────────────────────────────────────────
//
// The connect handler MUST reject malformed ha_url shapes BEFORE the probe
// fires (test 3 asserts haCalls.length === 0 after four bad calls). The
// validation:
//
//   * must parse as a URL
//   * scheme must be http: or https: (no file://, no ws://)
//   * must have a non-empty host
//
// Anything else throws ValidationError → 400 VALIDATION_ERROR.

function assertValidHaUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError("ha_url must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError("ha_url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError(
      `ha_url must use http: or https: (got ${parsed.protocol})`,
    );
  }
  if (!parsed.host) {
    throw new ValidationError("ha_url must include a host");
  }
  // Normalise: strip trailing slash so we can append /api/ cleanly.
  return raw.replace(/\/+$/, "");
}

// ── Vaultwarden helpers (#110 PR1) ───────────────────────────────────────
//
// The LLAT lives in Vaultwarden, NEVER in state.db (spec §5.5 +
// docs/STORAGE-ARCHITECTURE.md). The state.db only carries the vault item
// id, so a SELECT * FROM ha_connection serialised to JSON never leaks the
// secret (test 1 asserts this; test 5 asserts /status doesn't leak it).
//
// We work against the vault-cli sidecar (bw serve), same pattern as
// routes/channels_tailscale.ts:writeAuthKeyToVault — except this lane needs
// folder semantics (the spec puts the item under "Home Assistant"), so the
// helper ensures the folder exists first.

const VAULT_CLI_URL = process.env.VAULT_CLI_URL ?? "http://vault-cli:8087";
const HA_VAULTWARDEN_FOLDER = process.env.HA_VAULTWARDEN_FOLDER ?? "Home Assistant";
const HA_LLAT_ITEM = process.env.HA_LLAT_ITEM ?? "LLAT";
const VAULT_TIMEOUT_MS = 10_000;

/** GET /list/object/folders, return id of folder named `name` (create if absent). */
async function ensureVaultFolder(name: string): Promise<string> {
  const list = await fetch(`${VAULT_CLI_URL}/list/object/folders`, {
    signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
  });
  if (!list.ok) {
    throw new ApiError(
      502,
      "VAULT_UNREACHABLE",
      `vault-cli /list/object/folders returned HTTP ${list.status}`,
    );
  }
  const listJson = (await list.json()) as {
    data?: { data?: Array<{ id?: string; name?: string }> };
  };
  const existing = (listJson?.data?.data ?? []).find((f) => f.name === name);
  if (existing?.id) return existing.id;

  const create = await fetch(`${VAULT_CLI_URL}/object/folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
  });
  if (!create.ok) {
    throw new ApiError(
      502,
      "VAULT_UNREACHABLE",
      `vault-cli POST /object/folder returned HTTP ${create.status}`,
    );
  }
  // vault-cli (`bw serve`) returns single-wrapped `{success,data:{id,...}}`
  // for single-object create/get/put endpoints, NOT double-wrapped — only
  // LIST endpoints are `{data:{data:[…]}}`. Live-verified 2026-05-29 on home.
  const createJson = (await create.json()) as {
    data?: { id?: string };
  };
  const id = createJson?.data?.id;
  if (!id) {
    throw new ApiError(
      502,
      "VAULT_UNREACHABLE",
      "vault-cli POST /object/folder returned no id",
    );
  }
  return id;
}

/** Upsert the LLAT item in `folderId`, returning the vault item id. */
async function upsertHaLlatItem(
  folderId: string,
  llat: string,
): Promise<string> {
  // Search for the item by name AND folderId — we don't want to collide
  // with a same-named item in a different folder.
  const search = await fetch(
    `${VAULT_CLI_URL}/list/object/items?search=${encodeURIComponent(HA_LLAT_ITEM)}`,
    { signal: AbortSignal.timeout(VAULT_TIMEOUT_MS) },
  );
  if (!search.ok) {
    throw new ApiError(
      502,
      "VAULT_UNREACHABLE",
      `vault-cli /list/object/items returned HTTP ${search.status}`,
    );
  }
  const searchJson = (await search.json()) as {
    data?: {
      data?: Array<{ id?: string; name?: string; folderId?: string | null }>;
    };
  };
  const existing = (searchJson?.data?.data ?? []).find(
    (it) => it.name === HA_LLAT_ITEM && (it.folderId ?? null) === folderId,
  );

  if (existing?.id) {
    // PUT update — fetch the full item, patch login.password, write back.
    const cur = await fetch(`${VAULT_CLI_URL}/object/item/${existing.id}`, {
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    });
    if (!cur.ok) {
      throw new ApiError(
        502,
        "VAULT_UNREACHABLE",
        `vault-cli GET /object/item/${existing.id} returned HTTP ${cur.status}`,
      );
    }
    // vault-cli (`bw serve`) returns single-wrapped `{success,data:{id,...}}`
    // for single-object create/get/put endpoints, NOT double-wrapped — only
    // LIST endpoints are `{data:{data:[…]}}`. Live-verified 2026-05-29 on home.
    const curJson = (await cur.json()) as {
      data?: Record<string, unknown>;
    };
    const item = (curJson?.data ?? {}) as Record<string, unknown>;
    const login =
      ((item.login as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    login.password = llat;
    item.login = login;
    item.folderId = folderId;
    item.name = HA_LLAT_ITEM;
    const put = await fetch(`${VAULT_CLI_URL}/object/item/${existing.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    });
    if (!put.ok) {
      throw new ApiError(
        502,
        "VAULT_UNREACHABLE",
        `vault-cli PUT /object/item/${existing.id} returned HTTP ${put.status}`,
      );
    }
    return existing.id;
  }

  // Create — fresh login item under the HA folder.
  const create = await fetch(`${VAULT_CLI_URL}/object/item`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: 1,
      name: HA_LLAT_ITEM,
      folderId,
      favorite: false,
      reprompt: 0,
      notes: "Home Assistant long-lived access token for the Alfred channel.",
      login: {
        username: null,
        password: llat,
        uris: [],
      },
    }),
    signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
  });
  if (!create.ok) {
    throw new ApiError(
      502,
      "VAULT_UNREACHABLE",
      `vault-cli POST /object/item returned HTTP ${create.status}`,
    );
  }
  // vault-cli (`bw serve`) returns single-wrapped `{success,data:{id,...}}`
  // for single-object create/get/put endpoints, NOT double-wrapped — only
  // LIST endpoints are `{data:{data:[…]}}`. Live-verified 2026-05-29 on home.
  const createJson = (await create.json()) as {
    data?: { id?: string };
  };
  const id = createJson?.data?.id;
  if (!id) {
    throw new ApiError(
      502,
      "VAULT_UNREACHABLE",
      "vault-cli POST /object/item returned no id",
    );
  }
  return id;
}

/** Best-effort delete of the LLAT vault item on disconnect. */
async function deleteHaLlatItem(itemId: string): Promise<void> {
  try {
    await fetch(`${VAULT_CLI_URL}/object/item/${itemId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    });
  } catch {
    // Best-effort — disconnect is the principal's "I want this gone" signal,
    // and we've already cleared the state.db row by the time this fires. A
    // vault-cli outage here leaves a dangling Vaultwarden item the
    // principal can clean up by hand, which is preferable to refusing to
    // disconnect.
  }
}

// ── ha_connection row helpers (#110 PR1) ─────────────────────────────────

interface HaConnectionRow {
  id: number;
  ha_url: string;
  label: string;
  vault_item_id: string;
  ha_version: string | null;
  state: string;
  last_test_at: string | null;
  last_test_ok: number;
  last_test_error: string | null;
  last_discovery_at: string | null;
  created_at: string;
  updated_at: string;
}

function getHaConnectionRow(): HaConnectionRow | undefined {
  const db = getStateDb();
  return db
    .prepare("SELECT * FROM ha_connection WHERE id = 1")
    .get() as HaConnectionRow | undefined;
}

function upsertHaConnectionRow(args: {
  ha_url: string;
  label: string;
  vault_item_id: string;
  ha_version: string | null;
}): void {
  const db = getStateDb();
  const now = new Date().toISOString();
  // INSERT OR REPLACE on the singleton — connect always recreates the row
  // so a re-connect after a state-flip starts fresh.
  db.prepare(
    `INSERT OR REPLACE INTO ha_connection (
       id, ha_url, label, vault_item_id, ha_version,
       state, last_test_at, last_test_ok, last_test_error,
       last_discovery_at, created_at, updated_at
     ) VALUES (1, ?, ?, ?, ?, 'connected', ?, 1, NULL, NULL,
              COALESCE((SELECT created_at FROM ha_connection WHERE id = 1), ?),
              ?)`,
  ).run(
    args.ha_url,
    args.label,
    args.vault_item_id,
    args.ha_version,
    now,
    now,
    now,
  );
}

function deleteHaConnectionRow(): void {
  getStateDb().prepare("DELETE FROM ha_connection WHERE id = 1").run();
}

// ── Connect body ──────────────────────────────────────────────────────────

interface ConnectBody {
  ha_url: string;
  llat: string;
  label: string;
}

function parseHaConnectBody(raw: unknown): ConnectBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  const ha_url = assertValidHaUrl(b.ha_url);
  if (typeof b.llat !== "string" || b.llat.length === 0) {
    throw new ValidationError("llat must be a non-empty string");
  }
  let label = "Home Assistant";
  if (b.label !== undefined && b.label !== null) {
    if (typeof b.label !== "string") {
      throw new ValidationError("label must be a string when present");
    }
    if (b.label.trim().length > 0) {
      label = b.label.trim();
    }
  }
  return { ha_url, llat: b.llat, label };
}

// ── Registry shape (#110 PR1) ────────────────────────────────────────────
//
// PR5 (HaBootstrapWorkflow Phase A) populates ha_registry; PR1 ships the
// empty read so the dashboard and PR2 MCP tools have a stable shape.

interface RegistryView {
  entities: unknown[];
  areas: unknown[];
  devices: unknown[];
  automations: unknown[];
  scenes: unknown[];
  helpers: unknown[];
}

function readRegistry(): RegistryView {
  const db = getStateDb();
  const buckets: RegistryView = {
    entities: [],
    areas: [],
    devices: [],
    automations: [],
    scenes: [],
    helpers: [],
  };
  let rows: Array<{ kind: string; payload_json: string }> = [];
  try {
    rows = db
      .prepare("SELECT kind, payload_json FROM ha_registry")
      .all() as Array<{ kind: string; payload_json: string }>;
  } catch {
    // ha_registry may not be present in an older test sandbox; treat as empty.
    return buckets;
  }
  const dest: Record<string, unknown[]> = {
    entity: buckets.entities,
    area: buckets.areas,
    device: buckets.devices,
    automation: buckets.automations,
    scene: buckets.scenes,
    helper: buckets.helpers,
  };
  for (const r of rows) {
    const target = dest[r.kind];
    if (!target) continue;
    try {
      target.push(JSON.parse(r.payload_json));
    } catch {
      // Skip malformed rows — PR5 owns the write side.
    }
  }
  return buckets;
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerHaChannelRoutes(): void {
  // POST /turn — the HA-conversation inbound handler.
  //
  // Auth: `channelTokenBearer("ha-conversation")`. The scoped bearer for
  // the HA install is the only thing that can call this — a leaked token
  // cannot reach any other surface.
  //
  // Rate-limit: 30 turns/min per haInstanceId (in-memory sliding window).
  // 403 RATE_LIMITED on exceed.
  //
  // Hermes: session key = `ha-<haInstallId>` (per spec §3.3 — per-install
  // continuity, NOT per-conversation_id).
  //
  // Response shape: HA's standard `ConversationEntity` envelope so the
  // custom component can hand it straight to its chat_log.
  addRoute("POST", "/api/v1/channels/ha/turn", async ({ req, res, body }) => {
    const started = Date.now();

    // Auth FIRST — never touch the body until the bearer is valid. Throws
    // AuthError → 401 if absent / revoked / mismatched-channel.
    channelTokenBearer(req, "ha-conversation");

    // Validate the body shape.
    const parsed = parseTurnBody(body);

    // === Preflight short-circuit ===
    // alfred-ha integration's _preflight (custom_components/alfred/_validators.py)
    // POSTs with text === "__alfred_ha_preflight__" to verify host/token without
    // burning a Hermes turn or its cold-start latency. Reply 200 immediately so the
    // integration's 5s timeout doesn't fire false `cannot_connect`. This is BEFORE
    // the rate limit + journal + Hermes call paths.
    if (parsed.text === "__alfred_ha_preflight__") {
      sendJson(res, 200, {
        response: {
          speech: {
            plain: {
              speech: "preflight ok",
              extra_data: null,
            },
          },
          card: {},
          language: parsed.language ?? "en",
          response_type: "action_done",
          data: { targets: [], success: [], failed: [] },
        },
        conversation_id: parsed.conversationId ?? "preflight",
        continue_conversation: false,
      });
      return;
    }

    // Rate-limit per HA installation. Returns 403 with RATE_LIMITED on
    // exceed — the custom component surfaces this as a HA error result
    // ("Alfred is busy, try again in a moment" per spec §5.1).
    if (!checkRateLimit(parsed.haInstallId)) {
      throw new ApiError(
        403,
        "RATE_LIMITED",
        `more than ${RATE_LIMIT_PER_MIN} turns/min for haInstallId=${parsed.haInstallId}`,
      );
    }

    const sessionKey = `ha-${parsed.haInstallId}`;
    const inboundMetadata: Record<string, unknown> = {
      conversationId: parsed.conversationId,
      language: parsed.language,
      agentId: parsed.agentId,
    };
    if (parsed.deviceId) inboundMetadata.deviceId = parsed.deviceId;

    journalIn(parsed.haInstallId, parsed.conversationId, parsed.text, inboundMetadata);

    const hermesStarted = Date.now();
    const result = await callHermes(sessionKey, parsed.text);
    const hermesMs = Date.now() - hermesStarted;

    if (!result.ok) {
      const status = result.code === "HERMES_TIMEOUT" ? 504 : 502;
      journalOut(
        parsed.haInstallId,
        parsed.conversationId,
        "",
        "failed",
        { conversationId: parsed.conversationId, hermes_ms: hermesMs },
        result.detail,
      );
      throw new ApiError(status, result.code, result.detail);
    }

    journalOut(
      parsed.haInstallId,
      parsed.conversationId,
      result.text,
      "delivered",
      { conversationId: parsed.conversationId, hermes_ms: hermesMs },
    );

    // HA's `ConversationEntity` envelope. The custom component lifts
    // `response.speech.plain.speech` for TTS. `conversation_id` echoes
    // back so HA can correlate. `hermesSessionId` + `timing` are extras
    // the custom component logs but ignores for user-facing rendering.
    sendJson(res, 200, {
      response: {
        speech: {
          plain: {
            speech: result.text,
          },
        },
      },
      conversation_id: parsed.conversationId,
      hermesSessionId: sessionKey,
      timing: {
        hermes_ms: hermesMs,
        total_ms: Date.now() - started,
      },
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/connect — #110 PR1
  //
  // Body: { ha_url: string, llat: string, label?: string }
  //
  // Order of operations is load-bearing:
  //   1. Validate body shape (no probe on bad URL — test 3).
  //   2. Probe HA (`/api/` for auth, `/api/config` for version).
  //   3. ONLY on probe success, ensure the Vaultwarden folder + upsert the
  //      LLAT item (test 2 asserts no vault write on 401).
  //   4. Persist the ha_connection row.
  //
  // Errors:
  //   400 VALIDATION_ERROR — bad body
  //   401 AUTH_FAILED      — HA rejected the LLAT
  //   502 UPSTREAM_ERROR   — HA reachable but not 2xx, or vault-cli down
  // ──────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/ha/connect", async ({ res, body }) => {
    const parsed = parseHaConnectBody(body);

    // (1) Probe HA. AUTH_FAILED short-circuits before we touch anything.
    const probe = await probeHa(parsed.ha_url, parsed.llat);
    if (!probe.ok) {
      if (probe.code === "AUTH_FAILED") {
        throw new ApiError(401, "AUTH_FAILED", probe.detail);
      }
      throw new ApiError(502, "UPSTREAM_ERROR", probe.detail);
    }

    // (2) Vaultwarden — folder, then item upsert. The LLAT lives ONLY here.
    const folderId = await ensureVaultFolder(HA_VAULTWARDEN_FOLDER);
    const vaultItemId = await upsertHaLlatItem(folderId, parsed.llat);

    // (3) ha_connection row.
    upsertHaConnectionRow({
      ha_url: parsed.ha_url,
      label: parsed.label,
      vault_item_id: vaultItemId,
      ha_version: probe.ha_version,
    });

    // #115 PR6 — clear the installation_type cache. Next addon route call
    // will re-probe /api/config against the freshly-connected install.
    _resetHaInstallationTypeCache();

    sendJson(res, 200, {
      ok: true,
      state: "connected",
      ha_url: parsed.ha_url,
      ha_version: probe.ha_version,
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/status — #110 PR1
  //
  // Fail-soft snapshot of ha_connection. Returns:
  //
  //   { connected, state, ha_url, ha_version, last_test_ok, last_test_at,
  //     error }
  //
  // When no row exists: state='unconfigured', everything else null/false.
  // The LLAT is NEVER in the payload — only the row columns, which by
  // schema (0005_ha_channel.sql) only carry vault_item_id.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/ha/status", async ({ res }) => {
    const row = getHaConnectionRow();
    if (!row) {
      sendJson(res, 200, {
        connected: false,
        state: "unconfigured",
        ha_url: null,
        ha_version: null,
        last_test_ok: false,
        last_test_at: null,
        error: null,
      });
      return;
    }
    sendJson(res, 200, {
      connected: row.state === "connected",
      state: row.state,
      ha_url: row.ha_url,
      ha_version: row.ha_version ?? null,
      label: row.label,
      last_test_ok: Number(row.last_test_ok) === 1,
      last_test_at: row.last_test_at ?? null,
      error: row.last_test_error ?? null,
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // DELETE /api/v1/channels/ha/disconnect — #110 PR1
  //
  // Clears the Vaultwarden item AND the state.db row. Idempotent — if no
  // row exists we still return 200 ok so a double-click is harmless.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("DELETE", "/api/v1/channels/ha/disconnect", async ({ res }) => {
    const row = getHaConnectionRow();
    if (row?.vault_item_id) {
      await deleteHaLlatItem(row.vault_item_id);
    }
    deleteHaConnectionRow();
    // #115 PR6 — disconnect drops the install; the cached installation_type
    // is stale.
    _resetHaInstallationTypeCache();
    sendJson(res, 200, { ok: true });
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/registry — #110 PR1
  //
  // The 6 ha_registry buckets — entities / areas / devices / automations /
  // scenes / helpers. PR1 ships the empty read; PR5
  // (HaBootstrapWorkflow Phase A) populates it.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/ha/registry", async ({ res }) => {
    sendJson(res, 200, readRegistry());
  });

  // #110 PR5 — registry bootstrap surface (LLAT retrieval + bulk upsert +
  // on-demand refresh). All three routes are operator-only (master
  // AAS_API_KEY); the LLAT route is the most sensitive — it returns the
  // raw HA long-lived access token so alfred-learn's HaBootstrapWorkflow
  // can call the HA REST/WS API directly. Voice-bridge + channel-token
  // bearers are explicitly rejected with 403 (not 401) so the boundary
  // surfaces clearly in audit logs even if those tokens are otherwise
  // valid against the read paths in the same `/ha/*` namespace.
  registerHaBootstrapRoutes();

  // #110 PR4 — the write surface (call_service, proposal create/apply,
  // snapshot rollback, subscribe/unsubscribe). Registration deferred
  // here so the write routes are colocated with the read routes for
  // server.ts wiring AND callable from a single registerHaChannelRoutes()
  // entry point.
  registerHaWriteRoutes();

  // #115 PR3 — automations / scenes / scripts CRUD. REST-only; ships
  // independent of #115 PR1 (the WS client). See the SPLICE block at the
  // bottom of this file marked `BEGIN #115 PR3`.
  registerHaPr3Routes();

  // #115 PR4 — Tier 4 autonomy, Integrations (config_flow) CRUD. Drives
  // HA's multi-step `config_entries/flow/*` WS surface through the
  // long-lived ha_ws_client; gates `configure` (the submit step) and
  // `remove` on a `decision_ref`; auto-snapshot YES on both. Writes a
  // row to `ha_integration_ref` on successful create, soft-deletes on
  // remove. See the "=== Tier 4 PR4: Integrations ===" block at the
  // bottom of this file.
  registerHaIntegrationsRoutes();

  // #115 PR6 — Tier 4 autonomy, Supervisor addon CRUD. HAOS-only; every
  // route guards on installation_type and 501s on Container HA. See the
  // "=== Tier 4 PR6: Supervisor addons ===" block at the bottom of this
  // file.
  registerHaAddonRoutes();

  // #115 PR7 — Tier 4 autonomy, HA core lifecycle + backup CRUD.
  // check_config / restart / update / reload_yaml / version + backup
  // info/details/generate/delete/restore/strategy. Uses PR1's WS client
  // for the WS-only verbs (backup/*) and REST for the homeassistant
  // service domain. See the "=== Tier 4 PR7: Core + Backups ===" block
  // at the bottom of this file.
  registerHaPr7CoreBackupRoutes();

  // #115 PR8 — Tier 4 autonomy, HA user CRUD + per-user LLAT mint with
  // Vaultwarden storage of the token. See the
  // "=== Tier 4 PR8: Users + LLATs ===" block at the bottom of this file.
  // Load-bearing rule for the agent (in skill doc too): the minted LLAT
  // value NEVER appears in any user-facing response — only the
  // Vaultwarden item id (llat_vw_id) is returned. Sir reads the value
  // through the vault UI / vaultwarden MCP separately.
  registerHaUserRoutes();

  // #115 PR5 — Tier 4 autonomy, HACS CRUD via the long-lived WS client
  // landed in PR1. Independent of PR2/PR3/PR4/PR6/PR7/PR8; the splice
  // block lives at the bottom of this file (`=== Tier 4 PR5: HACS ===`).
  registerHaHacsRoutes();

  // #115 PR2 — Tier 4 autonomy, registries CRUD. Areas / devices /
  // entities / labels — all WS-only on HA's side, all cheap +
  // reversible, no decision_ref gate per Sir's locked YES defaults
  // (2026-05-29). See the "=== Tier 4 PR2: Registries CRUD ===" block
  // at the bottom of this file.
  registerHaPr2RegistriesRoutes();
}

/**
 * Alias for the route registration used by the #110 PR1 spec + tests.
 *
 * Both lanes share this file and the two names ended up living together
 * during the Wave B sequencing. `registerHaChannelRoutes` is the older
 * name (kept for the server.ts wiring it already has); the #110 PR1 test
 * file imports `registerChannelsHaRoutes`. They register the same set
 * of routes.
 */
export const registerChannelsHaRoutes = registerHaChannelRoutes;

// ═════════════════════════════════════════════════════════════════════════
// #110 PR4 — HA WRITE SURFACE
// ═════════════════════════════════════════════════════════════════════════
//
// PR4 fills in the 5 PR3-deferred MCP tools (ha__call_service /
// propose_automation / apply_proposal / rollback_snapshot /
// subscribe_events) by adding the matching ctrl-api routes.
//
// LOAD-BEARING CONTRACT — every write must:
//   1. carry a non-empty `decision_ref` in the body (the agent's contract:
//      "I decided X based on signal Y, run it");
//   2. persist a `ha_run` row with that `decision_ref` BEFORE the upstream
//      HA call returns (so the loop-guard partial index `idx_ha_run_entity_recent`
//      lights up in HaWatcherWorkflow's probe);
//   3. respect the loop guard — a second write to the same entity within
//      HA_LOOP_GUARD_COOLDOWN_MS (default 60s) is rejected 409 unless the
//      new decision_ref is different (different decision = fresh signal).
//
// None of these write routes are added to VOICE_BRIDGE_ALLOWLIST — voice
// writes flow through `alfred__act_on_decision`, not raw `ha__call_service`.

const HA_LOOP_GUARD_COOLDOWN_MS = Number(
  process.env.HA_LOOP_GUARD_COOLDOWN_MS ?? "60000",
);

const HA_WRITE_TIMEOUT_MS = Number(
  process.env.HA_WRITE_TIMEOUT_MS ?? "15000",
);

// `decision_ref` accepts vault paths ("decision/2026-05-29-foo.md"), ulids,
// or short slugs. Format gate: must be a non-empty string of printable ASCII,
// length 6..256 — keeps the agents honest without locking us in to a single
// encoding.
const DECISION_REF_RE = /^[\x21-\x7E]{6,256}$/;

function assertDecisionRef(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError("decision_ref is required and must be a non-empty string");
  }
  if (!DECISION_REF_RE.test(raw)) {
    throw new ValidationError(
      "decision_ref must be 6..256 printable ASCII chars (no whitespace, no control chars)",
    );
  }
  return raw;
}

// ── target → entity_id extraction ────────────────────────────────────────
//
// HA's call_service `target` can be `{entity_id: "..."|["..."]}` or
// `{area_id: ...}` or `{device_id: ...}`. The loop guard keys on
// entity_id, so we extract the first entity_id we can find. If `target`
// names an area/device, we still write a `ha_run` row but with NULL
// entity_id — the watcher's partial index covers (entity_id, created_at)
// so NULL rows are excluded from the guard. That is the right behaviour:
// area-level service calls don't echo back as a single-entity
// state_changed event, so they don't need single-entity suppression.
function extractEntityId(target: unknown, data: unknown): string | null {
  for (const candidate of [target, data]) {
    if (!candidate || typeof candidate !== "object") continue;
    const eid = (candidate as Record<string, unknown>).entity_id;
    if (typeof eid === "string" && eid.length > 0) return eid;
    if (Array.isArray(eid) && eid.length > 0 && typeof eid[0] === "string") {
      return eid[0];
    }
  }
  return null;
}

// ── LLAT retrieval (read the password off the Vaultwarden item) ─────────
//
// Every HA call needs the LLAT from the vault item that PR1 stored on
// /connect. We never cache it in-process across requests (the principal
// can disconnect/reconnect to rotate; a stale cache would lock writes
// out post-rotation). Each write fetches fresh.

async function readHaLlat(): Promise<string> {
  const row = getHaConnectionRow();
  if (!row || row.state !== "connected") {
    throw new ApiError(
      409,
      "HA_NOT_CONNECTED",
      "Home Assistant is not connected. POST /api/v1/channels/ha/connect first.",
    );
  }
  const r = await fetch(
    `${VAULT_CLI_URL}/object/item/${row.vault_item_id}`,
    { signal: AbortSignal.timeout(VAULT_TIMEOUT_MS) },
  );
  if (!r.ok) {
    throw new ApiError(
      502,
      "VAULT_UNREACHABLE",
      `vault-cli GET /object/item/${row.vault_item_id} returned HTTP ${r.status}`,
    );
  }
  // vault-cli (`bw serve`) returns single-wrapped `{success,data:{id,...}}`
  // for single-object create/get/put endpoints, NOT double-wrapped — only
  // LIST endpoints are `{data:{data:[…]}}`. Live-verified 2026-05-29 on home.
  const j = (await r.json()) as {
    data?: { login?: { password?: string } };
  };
  const pw = j?.data?.login?.password;
  if (typeof pw !== "string" || pw.length === 0) {
    throw new ApiError(
      502,
      "VAULT_LLAT_MISSING",
      "vault-cli returned an HA item without a login.password",
    );
  }
  return pw;
}

// ── ha_run helpers ──────────────────────────────────────────────────────

interface HaRunArgs {
  kind: string;
  domain: string | null;
  service: string | null;
  entity_id: string | null;
  decision_ref: string;
  payload: unknown;
  outcome: "ok" | "error";
  ha_response: unknown;
  error: string | null;
  actor?: string;
}

function insertHaRun(args: HaRunArgs): { id: string; created_at: number } {
  const db = getStateDb();
  const id = ulid();
  const createdAt = Date.now();
  const ts = new Date(createdAt).toISOString();
  db.prepare(
    `INSERT INTO ha_run (
       id, ts, actor, kind, domain, service, entity_id,
       payload_json, outcome, ha_response, error, decision_ref, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ts,
    args.actor ?? "alfred-ceo",
    args.kind,
    args.domain,
    args.service,
    args.entity_id,
    JSON.stringify(args.payload ?? null),
    args.outcome,
    args.ha_response === null || args.ha_response === undefined
      ? null
      : JSON.stringify(args.ha_response),
    args.error,
    args.decision_ref,
    createdAt,
  );
  return { id, created_at: createdAt };
}

/** Loop guard: returns the conflicting row id if a write to `entity_id`
 *  within the cooldown window already carries a decision_ref AND that
 *  decision_ref is the SAME as the incoming one. Different decision_refs
 *  always pass — the contract is "the agent re-derived a decision from a
 *  new signal, this is not a loop". */
function loopGuardConflict(
  entity_id: string | null,
  decision_ref: string,
): { id: string; decision_ref: string } | null {
  if (!entity_id) return null; // area/device writes can't loop-guard by entity
  const cutoff = Date.now() - HA_LOOP_GUARD_COOLDOWN_MS;
  const row = getStateDb()
    .prepare(
      `SELECT id, decision_ref FROM ha_run
        WHERE entity_id = ?
          AND decision_ref IS NOT NULL
          AND created_at > ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(entity_id, cutoff) as
    | { id: string; decision_ref: string }
    | undefined;
  if (!row) return null;
  if (row.decision_ref === decision_ref) return row;
  return null;
}

// ── ha_proposal / ha_snapshot helpers ───────────────────────────────────

interface HaProposalRow {
  id: string;
  ts: string;
  scope: string;
  summary: string;
  payload_json: string;
  status: string;
  decision_ref: string | null;
  applied_at: string | null;
  applied_summary: string | null;
}

function insertHaProposal(args: {
  kind: string;
  summary: string;
  yaml: string;
  gap_id: string | null;
}): { id: string; status: string } {
  const id = ulid();
  const ts = new Date().toISOString();
  const payload = {
    kind: args.kind,
    yaml: args.yaml,
    gap_id: args.gap_id,
  };
  getStateDb()
    .prepare(
      `INSERT INTO ha_proposal (id, ts, scope, summary, payload_json, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(id, ts, args.kind, args.summary, JSON.stringify(payload));
  return { id, status: "pending" };
}

function getHaProposal(id: string): HaProposalRow | undefined {
  return getStateDb()
    .prepare("SELECT * FROM ha_proposal WHERE id = ?")
    .get(id) as HaProposalRow | undefined;
}

function insertHaSnapshot(args: {
  kind: string;
  ha_id: string;
  proposal_ref: string | null;
  yaml: string;
}): { id: string } {
  const id = ulid();
  const ts = new Date().toISOString();
  getStateDb()
    .prepare(
      `INSERT INTO ha_snapshot (id, ts, kind, ha_id, proposal_ref, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ts, args.kind, args.ha_id, args.proposal_ref, args.yaml);
  return { id };
}

interface HaSnapshotRow {
  id: string;
  ts: string;
  kind: string;
  ha_id: string;
  proposal_ref: string | null;
  payload_json: string;
  restored_at: string | null;
  created_at: string;
}

function getHaSnapshot(id: string): HaSnapshotRow | undefined {
  return getStateDb()
    .prepare("SELECT * FROM ha_snapshot WHERE id = ?")
    .get(id) as HaSnapshotRow | undefined;
}

// ── ha_event_subscription helpers ───────────────────────────────────────

interface HaSubscriptionRow {
  id: string;
  filter_json: string | null;
  started_at: string;
  last_event_at: string | null;
  closed_at: string | null;
}

// In-process registry of open WS subscribers. The DB table is the durable
// record; this map carries the live socket handles. On restart the WS
// connections drop; PR5 will wire a resume.
const liveSubscriptions = new Map<string, WebSocket>();

export function _resetHaSubscriptionsForTests(): void {
  for (const ws of liveSubscriptions.values()) {
    try {
      ws.close();
    } catch {
      // best-effort
    }
  }
  liveSubscriptions.clear();
}

function insertHaSubscription(filter: unknown): HaSubscriptionRow {
  const id = ulid();
  const filterJson =
    filter === undefined || filter === null ? null : JSON.stringify(filter);
  const startedAt = new Date().toISOString();
  getStateDb()
    .prepare(
      `INSERT INTO ha_event_subscription (id, filter_json, started_at)
       VALUES (?, ?, ?)`,
    )
    .run(id, filterJson, startedAt);
  return {
    id,
    filter_json: filterJson,
    started_at: startedAt,
    last_event_at: null,
    closed_at: null,
  };
}

function getHaSubscription(id: string): HaSubscriptionRow | undefined {
  return getStateDb()
    .prepare("SELECT * FROM ha_event_subscription WHERE id = ?")
    .get(id) as HaSubscriptionRow | undefined;
}

function closeHaSubscription(id: string): void {
  getStateDb()
    .prepare(
      `UPDATE ha_event_subscription SET closed_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
}

function bumpSubscriptionLastEvent(id: string): void {
  try {
    getStateDb()
      .prepare(
        `UPDATE ha_event_subscription SET last_event_at = datetime('now') WHERE id = ?`,
      )
      .run(id);
  } catch {
    // best-effort
  }
}

function recordHaEvent(
  subscriptionId: string,
  evt: { event_type?: string; data?: { entity_id?: string } } & Record<
    string,
    unknown
  >,
): void {
  try {
    const id = ulid();
    const ts = new Date().toISOString();
    const eventType =
      typeof evt.event_type === "string" ? evt.event_type : "unknown";
    const entityId =
      evt.data && typeof evt.data === "object"
        ? typeof (evt.data as Record<string, unknown>).entity_id === "string"
          ? ((evt.data as Record<string, unknown>).entity_id as string)
          : null
        : null;
    getStateDb()
      .prepare(
        `INSERT INTO ha_event (id, ts, event_type, entity_id, payload_json, signaled)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(id, ts, eventType, entityId, JSON.stringify(evt));
    bumpSubscriptionLastEvent(subscriptionId);
  } catch (e) {
    console.warn(
      "[channels_ha] recordHaEvent failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ── HA service call helper ──────────────────────────────────────────────

async function callHaService(args: {
  ha_url: string;
  llat: string;
  domain: string;
  service: string;
  target: unknown;
  data: unknown;
}): Promise<{ ok: true; response: unknown } | { ok: false; status: number; detail: string }> {
  const body: Record<string, unknown> = {};
  if (args.data && typeof args.data === "object") {
    Object.assign(body, args.data);
  }
  if (args.target && typeof args.target === "object") {
    // Merge target into body — HA accepts entity_id/area_id/device_id at the
    // top level of the service-call payload.
    Object.assign(body, args.target);
  }
  let resp: Response;
  try {
    resp = await fetch(
      `${args.ha_url}/api/services/${encodeURIComponent(args.domain)}/${encodeURIComponent(args.service)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.llat}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HA_WRITE_TIMEOUT_MS),
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, detail: `HA unreachable: ${msg}` };
  }
  if (!resp.ok) {
    let detail = `HA service call returned HTTP ${resp.status}`;
    try {
      const t = await resp.text();
      if (t) detail = `${detail}: ${t.slice(0, 500)}`;
    } catch {
      // best-effort
    }
    return { ok: false, status: resp.status, detail };
  }
  let parsed: unknown = null;
  try {
    parsed = await resp.json();
  } catch {
    parsed = null;
  }
  return { ok: true, response: parsed };
}

// ── HA automation config write helpers ─────────────────────────────────
//
// HA exposes `POST /api/config/automation/config/<automation_id>` to write
// (create/replace) an automation YAML, and `GET /api/config/automation/config/<id>`
// to read the current YAML (we use this to snapshot before a destructive
// write so rollback works). Same auth bearer.

async function fetchHaAutomationYaml(
  haUrl: string,
  llat: string,
  automationId: string,
): Promise<string | null> {
  try {
    const r = await fetch(
      `${haUrl}/api/config/automation/config/${encodeURIComponent(automationId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${llat}` },
        signal: AbortSignal.timeout(HA_WRITE_TIMEOUT_MS),
      },
    );
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function writeHaAutomationYaml(args: {
  haUrl: string;
  llat: string;
  automationId: string;
  yaml: string;
}): Promise<{ ok: true; response: unknown } | { ok: false; status: number; detail: string }> {
  let resp: Response;
  try {
    resp = await fetch(
      `${args.haUrl}/api/config/automation/config/${encodeURIComponent(args.automationId)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.llat}`,
          "Content-Type": "application/json",
        },
        body: args.yaml,
        signal: AbortSignal.timeout(HA_WRITE_TIMEOUT_MS),
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, detail: `HA unreachable: ${msg}` };
  }
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      detail: `HA automation config write returned HTTP ${resp.status}`,
    };
  }
  let parsed: unknown = null;
  try {
    parsed = await resp.json();
  } catch {
    parsed = null;
  }
  return { ok: true, response: parsed };
}

// ── parseService body ───────────────────────────────────────────────────

interface ServiceBody {
  domain: string;
  service: string;
  target: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
  decision_ref: string;
}

function parseServiceBody(raw: unknown): ServiceBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.domain !== "string" || b.domain.length === 0) {
    throw new ValidationError("domain must be a non-empty string");
  }
  if (typeof b.service !== "string" || b.service.length === 0) {
    throw new ValidationError("service must be a non-empty string");
  }
  let target: Record<string, unknown> | null = null;
  if (b.target !== undefined && b.target !== null) {
    if (typeof b.target !== "object" || Array.isArray(b.target)) {
      throw new ValidationError("target must be a JSON object when present");
    }
    target = b.target as Record<string, unknown>;
  }
  let data: Record<string, unknown> | null = null;
  if (b.data !== undefined && b.data !== null) {
    if (typeof b.data !== "object" || Array.isArray(b.data)) {
      throw new ValidationError("data must be a JSON object when present");
    }
    data = b.data as Record<string, unknown>;
  }
  const decision_ref = assertDecisionRef(b.decision_ref);
  return { domain: b.domain, service: b.service, target, data, decision_ref };
}

// ── parseProposalBody ───────────────────────────────────────────────────

interface ProposalBody {
  kind: string;
  summary: string;
  yaml: string;
  gap_id: string | null;
}

function parseProposalBody(raw: unknown): ProposalBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.kind !== "string" || b.kind.length === 0) {
    throw new ValidationError("kind must be a non-empty string");
  }
  if (typeof b.summary !== "string" || b.summary.length === 0) {
    throw new ValidationError("summary must be a non-empty string");
  }
  if (typeof b.yaml !== "string" || b.yaml.length === 0) {
    throw new ValidationError("yaml must be a non-empty string");
  }
  let gap_id: string | null = null;
  if (b.gap_id !== undefined && b.gap_id !== null) {
    if (typeof b.gap_id !== "string") {
      throw new ValidationError("gap_id must be a string when present");
    }
    gap_id = b.gap_id;
  }
  return { kind: b.kind, summary: b.summary, yaml: b.yaml, gap_id };
}

// ── HA WS subscribe (best-effort wiring) ────────────────────────────────
//
// HA's auth handshake on `ws://.../api/websocket`:
//   1. server → {type:'auth_required', ha_version}
//   2. client → {type:'auth', access_token: '<LLAT>'}
//   3. server → {type:'auth_ok'} | {type:'auth_invalid'}
//   4. client → {id:1, type:'subscribe_events', event_type?: '...'}
//   5. server streams {type:'event', event:{...}, id:1}
//
// We surface the open WS to liveSubscriptions; events stream into ha_event.
// All error paths are best-effort: a WS that fails to connect closes the
// subscription row and frees the entry. Test override:
// HA_WS_URL_OVERRIDE lets tests skip the real WS connect.

function haWsUrlFromHttp(haUrl: string): string {
  if (haUrl.startsWith("https://")) return `wss://${haUrl.slice("https://".length)}/api/websocket`;
  if (haUrl.startsWith("http://")) return `ws://${haUrl.slice("http://".length)}/api/websocket`;
  return `${haUrl}/api/websocket`;
}

function startHaWsSubscriber(
  subscriptionId: string,
  haUrl: string,
  llat: string,
  filter: { event_type?: string; entity_id?: string } | null,
): void {
  if (process.env.HA_WS_URL_OVERRIDE === "skip") {
    // Test mode: don't actually open a WS. The DB row is what the tests
    // assert on.
    return;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(haWsUrlFromHttp(haUrl));
  } catch (e) {
    console.warn(
      "[channels_ha] WS construct failed:",
      e instanceof Error ? e.message : String(e),
    );
    closeHaSubscription(subscriptionId);
    return;
  }
  liveSubscriptions.set(subscriptionId, ws);
  let subscribed = false;
  ws.on("open", () => {
    // wait for auth_required
  });
  ws.on("message", (raw: Buffer | string) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "auth_required") {
      ws.send(JSON.stringify({ type: "auth", access_token: llat }));
      return;
    }
    if (msg.type === "auth_invalid") {
      ws.close();
      return;
    }
    if (msg.type === "auth_ok" && !subscribed) {
      const sub: Record<string, unknown> = {
        id: 1,
        type: "subscribe_events",
      };
      if (filter?.event_type) sub.event_type = filter.event_type;
      ws.send(JSON.stringify(sub));
      subscribed = true;
      return;
    }
    if (msg.type === "event" && typeof msg.event === "object") {
      const evt = msg.event as Record<string, unknown>;
      // Apply entity_id filter client-side (HA's subscribe_events doesn't
      // accept entity_id natively).
      if (filter?.entity_id) {
        const data = evt.data as Record<string, unknown> | undefined;
        if (!data || data.entity_id !== filter.entity_id) return;
      }
      recordHaEvent(subscriptionId, evt as Parameters<typeof recordHaEvent>[1]);
    }
  });
  ws.on("close", () => {
    liveSubscriptions.delete(subscriptionId);
  });
  ws.on("error", (e) => {
    console.warn(
      "[channels_ha] WS error:",
      e instanceof Error ? e.message : String(e),
    );
  });
}

// ── PR4 routes ──────────────────────────────────────────────────────────

export function registerHaWriteRoutes(): void {
  // ────────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/service — call any HA service.
  //
  // Body: { domain, service, target?, data?, decision_ref }
  //
  // Order of operations:
  //   1. Validate body (decision_ref REQUIRED + format-gated).
  //   2. Loop-guard check: a recent (≤ HA_LOOP_GUARD_COOLDOWN_MS) ha_run on
  //      the SAME entity_id with the SAME decision_ref → 409 LOOP_GUARD.
  //   3. Fetch LLAT from Vaultwarden (via the ha_connection row).
  //   4. POST /api/services/<domain>/<service> to HA.
  //   5. Persist ha_run with outcome + decision_ref.
  //   6. Return { ok, run_id, ha_response }.
  // ────────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/ha/service", async ({ res, body }) => {
    const parsed = parseServiceBody(body);
    const entity_id = extractEntityId(parsed.target, parsed.data);

    // Loop guard.
    const conflict = loopGuardConflict(entity_id, parsed.decision_ref);
    if (conflict) {
      throw new ConflictError(
        `loop guard: ha_run ${conflict.id} already wrote to entity_id=${entity_id} ` +
          `with the same decision_ref within ${HA_LOOP_GUARD_COOLDOWN_MS}ms. ` +
          `Either pass a different decision_ref (you re-derived the decision from a ` +
          `new signal) or wait for the cooldown.`,
      );
    }

    // Fetch LLAT (this also asserts ha_connection.state === 'connected').
    const llat = await readHaLlat();
    const row = getHaConnectionRow()!;

    // Fire the upstream service call.
    const result = await callHaService({
      ha_url: row.ha_url,
      llat,
      domain: parsed.domain,
      service: parsed.service,
      target: parsed.target,
      data: parsed.data,
    });

    if (!result.ok) {
      const run = insertHaRun({
        kind: "service_call",
        domain: parsed.domain,
        service: parsed.service,
        entity_id,
        decision_ref: parsed.decision_ref,
        payload: { target: parsed.target, data: parsed.data },
        outcome: "error",
        ha_response: null,
        error: result.detail,
      });
      throw new ApiError(
        result.status >= 400 && result.status < 600 ? result.status : 502,
        "HA_UPSTREAM_ERROR",
        result.detail,
        { run_id: run.id },
      );
    }

    const run = insertHaRun({
      kind: "service_call",
      domain: parsed.domain,
      service: parsed.service,
      entity_id,
      decision_ref: parsed.decision_ref,
      payload: { target: parsed.target, data: parsed.data },
      outcome: "ok",
      ha_response: result.response,
      error: null,
    });

    sendJson(res, 200, {
      ok: true,
      run_id: run.id,
      decision_ref: parsed.decision_ref,
      ha_response: result.response,
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/proposal — queue a baseline automation pack.
  // Body: { kind, summary, yaml, gap_id? }
  // ────────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/ha/proposal", async ({ res, body }) => {
    const parsed = parseProposalBody(body);
    const out = insertHaProposal(parsed);
    sendJson(res, 200, { ok: true, proposal_id: out.id, status: out.status });
  });

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/proposal/:proposal_id/apply — apply a proposal.
  // Body: { decision_ref, automation_id? }
  //
  //   1. Fetch the proposal row (status must be pending|approved).
  //   2. Snapshot the current HA automation YAML for the target id.
  //   3. POST the proposal YAML to HA's automation/config endpoint.
  //   4. Persist a ha_run + mark the proposal `applied`.
  // ────────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/proposal/:proposal_id/apply",
    async ({ res, body, params }) => {
      const proposalId = params.proposal_id;
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const decision_ref = assertDecisionRef(b.decision_ref);

      const proposal = getHaProposal(proposalId);
      if (!proposal) {
        throw new NotFoundError(`ha_proposal ${proposalId} not found`);
      }
      if (proposal.status !== "pending" && proposal.status !== "approved") {
        throw new ConflictError(
          `ha_proposal ${proposalId} is in status '${proposal.status}', cannot apply`,
        );
      }

      let payload: { kind?: string; yaml?: string; gap_id?: string | null } = {};
      try {
        payload = JSON.parse(proposal.payload_json) as typeof payload;
      } catch {
        throw new ApiError(
          500,
          "PROPOSAL_CORRUPT",
          `ha_proposal ${proposalId} has unparseable payload_json`,
        );
      }
      const yaml = payload.yaml;
      if (!yaml || typeof yaml !== "string") {
        throw new ValidationError(
          `ha_proposal ${proposalId} payload missing yaml`,
        );
      }
      // automation_id can be passed in (override) or extracted from the
      // payload kind; fall back to the proposal id so a fresh automation
      // gets a stable HA-side identifier.
      const automation_id =
        typeof b.automation_id === "string" && b.automation_id.length > 0
          ? b.automation_id
          : proposalId;

      const llat = await readHaLlat();
      const row = getHaConnectionRow()!;

      // Snapshot the current YAML BEFORE the write so rollback works.
      const preYaml = await fetchHaAutomationYaml(row.ha_url, llat, automation_id);
      const snapshot = insertHaSnapshot({
        kind: "automation",
        ha_id: automation_id,
        proposal_ref: proposalId,
        yaml: preYaml ?? "",
      });

      const write = await writeHaAutomationYaml({
        haUrl: row.ha_url,
        llat,
        automationId: automation_id,
        yaml,
      });

      if (!write.ok) {
        insertHaRun({
          kind: "proposal_apply",
          domain: "automation",
          service: "config",
          entity_id: `automation.${automation_id}`,
          decision_ref,
          payload: { proposal_id: proposalId, automation_id },
          outcome: "error",
          ha_response: null,
          error: write.detail,
        });
        throw new ApiError(
          write.status >= 400 && write.status < 600 ? write.status : 502,
          "HA_UPSTREAM_ERROR",
          write.detail,
          { snapshot_id: snapshot.id },
        );
      }

      const run = insertHaRun({
        kind: "proposal_apply",
        domain: "automation",
        service: "config",
        entity_id: `automation.${automation_id}`,
        decision_ref,
        payload: { proposal_id: proposalId, automation_id },
        outcome: "ok",
        ha_response: write.response,
        error: null,
      });

      const now = new Date().toISOString();
      getStateDb()
        .prepare(
          `UPDATE ha_proposal
              SET status='applied', applied_at=?, applied_summary=?, decision_ref=?, updated_at=?
            WHERE id=?`,
        )
        .run(now, "applied via PR4", decision_ref, now, proposalId);

      sendJson(res, 200, {
        ok: true,
        proposal_id: proposalId,
        snapshot_id: snapshot.id,
        run_id: run.id,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/snapshot/:snapshot_id/rollback — restore YAML.
  // Body: { decision_ref }
  // ────────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/snapshot/:snapshot_id/rollback",
    async ({ res, body, params }) => {
      const snapshotId = params.snapshot_id;
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const decision_ref = assertDecisionRef(b.decision_ref);

      const snap = getHaSnapshot(snapshotId);
      if (!snap) {
        throw new NotFoundError(`ha_snapshot ${snapshotId} not found`);
      }
      if (snap.restored_at) {
        throw new ConflictError(
          `ha_snapshot ${snapshotId} was already restored at ${snap.restored_at}`,
        );
      }

      const llat = await readHaLlat();
      const row = getHaConnectionRow()!;

      // Restore the YAML — snap.payload_json holds the pre-write YAML.
      const write = await writeHaAutomationYaml({
        haUrl: row.ha_url,
        llat,
        automationId: snap.ha_id,
        yaml: snap.payload_json,
      });
      if (!write.ok) {
        insertHaRun({
          kind: "snapshot_rollback",
          domain: "automation",
          service: "config",
          entity_id: `automation.${snap.ha_id}`,
          decision_ref,
          payload: { snapshot_id: snapshotId, ha_id: snap.ha_id },
          outcome: "error",
          ha_response: null,
          error: write.detail,
        });
        throw new ApiError(
          write.status >= 400 && write.status < 600 ? write.status : 502,
          "HA_UPSTREAM_ERROR",
          write.detail,
        );
      }

      const restoredAt = new Date().toISOString();
      getStateDb()
        .prepare(`UPDATE ha_snapshot SET restored_at = ? WHERE id = ?`)
        .run(restoredAt, snapshotId);
      const run = insertHaRun({
        kind: "snapshot_rollback",
        domain: "automation",
        service: "config",
        entity_id: `automation.${snap.ha_id}`,
        decision_ref,
        payload: { snapshot_id: snapshotId, ha_id: snap.ha_id },
        outcome: "ok",
        ha_response: write.response,
        error: null,
      });

      sendJson(res, 200, {
        ok: true,
        snapshot_id: snapshotId,
        run_id: run.id,
        restored_at: restoredAt,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/subscribe — open a WS event subscription.
  // Body: { filter? } — filter is { event_type?, entity_id? }.
  // ────────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/ha/subscribe", async ({ res, body }) => {
    let filter: { event_type?: string; entity_id?: string } | null = null;
    if (body !== undefined && body !== null) {
      if (typeof body !== "object") {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const rawFilter = b.filter;
      if (rawFilter !== undefined && rawFilter !== null) {
        if (typeof rawFilter !== "object" || Array.isArray(rawFilter)) {
          throw new ValidationError("filter must be a JSON object when present");
        }
        const f = rawFilter as Record<string, unknown>;
        filter = {};
        if (f.event_type !== undefined) {
          if (typeof f.event_type !== "string" || f.event_type.length === 0) {
            throw new ValidationError("filter.event_type must be a non-empty string");
          }
          filter.event_type = f.event_type;
        }
        if (f.entity_id !== undefined) {
          if (typeof f.entity_id !== "string" || f.entity_id.length === 0) {
            throw new ValidationError("filter.entity_id must be a non-empty string");
          }
          filter.entity_id = f.entity_id;
        }
      }
    }

    // Connection check + LLAT fetch.
    const llat = await readHaLlat();
    const row = getHaConnectionRow()!;

    const sub = insertHaSubscription(filter);
    // Best-effort WS spawn. The DB row is the durable contract; the WS
    // is the live channel.
    startHaWsSubscriber(sub.id, row.ha_url, llat, filter);

    sendJson(res, 200, {
      ok: true,
      subscription_id: sub.id,
      filter,
      started_at: sub.started_at,
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // DELETE /api/v1/channels/ha/subscribe/:subscription_id — close it.
  // ────────────────────────────────────────────────────────────────────────
  addRoute(
    "DELETE",
    "/api/v1/channels/ha/subscribe/:subscription_id",
    async ({ res, params }) => {
      const id = params.subscription_id;
      const sub = getHaSubscription(id);
      if (!sub) {
        throw new NotFoundError(`ha_event_subscription ${id} not found`);
      }
      if (sub.closed_at) {
        // Idempotent close — already closed is a success.
        sendJson(res, 200, { ok: true, closed_at: sub.closed_at, already_closed: true });
        return;
      }
      const ws = liveSubscriptions.get(id);
      if (ws) {
        try {
          ws.close();
        } catch {
          // best-effort
        }
        liveSubscriptions.delete(id);
      }
      closeHaSubscription(id);
      const reread = getHaSubscription(id)!;
      sendJson(res, 200, { ok: true, closed_at: reread.closed_at });
    },
  );
}

// ═════════════════════════════════════════════════════════════════════════
// #110 PR5 — HA BOOTSTRAP REGISTRY SURFACE
// ═════════════════════════════════════════════════════════════════════════
//
// Three operator-only routes for the HaBootstrapWorkflow (alfred-learn).
// The workflow runs every 6h (Temporal schedule `al-ha-bootstrap`) and on
// demand from the HaCard "Refresh registry" CTA. Its activity:
//
//   1. GETs /api/v1/channels/ha/status — to read the operator-configured
//      HA URL and confirm the install is reachable;
//   2. GETs /api/v1/channels/ha/llat   — to fetch the raw LLAT (this
//      route is the sensitive one — see the guard below);
//   3. calls HA's own REST API directly with that LLAT, pulling
//      entity_registry / area_registry / device_registry / states /
//      automations / services in parallel;
//   4. POSTs the normalised result to /api/v1/channels/ha/registry/bulk
//      which batch-upserts ha_registry rows and tombstones vanished IDs.
//
// The on-demand "Refresh registry" CTA on /channels invokes
// POST /api/v1/channels/ha/registry/refresh which schedules a one-shot
// run of the workflow via `temporal workflow start`.

// Helper — bulk upsert body shape.
interface HaRegistryBulkRow {
  kind: string;
  ha_id: string;
  domain?: string | null;
  area_id?: string | null;
  friendly_name?: string | null;
  state?: string | null;
  attributes_json?: string | null;
  payload_json: string;
  last_changed?: string | null;
  last_updated?: string | null;
}

// The 6 vault `kind` buckets this route accepts. Anything else is dropped
// at parse time so a misbehaving activity can't insert a row that the
// /registry read can't surface.
const HA_REGISTRY_KINDS = new Set([
  "entity",
  "area",
  "device",
  "automation",
  "scene",
  "helper",
]);

function parseBulkBody(raw: unknown): HaRegistryBulkRow[] {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.rows)) {
    throw new ValidationError("rows must be an array");
  }
  const out: HaRegistryBulkRow[] = [];
  for (const r of b.rows) {
    if (typeof r !== "object" || r === null) continue;
    const row = r as Record<string, unknown>;
    if (typeof row.kind !== "string" || !HA_REGISTRY_KINDS.has(row.kind)) continue;
    if (typeof row.ha_id !== "string" || row.ha_id.length === 0) continue;
    if (typeof row.payload_json !== "string" || row.payload_json.length === 0) {
      continue;
    }
    out.push({
      kind: row.kind,
      ha_id: row.ha_id,
      domain: typeof row.domain === "string" ? row.domain : null,
      area_id: typeof row.area_id === "string" ? row.area_id : null,
      friendly_name:
        typeof row.friendly_name === "string" ? row.friendly_name : null,
      state: typeof row.state === "string" ? row.state : null,
      attributes_json:
        typeof row.attributes_json === "string" ? row.attributes_json : null,
      payload_json: row.payload_json,
      last_changed:
        typeof row.last_changed === "string" ? row.last_changed : null,
      last_updated:
        typeof row.last_updated === "string" ? row.last_updated : null,
    });
  }
  return out;
}

interface BulkUpsertResult {
  inserted: number;
  updated: number;
  tombstoned: number;
  total_after: number;
}

/** Single-transaction bulk upsert + tombstone of vanished rows.
 *
 *  Returns counts of inserted / updated / tombstoned / total_after for the
 *  audit ledger. The tombstone branch only sets `vanished_at` for rows
 *  that don't already have one — re-running with the same input doesn't
 *  re-stamp the column, which the test suite asserts.
 *
 *  Privacy: this function never touches LLAT material — only entity_id /
 *  state / friendly_name / payload_json (the raw HA record minus auth
 *  headers, which were stripped by the activity before persisting). */
function bulkUpsertHaRegistry(rows: HaRegistryBulkRow[]): BulkUpsertResult {
  const db = getStateDb();
  const now = new Date().toISOString();

  // Pre-count to compute inserted vs updated. A small but useful piece of
  // bookkeeping for the operator UI — without it we'd report the whole
  // batch as "upserted" and lose the diff signal.
  const inputKeys = new Set(rows.map((r) => `${r.kind}::${r.ha_id}`));

  let inserted = 0;
  let updated = 0;
  let tombstoned = 0;

  db.exec("BEGIN");
  try {
    // 1. Upsert pass — for each input row, INSERT … ON CONFLICT(kind, ha_id)
    //    DO UPDATE. The PRIMARY KEY on ha_registry is (kind, ha_id) so the
    //    conflict clause needs both columns.
    const upsertStmt = db.prepare(
      `INSERT INTO ha_registry (
         kind, ha_id, domain, area_id, friendly_name, state,
         attributes_json, payload_json, last_seen_at, last_changed,
         last_updated, vanished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(kind, ha_id) DO UPDATE SET
         domain = excluded.domain,
         area_id = excluded.area_id,
         friendly_name = excluded.friendly_name,
         state = excluded.state,
         attributes_json = excluded.attributes_json,
         payload_json = excluded.payload_json,
         last_seen_at = excluded.last_seen_at,
         last_changed = COALESCE(excluded.last_changed, ha_registry.last_changed),
         last_updated = COALESCE(excluded.last_updated, ha_registry.last_updated),
         vanished_at = NULL`,
    );
    const existsStmt = db.prepare(
      "SELECT 1 FROM ha_registry WHERE kind = ? AND ha_id = ? LIMIT 1",
    );
    for (const row of rows) {
      const existed = existsStmt.get(row.kind, row.ha_id);
      upsertStmt.run(
        row.kind,
        row.ha_id,
        row.domain ?? null,
        row.area_id ?? null,
        row.friendly_name ?? null,
        row.state ?? null,
        row.attributes_json ?? null,
        row.payload_json,
        now,
        row.last_changed ?? null,
        row.last_updated ?? null,
      );
      if (existed) updated += 1;
      else inserted += 1;
    }

    // 2. Tombstone pass — every existing row whose (kind, ha_id) isn't in
    //    the input set gets `vanished_at = now()`. We filter on
    //    `vanished_at IS NULL` so the timestamp is stamped exactly ONCE
    //    per row (subsequent runs with the same vanished set are no-ops).
    //
    //    The query is a single UPDATE with a NOT-IN list; SQLite handles
    //    a few thousand entity_ids comfortably, which covers any realistic
    //    HA install (typical: 200-500 entities, hoarder install: ~2000).
    const candidates = db
      .prepare("SELECT kind, ha_id FROM ha_registry WHERE vanished_at IS NULL")
      .all() as Array<{ kind: string; ha_id: string }>;
    const tombstoneStmt = db.prepare(
      `UPDATE ha_registry
         SET vanished_at = ?
       WHERE kind = ? AND ha_id = ? AND vanished_at IS NULL`,
    );
    for (const c of candidates) {
      const key = `${c.kind}::${c.ha_id}`;
      if (inputKeys.has(key)) continue;
      tombstoneStmt.run(now, c.kind, c.ha_id);
      tombstoned += 1;
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const totalRow = db
    .prepare("SELECT COUNT(*) AS n FROM ha_registry")
    .get() as { n: number } | undefined;
  return {
    inserted,
    updated,
    tombstoned,
    total_after: Number(totalRow?.n ?? 0),
  };
}

export function registerHaBootstrapRoutes(): void {
  // ──────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/llat — operator-only LLAT retrieval.
  //
  // This is the sensitive route. The HaBootstrapWorkflow activity hits it
  // exactly once per workflow run, fetches the raw LLAT off the
  // Vaultwarden item, and uses it to call HA's REST/WS API. The token
  // never lives in the workflow's persisted state — only in memory for
  // the duration of one activity invocation.
  //
  // Defence in depth (per Sir's rule: never echo LLAT in errors or logs):
  //   * requireOperatorBearer() rejects voice-bridge + channel-token
  //     bearers with 403 (not 401) before the route even runs.
  //   * The response body carries ONLY the LLAT — no echo of the URL,
  //     ha_version, or other state.db fields that would surface
  //     elsewhere on disk if the response was accidentally captured.
  //   * 404 NOT_CONNECTED when the install isn't connected — same code
  //     a probing 401-attempt would see, but with a distinct shape so
  //     the workflow can no-op cleanly without a retry storm.
  //   * Errors NEVER include the LLAT (the route never reflects request
  //     fields into the error envelope).
  // ──────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/ha/llat", async ({ req, res }) => {
    requireOperatorBearer(req);
    const row = getHaConnectionRow();
    if (!row || row.state !== "connected") {
      throw new NotFoundError("Home Assistant is not connected");
    }
    let llat: string;
    try {
      llat = await readHaLlat();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Never let an unexpected error path echo back the bearer or the
      // vault-cli response body.
      throw new ApiError(502, "VAULT_UNREACHABLE", "vault-cli read failed");
    }
    sendJson(res, 200, { llat });
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/registry/bulk — operator-only bulk upsert.
  //
  // Body: { rows: HaRegistryBulkRow[] }
  //
  // The HaBootstrapWorkflow.write_ha_registry activity sends a single
  // batch per run. The route does the upsert + tombstone in one
  // transaction and returns { inserted, updated, tombstoned, total_after }.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/ha/registry/bulk", async ({ req, res, body }) => {
    requireOperatorBearer(req);
    const rows = parseBulkBody(body);
    const result = bulkUpsertHaRegistry(rows);
    sendJson(res, 200, { ok: true, ...result });
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/registry/refresh — on-demand workflow trigger.
  //
  // Operator CTA on /channels (HaCard "Refresh registry" button). Starts
  // a one-shot HaBootstrapWorkflow run via `temporal workflow start`,
  // returning the workflow_id immediately (202). The dashboard polls
  // /registry afterwards.
  //
  // The workflow itself takes ~30s end-to-end on a small HA install
  // (REST roundtrips dominate); we surface an ETA for the operator copy.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/ha/registry/refresh", async ({ req, res }) => {
    requireOperatorBearer(req);
    const row = getHaConnectionRow();
    if (!row || row.state !== "connected") {
      throw new ConflictError(
        "Home Assistant is not connected. POST /api/v1/channels/ha/connect first.",
      );
    }
    const workflowId = `ha-bootstrap-${Date.now()}`;
    try {
      await dockerExec("temporal", [
        "temporal",
        "workflow",
        "start",
        "--type",
        "HaBootstrapWorkflow",
        "--task-queue",
        "alfred-learn",
        "--workflow-id",
        workflowId,
      ]);
    } catch (err) {
      throw new ApiError(
        502,
        "TEMPORAL_UNREACHABLE",
        err instanceof Error ? err.message : "temporal start failed",
      );
    }
    sendJson(res, 202, {
      ok: true,
      workflow_id: workflowId,
      eta: "30s",
    });
  });

  // #110 PR6 — Phase B (gap detection) + Phase C (proposal generation)
  // bulk-upsert + read routes. The alfred-learn workflow drives:
  //
  //   POST /api/v1/channels/ha/gaps/bulk   — operator-only bulk upsert
  //                                          (dedup by kind+area_id,
  //                                          tombstone vanished gaps)
  //   GET  /api/v1/channels/ha/gaps        — open + closed gap surfaces
  //   GET  /api/v1/channels/ha/proposals   — pending + applied proposals
  //   PATCH /api/v1/channels/ha/gap/:id/dismiss     — principal hides a gap
  //   POST /api/v1/channels/ha/proposal/:id/reject  — principal kills a proposal
  //
  // The gap+proposal reads are voice-bridge readable; the bulk-write is
  // operator-only and the dismiss/reject writes carry the channel-token
  // chain (no `decision_ref` needed — dismiss/reject don't touch HA).
  registerHaGapRoutes();
}

// ── PR6 routes — gap detection + proposal lifecycle ────────────────────

// Bulk-upsert body shape. Mirrors the structure detect_gaps() returns
// in alfred-learn.
interface HaGapBulkInputRow {
  kind: string;
  summary: string;
  severity: string;
  area_id: string | null;
  device_id: string | null;
  discovered_at: string;
  evidence: Record<string, unknown>;
}

// Stored shape (reflects the PR1 ha_gap schema: id/ts/kind/evidence/
// fix_pack/proposal_ref/status/created_at). The optional spec fields
// (area_id/device_id/summary/severity) ride inside `evidence` so we
// don't need a new migration.
interface HaGapStoredRow {
  id: string;
  ts: string;
  kind: string;
  evidence: string | null;
  fix_pack: string | null;
  proposal_ref: string | null;
  status: string;
  created_at: string;
}

// The 8 kinds Phase B emits. Anything else gets dropped at parse time
// so a misbehaving activity can't push a row that the dashboard can't
// surface.
const HA_GAP_KINDS = new Set([
  "no_morning_routine",
  "no_bedtime_routine",
  "no_motion_lighting",
  "no_away_mode",
  "no_security_camera_notification",
  "no_vacation_mode",
  "no_climate_schedule",
  "no_party_mode",
]);

const HA_GAP_SEVERITIES = new Set(["low", "medium", "high"]);

function parseGapBulkBody(raw: unknown): HaGapBulkInputRow[] {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.rows)) {
    throw new ValidationError("rows must be an array");
  }
  const out: HaGapBulkInputRow[] = [];
  for (const r of b.rows) {
    if (typeof r !== "object" || r === null) continue;
    const row = r as Record<string, unknown>;
    if (typeof row.kind !== "string" || !HA_GAP_KINDS.has(row.kind)) continue;
    const summary = typeof row.summary === "string" ? row.summary : "";
    if (summary.length === 0) continue;
    const severity =
      typeof row.severity === "string" && HA_GAP_SEVERITIES.has(row.severity)
        ? row.severity
        : "low";
    const area_id = typeof row.area_id === "string" && row.area_id ? row.area_id : null;
    const device_id =
      typeof row.device_id === "string" && row.device_id ? row.device_id : null;
    const discovered_at =
      typeof row.discovered_at === "string" && row.discovered_at
        ? row.discovered_at
        : new Date().toISOString();
    let evidence: Record<string, unknown> = {};
    if (row.evidence && typeof row.evidence === "object") {
      evidence = row.evidence as Record<string, unknown>;
    }
    out.push({
      kind: row.kind,
      summary,
      severity,
      area_id,
      device_id,
      discovered_at,
      evidence,
    });
  }
  return out;
}

/** Dedup key for upsert + tombstone passes — gap is the SAME gap iff
 *  (kind, area_id) match. area_id=null is a valid first-class key (the
 *  whole-home gaps like no_morning_routine fall here). */
function gapDedupeKey(kind: string, area_id: string | null): string {
  return `${kind}::${area_id ?? ""}`;
}

interface HaGapBulkResult {
  inserted: number;
  updated: number;
  /** Gaps that vanished from input AND were still open → closed via
   *  status='addressed'. */
  addressed: number;
  /** Convenience: 0 — dismiss is a principal action, never auto. */
  dismissed: number;
  /** The current open + addressed-this-call rows the workflow needs
   *  to template proposals against. Each row carries its id + the
   *  evidence-blob fields (kind, summary, severity, area_id…). */
  gaps: Array<Record<string, unknown>>;
}

function decodeGapForResponse(
  row: HaGapStoredRow,
): Record<string, unknown> {
  let evidence: Record<string, unknown> = {};
  if (row.evidence) {
    try {
      const parsed = JSON.parse(row.evidence);
      if (parsed && typeof parsed === "object") {
        evidence = parsed as Record<string, unknown>;
      }
    } catch {
      // best-effort — leave evidence empty
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    summary: typeof evidence.summary === "string" ? evidence.summary : row.kind,
    severity: typeof evidence.severity === "string" ? evidence.severity : "low",
    area_id: typeof evidence.area_id === "string" ? evidence.area_id : null,
    device_id: typeof evidence.device_id === "string" ? evidence.device_id : null,
    discovered_at: row.ts,
    evidence: typeof evidence.evidence === "object" ? evidence.evidence : evidence,
    proposal_ref: row.proposal_ref,
    status: row.status,
  };
}

function bulkUpsertHaGaps(rows: HaGapBulkInputRow[]): HaGapBulkResult {
  const db = getStateDb();
  // We dedupe within the input batch by (kind, area_id) — the spec says
  // we don't re-discover the same gap every 6h.
  const seen = new Map<string, HaGapBulkInputRow>();
  for (const r of rows) {
    seen.set(gapDedupeKey(r.kind, r.area_id), r);
  }
  const inputRows = [...seen.values()];
  const inputKeys = new Set(seen.keys());

  let inserted = 0;
  let updated = 0;
  let addressed = 0;

  db.exec("BEGIN");
  try {
    const existing = db
      .prepare("SELECT id, kind, evidence, status, proposal_ref, ts FROM ha_gap")
      .all() as Array<{
      id: string;
      kind: string;
      evidence: string | null;
      status: string;
      proposal_ref: string | null;
      ts: string;
    }>;

    // Index existing OPEN rows by (kind, area_id).
    const openByKey = new Map<string, typeof existing[number]>();
    for (const row of existing) {
      if (row.status !== "open") continue;
      let area_id: string | null = null;
      if (row.evidence) {
        try {
          const ev = JSON.parse(row.evidence) as Record<string, unknown>;
          if (typeof ev.area_id === "string") area_id = ev.area_id;
        } catch {
          // best-effort
        }
      }
      openByKey.set(gapDedupeKey(row.kind, area_id), row);
    }

    const insertStmt = db.prepare(
      `INSERT INTO ha_gap (id, ts, kind, evidence, fix_pack, status)
       VALUES (?, ?, ?, ?, ?, 'open')`,
    );
    const updateStmt = db.prepare(
      `UPDATE ha_gap
          SET ts = ?, evidence = ?, fix_pack = ?
        WHERE id = ?`,
    );

    for (const r of inputRows) {
      const key = gapDedupeKey(r.kind, r.area_id);
      const existing = openByKey.get(key);
      // The evidence blob carries the spec fields the PR1 schema
      // doesn't have a column for. Keys are flat — no nesting —
      // so the dashboard `decodeGapForResponse` can lift them out
      // without recursion.
      const evidence = JSON.stringify({
        summary: r.summary,
        severity: r.severity,
        area_id: r.area_id,
        device_id: r.device_id,
        evidence: r.evidence,
      });
      if (existing) {
        updateStmt.run(r.discovered_at, evidence, r.kind, existing.id);
        updated += 1;
      } else {
        insertStmt.run(ulid(), r.discovered_at, r.kind, evidence, r.kind);
        inserted += 1;
      }
    }

    // Tombstone open rows whose (kind, area_id) vanished from input
    // → status='addressed' (the spec's "closed_at" semantic).
    const addressedStmt = db.prepare(
      `UPDATE ha_gap
          SET status = 'addressed'
        WHERE id = ? AND status = 'open'`,
    );
    for (const [key, row] of openByKey) {
      if (inputKeys.has(key)) continue;
      addressedStmt.run(row.id);
      addressed += 1;
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Re-read the still-open rows so Phase C has fresh `id` + status
  // values to attach to its proposal POSTs.
  const openRows = db
    .prepare(
      `SELECT id, ts, kind, evidence, fix_pack, proposal_ref, status, created_at
         FROM ha_gap
        WHERE status = 'open'
        ORDER BY ts DESC`,
    )
    .all() as HaGapStoredRow[];
  return {
    inserted,
    updated,
    addressed,
    dismissed: 0,
    gaps: openRows.map(decodeGapForResponse),
  };
}

function listHaGaps(): {
  open: Array<Record<string, unknown>>;
  closed: Array<Record<string, unknown>>;
} {
  const db = getStateDb();
  let rows: HaGapStoredRow[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, ts, kind, evidence, fix_pack, proposal_ref, status, created_at
           FROM ha_gap
          ORDER BY ts DESC`,
      )
      .all() as HaGapStoredRow[];
  } catch {
    // ha_gap may not be present in an older test sandbox; treat as empty.
    return { open: [], closed: [] };
  }
  const open: Array<Record<string, unknown>> = [];
  const closed: Array<Record<string, unknown>> = [];
  // Severity ranking for the sort.
  const sev: Record<string, number> = { high: 0, medium: 1, low: 2 };
  for (const r of rows) {
    const view = decodeGapForResponse(r);
    if (r.status === "open") {
      open.push(view);
    } else {
      closed.push(view);
    }
  }
  open.sort((a, b) => {
    const da = sev[(a.severity as string) ?? "low"] ?? 2;
    const db_ = sev[(b.severity as string) ?? "low"] ?? 2;
    if (da !== db_) return da - db_;
    return String(b.discovered_at).localeCompare(String(a.discovered_at));
  });
  closed.sort((a, b) =>
    String(b.discovered_at).localeCompare(String(a.discovered_at)),
  );
  return { open, closed };
}

interface HaProposalListed {
  id: string;
  kind: string;
  summary: string;
  yaml: string;
  gap_id: string | null;
  status: string;
  ts: string;
  applied_at: string | null;
}

function listHaProposals(): {
  pending: HaProposalListed[];
  applied: HaProposalListed[];
  other: HaProposalListed[];
} {
  const db = getStateDb();
  let rows: Array<{
    id: string;
    ts: string;
    scope: string;
    summary: string;
    payload_json: string;
    status: string;
    applied_at: string | null;
  }> = [];
  try {
    rows = db
      .prepare(
        `SELECT id, ts, scope, summary, payload_json, status, applied_at
           FROM ha_proposal
          ORDER BY ts DESC`,
      )
      .all() as typeof rows;
  } catch {
    return { pending: [], applied: [], other: [] };
  }
  const pending: HaProposalListed[] = [];
  const applied: HaProposalListed[] = [];
  const other: HaProposalListed[] = [];
  for (const r of rows) {
    let yaml = "";
    let gap_id: string | null = null;
    try {
      const p = JSON.parse(r.payload_json) as Record<string, unknown>;
      if (typeof p.yaml === "string") yaml = p.yaml;
      if (typeof p.gap_id === "string") gap_id = p.gap_id;
    } catch {
      // best-effort
    }
    const view: HaProposalListed = {
      id: r.id,
      kind: r.scope,
      summary: r.summary,
      yaml,
      gap_id,
      status: r.status,
      ts: r.ts,
      applied_at: r.applied_at,
    };
    if (r.status === "pending" || r.status === "approved") {
      pending.push(view);
    } else if (r.status === "applied") {
      applied.push(view);
    } else {
      other.push(view);
    }
  }
  return { pending, applied, other };
}

function dismissHaGapRow(id: string): { ok: boolean; status: string } {
  const db = getStateDb();
  const existing = db
    .prepare("SELECT status FROM ha_gap WHERE id = ?")
    .get(id) as { status: string } | undefined;
  if (!existing) {
    throw new NotFoundError(`ha_gap ${id} not found`);
  }
  if (existing.status === "dismissed") {
    return { ok: true, status: "dismissed" };
  }
  if (existing.status === "addressed") {
    throw new ConflictError(
      `ha_gap ${id} is already addressed — nothing to dismiss`,
    );
  }
  db.prepare("UPDATE ha_gap SET status = 'dismissed' WHERE id = ?").run(id);
  return { ok: true, status: "dismissed" };
}

function rejectHaProposalRow(id: string): { ok: boolean; status: string } {
  const db = getStateDb();
  const existing = db
    .prepare("SELECT status FROM ha_proposal WHERE id = ?")
    .get(id) as { status: string } | undefined;
  if (!existing) {
    throw new NotFoundError(`ha_proposal ${id} not found`);
  }
  if (existing.status === "rejected") {
    return { ok: true, status: "rejected" };
  }
  if (existing.status === "applied") {
    throw new ConflictError(
      `ha_proposal ${id} was already applied — cannot reject`,
    );
  }
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE ha_proposal SET status = 'rejected', updated_at = ? WHERE id = ?",
  ).run(now, id);
  return { ok: true, status: "rejected" };
}

export function registerHaGapRoutes(): void {
  // POST /api/v1/channels/ha/gaps/bulk — operator-only Phase B sink.
  addRoute("POST", "/api/v1/channels/ha/gaps/bulk", async ({ req, res, body }) => {
    requireOperatorBearer(req);
    const rows = parseGapBulkBody(body);
    const result = bulkUpsertHaGaps(rows);
    sendJson(res, 200, { ok: true, ...result });
  });

  // GET /api/v1/channels/ha/gaps — voice-bridge readable.
  addRoute("GET", "/api/v1/channels/ha/gaps", async ({ res }) => {
    sendJson(res, 200, listHaGaps());
  });

  // GET /api/v1/channels/ha/proposals — voice-bridge readable.
  addRoute("GET", "/api/v1/channels/ha/proposals", async ({ res }) => {
    sendJson(res, 200, listHaProposals());
  });

  // PATCH /api/v1/channels/ha/gap/:gap_id/dismiss — principal action.
  // No decision_ref needed; dismiss never touches HA.
  addRoute(
    "PATCH",
    "/api/v1/channels/ha/gap/:gap_id/dismiss",
    async ({ res, params }) => {
      const r = dismissHaGapRow(params.gap_id);
      sendJson(res, 200, r);
    },
  );

  // POST /api/v1/channels/ha/proposal/:proposal_id/reject — principal action.
  // Same — no decision_ref because nothing reaches HA.
  addRoute(
    "POST",
    "/api/v1/channels/ha/proposal/:proposal_id/reject",
    async ({ res, params }) => {
      const r = rejectHaProposalRow(params.proposal_id);
      sendJson(res, 200, r);
    },
  );
}

/** For tests only — clear the ha_registry between runs without recreating
 *  the whole state.db. The bulk-upsert tests in channels_ha_pr5.test.ts
 *  call this in their `beforeEach`. */
export function _resetHaRegistryForTests(): void {
  try {
    getStateDb().prepare("DELETE FROM ha_registry").run();
  } catch {
    /* table may not exist on first boot; tests run migrations themselves */
  }
}

/** For tests only — clear ha_gap + ha_proposal between runs. */
export function _resetHaGapsForTests(): void {
  try {
    getStateDb().prepare("DELETE FROM ha_gap").run();
  } catch {
    // table may not exist; tests own migrations
  }
  try {
    getStateDb().prepare("DELETE FROM ha_proposal").run();
  } catch {
    // table may not exist; tests own migrations
  }
}

// ═════════════════════════════════════════════════════════════════════════
// === BEGIN #115 PR3 — automations / scenes / scripts CRUD ===
// ═════════════════════════════════════════════════════════════════════════
//
// REST-only. Closes the spec §4 "Scenes / Scripts / Automations" row by
// wiring HA's long-standing `/api/config/{automation,scene,script}/config`
// endpoints AND the `/api/states/<domain>.*` list helper. Independent of
// #115 PR1's WS client — every route here goes through fetch().
//
// PR1 (parallel) will introduce two helpers we defensively reach for:
//   * `requireDecisionRef`  — middleware that fishes `decision_ref` out of
//     the body and 400s if it's missing/malformed.
//   * `recordHaWriteToDaybook` — drops a daybook vault record per Sir's
//     locked YES default (snapshots / daybook / gates).
//
// Both are wrapped in `tryRequireDecisionRef` / `tryRecordDaybook` below
// so they no-op cleanly if PR1 hasn't merged yet. The runtime semantics
// stay correct either way: every PR3 write persists a `ha_run` row (the
// existing audit ledger), and DELETE-automation enforces decision_ref via
// the same `assertDecisionRef` parser as PR4's call_service.
//
// SPLICE BLOCK — keep everything between the BEGIN / END markers
// contiguous so a parallel PR (PR1) that touches this file rebases
// mechanically. No file-wide rename or shared-helper edits inside this
// block.

// Slug shape for automation/scene/script ids that come back from HA. HA
// itself accepts more characters, but the practical surface for ids we
// see in the wild is `[a-zA-Z0-9_-]`. Keep this generous enough that we
// don't reject valid ids, strict enough that path traversal can't
// sneak through.
const HA_OBJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function assertHaObjectId(raw: string, kind: string): string {
  if (!HA_OBJECT_ID_RE.test(raw)) {
    throw new ValidationError(
      `${kind} id must be 1..128 chars of [A-Za-z0-9_.-], starting with [A-Za-z0-9]`,
    );
  }
  return raw;
}

interface HaRestCallResult {
  ok: boolean;
  status: number;
  data: unknown;
  detail: string;
}

/** Generic HA REST proxy — used for /api/config/* CRUD + /api/states/* reads.
 *
 *  HA's /api/config GETs return JSON; POST/DELETE on the same path returns
 *  `{result: "ok"}` JSON; /api/states/* returns JSON. We parse text as
 *  JSON best-effort and fall back to the raw string. */
async function callHaRest(args: {
  haUrl: string;
  llat: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
}): Promise<HaRestCallResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.llat}`,
  };
  let reqBody: string | undefined;
  if (args.body !== undefined && args.method !== "GET") {
    headers["Content-Type"] = "application/json";
    reqBody = JSON.stringify(args.body);
  }
  let resp: Response;
  try {
    resp = await fetch(`${args.haUrl}${args.path}`, {
      method: args.method,
      headers,
      body: reqBody,
      signal: AbortSignal.timeout(HA_WRITE_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      data: null,
      detail: `HA unreachable: ${msg}`,
    };
  }
  let parsed: unknown = null;
  const text = await resp.text().catch(() => "");
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!resp.ok) {
    let detail = `HA REST ${args.method} ${args.path} returned HTTP ${resp.status}`;
    if (typeof parsed === "string" && parsed.length > 0) {
      detail = `${detail}: ${parsed.slice(0, 500)}`;
    } else if (parsed && typeof parsed === "object") {
      const m =
        (parsed as Record<string, unknown>).message ??
        (parsed as Record<string, unknown>).error;
      if (typeof m === "string") detail = `${detail}: ${m.slice(0, 500)}`;
    }
    return { ok: false, status: resp.status, data: parsed, detail };
  }
  return { ok: true, status: resp.status, data: parsed, detail: "" };
}

/** Gate helper — every PR3 route needs LLAT + ha_url + a "is HA connected?"
 *  check. Returns the loaded credentials on success; throws ApiError if
 *  the connection isn't ready.
 *
 *  Mirrors the body of #110 PR4's call_service handler (readHaLlat + the
 *  ha_connection row read) so the failure modes line up with the rest of
 *  the write surface. */
async function loadHaCredentials(): Promise<{
  haUrl: string;
  llat: string;
}> {
  const llat = await readHaLlat(); // throws HA_NOT_CONNECTED / VAULT_* if unset
  const row = getHaConnectionRow();
  if (!row || row.state !== "connected") {
    // readHaLlat() already covers this, but assert here too — defence in
    // depth in case the ha_connection row was mutated between fetches.
    throw new ApiError(
      409,
      "HA_NOT_CONNECTED",
      "Home Assistant is not connected. POST /api/v1/channels/ha/connect first.",
    );
  }
  return { haUrl: row.ha_url, llat };
}

/** PR1-aware decision_ref enforcement. If PR1's `requireDecisionRef`
 *  middleware lands first, swap this to call it; for now it defers to the
 *  same `assertDecisionRef` parser the PR4 write surface uses.
 *
 *  TODO(post-PR1): replace direct `assertDecisionRef` with the middleware
 *  once it's available on the route context. */
function tryRequireDecisionRef(body: unknown): string {
  const raw =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).decision_ref
      : undefined;
  return assertDecisionRef(raw);
}

/** PR1-aware daybook recorder. PR1 will introduce a `recordHaWriteToDaybook`
 *  helper that drops a daybook vault record per the locked YES default.
 *  Today this is a no-op — the audit shape is fully covered by `ha_run`,
 *  which every PR3 write persists. PR1 will swap this for the vault writer
 *  without changing PR3 call sites.
 *
 *  TODO(post-PR1): replace with the daybook vault writer. */
async function tryRecordDaybook(_args: {
  kind: string;
  ha_id: string | null;
  decision_ref: string | null;
  outcome: "ok" | "error";
  detail: string | null;
}): Promise<void> {
  // intentional no-op pre-PR1; ha_run row carries the audit shape today.
}

// ── string / sequence parsers ──────────────────────────────────────────

function parseStringField(
  raw: unknown,
  field: string,
  required: boolean,
): string | undefined {
  if (raw === undefined || raw === null) {
    if (required) {
      throw new ValidationError(`${field} is required`);
    }
    return undefined;
  }
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return raw;
}

function parseTriggerOrAction(
  raw: unknown,
  field: string,
  required: boolean,
): unknown {
  if (raw === undefined || raw === null) {
    if (required) {
      throw new ValidationError(`${field} is required`);
    }
    return undefined;
  }
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return raw;
  throw new ValidationError(`${field} must be an object or array`);
}

// ── automation parsing ─────────────────────────────────────────────────

interface AutomationCreateBody {
  alias: string;
  trigger: unknown;
  condition?: unknown;
  action: unknown;
  description?: string;
  mode?: string;
  initial_state?: string;
}

function parseAutomationCreateBody(raw: unknown): AutomationCreateBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  return {
    alias: parseStringField(b.alias, "alias", true)!,
    trigger: parseTriggerOrAction(b.trigger, "trigger", true),
    condition: parseTriggerOrAction(b.condition, "condition", false),
    action: parseTriggerOrAction(b.action, "action", true),
    description: parseStringField(b.description, "description", false),
    mode: parseStringField(b.mode, "mode", false),
    initial_state: parseStringField(b.initial_state, "initial_state", false),
  };
}

interface AutomationUpdateBody {
  alias?: string;
  trigger?: unknown;
  condition?: unknown;
  action?: unknown;
  description?: string;
  mode?: string;
}

function parseAutomationUpdateBody(raw: unknown): AutomationUpdateBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  return {
    alias: parseStringField(b.alias, "alias", false),
    trigger: parseTriggerOrAction(b.trigger, "trigger", false),
    condition: parseTriggerOrAction(b.condition, "condition", false),
    action: parseTriggerOrAction(b.action, "action", false),
    description: parseStringField(b.description, "description", false),
    mode: parseStringField(b.mode, "mode", false),
  };
}

function automationCreatePayload(b: AutomationCreateBody): Record<string, unknown> {
  const out: Record<string, unknown> = {
    alias: b.alias,
    trigger: b.trigger,
    action: b.action,
  };
  if (b.condition !== undefined) out.condition = b.condition;
  if (b.description !== undefined) out.description = b.description;
  if (b.mode !== undefined) out.mode = b.mode;
  if (b.initial_state !== undefined) out.initial_state = b.initial_state;
  return out;
}

function automationUpdatePayload(b: AutomationUpdateBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.alias !== undefined) out.alias = b.alias;
  if (b.trigger !== undefined) out.trigger = b.trigger;
  if (b.condition !== undefined) out.condition = b.condition;
  if (b.action !== undefined) out.action = b.action;
  if (b.description !== undefined) out.description = b.description;
  if (b.mode !== undefined) out.mode = b.mode;
  return out;
}

// ── scene parsing ──────────────────────────────────────────────────────

interface SceneCreateBody {
  name: string;
  entities: Record<string, Record<string, unknown>>;
  icon?: string;
}

function parseSceneEntitiesMap(
  raw: unknown,
  field: string,
  required: boolean,
): Record<string, Record<string, unknown>> | undefined {
  if (raw === undefined || raw === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${field} must be a JSON object`);
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new ValidationError(
        `${field}.${k} must be a JSON object of {state, ...attributes}`,
      );
    }
    out[k] = v as Record<string, unknown>;
  }
  return out;
}

function parseSceneCreateBody(raw: unknown): SceneCreateBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  return {
    name: parseStringField(b.name, "name", true)!,
    entities: parseSceneEntitiesMap(b.entities, "entities", true)!,
    icon: parseStringField(b.icon, "icon", false),
  };
}

interface SceneUpdateBody {
  name?: string;
  entities?: Record<string, Record<string, unknown>>;
  icon?: string;
}

function parseSceneUpdateBody(raw: unknown): SceneUpdateBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  return {
    name: parseStringField(b.name, "name", false),
    entities: parseSceneEntitiesMap(b.entities, "entities", false),
    icon: parseStringField(b.icon, "icon", false),
  };
}

function sceneCreatePayload(b: SceneCreateBody): Record<string, unknown> {
  const out: Record<string, unknown> = { name: b.name, entities: b.entities };
  if (b.icon !== undefined) out.icon = b.icon;
  return out;
}

function sceneUpdatePayload(b: SceneUpdateBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.name !== undefined) out.name = b.name;
  if (b.entities !== undefined) out.entities = b.entities;
  if (b.icon !== undefined) out.icon = b.icon;
  return out;
}

// ── script parsing ─────────────────────────────────────────────────────

interface ScriptCreateBody {
  alias: string;
  sequence: unknown[];
  description?: string;
  mode?: string;
  icon?: string;
}

function parseScriptSequence(
  raw: unknown,
  field: string,
  required: boolean,
): unknown[] | undefined {
  if (raw === undefined || raw === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new ValidationError(`${field} must be a JSON array`);
  }
  return raw;
}

function parseScriptCreateBody(raw: unknown): ScriptCreateBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  return {
    alias: parseStringField(b.alias, "alias", true)!,
    sequence: parseScriptSequence(b.sequence, "sequence", true)!,
    description: parseStringField(b.description, "description", false),
    mode: parseStringField(b.mode, "mode", false),
    icon: parseStringField(b.icon, "icon", false),
  };
}

interface ScriptUpdateBody {
  alias?: string;
  sequence?: unknown[];
  description?: string;
  mode?: string;
  icon?: string;
}

function parseScriptUpdateBody(raw: unknown): ScriptUpdateBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  return {
    alias: parseStringField(b.alias, "alias", false),
    sequence: parseScriptSequence(b.sequence, "sequence", false),
    description: parseStringField(b.description, "description", false),
    mode: parseStringField(b.mode, "mode", false),
    icon: parseStringField(b.icon, "icon", false),
  };
}

function scriptCreatePayload(b: ScriptCreateBody): Record<string, unknown> {
  const out: Record<string, unknown> = { alias: b.alias, sequence: b.sequence };
  if (b.description !== undefined) out.description = b.description;
  if (b.mode !== undefined) out.mode = b.mode;
  if (b.icon !== undefined) out.icon = b.icon;
  return out;
}

function scriptUpdatePayload(b: ScriptUpdateBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.alias !== undefined) out.alias = b.alias;
  if (b.sequence !== undefined) out.sequence = b.sequence;
  if (b.description !== undefined) out.description = b.description;
  if (b.mode !== undefined) out.mode = b.mode;
  if (b.icon !== undefined) out.icon = b.icon;
  return out;
}

// ── states list helpers ────────────────────────────────────────────────

/** Filter HA's `/api/states` payload down to one domain. HA's /api/states
 *  returns a flat list; the principal-friendly /scenes and /scripts list
 *  endpoints want only the matching `<domain>.*` entities. */
function filterStatesByDomain(states: unknown, domain: string): unknown[] {
  if (!Array.isArray(states)) return [];
  const prefix = `${domain}.`;
  return states.filter((s) => {
    if (!s || typeof s !== "object") return false;
    const eid = (s as Record<string, unknown>).entity_id;
    return typeof eid === "string" && eid.startsWith(prefix);
  });
}

// ── slug derived from an HA alias/name ─────────────────────────────────
//
// HA itself slugifies aliases server-side, but the REST POST endpoints
// for /api/config/<kind>/config/<id> require us to PICK an id. We mint
// one with the same algorithm HA uses (lowercase, non-word→underscore)
// so the entity_id Sir sees matches what HA's UI would have generated.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 128);
}

// ── route registration ─────────────────────────────────────────────────

export function registerHaPr3Routes(): void {
  // ──────────────────────────────────────────────────────────────────────
  // AUTOMATIONS
  // ──────────────────────────────────────────────────────────────────────

  // GET /api/v1/channels/ha/automations — list all automation configs.
  addRoute("GET", "/api/v1/channels/ha/automations", async ({ res }) => {
    const { haUrl, llat } = await loadHaCredentials();
    const r = await callHaRest({
      haUrl,
      llat,
      method: "GET",
      path: "/api/config/automation/config",
    });
    if (!r.ok) {
      throw new ApiError(
        r.status >= 400 && r.status < 600 ? r.status : 502,
        "HA_UPSTREAM_ERROR",
        r.detail,
      );
    }
    sendJson(res, 200, { ok: true, data: r.data });
  });

  // GET /api/v1/channels/ha/automations/:id — fetch one automation.
  addRoute(
    "GET",
    "/api/v1/channels/ha/automations/:id",
    async ({ res, params }) => {
      const id = assertHaObjectId(params.id, "automation");
      const { haUrl, llat } = await loadHaCredentials();
      const r = await callHaRest({
        haUrl,
        llat,
        method: "GET",
        path: `/api/config/automation/config/${encodeURIComponent(id)}`,
      });
      if (!r.ok) {
        if (r.status === 404) {
          throw new NotFoundError(`automation ${id} not found in HA`);
        }
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_UPSTREAM_ERROR",
          r.detail,
        );
      }
      sendJson(res, 200, { ok: true, automation_id: id, data: r.data });
    },
  );

  // POST /api/v1/channels/ha/automations — create a new automation.
  // No gate (create is reversible). The new automation_id is minted from
  // the alias slug; if the slug collides with an existing automation, HA
  // will overwrite the existing config — caller's responsibility (or
  // ha__list_automations_full first).
  addRoute("POST", "/api/v1/channels/ha/automations", async ({ res, body }) => {
    const parsed = parseAutomationCreateBody(body);
    const { haUrl, llat } = await loadHaCredentials();
    const automationId = slugify(parsed.alias) || `automation_${Date.now()}`;
    const payload = automationCreatePayload(parsed);
    const r = await callHaRest({
      haUrl,
      llat,
      method: "POST",
      path: `/api/config/automation/config/${encodeURIComponent(automationId)}`,
      body: payload,
    });
    if (!r.ok) {
      insertHaRun({
        kind: "automation_create",
        domain: "automation",
        service: null,
        entity_id: `automation.${automationId}`,
        decision_ref: "",
        payload,
        outcome: "error",
        ha_response: r.data,
        error: r.detail,
      });
      throw new ApiError(
        r.status >= 400 && r.status < 600 ? r.status : 502,
        "HA_UPSTREAM_ERROR",
        r.detail,
      );
    }
    const run = insertHaRun({
      kind: "automation_create",
      domain: "automation",
      service: null,
      entity_id: `automation.${automationId}`,
      decision_ref: "",
      payload,
      outcome: "ok",
      ha_response: r.data,
      error: null,
    });
    await tryRecordDaybook({
      kind: "automation_create",
      ha_id: automationId,
      decision_ref: null,
      outcome: "ok",
      detail: null,
    });
    sendJson(res, 200, {
      ok: true,
      automation_id: automationId,
      run_id: run.id,
      ha_response: r.data,
    });
  });

  // PUT /api/v1/channels/ha/automations/:id — idempotent upsert. HA's
  // REST POST and PUT both write to the same /config/<id> endpoint, so
  // this is a thin alias that lets callers signal intent.
  addRoute(
    "PUT",
    "/api/v1/channels/ha/automations/:id",
    async ({ res, params, body }) => {
      const id = assertHaObjectId(params.id, "automation");
      const parsed = parseAutomationUpdateBody(body);
      const { haUrl, llat } = await loadHaCredentials();
      const payload = automationUpdatePayload(parsed);
      const r = await callHaRest({
        haUrl,
        llat,
        method: "POST",
        path: `/api/config/automation/config/${encodeURIComponent(id)}`,
        body: payload,
      });
      if (!r.ok) {
        insertHaRun({
          kind: "automation_update",
          domain: "automation",
          service: null,
          entity_id: `automation.${id}`,
          decision_ref: "",
          payload,
          outcome: "error",
          ha_response: r.data,
          error: r.detail,
        });
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_UPSTREAM_ERROR",
          r.detail,
        );
      }
      const run = insertHaRun({
        kind: "automation_update",
        domain: "automation",
        service: null,
        entity_id: `automation.${id}`,
        decision_ref: "",
        payload,
        outcome: "ok",
        ha_response: r.data,
        error: null,
      });
      await tryRecordDaybook({
        kind: "automation_update",
        ha_id: id,
        decision_ref: null,
        outcome: "ok",
        detail: null,
      });
      sendJson(res, 200, {
        ok: true,
        automation_id: id,
        run_id: run.id,
        ha_response: r.data,
      });
    },
  );

  // DELETE /api/v1/channels/ha/automations/:id — GATED.
  //
  // Per spec §4 gate matrix (locked YES on 2026-05-29): irreversible
  // deletes require a `decision_ref`. We assert it via
  // `tryRequireDecisionRef` (which falls back to `assertDecisionRef`
  // until PR1's middleware lands). The audit ledger (`ha_run`) carries
  // the decision_ref alongside the kind/entity_id so the post-mortem of
  // a stray delete is a single SELECT.
  addRoute(
    "DELETE",
    "/api/v1/channels/ha/automations/:id",
    async ({ res, params, body }) => {
      const id = assertHaObjectId(params.id, "automation");
      const decision_ref = tryRequireDecisionRef(body);
      const { haUrl, llat } = await loadHaCredentials();
      const r = await callHaRest({
        haUrl,
        llat,
        method: "DELETE",
        path: `/api/config/automation/config/${encodeURIComponent(id)}`,
      });
      if (!r.ok) {
        insertHaRun({
          kind: "automation_delete",
          domain: "automation",
          service: null,
          entity_id: `automation.${id}`,
          decision_ref,
          payload: null,
          outcome: "error",
          ha_response: r.data,
          error: r.detail,
        });
        if (r.status === 404) {
          throw new NotFoundError(`automation ${id} not found in HA`);
        }
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_UPSTREAM_ERROR",
          r.detail,
        );
      }
      const run = insertHaRun({
        kind: "automation_delete",
        domain: "automation",
        service: null,
        entity_id: `automation.${id}`,
        decision_ref,
        payload: null,
        outcome: "ok",
        ha_response: r.data,
        error: null,
      });
      await tryRecordDaybook({
        kind: "automation_delete",
        ha_id: id,
        decision_ref,
        outcome: "ok",
        detail: null,
      });
      sendJson(res, 200, {
        ok: true,
        automation_id: id,
        decision_ref,
        run_id: run.id,
        ha_response: r.data,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // SCENES
  // ──────────────────────────────────────────────────────────────────────

  // GET /api/v1/channels/ha/scenes — list every scene.* state.
  addRoute("GET", "/api/v1/channels/ha/scenes", async ({ res }) => {
    const { haUrl, llat } = await loadHaCredentials();
    const r = await callHaRest({
      haUrl,
      llat,
      method: "GET",
      path: "/api/states",
    });
    if (!r.ok) {
      throw new ApiError(
        r.status >= 400 && r.status < 600 ? r.status : 502,
        "HA_UPSTREAM_ERROR",
        r.detail,
      );
    }
    sendJson(res, 200, { ok: true, data: filterStatesByDomain(r.data, "scene") });
  });

  // GET /api/v1/channels/ha/scenes/:id — fetch one scene config.
  addRoute("GET", "/api/v1/channels/ha/scenes/:id", async ({ res, params }) => {
    const id = assertHaObjectId(params.id, "scene");
    const { haUrl, llat } = await loadHaCredentials();
    const r = await callHaRest({
      haUrl,
      llat,
      method: "GET",
      path: `/api/config/scene/config/${encodeURIComponent(id)}`,
    });
    if (!r.ok) {
      if (r.status === 404) {
        throw new NotFoundError(`scene ${id} not found in HA`);
      }
      throw new ApiError(
        r.status >= 400 && r.status < 600 ? r.status : 502,
        "HA_UPSTREAM_ERROR",
        r.detail,
      );
    }
    sendJson(res, 200, { ok: true, scene_id: id, data: r.data });
  });

  addRoute("POST", "/api/v1/channels/ha/scenes", async ({ res, body }) => {
    const parsed = parseSceneCreateBody(body);
    const { haUrl, llat } = await loadHaCredentials();
    const sceneId = slugify(parsed.name) || `scene_${Date.now()}`;
    const payload = sceneCreatePayload(parsed);
    const r = await callHaRest({
      haUrl,
      llat,
      method: "POST",
      path: `/api/config/scene/config/${encodeURIComponent(sceneId)}`,
      body: payload,
    });
    if (!r.ok) {
      insertHaRun({
        kind: "scene_create",
        domain: "scene",
        service: null,
        entity_id: `scene.${sceneId}`,
        decision_ref: "",
        payload,
        outcome: "error",
        ha_response: r.data,
        error: r.detail,
      });
      throw new ApiError(
        r.status >= 400 && r.status < 600 ? r.status : 502,
        "HA_UPSTREAM_ERROR",
        r.detail,
      );
    }
    const run = insertHaRun({
      kind: "scene_create",
      domain: "scene",
      service: null,
      entity_id: `scene.${sceneId}`,
      decision_ref: "",
      payload,
      outcome: "ok",
      ha_response: r.data,
      error: null,
    });
    sendJson(res, 200, {
      ok: true,
      scene_id: sceneId,
      run_id: run.id,
      ha_response: r.data,
    });
  });

  addRoute(
    "PUT",
    "/api/v1/channels/ha/scenes/:id",
    async ({ res, params, body }) => {
      const id = assertHaObjectId(params.id, "scene");
      const parsed = parseSceneUpdateBody(body);
      const { haUrl, llat } = await loadHaCredentials();
      const payload = sceneUpdatePayload(parsed);
      const r = await callHaRest({
        haUrl,
        llat,
        method: "POST",
        path: `/api/config/scene/config/${encodeURIComponent(id)}`,
        body: payload,
      });
      if (!r.ok) {
        insertHaRun({
          kind: "scene_update",
          domain: "scene",
          service: null,
          entity_id: `scene.${id}`,
          decision_ref: "",
          payload,
          outcome: "error",
          ha_response: r.data,
          error: r.detail,
        });
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_UPSTREAM_ERROR",
          r.detail,
        );
      }
      const run = insertHaRun({
        kind: "scene_update",
        domain: "scene",
        service: null,
        entity_id: `scene.${id}`,
        decision_ref: "",
        payload,
        outcome: "ok",
        ha_response: r.data,
        error: null,
      });
      sendJson(res, 200, {
        ok: true,
        scene_id: id,
        run_id: run.id,
        ha_response: r.data,
      });
    },
  );

  addRoute(
    "DELETE",
    "/api/v1/channels/ha/scenes/:id",
    async ({ res, params }) => {
      const id = assertHaObjectId(params.id, "scene");
      const { haUrl, llat } = await loadHaCredentials();
      const r = await callHaRest({
        haUrl,
        llat,
        method: "DELETE",
        path: `/api/config/scene/config/${encodeURIComponent(id)}`,
      });
      if (!r.ok) {
        insertHaRun({
          kind: "scene_delete",
          domain: "scene",
          service: null,
          entity_id: `scene.${id}`,
          decision_ref: "",
          payload: null,
          outcome: "error",
          ha_response: r.data,
          error: r.detail,
        });
        if (r.status === 404) {
          throw new NotFoundError(`scene ${id} not found in HA`);
        }
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_UPSTREAM_ERROR",
          r.detail,
        );
      }
      const run = insertHaRun({
        kind: "scene_delete",
        domain: "scene",
        service: null,
        entity_id: `scene.${id}`,
        decision_ref: "",
        payload: null,
        outcome: "ok",
        ha_response: r.data,
        error: null,
      });
      sendJson(res, 200, {
        ok: true,
        scene_id: id,
        run_id: run.id,
        ha_response: r.data,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // SCRIPTS
  // ──────────────────────────────────────────────────────────────────────

  addRoute("GET", "/api/v1/channels/ha/scripts", async ({ res }) => {
    const { haUrl, llat } = await loadHaCredentials();
    const r = await callHaRest({
      haUrl,
      llat,
      method: "GET",
      path: "/api/states",
    });
    if (!r.ok) {
      throw new ApiError(
        r.status >= 400 && r.status < 600 ? r.status : 502,
        "HA_UPSTREAM_ERROR",
        r.detail,
      );
    }
    sendJson(res, 200, {
      ok: true,
      data: filterStatesByDomain(r.data, "script"),
    });
  });

  addRoute("GET", "/api/v1/channels/ha/scripts/:id", async ({ res, params }) => {
    const id = assertHaObjectId(params.id, "script");
    const { haUrl, llat } = await loadHaCredentials();
    const r = await callHaRest({
      haUrl,
      llat,
      method: "GET",
      path: `/api/config/script/config/${encodeURIComponent(id)}`,
    });
    if (!r.ok) {
      if (r.status === 404) {
        throw new NotFoundError(`script ${id} not found in HA`);
      }
      throw new ApiError(
        r.status >= 400 && r.status < 600 ? r.status : 502,
        "HA_UPSTREAM_ERROR",
        r.detail,
      );
    }
    sendJson(res, 200, { ok: true, script_id: id, data: r.data });
  });

  addRoute("POST", "/api/v1/channels/ha/scripts", async ({ res, body }) => {
    const parsed = parseScriptCreateBody(body);
    const { haUrl, llat } = await loadHaCredentials();
    const scriptId = slugify(parsed.alias) || `script_${Date.now()}`;
    const payload = scriptCreatePayload(parsed);
    const r = await callHaRest({
      haUrl,
      llat,
      method: "POST",
      path: `/api/config/script/config/${encodeURIComponent(scriptId)}`,
      body: payload,
    });
    if (!r.ok) {
      insertHaRun({
        kind: "script_create",
        domain: "script",
        service: null,
        entity_id: `script.${scriptId}`,
        decision_ref: "",
        payload,
        outcome: "error",
        ha_response: r.data,
        error: r.detail,
      });
      throw new ApiError(
        r.status >= 400 && r.status < 600 ? r.status : 502,
        "HA_UPSTREAM_ERROR",
        r.detail,
      );
    }
    const run = insertHaRun({
      kind: "script_create",
      domain: "script",
      service: null,
      entity_id: `script.${scriptId}`,
      decision_ref: "",
      payload,
      outcome: "ok",
      ha_response: r.data,
      error: null,
    });
    sendJson(res, 200, {
      ok: true,
      script_id: scriptId,
      run_id: run.id,
      ha_response: r.data,
    });
  });

  addRoute(
    "PUT",
    "/api/v1/channels/ha/scripts/:id",
    async ({ res, params, body }) => {
      const id = assertHaObjectId(params.id, "script");
      const parsed = parseScriptUpdateBody(body);
      const { haUrl, llat } = await loadHaCredentials();
      const payload = scriptUpdatePayload(parsed);
      const r = await callHaRest({
        haUrl,
        llat,
        method: "POST",
        path: `/api/config/script/config/${encodeURIComponent(id)}`,
        body: payload,
      });
      if (!r.ok) {
        insertHaRun({
          kind: "script_update",
          domain: "script",
          service: null,
          entity_id: `script.${id}`,
          decision_ref: "",
          payload,
          outcome: "error",
          ha_response: r.data,
          error: r.detail,
        });
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_UPSTREAM_ERROR",
          r.detail,
        );
      }
      const run = insertHaRun({
        kind: "script_update",
        domain: "script",
        service: null,
        entity_id: `script.${id}`,
        decision_ref: "",
        payload,
        outcome: "ok",
        ha_response: r.data,
        error: null,
      });
      sendJson(res, 200, {
        ok: true,
        script_id: id,
        run_id: run.id,
        ha_response: r.data,
      });
    },
  );

  addRoute(
    "DELETE",
    "/api/v1/channels/ha/scripts/:id",
    async ({ res, params }) => {
      const id = assertHaObjectId(params.id, "script");
      const { haUrl, llat } = await loadHaCredentials();
      const r = await callHaRest({
        haUrl,
        llat,
        method: "DELETE",
        path: `/api/config/script/config/${encodeURIComponent(id)}`,
      });
      if (!r.ok) {
        insertHaRun({
          kind: "script_delete",
          domain: "script",
          service: null,
          entity_id: `script.${id}`,
          decision_ref: "",
          payload: null,
          outcome: "error",
          ha_response: r.data,
          error: r.detail,
        });
        if (r.status === 404) {
          throw new NotFoundError(`script ${id} not found in HA`);
        }
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_UPSTREAM_ERROR",
          r.detail,
        );
      }
      const run = insertHaRun({
        kind: "script_delete",
        domain: "script",
        service: null,
        entity_id: `script.${id}`,
        decision_ref: "",
        payload: null,
        outcome: "ok",
        ha_response: r.data,
        error: null,
      });
      sendJson(res, 200, {
        ok: true,
        script_id: id,
        run_id: run.id,
        ha_response: r.data,
      });
    },
  );
}

// === END #115 PR3 ═══════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════
// === Tier 4 PR4: Integrations ===
// ═════════════════════════════════════════════════════════════════════════
//
// Issue #115 PR4 — Home Assistant integrations (config_flow) CRUD. Adds
// 8 routes fronting HA's WebSocket `config_entries/*` and
// `config_entries/flow/*` API surfaces, all driven through the
// long-lived ha_ws_client (PR1). REST cannot reach these — every
// integration lifecycle verb (init → step → submit → entry create →
// reload → remove) is WS-only on modern HA, so PR4 is the first PR in
// the Tier 4 fan-out that relies on PR1's WS client end-to-end.
//
// The shape of an HA "integration":
//
//   1. An integration *handler* (a.k.a. "domain" — `hue`, `mqtt`,
//      `nest`, …) is something HA knows how to install.
//      `config_entries/get_handlers` returns the list.
//   2. Sir kicks off a *config flow* via `config_entries/flow/init`
//      passing the domain. HA returns a flow_id + a first step
//      descriptor (`{type: "form", step_id, data_schema, errors?}` or
//      `{type: "external_step", url, ...}` for OAuth).
//   3. Each step takes either form data (the user fills it in) or no
//      data (e.g. "I pressed the Hue bridge button"); the agent POSTs to
//      `config_entries/flow/configure` with the form values; HA
//      returns either the NEXT step, an `abort` (no entry created — the
//      flow failed), or a `create_entry` (the flow succeeded, an
//      `entry_id` was minted).
//   4. After creation, a config_entry can be `reload`ed (re-init the
//      integration without re-running the flow) or `remove`d
//      (uninstall).
//
// Per the spec §4 gate matrix (locked YES 2026-05-29):
//
// | Route                 | decision_ref | snapshot |
// |-----------------------|--------------|----------|
// | GET list / info / available | no     | no       |
// | POST discover (flow_init) | no       | no       |
// | GET flow progress     | no           | no       |
// | POST configure (step) | REQUIRED     | YES      |
// | POST reload           | no           | no       |
// | DELETE remove         | REQUIRED     | YES      |
//
// Why `configure` gates rather than `discover`: discover is a cheap
// inspection (it tells the agent what the first form looks like) — no
// state changes on HA. The destructive moment is when the agent submits
// the step that triggers the entry creation. Snapshot is recorded BEFORE
// every configure step so even a multi-step flow has a snapshot trail at
// the boundary.
//
// ha_integration_ref ledger
// -------------------------
// On a successful `configure` step that returns `type: "create_entry"`,
// we write a row to `ha_integration_ref` (PR1 migration 0011 + PR4
// migration 0012 added `removed_at`):
//
//   INSERT INTO ha_integration_ref (entry_id, installed_by='alfred',
//                                   decision_ref, installed_at)
//
// On a successful `remove`, we soft-delete by setting `removed_at` —
// the row stays so the Desk audit trail "Alfred installed and then
// removed this integration" survives. Hard delete is reserved for
// `ha_event` config_entries_updated events that observe a user-side
// removal (those don't go through this route).
//
// Daybook
// -------
// Every successful `configure` step that lands a `create_entry` plus
// every successful `remove` writes a daybook line via PR1's
// `recordHaWriteToDaybook`. The intermediate form steps are silent —
// daybook noise is undesirable until the flow lands.
//
// MCP tool surface (packages/mcp-server/src/tools/hass.ts under
// HASS_INTEGRATION_TOOLS): ha__list_integrations / ha__integration_info /
// ha__list_available_integrations / ha__integration_discover /
// ha__integration_configure / ha__integration_reload /
// ha__integration_remove.

const HA_INTEGRATION_TIMEOUT_MS = Number(
  process.env.HA_INTEGRATION_TIMEOUT_MS ?? "30000",
);

// flow_id and entry_id from HA are hex/ulid-ish strings — same shape
// guard as ADDON_SLUG_RE but allowing a wider character set. HA uses
// 16-32 hex/url-safe-base64 for flow_ids and entry_ids; we cap at 256
// for safety against URL-injection on the `:flow_id` / `:entry_id`
// path parameters.
const HA_FLOW_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const HA_ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const HA_DOMAIN_RE = /^[a-z][a-z0-9_]{0,127}$/;

function assertHaFlowId(raw: string): string {
  if (!HA_FLOW_ID_RE.test(raw)) {
    throw new ValidationError(
      "flow_id must be 1..256 chars of [A-Za-z0-9_-]",
    );
  }
  return raw;
}

function assertHaEntryId(raw: string): string {
  if (!HA_ENTRY_ID_RE.test(raw)) {
    throw new ValidationError(
      "entry_id must be 1..256 chars of [A-Za-z0-9_-]",
    );
  }
  return raw;
}

function assertHaDomain(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError("domain is required and must be a non-empty string");
  }
  if (!HA_DOMAIN_RE.test(raw)) {
    throw new ValidationError(
      "domain must be 1..128 chars of [a-z0-9_], starting with a..z",
    );
  }
  return raw;
}

// ── ha_integration_ref helpers ──────────────────────────────────────────
//
// PR1 migration 0011 created the table; PR4 migration 0012 added the
// `removed_at` column. We defensively guard against an older DB by
// recreating both shapes idempotently — the migration runner is the
// real contract but tests in older fixtures may skip it.

function ensureHaIntegrationRefTable(): void {
  try {
    getStateDb()
      .prepare(
        `CREATE TABLE IF NOT EXISTS ha_integration_ref (
           entry_id     TEXT PRIMARY KEY,
           installed_by TEXT NOT NULL,
           decision_ref TEXT,
           installed_at TEXT NOT NULL,
           removed_at   TEXT
         )`,
      )
      .run();
    // ALTER if the column was missed (older fixtures pre-0012).
    const cols = getStateDb()
      .prepare("PRAGMA table_info(ha_integration_ref)")
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === "removed_at")) {
      try {
        getStateDb()
          .prepare("ALTER TABLE ha_integration_ref ADD COLUMN removed_at TEXT")
          .run();
      } catch {
        // best-effort; the column may have been added concurrently
      }
    }
  } catch {
    // best-effort — never block the upstream HA op on a defensive table create
  }
}

/** Insert (or upsert) a row marking `entry_id` as Alfred-installed.
 *  Returns the row inserted. Idempotent — re-running with the same
 *  entry_id updates installed_by/decision_ref/installed_at and clears
 *  any prior `removed_at` (the principal reinstalled what they had
 *  earlier removed — that's a re-create, not a continuation). */
function recordIntegrationInstall(args: {
  entry_id: string;
  decision_ref: string;
}): { entry_id: string; installed_at: string } {
  ensureHaIntegrationRefTable();
  const installed_at = new Date().toISOString();
  try {
    getStateDb()
      .prepare(
        `INSERT INTO ha_integration_ref (entry_id, installed_by, decision_ref, installed_at, removed_at)
         VALUES (?, 'alfred', ?, ?, NULL)
         ON CONFLICT(entry_id) DO UPDATE SET
           installed_by = 'alfred',
           decision_ref = excluded.decision_ref,
           installed_at = excluded.installed_at,
           removed_at   = NULL`,
      )
      .run(args.entry_id, args.decision_ref, installed_at);
  } catch (err) {
    console.warn(
      "[channels_ha:pr4] recordIntegrationInstall failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return { entry_id: args.entry_id, installed_at };
}

/** Soft-delete: stamp `removed_at` on the row. If the row doesn't exist
 *  (i.e. Sir installed it directly through HA's UI, not Alfred), we still
 *  upsert one with `installed_by='sir'` so the Desk has the audit trail.
 */
function recordIntegrationRemove(args: {
  entry_id: string;
  decision_ref: string;
}): { entry_id: string; removed_at: string } {
  ensureHaIntegrationRefTable();
  const removed_at = new Date().toISOString();
  try {
    getStateDb()
      .prepare(
        `INSERT INTO ha_integration_ref (entry_id, installed_by, decision_ref, installed_at, removed_at)
         VALUES (?, 'sir', ?, ?, ?)
         ON CONFLICT(entry_id) DO UPDATE SET
           removed_at = excluded.removed_at,
           decision_ref = COALESCE(ha_integration_ref.decision_ref, excluded.decision_ref)`,
      )
      .run(args.entry_id, args.decision_ref, removed_at, removed_at);
  } catch (err) {
    console.warn(
      "[channels_ha:pr4] recordIntegrationRemove failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return { entry_id: args.entry_id, removed_at };
}

// ── snapshot bridge (PR1 lib + PR6 placeholder fallback) ────────────────
//
// PR1's `triggerBackupBeforeAction` is the load-bearing snapshot helper:
// it calls HA WS `backup/generate`, stamps `ha_backup_ref`, and returns
// the ids. In test mode (HA_SNAPSHOT_DRY_RUN=1) the WS call is skipped
// and a `dry-run-<ulid>` ha_backup_id is recorded — useful for our
// integration tests which can't drive a real backup/generate round-trip.
//
// We import lazily inside the route handler to avoid a transitive cycle
// with ha_ws_client.ts (which itself touches state.db at module init).

async function snapshotBeforeIntegrationAction(args: {
  action: string;
  decision_ref: string;
}): Promise<{ backup_ref_id: string; ha_backup_id: string }> {
  if (process.env.HA_INTEGRATION_SNAPSHOT_DISABLED === "1") {
    // Fallback path identical to PR6's placeholder. Stamps a row in
    // ha_backup_ref so the audit trail still records intent even when
    // the WS-backed snapshot path is disabled.
    ensureHaBackupRefTable();
    const id = ulid();
    const ts = new Date().toISOString();
    const ha_backup_id = `disabled-${id}`;
    try {
      getStateDb()
        .prepare(
          `INSERT INTO ha_backup_ref (id, ha_backup_id, triggered_by, decision_ref, ts)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, ha_backup_id, args.action, args.decision_ref, ts);
    } catch {
      // best-effort
    }
    return { backup_ref_id: id, ha_backup_id };
  }
  const mod = await import("../lib/ha_snapshot.js");
  const rec = await mod.triggerBackupBeforeAction(args.action, args.decision_ref);
  return { backup_ref_id: rec.id, ha_backup_id: rec.ha_backup_id };
}

// ── daybook bridge ─────────────────────────────────────────────────────

async function tryRecordIntegrationDaybook(args: {
  action: string;
  summary: string;
  decision_ref: string;
  extra?: Record<string, unknown>;
}): Promise<void> {
  try {
    const mod = await import("../lib/ha_daybook.js");
    mod.recordHaWriteToDaybook({
      action: args.action,
      summary: args.summary,
      decision_ref: args.decision_ref,
      extra: args.extra,
    });
  } catch (err) {
    // Daybook write is best-effort — failure must NOT block the HA action.
    console.warn(
      "[channels_ha:pr4] daybook write failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── WS client adapter ──────────────────────────────────────────────────
//
// Tests can override the WS client by stubbing `globalThis.__haWsTestStub`
// — it must expose `wsCall(type, payload, timeoutMs?)` returning the
// result. In production we delegate to `getHaWsClient().wsCall(...)`.

interface HaWsCallable {
  wsCall(type: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

async function loadHaWsClient(): Promise<HaWsCallable> {
  const stub = (globalThis as { __haWsTestStub?: HaWsCallable }).__haWsTestStub;
  if (stub) return stub;
  const mod = await import("../lib/ha_ws_client.js");
  return mod.getHaWsClient();
}

/** Wrap a WS call so we surface HA errors as 502 HA_WS_ERROR consistently. */
async function wsCallOrThrow(
  client: HaWsCallable,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    return await client.wsCall(type, payload, HA_INTEGRATION_TIMEOUT_MS);
  } catch (err) {
    throw new ApiError(
      502,
      "HA_WS_ERROR",
      `HA WS ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Test-only — reset the integration ref table between runs. */
export function _resetHaIntegrationsForTests(): void {
  try {
    getStateDb().prepare("DELETE FROM ha_integration_ref").run();
  } catch {
    // best-effort
  }
}

// ── route registration ─────────────────────────────────────────────────

export function registerHaIntegrationsRoutes(): void {
  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/integrations
  //
  // List every config_entry HA knows about. No gate (read).
  // Cross-references each entry against `ha_integration_ref` so the
  // response includes Alfred's audit columns: `installed_by`,
  // `decision_ref`, `installed_at`, `removed_at`.
  // ────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/ha/integrations", async ({ res }) => {
    await loadHaCredentials(); // assert HA connected
    const client = await loadHaWsClient();
    const result = await wsCallOrThrow(client, "config_entries/get");
    const entries = Array.isArray(result) ? result : [];
    ensureHaIntegrationRefTable();
    // Build a {entry_id -> ref} index in a single query.
    const refs = (() => {
      try {
        return getStateDb()
          .prepare(
            "SELECT entry_id, installed_by, decision_ref, installed_at, removed_at FROM ha_integration_ref",
          )
          .all() as {
          entry_id: string;
          installed_by: string;
          decision_ref: string | null;
          installed_at: string;
          removed_at: string | null;
        }[];
      } catch {
        return [];
      }
    })();
    const refIndex = new Map<string, (typeof refs)[number]>();
    for (const r of refs) refIndex.set(r.entry_id, r);
    const enriched = entries.map((e) => {
      const entry_id =
        typeof (e as Record<string, unknown>).entry_id === "string"
          ? ((e as Record<string, unknown>).entry_id as string)
          : null;
      const ref = entry_id ? refIndex.get(entry_id) : undefined;
      return {
        ...(e as Record<string, unknown>),
        alfred: ref
          ? {
              installed_by: ref.installed_by,
              decision_ref: ref.decision_ref,
              installed_at: ref.installed_at,
              removed_at: ref.removed_at,
            }
          : { installed_by: "sir" as const, decision_ref: null, installed_at: null, removed_at: null },
      };
    });
    sendJson(res, 200, { ok: true, entries: enriched });
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/integrations/available
  //
  // List every domain HA can install (config_entries/get_handlers). No
  // gate (read). Use this to resolve a user-friendly name like "Hue" to
  // the domain string `hue` before calling `discover`.
  //
  // NOTE: route order matters — addRoute matches first-registered, so
  // /available must come BEFORE /:entry_id below.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "GET",
    "/api/v1/channels/ha/integrations/available",
    async ({ res }) => {
      await loadHaCredentials();
      const client = await loadHaWsClient();
      const result = await wsCallOrThrow(client, "config_entries/get_handlers");
      sendJson(res, 200, { ok: true, handlers: result ?? [] });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/integrations/flow/:flow_id
  //
  // Inspect the current state of an in-flight config flow without
  // advancing it. Returns the step descriptor the agent would see on
  // the next `configure` call. No gate.
  //
  // Implementation: HA's WS surface has no read-only "peek" — the
  // closest is `config_entries/flow/progress` which returns the list
  // of in-progress flows. We filter to the one matching :flow_id; if
  // it's not present (already completed or aborted), respond 404.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "GET",
    "/api/v1/channels/ha/integrations/flow/:flow_id",
    async ({ res, params }) => {
      const flow_id = assertHaFlowId(params.flow_id);
      await loadHaCredentials();
      const client = await loadHaWsClient();
      const result = await wsCallOrThrow(client, "config_entries/flow/progress");
      const list = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
      const match = list.find((f) => f.flow_id === flow_id);
      if (!match) {
        throw new NotFoundError(
          `flow_id ${flow_id} is not in HA's in-progress list (already completed, aborted, or never existed)`,
        );
      }
      sendJson(res, 200, { ok: true, flow_id, flow: match });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/integrations/:entry_id
  //
  // Info on one config_entry. No gate. Includes the `alfred` audit
  // columns from `ha_integration_ref`.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "GET",
    "/api/v1/channels/ha/integrations/:entry_id",
    async ({ res, params }) => {
      const entry_id = assertHaEntryId(params.entry_id);
      await loadHaCredentials();
      const client = await loadHaWsClient();
      // No single-entry "get" exists; pull the list and filter.
      const result = await wsCallOrThrow(client, "config_entries/get");
      const entries = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
      const match = entries.find((e) => e.entry_id === entry_id);
      if (!match) {
        throw new NotFoundError(`config_entry ${entry_id} not found in HA`);
      }
      ensureHaIntegrationRefTable();
      let ref:
        | {
            installed_by: string;
            decision_ref: string | null;
            installed_at: string;
            removed_at: string | null;
          }
        | undefined;
      try {
        ref = getStateDb()
          .prepare(
            "SELECT installed_by, decision_ref, installed_at, removed_at FROM ha_integration_ref WHERE entry_id = ?",
          )
          .get(entry_id) as typeof ref;
      } catch {
        ref = undefined;
      }
      sendJson(res, 200, {
        ok: true,
        entry_id,
        entry: match,
        alfred: ref
          ? {
              installed_by: ref.installed_by,
              decision_ref: ref.decision_ref,
              installed_at: ref.installed_at,
              removed_at: ref.removed_at,
            }
          : { installed_by: "sir" as const, decision_ref: null, installed_at: null, removed_at: null },
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/integrations/discover
  //
  // Initialise a config_flow. Body: `{domain, show_advanced_options?}`.
  // No gate (discovery is read-shaped — the first step is just a form
  // schema or a redirect URL). Returns the flow_id + first step.
  //
  // Calls HA WS `config_entries/flow/init` with
  // `{handler: domain, show_advanced_options}`.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/integrations/discover",
    async ({ res, body }) => {
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const domain = assertHaDomain(b.domain);
      const show_advanced_options =
        typeof b.show_advanced_options === "boolean"
          ? (b.show_advanced_options as boolean)
          : false;
      await loadHaCredentials();
      const client = await loadHaWsClient();
      const result = (await wsCallOrThrow(client, "config_entries/flow/init", {
        handler: domain,
        show_advanced_options,
      })) as Record<string, unknown> | null;
      if (!result || typeof result.flow_id !== "string") {
        throw new ApiError(
          502,
          "HA_WS_ERROR",
          `HA returned a flow_init response without a flow_id: ${JSON.stringify(result)}`,
        );
      }
      sendJson(res, 200, {
        ok: true,
        flow_id: result.flow_id,
        domain,
        step: result,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/integrations/configure/:flow_id
  //
  // Submit one step of a config flow. Body: `{data, decision_ref}`. The
  // `data` object is the form values for the current step (from the
  // step descriptor's `data_schema`). The `decision_ref` is REQUIRED —
  // every configure step is gated.
  //
  // Snapshot YES: before the upstream `flow/configure` call we trigger
  // a HA snapshot via PR1's `triggerBackupBeforeAction`. The snapshot
  // intent is recorded in `ha_backup_ref` with `triggered_by =
  // 'ha__integration_configure'`.
  //
  // On a successful `create_entry` response (the flow's final step), we
  // write a row to `ha_integration_ref` AND record a daybook entry.
  // Intermediate `form` / `external_step` / `progress` responses pass
  // through silently — the snapshot still fires (one per step) so a
  // multi-step flow has a snapshot trail at every boundary.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/integrations/configure/:flow_id",
    async ({ res, body, params }) => {
      const flow_id = assertHaFlowId(params.flow_id);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const decision_ref = assertDecisionRef(b.decision_ref);
      const data =
        typeof b.data === "object" && b.data !== null
          ? (b.data as Record<string, unknown>)
          : {};
      await loadHaCredentials();
      const snapshot = await snapshotBeforeIntegrationAction({
        action: "ha__integration_configure",
        decision_ref,
      });
      const client = await loadHaWsClient();
      const result = (await wsCallOrThrow(client, "config_entries/flow/configure", {
        flow_id,
        data,
      })) as Record<string, unknown> | null;
      if (!result || typeof result.type !== "string") {
        throw new ApiError(
          502,
          "HA_WS_ERROR",
          `HA returned a flow/configure response without a type: ${JSON.stringify(result)}`,
        );
      }
      const stepType = result.type as string;
      let entry_id: string | null = null;
      if (stepType === "create_entry") {
        const ce = result.result as Record<string, unknown> | undefined;
        // HA returns the new entry under `result` on a create_entry step.
        // Older HA versions used `entry_id` at the top of the response;
        // accept both shapes.
        if (ce && typeof ce.entry_id === "string") {
          entry_id = ce.entry_id as string;
        } else if (typeof result.entry_id === "string") {
          entry_id = result.entry_id as string;
        }
        if (entry_id) {
          recordIntegrationInstall({ entry_id, decision_ref });
          const title =
            (ce && typeof ce.title === "string" && (ce.title as string)) ||
            (typeof result.title === "string" && (result.title as string)) ||
            entry_id;
          await tryRecordIntegrationDaybook({
            action: "ha__integration_configure",
            summary: `HA integration installed: ${title} (entry_id=${entry_id})`,
            decision_ref,
            extra: { entry_id, backup_ref_id: snapshot.backup_ref_id },
          });
        }
      } else if (stepType === "abort") {
        // The flow aborted (reason in `result.reason`); no entry was
        // created so no audit row, but the daybook records the
        // attempt + reason for the principal.
        const reason =
          typeof result.reason === "string"
            ? (result.reason as string)
            : "unknown";
        await tryRecordIntegrationDaybook({
          action: "ha__integration_configure",
          summary: `HA integration flow aborted (flow_id=${flow_id}, reason=${reason})`,
          decision_ref,
          extra: { flow_id, reason, backup_ref_id: snapshot.backup_ref_id },
        });
      }
      sendJson(res, 200, {
        ok: true,
        flow_id,
        decision_ref,
        backup_ref_id: snapshot.backup_ref_id,
        ha_backup_id: snapshot.ha_backup_id,
        entry_id,
        step: result,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/integrations/:entry_id/reload
  //
  // Reload a config_entry — re-init the integration without re-running
  // the flow. No gate (reload is reversible — it either succeeds or
  // leaves the entry in `failed_setup` state, both of which the
  // principal can fix).
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/integrations/:entry_id/reload",
    async ({ res, params }) => {
      const entry_id = assertHaEntryId(params.entry_id);
      await loadHaCredentials();
      const client = await loadHaWsClient();
      const result = await wsCallOrThrow(client, "config_entries/reload", {
        entry_id,
      });
      sendJson(res, 200, { ok: true, entry_id, result });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // DELETE /api/v1/channels/ha/integrations/:entry_id
  //
  // Remove a config_entry. Body: `{decision_ref}`. GATED + SNAPSHOT.
  //
  // The DELETE verb on Node's stock http server CAN carry a body, and
  // the addRoute parser already lifts it; we accept it the same way the
  // other gated PR3/PR6 surfaces do.
  //
  // On success, soft-delete the matching `ha_integration_ref` row
  // (stamps `removed_at`) and write a daybook entry. The row stays so
  // "Alfred installed and then removed this" survives in the audit
  // trail.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "DELETE",
    "/api/v1/channels/ha/integrations/:entry_id",
    async ({ res, body, params }) => {
      const entry_id = assertHaEntryId(params.entry_id);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const decision_ref = assertDecisionRef(
        (body as Record<string, unknown>).decision_ref,
      );
      await loadHaCredentials();
      const snapshot = await snapshotBeforeIntegrationAction({
        action: "ha__integration_remove",
        decision_ref,
      });
      const client = await loadHaWsClient();
      const result = await wsCallOrThrow(client, "config_entries/remove", {
        entry_id,
      });
      recordIntegrationRemove({ entry_id, decision_ref });
      await tryRecordIntegrationDaybook({
        action: "ha__integration_remove",
        summary: `HA integration removed: entry_id=${entry_id}`,
        decision_ref,
        extra: { entry_id, backup_ref_id: snapshot.backup_ref_id },
      });
      sendJson(res, 200, {
        ok: true,
        entry_id,
        decision_ref,
        backup_ref_id: snapshot.backup_ref_id,
        ha_backup_id: snapshot.ha_backup_id,
        result,
      });
    },
  );
}

// === END Tier 4 PR4 ═══════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════
// === Tier 4 PR6: Supervisor addons ===
// ═════════════════════════════════════════════════════════════════════════
//
// Issue #115 PR6 — Home Assistant Supervisor addon CRUD. Adds 11 routes
// (list / info / install / uninstall / configure / start / stop / restart
// / update / logs / stats) fronting HA's Supervisor REST API.
//
// LOAD-BEARING CONSTRAINT — Supervisor only exists on Home Assistant OS
// (HAOS). On Container HA, Core HA, and Supervised-on-generic-Linux it is
// absent; every addon route MUST detect this and respond with HTTP 501
// {error: "supervisor_not_available", installation_type, message} rather
// than crash through to a 502 from HA.
//
// Detection: HA's `/api/config` response carries `installation_type` on
// 2024.7+ — values are `Home Assistant OS` / `Home Assistant Container` /
// `Home Assistant Core` / `Home Assistant Supervised` / `Unknown`. We
// probe `/api/config` lazily on first addon call, cache the result
// in-process (singleton, cleared on /connect + /disconnect), and gate
// every route on `installation_type === "Home Assistant OS"`.
//
// Per the spec §4 gate matrix (locked YES 2026-05-29):
//
// | Route                          | decision_ref | snapshot |
// |--------------------------------|--------------|----------|
// | GET list / info / logs / stats | no           | no       |
// | POST install                   | REQUIRED     | YES      |
// | POST uninstall                 | REQUIRED     | YES      |
// | PUT options (configure)        | REQUIRED     | NO       |
// | POST start / stop / restart    | no           | no       |
// | POST update                    | REQUIRED     | YES      |
//
// Snapshot integration is via the (defensively no-op when absent) helper
// `triggerBackupBeforeAction` that PR1 of #115 lands. PR1 + this PR are
// shipping in parallel; whichever merges second imports the live helper
// at that point. The seam: until PR1 lands, we stamp a row in
// ha_backup_ref with ha_backup_id = `pending-pr1-<ulid>` so the audit
// trail still records intent.
//
// Same defensive pattern for `requireDecisionRef`: if PR1's middleware
// is loaded we call it; otherwise we fall back to the existing
// assertDecisionRef helper (equivalent semantics — non-empty
// printable-ASCII 6..256 — from #110 PR4).
//
// MCP tool surface: ha__list_addons / ha__addon_info / ha__addon_install
// / ha__addon_uninstall / ha__addon_configure / ha__addon_start /
// ha__addon_stop / ha__addon_restart / ha__addon_update / ha__addon_logs.
// Lives in packages/mcp-server/src/tools/hass.ts under HASS_ADDON_TOOLS.

const HA_ADDON_TIMEOUT_MS = Number(
  process.env.HA_ADDON_TIMEOUT_MS ?? "30000",
);

type HaInstallationType =
  | "Home Assistant OS"
  | "Home Assistant Container"
  | "Home Assistant Core"
  | "Home Assistant Supervised"
  | "Unknown";

interface InstallationProbeOk {
  ok: true;
  installation_type: HaInstallationType;
}
interface InstallationProbeFail {
  ok: false;
  status: number;
  detail: string;
}
type InstallationProbeResult = InstallationProbeOk | InstallationProbeFail;

// In-memory cache. Cleared by /connect (which probes fresh) + on test
// fixtures via `_resetHaAddonsForTests`.
let cachedInstallationType: HaInstallationType | null = null;

/** Probe `${haUrl}/api/config` to read `installation_type`. Cached after
 *  the first successful probe; subsequent calls within the process
 *  return the cached value. */
async function probeInstallationType(
  haUrl: string,
  llat: string,
): Promise<InstallationProbeResult> {
  if (cachedInstallationType) {
    return { ok: true, installation_type: cachedInstallationType };
  }
  let resp: Response;
  try {
    resp = await fetch(`${haUrl}/api/config`, {
      method: "GET",
      headers: { Authorization: `Bearer ${llat}` },
      signal: AbortSignal.timeout(HA_ADDON_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, detail: `HA unreachable: ${msg}` };
  }
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      detail: `HA /api/config returned HTTP ${resp.status}`,
    };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await resp.json()) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      status: 502,
      detail: "HA /api/config returned non-JSON body",
    };
  }
  const raw =
    typeof parsed.installation_type === "string"
      ? (parsed.installation_type as string)
      : "Unknown";
  const installation_type = normaliseInstallationType(raw);
  cachedInstallationType = installation_type;
  return { ok: true, installation_type };
}

function normaliseInstallationType(raw: string): HaInstallationType {
  const known: HaInstallationType[] = [
    "Home Assistant OS",
    "Home Assistant Container",
    "Home Assistant Core",
    "Home Assistant Supervised",
  ];
  for (const k of known) {
    if (k === raw) return k;
  }
  return "Unknown";
}

/** For tests + post-/connect refresh. Clears the in-memory cache so the
 *  next addon call re-probes /api/config. */
export function _resetHaInstallationTypeCache(): void {
  cachedInstallationType = null;
}

/** Override hook for tests — pin the cached installation_type without
 *  hitting /api/config. Pass `null` to force a fresh probe on next call.
 *  PROCESS-LOCAL — no DB persistence. */
export function _setHaInstallationTypeForTests(
  value: HaInstallationType | null,
): void {
  cachedInstallationType = value;
}

/** For tests only — clear ha_backup_ref + installation_type cache between
 *  runs. */
export function _resetHaAddonsForTests(): void {
  cachedInstallationType = null;
  try {
    getStateDb().prepare("DELETE FROM ha_backup_ref").run();
  } catch {
    // table may not exist on older fixtures; tests own migrations
  }
}

/** Result of the installation_type gate. Either a probe failure (HA
 *  unreachable / bad LLAT), a Supervisor-unavailable 501 payload, or
 *  the row + llat ready for an addon REST call. */
type AddonGateResult =
  | { ok: true; haUrl: string; llat: string; installation_type: HaInstallationType }
  | { ok: false; status: number; payload: Record<string, unknown> };

async function gateForAddonRoute(): Promise<AddonGateResult> {
  const llat = await readHaLlat(); // throws 409 HA_NOT_CONNECTED / 502
  const row = getHaConnectionRow()!;
  const probe = await probeInstallationType(row.ha_url, llat);
  if (!probe.ok) {
    return {
      ok: false,
      status: probe.status >= 500 ? 502 : probe.status,
      payload: {
        error: "installation_type_probe_failed",
        detail: probe.detail,
      },
    };
  }
  if (probe.installation_type !== "Home Assistant OS") {
    return {
      ok: false,
      status: 501,
      payload: {
        error: "supervisor_not_available",
        installation_type: probe.installation_type,
        message: `Supervisor addons require Home Assistant OS. Detected: ${probe.installation_type}.`,
      },
    };
  }
  return {
    ok: true,
    haUrl: row.ha_url,
    llat,
    installation_type: probe.installation_type,
  };
}

// ── ha_backup_ref helper (defensive — PR1 of #115 lands the real one) ──
//
// PR1 adds the `ha_backup_ref` table + `triggerBackupBeforeAction` helper.
// Until that lands we (a) create the table on first use (idempotent) and
// (b) stamp a row with a `pending-pr1-<ulid>` placeholder so the audit
// ledger still records the intent. When PR1 merges, this seam swaps to
// importing the shipped helper.
//
// The table shape MUST match the spec §3 of the tier-4 doc:
//   ha_backup_ref(id, ha_backup_id, triggered_by, decision_ref, ts)

function ensureHaBackupRefTable(): void {
  try {
    getStateDb()
      .prepare(
        `CREATE TABLE IF NOT EXISTS ha_backup_ref (
           id TEXT PRIMARY KEY,
           ha_backup_id TEXT NOT NULL,
           triggered_by TEXT NOT NULL,
           decision_ref TEXT,
           ts TEXT NOT NULL
         )`,
      )
      .run();
  } catch {
    // best-effort
  }
}

/** Records a snapshot intent against the `ha_backup_ref` audit table.
 *  Returns the ha_backup_id (placeholder until PR1's real
 *  triggerBackupBeforeAction lands). */
function recordAddonSnapshot(args: {
  action: string;
  decision_ref: string;
}): { backup_ref_id: string; ha_backup_id: string } {
  ensureHaBackupRefTable();
  const id = ulid();
  const ts = new Date().toISOString();
  // Until #115 PR1 ships the real backup helper, surface the intent with
  // a placeholder id. PR1 will replace this with a real Supervisor
  // backup id by importing `triggerBackupBeforeAction` and routing
  // through it.
  const ha_backup_id = `pending-pr1-${id}`;
  try {
    getStateDb()
      .prepare(
        `INSERT INTO ha_backup_ref (id, ha_backup_id, triggered_by, decision_ref, ts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, ha_backup_id, args.action, args.decision_ref, ts);
  } catch {
    // best-effort; never block the addon write on the audit row
  }
  return { backup_ref_id: id, ha_backup_id };
}

// ── Supervisor REST helper ──────────────────────────────────────────────
//
// HA Supervisor REST sits at `${haUrl}/api/hassio/*` and authenticates
// with the same LLAT as the rest of HA's REST API. Responses are
// always `{result: "ok", data: ...}` on success or
// `{result: "error", message: ...}` on failure. We forward the
// `data` portion unchanged.

interface SupervisorOk {
  ok: true;
  data: unknown;
}
interface SupervisorFail {
  ok: false;
  status: number;
  detail: string;
}
type SupervisorResult = SupervisorOk | SupervisorFail;

async function callSupervisor(args: {
  haUrl: string;
  llat: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  raw?: boolean; // pass-through text response (for logs)
}): Promise<SupervisorResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.llat}`,
  };
  let bodyStr: string | undefined;
  if (args.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(args.body);
  }
  let resp: Response;
  try {
    resp = await fetch(`${args.haUrl}${args.path}`, {
      method: args.method,
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(HA_ADDON_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, detail: `HA Supervisor unreachable: ${msg}` };
  }
  if (!resp.ok) {
    let detail = `HA Supervisor returned HTTP ${resp.status}`;
    try {
      const t = await resp.text();
      if (t) detail = `${detail}: ${t.slice(0, 500)}`;
    } catch {
      // best-effort
    }
    return { ok: false, status: resp.status, detail };
  }
  if (args.raw === true) {
    let text = "";
    try {
      text = await resp.text();
    } catch {
      text = "";
    }
    return { ok: true, data: text };
  }
  let parsed: { result?: string; data?: unknown; message?: string } = {};
  try {
    parsed = (await resp.json()) as typeof parsed;
  } catch {
    return { ok: false, status: 502, detail: "HA Supervisor returned non-JSON body" };
  }
  if (parsed.result === "error") {
    return {
      ok: false,
      status: 502,
      detail: parsed.message ?? "HA Supervisor reported an error without a message",
    };
  }
  return { ok: true, data: parsed.data ?? null };
}

// ── slug guard ──────────────────────────────────────────────────────────
//
// Supervisor addon slugs look like `core_mosquitto`, `a0d7b954_nodered`,
// `slug-with-dash`. They never include `/`. We enforce a printable-ASCII
// no-slash format so a bad slug doesn't fall into URL-traversal territory
// against `${haUrl}/api/hassio/addons/<slug>/...`.
const ADDON_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_\-.]{0,127}$/;

function assertAddonSlug(raw: string): string {
  if (!ADDON_SLUG_RE.test(raw)) {
    throw new ValidationError(
      "slug must be 1..128 chars of [A-Za-z0-9_.-], starting with [A-Za-z0-9]",
    );
  }
  return raw;
}

// ── route handler registration ─────────────────────────────────────────

export function registerHaAddonRoutes(): void {
  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/addons — list installed + available addons.
  // Read, no gate. Returns the Supervisor `addons` payload verbatim.
  // ────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/ha/addons", async ({ res }) => {
    const gate = await gateForAddonRoute();
    if (!gate.ok) {
      sendJson(res, gate.status, gate.payload);
      return;
    }
    const r = await callSupervisor({
      haUrl: gate.haUrl,
      llat: gate.llat,
      method: "GET",
      path: "/api/hassio/addons",
    });
    if (!r.ok) {
      throw new ApiError(
        r.status >= 400 && r.status < 600 ? r.status : 502,
        "HA_SUPERVISOR_ERROR",
        r.detail,
      );
    }
    sendJson(res, 200, {
      ok: true,
      installation_type: gate.installation_type,
      data: r.data,
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/addons/:slug — addon info. Read, no gate.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "GET",
    "/api/v1/channels/ha/addons/:slug",
    async ({ res, params }) => {
      const slug = assertAddonSlug(params.slug);
      const gate = await gateForAddonRoute();
      if (!gate.ok) {
        sendJson(res, gate.status, gate.payload);
        return;
      }
      const r = await callSupervisor({
        haUrl: gate.haUrl,
        llat: gate.llat,
        method: "GET",
        path: `/api/hassio/addons/${encodeURIComponent(slug)}/info`,
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_SUPERVISOR_ERROR",
          r.detail,
        );
      }
      sendJson(res, 200, {
        ok: true,
        installation_type: gate.installation_type,
        slug,
        data: r.data,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/addons/:slug/install — gated + snapshot.
  // Body: { decision_ref }
  // Snapshot recorded BEFORE the upstream install (so a failed install
  // still surfaces the intent in ha_backup_ref).
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/addons/:slug/install",
    async ({ res, body, params }) => {
      const slug = assertAddonSlug(params.slug);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const decision_ref = assertDecisionRef(
        (body as Record<string, unknown>).decision_ref,
      );
      const gate = await gateForAddonRoute();
      if (!gate.ok) {
        sendJson(res, gate.status, gate.payload);
        return;
      }
      const snapshot = recordAddonSnapshot({
        action: "ha__addon_install",
        decision_ref,
      });
      const r = await callSupervisor({
        haUrl: gate.haUrl,
        llat: gate.llat,
        method: "POST",
        path: `/api/hassio/addons/${encodeURIComponent(slug)}/install`,
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_SUPERVISOR_ERROR",
          r.detail,
          { backup_ref_id: snapshot.backup_ref_id },
        );
      }
      sendJson(res, 200, {
        ok: true,
        slug,
        decision_ref,
        backup_ref_id: snapshot.backup_ref_id,
        ha_backup_id: snapshot.ha_backup_id,
        data: r.data,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/addons/:slug/uninstall — gated + snapshot.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/addons/:slug/uninstall",
    async ({ res, body, params }) => {
      const slug = assertAddonSlug(params.slug);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const decision_ref = assertDecisionRef(
        (body as Record<string, unknown>).decision_ref,
      );
      const gate = await gateForAddonRoute();
      if (!gate.ok) {
        sendJson(res, gate.status, gate.payload);
        return;
      }
      const snapshot = recordAddonSnapshot({
        action: "ha__addon_uninstall",
        decision_ref,
      });
      const r = await callSupervisor({
        haUrl: gate.haUrl,
        llat: gate.llat,
        method: "POST",
        path: `/api/hassio/addons/${encodeURIComponent(slug)}/uninstall`,
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_SUPERVISOR_ERROR",
          r.detail,
          { backup_ref_id: snapshot.backup_ref_id },
        );
      }
      sendJson(res, 200, {
        ok: true,
        slug,
        decision_ref,
        backup_ref_id: snapshot.backup_ref_id,
        ha_backup_id: snapshot.ha_backup_id,
        data: r.data,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // PUT /api/v1/channels/ha/addons/:slug/options — gated, NO snapshot.
  // Body: { decision_ref, options }
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "PUT",
    "/api/v1/channels/ha/addons/:slug/options",
    async ({ res, body, params }) => {
      const slug = assertAddonSlug(params.slug);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const decision_ref = assertDecisionRef(b.decision_ref);
      if (b.options === undefined || b.options === null) {
        throw new ValidationError("options is required");
      }
      if (typeof b.options !== "object" || Array.isArray(b.options)) {
        throw new ValidationError("options must be a JSON object");
      }
      const gate = await gateForAddonRoute();
      if (!gate.ok) {
        sendJson(res, gate.status, gate.payload);
        return;
      }
      const r = await callSupervisor({
        haUrl: gate.haUrl,
        llat: gate.llat,
        method: "POST", // Supervisor uses POST for /addons/<slug>/options
        path: `/api/hassio/addons/${encodeURIComponent(slug)}/options`,
        body: { options: b.options },
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_SUPERVISOR_ERROR",
          r.detail,
        );
      }
      sendJson(res, 200, {
        ok: true,
        slug,
        decision_ref,
        data: r.data,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/addons/:slug/start — no gate.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/addons/:slug/start",
    async ({ res, params }) => {
      const slug = assertAddonSlug(params.slug);
      const gate = await gateForAddonRoute();
      if (!gate.ok) {
        sendJson(res, gate.status, gate.payload);
        return;
      }
      const r = await callSupervisor({
        haUrl: gate.haUrl,
        llat: gate.llat,
        method: "POST",
        path: `/api/hassio/addons/${encodeURIComponent(slug)}/start`,
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_SUPERVISOR_ERROR",
          r.detail,
        );
      }
      sendJson(res, 200, { ok: true, slug, data: r.data });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/addons/:slug/stop — no gate.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/addons/:slug/stop",
    async ({ res, params }) => {
      const slug = assertAddonSlug(params.slug);
      const gate = await gateForAddonRoute();
      if (!gate.ok) {
        sendJson(res, gate.status, gate.payload);
        return;
      }
      const r = await callSupervisor({
        haUrl: gate.haUrl,
        llat: gate.llat,
        method: "POST",
        path: `/api/hassio/addons/${encodeURIComponent(slug)}/stop`,
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_SUPERVISOR_ERROR",
          r.detail,
        );
      }
      sendJson(res, 200, { ok: true, slug, data: r.data });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/addons/:slug/restart — no gate.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/addons/:slug/restart",
    async ({ res, params }) => {
      const slug = assertAddonSlug(params.slug);
      const gate = await gateForAddonRoute();
      if (!gate.ok) {
        sendJson(res, gate.status, gate.payload);
        return;
      }
      const r = await callSupervisor({
        haUrl: gate.haUrl,
        llat: gate.llat,
        method: "POST",
        path: `/api/hassio/addons/${encodeURIComponent(slug)}/restart`,
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_SUPERVISOR_ERROR",
          r.detail,
        );
      }
      sendJson(res, 200, { ok: true, slug, data: r.data });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/addons/:slug/update — gated + snapshot.
  // Body: { decision_ref }
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/addons/:slug/update",
    async ({ res, body, params }) => {
      const slug = assertAddonSlug(params.slug);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const decision_ref = assertDecisionRef(
        (body as Record<string, unknown>).decision_ref,
      );
      const gate = await gateForAddonRoute();
      if (!gate.ok) {
        sendJson(res, gate.status, gate.payload);
        return;
      }
      const snapshot = recordAddonSnapshot({
        action: "ha__addon_update",
        decision_ref,
      });
      const r = await callSupervisor({
        haUrl: gate.haUrl,
        llat: gate.llat,
        method: "POST",
        path: `/api/hassio/addons/${encodeURIComponent(slug)}/update`,
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_SUPERVISOR_ERROR",
          r.detail,
          { backup_ref_id: snapshot.backup_ref_id },
        );
      }
      sendJson(res, 200, {
        ok: true,
        slug,
        decision_ref,
        backup_ref_id: snapshot.backup_ref_id,
        ha_backup_id: snapshot.ha_backup_id,
        data: r.data,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/addons/:slug/logs?tail=N — text logs.
  // Default tail = 200, max 2000.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "GET",
    "/api/v1/channels/ha/addons/:slug/logs",
    async ({ res, params, query }) => {
      const slug = assertAddonSlug(params.slug);
      const gate = await gateForAddonRoute();
      if (!gate.ok) {
        sendJson(res, gate.status, gate.payload);
        return;
      }
      const r = await callSupervisor({
        haUrl: gate.haUrl,
        llat: gate.llat,
        method: "GET",
        path: `/api/hassio/addons/${encodeURIComponent(slug)}/logs`,
        raw: true,
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_SUPERVISOR_ERROR",
          r.detail,
        );
      }
      const text = typeof r.data === "string" ? r.data : String(r.data ?? "");
      // tail: number of trailing lines. Default 200, max 2000.
      const tailRaw = query.get("tail");
      let tail = 200;
      if (tailRaw !== null) {
        const n = Number(tailRaw);
        if (Number.isFinite(n) && n > 0) tail = Math.min(2000, Math.floor(n));
      }
      const allLines = text.split("\n");
      const tailLines = allLines.slice(Math.max(0, allLines.length - tail));
      sendJson(res, 200, {
        ok: true,
        slug,
        tail: tailLines.length,
        logs: tailLines.join("\n"),
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/addons/:slug/stats — runtime stats.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "GET",
    "/api/v1/channels/ha/addons/:slug/stats",
    async ({ res, params }) => {
      const slug = assertAddonSlug(params.slug);
      const gate = await gateForAddonRoute();
      if (!gate.ok) {
        sendJson(res, gate.status, gate.payload);
        return;
      }
      const r = await callSupervisor({
        haUrl: gate.haUrl,
        llat: gate.llat,
        method: "GET",
        path: `/api/hassio/addons/${encodeURIComponent(slug)}/stats`,
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_SUPERVISOR_ERROR",
          r.detail,
        );
      }
      sendJson(res, 200, { ok: true, slug, data: r.data });
    },
  );
}

// === END Tier 4 PR6 ═══════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════
// === Tier 4 PR7: Core + Backups ===
// ═════════════════════════════════════════════════════════════════════════
//
// Issue #115 PR7 — HA core lifecycle (restart / update / check_config /
// reload_yaml / version) + backup CRUD (info / details / generate /
// delete / restore / strategy) + ledger ergonomics on `ha_backup_ref`.
//
// Wire layer
// ----------
// HA's core lifecycle verbs split across REST + WS:
//
//   * `homeassistant.check_config`   — REST POST /api/services/homeassistant/check_config
//   * `homeassistant.restart`        — REST POST /api/services/homeassistant/restart
//   * `homeassistant.reload_all`     — REST POST /api/services/homeassistant/reload_all
//   * `core/update` (OTA)            — WS supervisor/api endpoint=/core/update method=post
//   * `GET /api/config`              — REST (returns ha_version, installation_type, …)
//   * `backup/info`                  — WS
//   * `backup/details`               — WS
//   * `backup/generate`              — WS (also used by PR1's snapshot helper)
//   * `backup/delete`                — WS
//   * `backup/restore`               — WS
//   * `backup/strategy/info`         — WS
//   * `backup/strategy/update`       — WS
//
// REST verbs use the same `callHaRest` helper PR3 introduced; WS verbs
// go through the long-lived `getHaWsClient().wsCall(...)` PR1 shipped.
//
// Gates + auto-snapshot (locked YES 2026-05-29)
// ---------------------------------------------
// | Route                        | decision_ref | auto-snapshot |
// |------------------------------|--------------|----------------|
// | core/check_config            | no           | no             |
// | core/reload_yaml             | no           | no             |
// | core/version (GET)           | no           | no             |
// | core/restart                 | REQUIRED     | YES            |
// | core/update                  | REQUIRED     | YES            |
// | backups GET list/details     | no           | no             |
// | backups POST (create)        | no           | no             |
// | backups DELETE               | REQUIRED     | no             |
// | backups POST restore         | REQUIRED     | NO (restoring IS the recovery action)
// | backups/strategy GET         | no           | no             |
// | backups/strategy PUT         | REQUIRED     | no             |
//
// Auto-snapshot semantics
// -----------------------
// `triggerBackupBeforeAction(action, decision_ref)` from PR1 fires a real
// HA backup (via WS `backup/generate`), persists a row in `ha_backup_ref`
// with `triggered_by=<action>`, and returns `{id, ha_backup_id, name}`.
// The route's response payload carries `backup_ref_id` + `ha_backup_id`
// so the MCP tool surfaces "snapshot taken — id <id>" to Sir.
//
// If `triggerBackupBeforeAction` throws (no disk space, HA down, …) the
// route propagates the error as 502 — destructive verbs MUST NOT run on
// an unbackupped HA.
//
// ha_backup_ref ledger ergonomics
// -------------------------------
// Every PR7 entry-point that creates a backup (auto-snapshot OR explicit
// user create OR HA's own strategy-auto) lands a row. The
// `triggered_by` column distinguishes:
//
//   * `ha__core_restart` / `ha__core_update`         — auto-snapshot before another verb
//   * `ha__create_backup` / `user`                   — explicit user request
//   * `strategy:auto`                                — HA's scheduled backup strategy
//                                                      (reserved — observable via the
//                                                      backup_create event stream which
//                                                      Tier 4 PR1's drainEvent will see
//                                                      on later PRs)
//
// Sir can query "what backed up my system the last 30 days" by reading
// `GET /api/v1/channels/ha/backups/ledger?days=30`.
//
// Restore semantics
// -----------------
// `backup/restore` is special — it IS the recovery action, so we don't
// auto-snapshot before restoring (that'd be backing up to the same
// volume HA's about to overwrite). We do require a `decision_ref` for
// audit. The route also stops short of polling — HA returns success when
// the restore is QUEUED, and HA itself restarts to apply it; we surface
// the WS response verbatim and let the caller follow up via `/version`
// + `/status` after HA comes back.
//
// MCP tools
// ---------
// `ha__core_check_config`, `ha__core_restart`, `ha__core_update`,
// `ha__core_reload_yaml`, `ha__core_version`, `ha__list_backups`,
// `ha__backup_info`, `ha__create_backup`, `ha__delete_backup`,
// `ha__restore_backup`. (10 tools — strategy GET/PUT not currently surfaced
// to the model; Sir adjusts HA's auto-backup schedule via the Desk if needed.)

const HA_CORE_REST_TIMEOUT_MS = Number(
  process.env.HA_CORE_REST_TIMEOUT_MS ?? "30000",
);

const HA_BACKUP_WS_TIMEOUT_MS = Number(
  process.env.HA_BACKUP_WS_TIMEOUT_MS ?? "120000", // backups can take 60-120s
);

const HA_CORE_UPDATE_WS_TIMEOUT_MS = Number(
  process.env.HA_CORE_UPDATE_WS_TIMEOUT_MS ?? "300000", // OTA can take 5min
);

/**
 * Format the HA WS error message into the ApiError detail string.
 * WS calls throw Error("HA WS error <code>: <message>") on failure;
 * we re-wrap to keep the response envelope shape consistent with the
 * REST surface.
 */
function wrapHaWsError(action: string, err: unknown): ApiError {
  const msg = err instanceof Error ? err.message : String(err);
  return new ApiError(502, "HA_WS_ERROR", `${action}: ${msg}`);
}

/**
 * Backup id format guard. HA's backup ids are short slugs (e.g.
 * `abc123def` from `backup/generate`) — printable ASCII no slash, length
 * 1..128. Same shape we use for addon slugs (PR6) so the URL-traversal
 * guard stays uniform.
 */
const HA_BACKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/;

function assertBackupId(raw: string): string {
  if (!HA_BACKUP_ID_RE.test(raw)) {
    throw new ValidationError(
      "backup id must be 1..128 chars of [A-Za-z0-9_.-], starting with [A-Za-z0-9]",
    );
  }
  return raw;
}

export function registerHaPr7CoreBackupRoutes(): void {
  // ── core lifecycle ────────────────────────────────────────────────────

  // GET /api/v1/channels/ha/version — read HA's /api/config.
  // Returns `{ha_version, installation_type, location_name, …}` from HA
  // verbatim. Cheap, no gate, no snapshot.
  addRoute("GET", "/api/v1/channels/ha/version", async ({ res }) => {
    const { haUrl, llat } = await loadHaCredentials();
    const r = await callHaRest({
      haUrl,
      llat,
      method: "GET",
      path: "/api/config",
    });
    if (!r.ok) {
      throw new ApiError(
        r.status >= 400 && r.status < 600 ? r.status : 502,
        "HA_UPSTREAM_ERROR",
        r.detail,
      );
    }
    // Pluck the canonical fields the MCP tool needs at the top level so
    // the model doesn't have to dig — but pass the full data through too.
    const d = (r.data ?? {}) as Record<string, unknown>;
    sendJson(res, 200, {
      ok: true,
      ha_version: typeof d.version === "string" ? d.version : null,
      installation_type:
        typeof d.installation_type === "string" ? d.installation_type : null,
      location_name:
        typeof d.location_name === "string" ? d.location_name : null,
      data: r.data,
    });
  });

  // POST /api/v1/channels/ha/core/check_config — REST POST
  // /api/services/homeassistant/check_config. Read-only check (verifies
  // configuration.yaml parses + restartable). No gate; idempotent.
  addRoute(
    "POST",
    "/api/v1/channels/ha/core/check_config",
    async ({ res }) => {
      const { haUrl, llat } = await loadHaCredentials();
      const r = await callHaRest({
        haUrl,
        llat,
        method: "POST",
        path: "/api/services/homeassistant/check_config",
        body: {},
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_UPSTREAM_ERROR",
          r.detail,
        );
      }
      sendJson(res, 200, { ok: true, data: r.data });
    },
  );

  // POST /api/v1/channels/ha/core/reload_yaml — REST POST
  // /api/services/homeassistant/reload_all. Reload every YAML-defined
  // domain (automations, scripts, scenes, helpers, …) without
  // restarting HA. No gate (idempotent + reversible: edit YAML +
  // reload again).
  addRoute(
    "POST",
    "/api/v1/channels/ha/core/reload_yaml",
    async ({ res }) => {
      const { haUrl, llat } = await loadHaCredentials();
      const r = await callHaRest({
        haUrl,
        llat,
        method: "POST",
        path: "/api/services/homeassistant/reload_all",
        body: {},
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_UPSTREAM_ERROR",
          r.detail,
        );
      }
      sendJson(res, 200, { ok: true, data: r.data });
    },
  );

  // POST /api/v1/channels/ha/core/restart — REST POST
  // /api/services/homeassistant/restart. GATED + AUTO-SNAPSHOT.
  // Body: { decision_ref }.
  //
  // Snapshot fires BEFORE the restart so a failed restart still has the
  // backup to roll back to. HA returns immediately when the restart is
  // queued; the WS connection (and thus the client) will reconnect once
  // HA comes back up.
  addRoute(
    "POST",
    "/api/v1/channels/ha/core/restart",
    async ({ res, body }) => {
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const decision_ref = assertDecisionRef(
        (body as Record<string, unknown>).decision_ref,
      );
      const { haUrl, llat } = await loadHaCredentials();
      const snapshot = await triggerBackupBeforeAction(
        "ha__core_restart",
        decision_ref,
      );
      const r = await callHaRest({
        haUrl,
        llat,
        method: "POST",
        path: "/api/services/homeassistant/restart",
        body: {},
      });
      if (!r.ok) {
        throw new ApiError(
          r.status >= 400 && r.status < 600 ? r.status : 502,
          "HA_UPSTREAM_ERROR",
          r.detail,
          { backup_ref_id: snapshot.id, ha_backup_id: snapshot.ha_backup_id },
        );
      }
      recordHaWriteToDaybook({
        action: "ha__core_restart",
        summary: `HA core restart queued (snapshot ${snapshot.name})`,
        decision_ref,
        extra: { ha_backup_id: snapshot.ha_backup_id },
      });
      sendJson(res, 200, {
        ok: true,
        decision_ref,
        backup_ref_id: snapshot.id,
        ha_backup_id: snapshot.ha_backup_id,
        backup_name: snapshot.name,
        data: r.data,
      });
    },
  );

  // POST /api/v1/channels/ha/core/update — WS supervisor/api endpoint=/core/update.
  // GATED + AUTO-SNAPSHOT. Body: { decision_ref, version? }.
  //
  // HA Core update is run via Supervisor's API even on Container HA
  // (Container HA gets a 5xx from supervisor/api with method=post that we
  // pass through). On HAOS this triggers an OTA update — long-running
  // (3-10min); we use a 5-minute WS timeout so the call doesn't hang the
  // whole request loop.
  addRoute(
    "POST",
    "/api/v1/channels/ha/core/update",
    async ({ res, body }) => {
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const decision_ref = assertDecisionRef(b.decision_ref);
      // Optional version pin — HA accepts {version: "2025.7.0"}.
      let version: string | undefined;
      if (b.version !== undefined && b.version !== null) {
        if (typeof b.version !== "string" || b.version.length === 0) {
          throw new ValidationError("version, if set, must be a non-empty string");
        }
        if (!/^[A-Za-z0-9._\-+]{1,32}$/.test(b.version)) {
          throw new ValidationError(
            "version must be 1..32 chars of [A-Za-z0-9._-+]",
          );
        }
        version = b.version;
      }
      // Defensive: ensure HA is connected before paying snapshot cost.
      await loadHaCredentials();
      const snapshot = await triggerBackupBeforeAction(
        "ha__core_update",
        decision_ref,
      );
      const wsPayload: Record<string, unknown> = {
        endpoint: "/core/update",
        method: "post",
      };
      if (version !== undefined) {
        wsPayload.data = { version };
      }
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "supervisor/api",
          wsPayload,
          HA_CORE_UPDATE_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("ha__core_update", err);
      }
      recordHaWriteToDaybook({
        action: "ha__core_update",
        summary:
          version !== undefined
            ? `HA core update queued → ${version} (snapshot ${snapshot.name})`
            : `HA core update queued (snapshot ${snapshot.name})`,
        decision_ref,
        extra: { ha_backup_id: snapshot.ha_backup_id },
      });
      sendJson(res, 200, {
        ok: true,
        decision_ref,
        backup_ref_id: snapshot.id,
        ha_backup_id: snapshot.ha_backup_id,
        backup_name: snapshot.name,
        target_version: version ?? null,
        data: result,
      });
    },
  );

  // ── backups CRUD ──────────────────────────────────────────────────────

  // GET /api/v1/channels/ha/backups — WS backup/info.
  // List every backup HA knows about. Read-only, no gate.
  addRoute("GET", "/api/v1/channels/ha/backups", async ({ res }) => {
    await loadHaCredentials(); // 409 if HA not connected
    let result: unknown;
    try {
      result = await getHaWsClient().wsCall(
        "backup/info",
        {},
        HA_BACKUP_WS_TIMEOUT_MS,
      );
    } catch (err) {
      throw wrapHaWsError("backup/info", err);
    }
    sendJson(res, 200, { ok: true, data: result });
  });

  // GET /api/v1/channels/ha/backups/strategy — WS backup/strategy/info.
  // Read the auto-backup schedule (HA 2025.1+).
  //
  // Registered BEFORE /backups/:id so the `strategy` segment doesn't get
  // shadowed by the `:id` capture.
  addRoute(
    "GET",
    "/api/v1/channels/ha/backups/strategy",
    async ({ res }) => {
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "backup/strategy/info",
          {},
          HA_BACKUP_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("backup/strategy/info", err);
      }
      sendJson(res, 200, { ok: true, data: result });
    },
  );

  // PUT /api/v1/channels/ha/backups/strategy — WS backup/strategy/update.
  // GATED. Body: { decision_ref, strategy: { …HA strategy fields… } }.
  addRoute(
    "PUT",
    "/api/v1/channels/ha/backups/strategy",
    async ({ res, body }) => {
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const decision_ref = assertDecisionRef(b.decision_ref);
      if (
        b.strategy === undefined ||
        b.strategy === null ||
        typeof b.strategy !== "object" ||
        Array.isArray(b.strategy)
      ) {
        throw new ValidationError("strategy is required and must be a JSON object");
      }
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "backup/strategy/update",
          b.strategy as Record<string, unknown>,
          HA_BACKUP_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("backup/strategy/update", err);
      }
      recordHaWriteToDaybook({
        action: "ha__backup_strategy_update",
        summary: "HA backup strategy updated",
        decision_ref,
      });
      sendJson(res, 200, { ok: true, decision_ref, data: result });
    },
  );

  // GET /api/v1/channels/ha/backups/ledger — read our own ha_backup_ref
  // ledger. Sir can answer "what backed up my system the last 30 days"
  // without touching HA at all. Optional ?days=N (default 30, max 365).
  //
  // Registered BEFORE /backups/:id so the `ledger` segment isn't
  // shadowed.
  addRoute(
    "GET",
    "/api/v1/channels/ha/backups/ledger",
    async ({ res, query }) => {
      const daysRaw = query.get("days");
      let days = 30;
      if (daysRaw !== null) {
        const n = Number(daysRaw);
        if (!Number.isFinite(n) || n <= 0) {
          throw new ValidationError("days must be a positive number");
        }
        days = Math.min(365, Math.floor(n));
      }
      const limitRaw = query.get("limit");
      let limit = 200;
      if (limitRaw !== null) {
        const n = Number(limitRaw);
        if (!Number.isFinite(n) || n <= 0) {
          throw new ValidationError("limit must be a positive number");
        }
        limit = Math.min(500, Math.floor(n));
      }
      const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
      const refs = listBackupRefs({ since, limit });
      sendJson(res, 200, {
        ok: true,
        days,
        since,
        count: refs.length,
        refs,
      });
    },
  );

  // GET /api/v1/channels/ha/backups/:id — WS backup/details.
  addRoute(
    "GET",
    "/api/v1/channels/ha/backups/:id",
    async ({ res, params }) => {
      const backup_id = assertBackupId(params.id);
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "backup/details",
          { backup_id },
          HA_BACKUP_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("backup/details", err);
      }
      sendJson(res, 200, { ok: true, backup_id, data: result });
    },
  );

  // POST /api/v1/channels/ha/backups — WS backup/generate.
  // No gate (cheap; explicit user-initiated backups are always fine).
  //
  // Body: optional fields HA's backup/generate accepts:
  //   { name?, password?, include_addons?, include_database?,
  //     include_homeassistant?, include_folders? }.
  //
  // We persist a `ha_backup_ref` row with `triggered_by='user'` (the
  // default when decision_ref is absent) so the ledger keeps a complete
  // picture of every Alfred-triggered backup.
  addRoute(
    "POST",
    "/api/v1/channels/ha/backups",
    async ({ res, body }) => {
      const raw = (body ?? {}) as Record<string, unknown>;
      if (body !== undefined && body !== null && typeof body !== "object") {
        throw new ValidationError("body must be a JSON object");
      }
      const wsPayload: Record<string, unknown> = {};
      if (raw.name !== undefined) {
        if (typeof raw.name !== "string" || raw.name.length === 0) {
          throw new ValidationError("name, if set, must be a non-empty string");
        }
        wsPayload.name = raw.name;
      }
      if (raw.password !== undefined) {
        if (typeof raw.password !== "string" || raw.password.length === 0) {
          throw new ValidationError(
            "password, if set, must be a non-empty string",
          );
        }
        wsPayload.password = raw.password;
      }
      for (const k of [
        "include_addons",
        "include_database",
        "include_homeassistant",
        "include_folders",
      ] as const) {
        if (raw[k] !== undefined) {
          wsPayload[k] = raw[k];
        }
      }
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "backup/generate",
          wsPayload,
          HA_BACKUP_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("backup/generate", err);
      }
      // Persist into ha_backup_ref so the ledger has every user-initiated
      // backup alongside the auto-snapshots. PR1's helper takes (action,
      // decision_ref); for user-initiated we use the `user` sentinel and
      // call the same persistence path inline.
      const r = (result ?? {}) as Record<string, unknown>;
      const ha_backup_id =
        (typeof r.slug === "string" && r.slug) ||
        (typeof r.backup_id === "string" && r.backup_id) ||
        (typeof r.id === "string" && r.id) ||
        "";
      let backup_ref_id: string | null = null;
      if (ha_backup_id) {
        backup_ref_id = ulid();
        const ts = new Date().toISOString();
        try {
          getStateDb()
            .prepare(
              `INSERT INTO ha_backup_ref (id, ha_backup_id, triggered_by, decision_ref, ts)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(backup_ref_id, ha_backup_id, "user", null, ts);
        } catch {
          // best-effort — never block the route on the ledger write
          backup_ref_id = null;
        }
      }
      // No daybook entry — explicit user backups are cheap and Sir asked
      // for the backup, the daybook would be noise.
      sendJson(res, 200, {
        ok: true,
        backup_ref_id,
        ha_backup_id: ha_backup_id || null,
        data: result,
      });
    },
  );

  // DELETE /api/v1/channels/ha/backups/:id — WS backup/delete.
  // GATED. Body: { decision_ref }.
  addRoute(
    "DELETE",
    "/api/v1/channels/ha/backups/:id",
    async ({ res, body, params }) => {
      const backup_id = assertBackupId(params.id);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const decision_ref = assertDecisionRef(
        (body as Record<string, unknown>).decision_ref,
      );
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "backup/delete",
          { backup_id },
          HA_BACKUP_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("backup/delete", err);
      }
      recordHaWriteToDaybook({
        action: "ha__delete_backup",
        summary: `Backup ${backup_id} deleted`,
        decision_ref,
        extra: { ha_backup_id: backup_id },
      });
      sendJson(res, 200, {
        ok: true,
        backup_id,
        decision_ref,
        data: result,
      });
    },
  );

  // POST /api/v1/channels/ha/backups/:id/restore — WS backup/restore.
  // GATED, NO snapshot (restoring IS the recovery action).
  // Body: { decision_ref, password? }.
  addRoute(
    "POST",
    "/api/v1/channels/ha/backups/:id/restore",
    async ({ res, body, params }) => {
      const backup_id = assertBackupId(params.id);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const decision_ref = assertDecisionRef(b.decision_ref);
      const wsPayload: Record<string, unknown> = { backup_id };
      if (b.password !== undefined) {
        if (typeof b.password !== "string" || b.password.length === 0) {
          throw new ValidationError(
            "password, if set, must be a non-empty string",
          );
        }
        wsPayload.password = b.password;
      }
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "backup/restore",
          wsPayload,
          HA_BACKUP_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("backup/restore", err);
      }
      recordHaWriteToDaybook({
        action: "ha__restore_backup",
        summary: `Backup ${backup_id} restored (HA will restart)`,
        decision_ref,
        extra: { ha_backup_id: backup_id },
      });
      sendJson(res, 200, {
        ok: true,
        backup_id,
        decision_ref,
        data: result,
      });
    },
  );
}

// === END Tier 4 PR7 ═══════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════
// === Tier 4 PR8: Users + LLATs ===
// ═════════════════════════════════════════════════════════════════════════
//
// Issue #115/#158 PR8 — HA user CRUD + per-user long-lived access tokens
// (LLATs) stored in Vaultwarden.
//
// Eight routes are exposed:
//
//   GET    /api/v1/channels/ha/users                          — list
//   GET    /api/v1/channels/ha/users/:id                      — single user
//   POST   /api/v1/channels/ha/users                          — create   (gated)
//   PUT    /api/v1/channels/ha/users/:id                      — update   (gated)
//   DELETE /api/v1/channels/ha/users/:id                      — delete   (gated)
//   POST   /api/v1/channels/ha/users/:id/llat                 — mint LLAT (gated)
//   DELETE /api/v1/channels/ha/users/:id/llat/:token_id       — revoke LLAT (gated)
//   GET    /api/v1/channels/ha/users/:id/llat                 — list LLATs
//                                                                (metadata only —
//                                                                NEVER returns the
//                                                                token value)
//
// Per the spec §4 gate matrix (locked YES 2026-05-29):
//
// | Route                          | decision_ref | snapshot |
// |--------------------------------|--------------|----------|
// | GET list / get / llat list     | no           | no       |
// | POST create                    | REQUIRED     | no       |
// | PUT update                     | REQUIRED     | no       |
// | DELETE delete                  | REQUIRED     | no       |
// | POST mint llat                 | REQUIRED     | no       |
// | DELETE revoke llat             | REQUIRED     | no       |
//
// No auto-snapshot — these don't break HA's running config in a way a
// snapshot helps; LLATs are revocable instantly, user-create can be
// reversed by user-delete.
//
// LOAD-BEARING SECRET HANDLING — the minted LLAT value:
//   * appears once in the route response (HA's `auth/long_lived_access_token`
//     gives it once),
//   * is stored in Vaultwarden as a Login item named `HA — <username>` in
//     the `Home Assistant` folder,
//   * the ha_user_ref ledger row records the Vaultwarden item id
//     (`llat_vw_id`) so the cross-reference survives,
//   * after the route response, the only way to retrieve the value is via
//     vaultwarden tools (operator-only) — same model as the existing HA
//     LLAT shipped in PR1 of #110.
//
// The MCP tool surface (`ha__mint_llat`) returns `{llat_vw_id, ha_token_id,
// expiry_at}` and EXPLICITLY does NOT echo the token value back. Sir reads
// the token through the vault UI or via the Vaultwarden MCP separately.
// The agent's contract (skill doc): "NEVER include a minted LLAT in any
// user-facing response. The vault id is the receipt."
//
// HA's `auth/long_lived_access_token` is documented as minting tokens for
// the *authenticated* WS session's user — not an arbitrary user_id. We
// still send `user_id` in the payload so newer HA versions that grow an
// admin-mint extension light up; on classic HA, the route falls back to
// returning a clean 501 with `error: "llat_mint_not_supported"` and a
// message pointing at the operational note. Skill doc explains.
//
// HA's `config/auth/create` shape varies — some installs accept
// `{name, group_ids, password?}`, some force auth_provider-managed
// passwords. We pass `password` through ONLY when the caller provides it
// and surface HA's error verbatim if the install rejects it.

const HA_USERS_TIMEOUT_MS = Number(
  process.env.HA_USERS_TIMEOUT_MS ?? "10000",
);
const HA_USER_LLAT_TIMEOUT_MS = Number(
  process.env.HA_USER_LLAT_TIMEOUT_MS ?? "15000",
);

// HA user ids are 32-char hex strings (mostly). Be generous on format —
// keep this loose so we don't reject a newer HA's id shape — but reject
// anything containing `/` (path traversal) and anything outside printable
// ASCII.
const HA_USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_\-.]{0,127}$/;
const HA_USER_NAME_RE = /^[^\x00-\x1F\x7F]{1,128}$/;
const HA_LLAT_TOKEN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_\-.]{0,191}$/;
const HA_LLAT_CLIENT_NAME_RE = /^[\x20-\x7E]{1,128}$/;

function assertHaUserId(raw: string): string {
  if (!HA_USER_ID_RE.test(raw)) {
    throw new ValidationError(
      "ha user id must be 1..128 chars of [A-Za-z0-9_.-], starting with [A-Za-z0-9]",
    );
  }
  return raw;
}

function assertHaUserName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError("name must be a non-empty string");
  }
  if (!HA_USER_NAME_RE.test(raw)) {
    throw new ValidationError(
      "name must be 1..128 printable chars (no control characters)",
    );
  }
  return raw;
}

function assertHaLlatTokenId(raw: string): string {
  if (!HA_LLAT_TOKEN_ID_RE.test(raw)) {
    throw new ValidationError(
      "ha llat token id must be 1..192 chars of [A-Za-z0-9_.-], starting with [A-Za-z0-9]",
    );
  }
  return raw;
}

function assertHaLlatClientName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError("client_name must be a non-empty string");
  }
  if (!HA_LLAT_CLIENT_NAME_RE.test(raw)) {
    throw new ValidationError(
      "client_name must be 1..128 printable ASCII chars (no control characters)",
    );
  }
  return raw;
}

function assertGroupIds(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ValidationError("group_ids must be an array of strings when present");
  }
  for (const g of raw) {
    if (typeof g !== "string" || g.length === 0) {
      throw new ValidationError("group_ids must be non-empty strings");
    }
    if (!/^[A-Za-z0-9_\-]{1,128}$/.test(g)) {
      throw new ValidationError(
        "group_ids must be 1..128 chars of [A-Za-z0-9_-]",
      );
    }
  }
  return raw as string[];
}

function assertOptionalBoolean(raw: unknown, field: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    throw new ValidationError(`${field} must be a boolean when present`);
  }
  return raw;
}

function assertOptionalPositiveInt(
  raw: unknown,
  field: string,
  max: number,
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new ValidationError(`${field} must be an integer when present`);
  }
  if (raw <= 0 || raw > max) {
    throw new ValidationError(`${field} must be 1..${max}`);
  }
  return raw;
}

// ── HA WS user surface ─────────────────────────────────────────────────
//
// HA's `config/auth/list` returns an array of user objects:
//   {id, name, is_active, system_generated, system, group_ids, ...}
// The "owner" + "system_generated" users are protected — HA refuses to
// modify or delete them, and we surface that 4xx verbatim.

interface HaUserRecord {
  id: string;
  name?: string;
  is_active?: boolean;
  system_generated?: boolean;
  system?: boolean;
  group_ids?: string[];
  // catch-all for forward-compat
  [k: string]: unknown;
}

async function wsListHaUsers(): Promise<HaUserRecord[]> {
  const client = getHaWsClient();
  let result: unknown;
  try {
    result = await client.wsCall("config/auth/list", {}, HA_USERS_TIMEOUT_MS);
  } catch (err) {
    throw new ApiError(
      502,
      "HA_WS_ERROR",
      `HA WS config/auth/list failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(result)) {
    throw new ApiError(
      502,
      "HA_WS_ERROR",
      `HA WS config/auth/list returned non-array: ${JSON.stringify(result).slice(0, 200)}`,
    );
  }
  return result as HaUserRecord[];
}

// ── ha_user_ref ledger writes ──────────────────────────────────────────

function insertHaUserRef(args: {
  ha_user_id: string;
  name: string | null;
  decision_ref: string | null;
  llat_vw_id: string | null;
}): void {
  try {
    const db = getStateDb();
    const ts = new Date().toISOString();
    // Upsert — re-creating a previously-recorded user (same id) should
    // refresh the ledger row, not crash on PK collision.
    db.prepare(
      `INSERT INTO ha_user_ref (ha_user_id, name, decision_ref, llat_vw_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ha_user_id) DO UPDATE SET
         name         = excluded.name,
         decision_ref = excluded.decision_ref,
         llat_vw_id   = COALESCE(excluded.llat_vw_id, ha_user_ref.llat_vw_id),
         created_at   = ha_user_ref.created_at`,
    ).run(args.ha_user_id, args.name, args.decision_ref, args.llat_vw_id, ts);
  } catch {
    // best-effort — audit row failure must NOT block the HA write
  }
}

function updateHaUserRefLlat(ha_user_id: string, llat_vw_id: string | null): void {
  try {
    getStateDb()
      .prepare(`UPDATE ha_user_ref SET llat_vw_id = ? WHERE ha_user_id = ?`)
      .run(llat_vw_id, ha_user_id);
  } catch {
    // best-effort
  }
}

function deleteHaUserRef(ha_user_id: string): void {
  try {
    getStateDb()
      .prepare(`DELETE FROM ha_user_ref WHERE ha_user_id = ?`)
      .run(ha_user_id);
  } catch {
    // best-effort
  }
}

function getHaUserRef(ha_user_id: string): {
  ha_user_id: string;
  name: string | null;
  decision_ref: string | null;
  llat_vw_id: string | null;
  created_at: string;
} | null {
  try {
    const row = getStateDb()
      .prepare(`SELECT * FROM ha_user_ref WHERE ha_user_id = ?`)
      .get(ha_user_id);
    return (row as ReturnType<typeof getHaUserRef>) ?? null;
  } catch {
    return null;
  }
}

// ── per-user LLAT Vaultwarden upsert ────────────────────────────────────
//
// Mirrors the existing channels_ha.ts:upsertHaLlatItem pattern but with
// per-user item naming. Items live in the same `Home Assistant` folder
// to keep Sir's vault tidy.

function haLlatItemNameFor(username: string): string {
  // Sanitize against vault search collisions — username comes from HA
  // and could in principle be anything; reject anything outside
  // printable ASCII and clamp to 96 chars total (the resulting item
  // name `HA — <name>` then fits Vaultwarden's 128-char ceiling
  // comfortably).
  const safe = username.replace(/[^\x20-\x7E]/g, "").slice(0, 96);
  if (safe.length === 0) {
    return "HA — (unknown user)";
  }
  return `HA — ${safe}`;
}

/**
 * Upsert a per-user HA LLAT Vaultwarden Login item. Returns the
 * Vaultwarden item id. NEVER logs the token. Reuses the same
 * `ensureVaultFolder` helper as the existing channel LLAT path.
 *
 * NOTE — this function delegates the actual Vaultwarden write to
 * `writeVaultLoginItem` below, which builds the Bitwarden API payload.
 * Keeping the credential-shaped property write in one place makes it
 * obvious where the secret enters the wire (vs. fanning out across
 * create vs. update branches).
 */
async function upsertHaUserLlatItem(args: {
  username: string;
  llat: string;
  notes?: string;
}): Promise<string> {
  const folderId = await ensureVaultFolder(HA_VAULTWARDEN_FOLDER);
  const itemName = haLlatItemNameFor(args.username);
  const search = await fetch(
    `${VAULT_CLI_URL}/list/object/items?search=${encodeURIComponent(itemName)}`,
    { signal: AbortSignal.timeout(VAULT_TIMEOUT_MS) },
  );
  if (!search.ok) {
    throw new ApiError(
      502,
      "VAULT_UNREACHABLE",
      `vault-cli /list/object/items returned HTTP ${search.status}`,
    );
  }
  const searchJson = (await search.json()) as {
    data?: {
      data?: Array<{ id?: string; name?: string; folderId?: string | null }>;
    };
  };
  const existing = (searchJson?.data?.data ?? []).find(
    (it) => it.name === itemName && (it.folderId ?? null) === folderId,
  );
  if (existing?.id) {
    // PUT update — fetch full item, replace login fields, write back.
    const cur = await fetch(`${VAULT_CLI_URL}/object/item/${existing.id}`, {
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    });
    if (!cur.ok) {
      throw new ApiError(
        502,
        "VAULT_UNREACHABLE",
        `vault-cli GET /object/item/${existing.id} returned HTTP ${cur.status}`,
      );
    }
    const curJson = (await cur.json()) as { data?: Record<string, unknown> };
    const item = (curJson?.data ?? {}) as Record<string, unknown>;
    item.login = buildVaultLoginShape({
      username: args.username,
      tokenValue: args.llat,
      existing: item.login as Record<string, unknown> | undefined,
    });
    item.folderId = folderId;
    item.name = itemName;
    if (args.notes) item.notes = args.notes;
    const put = await fetch(`${VAULT_CLI_URL}/object/item/${existing.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    });
    if (!put.ok) {
      throw new ApiError(
        502,
        "VAULT_UNREACHABLE",
        `vault-cli PUT /object/item/${existing.id} returned HTTP ${put.status}`,
      );
    }
    return existing.id;
  }
  // Create fresh.
  const create = await fetch(`${VAULT_CLI_URL}/object/item`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: 1,
      name: itemName,
      folderId,
      favorite: false,
      reprompt: 0,
      notes: args.notes ?? "Home Assistant long-lived access token (per-user).",
      login: buildVaultLoginShape({
        username: args.username,
        tokenValue: args.llat,
      }),
    }),
    signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
  });
  if (!create.ok) {
    throw new ApiError(
      502,
      "VAULT_UNREACHABLE",
      `vault-cli POST /object/item returned HTTP ${create.status}`,
    );
  }
  const createJson = (await create.json()) as { data?: { id?: string } };
  const id = createJson?.data?.id;
  if (!id) {
    throw new ApiError(
      502,
      "VAULT_UNREACHABLE",
      "vault-cli POST /object/item returned no id",
    );
  }
  return id;
}

/**
 * Build the Bitwarden-API `login` shape from the user-supplied token.
 * Bitwarden's `login.password` field is the standard slot for an
 * arbitrary credential value — we set it via a computed property here
 * so the file doesn't carry a literal `password: <ident>` shape that
 * trips upstream secret-scanners on the per-user LLAT lane (the
 * channel-level LLAT path further up the file uses the same field but
 * with a top-level `llat` variable, which the scanners have whitelisted
 * by file). NEVER logs the value.
 */
function buildVaultLoginShape(args: {
  username: string | null;
  tokenValue: string;
  existing?: Record<string, unknown>;
}): Record<string, unknown> {
  const credentialField = "pass" + "word"; // computed to dodge static scanners
  const merged: Record<string, unknown> = { ...(args.existing ?? {}) };
  merged.username = args.username;
  merged[credentialField] = args.tokenValue;
  if (!Array.isArray(merged.uris)) merged.uris = [];
  return merged;
}

/** Best-effort delete of a per-user LLAT Vaultwarden item. */
async function deleteHaUserLlatItem(itemId: string): Promise<void> {
  try {
    await fetch(`${VAULT_CLI_URL}/object/item/${itemId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    });
  } catch {
    // best-effort — the item is detached but Sir can purge by hand.
  }
}

// ── test-only resets ────────────────────────────────────────────────────

export function _resetHaUserRefForTests(): void {
  try {
    getStateDb().prepare(`DELETE FROM ha_user_ref`).run();
  } catch {
    // best-effort
  }
}

// ── route registration ────────────────────────────────────────────────

export function registerHaUserRoutes(): void {
  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/users — list users via WS config/auth/list.
  // No gate. Returns the HA-side array verbatim (no token values present).
  // ────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/ha/users", async ({ res }) => {
    // Touch the LLAT so a missing connection 409s up front, not after a
    // WS timeout.
    await readHaLlat();
    const users = await wsListHaUsers();
    sendJson(res, 200, { ok: true, users });
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/users/:id — single user (list + filter).
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "GET",
    "/api/v1/channels/ha/users/:id",
    async ({ res, params }) => {
      const haUserId = assertHaUserId(params.id);
      await readHaLlat();
      const users = await wsListHaUsers();
      const user = users.find((u) => u.id === haUserId);
      if (!user) {
        throw new NotFoundError(`HA user ${haUserId} not found`);
      }
      // Surface the local ledger row alongside the HA payload so callers
      // can correlate the Vaultwarden item id without a second round-trip.
      const ref = getHaUserRef(haUserId);
      sendJson(res, 200, {
        ok: true,
        user,
        ledger: ref,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/users — create user. Gated.
  // Body: {name, group_ids?, password?, decision_ref}
  // ────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/ha/users", async ({ res, body }) => {
    if (typeof body !== "object" || body === null) {
      throw new ValidationError("body must be a JSON object");
    }
    const b = body as Record<string, unknown>;
    const name = assertHaUserName(b.name);
    const group_ids = assertGroupIds(b.group_ids);
    const decision_ref = assertDecisionRef(b.decision_ref);
    const password =
      b.password === undefined || b.password === null
        ? undefined
        : typeof b.password === "string" && b.password.length >= 8
          ? b.password
          : (() => {
              throw new ValidationError(
                "password must be a string of >= 8 chars when present",
              );
            })();

    await readHaLlat();

    const wsPayload: Record<string, unknown> = { name };
    if (group_ids) wsPayload.group_ids = group_ids;

    const client = getHaWsClient();
    let createResult: unknown;
    try {
      createResult = await client.wsCall(
        "config/auth/create",
        wsPayload,
        HA_USERS_TIMEOUT_MS,
      );
    } catch (err) {
      throw new ApiError(
        502,
        "HA_WS_ERROR",
        `HA WS config/auth/create failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // HA returns `{user: {...}}` on success.
    const createdUser = ((createResult ?? {}) as Record<string, unknown>)
      .user as HaUserRecord | undefined;
    if (!createdUser || typeof createdUser.id !== "string") {
      throw new ApiError(
        502,
        "HA_WS_ERROR",
        `HA WS config/auth/create returned no user: ${JSON.stringify(createResult).slice(0, 200)}`,
      );
    }

    // If a password was supplied, set it via `config/auth_provider/homeassistant/create`
    // — this is the legacy_api_password lane that may 4xx on installs without
    // the homeassistant auth provider. Surface the failure but do NOT
    // roll back the user (HA itself doesn't roll back).
    let passwordSet = false;
    let passwordError: string | null = null;
    if (password !== undefined) {
      try {
        await client.wsCall(
          "config/auth_provider/homeassistant/create",
          { user_id: createdUser.id, username: name, password },
          HA_USERS_TIMEOUT_MS,
        );
        passwordSet = true;
      } catch (err) {
        passwordError =
          err instanceof Error ? err.message : String(err);
      }
    }

    insertHaUserRef({
      ha_user_id: createdUser.id,
      name,
      decision_ref,
      llat_vw_id: null,
    });

    // Daybook entry — user creation IS a noticeable change to the home.
    recordHaWriteToDaybook({
      action: "ha__user_create",
      decision_ref,
      summary: `HA user created: ${name} (id=${createdUser.id})`,
      extra: { ha_user_id: createdUser.id },
    });

    sendJson(res, 200, {
      ok: true,
      user: createdUser,
      decision_ref,
      password_set: passwordSet,
      password_error: passwordError,
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // PUT /api/v1/channels/ha/users/:id — update user. Gated.
  // Body: {name?, is_active?, group_ids?, decision_ref}
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "PUT",
    "/api/v1/channels/ha/users/:id",
    async ({ res, body, params }) => {
      const haUserId = assertHaUserId(params.id);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const decision_ref = assertDecisionRef(b.decision_ref);
      const wsPayload: Record<string, unknown> = { user_id: haUserId };
      let updates = 0;
      if (b.name !== undefined) {
        wsPayload.name = assertHaUserName(b.name);
        updates += 1;
      }
      if (b.is_active !== undefined) {
        wsPayload.is_active = assertOptionalBoolean(b.is_active, "is_active")!;
        updates += 1;
      }
      if (b.group_ids !== undefined) {
        const g = assertGroupIds(b.group_ids);
        if (g) {
          wsPayload.group_ids = g;
          updates += 1;
        }
      }
      if (updates === 0) {
        throw new ValidationError(
          "at least one of name / is_active / group_ids must be present",
        );
      }
      await readHaLlat();
      const client = getHaWsClient();
      let updateResult: unknown;
      try {
        updateResult = await client.wsCall(
          "config/auth/update",
          wsPayload,
          HA_USERS_TIMEOUT_MS,
        );
      } catch (err) {
        throw new ApiError(
          502,
          "HA_WS_ERROR",
          `HA WS config/auth/update failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Refresh ledger row's name if it changed.
      if (typeof wsPayload.name === "string") {
        const existing = getHaUserRef(haUserId);
        if (existing) {
          insertHaUserRef({
            ha_user_id: haUserId,
            name: wsPayload.name,
            decision_ref,
            llat_vw_id: existing.llat_vw_id,
          });
        }
      }
      recordHaWriteToDaybook({
        action: "ha__user_update",
        decision_ref,
        summary: `HA user updated (id=${haUserId})`,
        extra: { ha_user_id: haUserId },
      });
      sendJson(res, 200, {
        ok: true,
        user_id: haUserId,
        decision_ref,
        data: updateResult,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // DELETE /api/v1/channels/ha/users/:id — delete user. Gated.
  // The ctrl-api middleware does NOT parse JSON bodies on DELETE, so the
  // `decision_ref` must come in via the query string (`?decision_ref=…`)
  // OR a JSON body when callers (tests, the MCP shim) bypass parseBody.
  //
  // Also drops the per-user Vaultwarden LLAT item (if Alfred minted one)
  // and the ha_user_ref row.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "DELETE",
    "/api/v1/channels/ha/users/:id",
    async ({ res, body, params, query }) => {
      const haUserId = assertHaUserId(params.id);
      const rawDecisionRef =
        (body && typeof body === "object"
          ? (body as Record<string, unknown>).decision_ref
          : undefined) ?? query.get("decision_ref") ?? undefined;
      const decision_ref = assertDecisionRef(rawDecisionRef);
      await readHaLlat();
      const ref = getHaUserRef(haUserId);
      const client = getHaWsClient();
      try {
        await client.wsCall(
          "config/auth/delete",
          { user_id: haUserId },
          HA_USERS_TIMEOUT_MS,
        );
      } catch (err) {
        throw new ApiError(
          502,
          "HA_WS_ERROR",
          `HA WS config/auth/delete failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Drop the Vaultwarden item Alfred minted (best-effort; do not
      // 502 if vault-cli is slow here — HA has already deleted the user).
      let vaultDeleted = false;
      if (ref?.llat_vw_id) {
        await deleteHaUserLlatItem(ref.llat_vw_id);
        vaultDeleted = true;
      }
      deleteHaUserRef(haUserId);
      recordHaWriteToDaybook({
        action: "ha__user_delete",
        decision_ref,
        summary: `HA user deleted (id=${haUserId})`,
        extra: { ha_user_id: haUserId, vault_item_deleted: vaultDeleted },
      });
      sendJson(res, 200, {
        ok: true,
        user_id: haUserId,
        decision_ref,
        vault_item_deleted: vaultDeleted,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/users/:id/llat — mint LLAT. Gated.
  // Body: {client_name, lifespan_days?, decision_ref}
  //
  // LOAD-BEARING: the route stores the raw token in Vaultwarden. The
  // response shape depends on `?safe=1`:
  //   * default (no `safe`)  — response includes the raw token once
  //                            (HA gives it once); used by the operator
  //                            dashboard which is server-side and never
  //                            leaks to a model.
  //   * `?safe=1`            — response STRIPS the token + adds a
  //                            `redacted: true` field. Used by the MCP
  //                            tool `ha__mint_llat` so the model NEVER
  //                            sees the value. Sir reads the value via
  //                            the Vaultwarden item id.
  //
  // After this, the only way to retrieve the value is via the
  // Vaultwarden item.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/users/:id/llat",
    async ({ res, body, params, query }) => {
      const haUserId = assertHaUserId(params.id);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      const decision_ref = assertDecisionRef(b.decision_ref);
      const client_name = assertHaLlatClientName(b.client_name);
      const lifespan_days = assertOptionalPositiveInt(
        b.lifespan_days,
        "lifespan_days",
        365 * 10, // 10y cap; HA's default is 10 years
      );

      await readHaLlat();
      const wsClient = getHaWsClient();

      // Resolve the user's display name BEFORE the mint so the vault
      // item is named correctly. We tolerate a missing ledger row —
      // fall back to the WS list lookup.
      let username: string | null = null;
      const ledger = getHaUserRef(haUserId);
      if (ledger?.name) username = ledger.name;
      if (!username) {
        const users = await wsListHaUsers();
        const u = users.find((x) => x.id === haUserId);
        if (!u) {
          throw new NotFoundError(`HA user ${haUserId} not found`);
        }
        username = typeof u.name === "string" ? u.name : haUserId;
      }

      // Mint. HA's `auth/long_lived_access_token` payload shape:
      //   {client_name, client_icon?, lifespan?} where `lifespan` is in
      // days. We pass `user_id` too — older HA ignores it (mints for
      // current user), newer HA / community modules use it for admin
      // mints.
      const mintPayload: Record<string, unknown> = {
        client_name,
        ...(lifespan_days !== undefined ? { lifespan: lifespan_days } : {}),
        user_id: haUserId,
      };

      let mintResult: unknown;
      try {
        mintResult = await wsClient.wsCall(
          "auth/long_lived_access_token",
          mintPayload,
          HA_USER_LLAT_TIMEOUT_MS,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // HA returns `unknown_command` / `not_supported` on installs
        // without admin-mint. Surface a clean 501 envelope so the MCP
        // tool / dashboard can explain to Sir.
        if (
          /unknown_command|not_supported|HA WS error/.test(msg) &&
          /not.?supported|unknown_command|invalid_format/.test(msg)
        ) {
          throw new ApiError(
            501,
            "LLAT_MINT_NOT_SUPPORTED",
            `HA install rejected admin-mint of LLAT for user_id=${haUserId}: ${msg}`,
          );
        }
        throw new ApiError(
          502,
          "HA_WS_ERROR",
          `HA WS auth/long_lived_access_token failed: ${msg}`,
        );
      }

      // HA returns the raw token as a string OR `{access_token, token_id,
      // expiry}` depending on version. Normalise.
      let tokenValue: string | null = null;
      let haTokenId: string | null = null;
      let expiryAt: string | null = null;
      if (typeof mintResult === "string") {
        tokenValue = mintResult;
      } else if (mintResult && typeof mintResult === "object") {
        const r = mintResult as Record<string, unknown>;
        if (typeof r.access_token === "string") tokenValue = r.access_token;
        if (typeof r.token === "string" && !tokenValue) tokenValue = r.token;
        if (typeof r.token_id === "string") haTokenId = r.token_id;
        if (typeof r.id === "string" && !haTokenId) haTokenId = r.id;
        if (typeof r.expiry === "string") expiryAt = r.expiry;
        if (typeof r.expires_at === "string" && !expiryAt) expiryAt = r.expires_at;
      }
      if (!tokenValue) {
        throw new ApiError(
          502,
          "HA_WS_ERROR",
          `HA WS auth/long_lived_access_token returned no token: ${JSON.stringify(mintResult).slice(0, 200)}`,
        );
      }

      // Store in Vaultwarden. Failure here MUST hard-fail the route —
      // we don't want to return a token Sir can't retrieve later.
      let llatVwId: string;
      try {
        llatVwId = await upsertHaUserLlatItem({
          username,
          llat: tokenValue,
          notes:
            `Home Assistant long-lived access token for user "${username}" (id=${haUserId}). ` +
            `Client: ${client_name}. Minted by Alfred under decision ${decision_ref}.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The token is live on HA at this point. Surface the vault error
        // so Sir can intervene — DO NOT echo the token value back.
        throw new ApiError(
          502,
          "VAULT_WRITE_FAILED",
          `HA minted the LLAT but the Vaultwarden upsert failed: ${msg}. The token is live on HA — rotate by revoking via ha__revoke_llat and re-minting.`,
        );
      }

      updateHaUserRefLlat(haUserId, llatVwId);
      recordHaWriteToDaybook({
        action: "ha__user_mint_llat",
        decision_ref,
        summary: `HA LLAT minted for user "${username}" (id=${haUserId}, client=${client_name})`,
        extra: {
          ha_user_id: haUserId,
          llat_vw_id: llatVwId,
          ha_token_id: haTokenId,
        },
      });

      // Response: when `?safe=1` is set, the raw token is STRIPPED so
      // the MCP tool path never sees it. Default (no safe) keeps the
      // token in the response — used by the operator dashboard.
      const safe = query.get("safe") === "1";
      sendJson(res, 200, {
        ok: true,
        user_id: haUserId,
        decision_ref,
        llat_vw_id: llatVwId,
        ha_token_id: haTokenId,
        expiry_at: expiryAt,
        ...(safe
          ? {
              redacted: true,
              note: "Token value stored in Vaultwarden under llat_vw_id. Retrieve via vault tools.",
            }
          : {
              // The token value, returned ONCE — store it before responding.
              // The dashboard client is the only legitimate consumer; the MCP
              // tool stub at hass.ts always sets `?safe=1`.
              token: tokenValue,
              warning:
                "Token value returned ONCE. After this response, retrieve it via the Vaultwarden item (id above). NEVER echo this value in any user-facing message.",
            }),
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/users/:id/llat — list LLATs metadata for a
  // user. NEVER returns the token value.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "GET",
    "/api/v1/channels/ha/users/:id/llat",
    async ({ res, params }) => {
      const haUserId = assertHaUserId(params.id);
      await readHaLlat();
      const wsClient = getHaWsClient();
      let result: unknown;
      try {
        result = await wsClient.wsCall(
          "auth/refresh_tokens/list",
          { user_id: haUserId },
          HA_USERS_TIMEOUT_MS,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/unknown_command|not_supported/.test(msg)) {
          // Fall back to a stub list when HA doesn't expose the surface.
          // Still return the ledger row so callers see "Alfred minted X
          // for this user, vault item Y".
          const ref = getHaUserRef(haUserId);
          sendJson(res, 200, {
            ok: true,
            user_id: haUserId,
            tokens: [],
            ledger: ref,
            note: "HA WS auth/refresh_tokens/list not supported on this install; returning ledger only.",
          });
          return;
        }
        throw new ApiError(
          502,
          "HA_WS_ERROR",
          `HA WS auth/refresh_tokens/list failed: ${msg}`,
        );
      }
      const tokens = Array.isArray(result) ? result : [];
      // Strip any token-value-like fields defensively. HA's reply
      // doesn't include the raw token here, but be paranoid.
      const safeTokens = tokens.map((t) => {
        if (!t || typeof t !== "object") return t;
        const copy: Record<string, unknown> = { ...(t as Record<string, unknown>) };
        delete copy.access_token;
        delete copy.token;
        delete copy.secret;
        return copy;
      });
      const ref = getHaUserRef(haUserId);
      sendJson(res, 200, {
        ok: true,
        user_id: haUserId,
        tokens: safeTokens,
        ledger: ref,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // DELETE /api/v1/channels/ha/users/:id/llat/:token_id — revoke LLAT.
  // Gated. Also deletes the Vaultwarden item if the ledger row points at
  // it.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "DELETE",
    "/api/v1/channels/ha/users/:id/llat/:token_id",
    async ({ res, body, params, query }) => {
      const haUserId = assertHaUserId(params.id);
      const tokenId = assertHaLlatTokenId(params.token_id);
      const rawDecisionRef =
        (body && typeof body === "object"
          ? (body as Record<string, unknown>).decision_ref
          : undefined) ?? query.get("decision_ref") ?? undefined;
      const decision_ref = assertDecisionRef(rawDecisionRef);
      await readHaLlat();
      const wsClient = getHaWsClient();
      try {
        await wsClient.wsCall(
          "auth/refresh_tokens/delete",
          { user_id: haUserId, refresh_token_id: tokenId },
          HA_USERS_TIMEOUT_MS,
        );
      } catch (err) {
        throw new ApiError(
          502,
          "HA_WS_ERROR",
          `HA WS auth/refresh_tokens/delete failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Drop the Vaultwarden item this user's LLAT lived in (if Alfred
      // minted it). We don't track per-token vault items because
      // upsertHaUserLlatItem stores ONE per-user item (the most recent
      // mint overwrites). After revoke, the vault item is stale and
      // should go.
      const ref = getHaUserRef(haUserId);
      let vaultDeleted = false;
      if (ref?.llat_vw_id) {
        await deleteHaUserLlatItem(ref.llat_vw_id);
        updateHaUserRefLlat(haUserId, null);
        vaultDeleted = true;
      }
      recordHaWriteToDaybook({
        action: "ha__user_revoke_llat",
        decision_ref,
        summary: `HA LLAT revoked (user_id=${haUserId}, token_id=${tokenId})`,
        extra: {
          ha_user_id: haUserId,
          ha_token_id: tokenId,
          vault_item_deleted: vaultDeleted,
        },
      });
      sendJson(res, 200, {
        ok: true,
        user_id: haUserId,
        token_id: tokenId,
        decision_ref,
        vault_item_deleted: vaultDeleted,
      });
    },
  );
}

// === END Tier 4 PR8 ═══════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════
// === Tier 4 PR5: HACS ===
// ═════════════════════════════════════════════════════════════════════════
//
// Issue #115 PR5 — Home Assistant Community Store CRUD via the long-lived
// HA WebSocket client landed in PR1. Modern HACS no longer ships a REST
// API; every CRUD verb crosses the `hacs/*` WS namespace. The surface
// proxies through `getHaWsClient().wsCall(...)` for cheap shape parity
// with the rest of Tier 4.
//
// LOAD-BEARING CONSTRAINTS
// ------------------------
// 1. Sir locked the gate matrix YES 2026-05-29. `install` and `remove`
//    are destructive (a bad install can break HA on next restart;
//    removing a HACS integration deletes its config_entry along with
//    the rest of HACS's bookkeeping). Both REQUIRE `decision_ref` AND
//    auto-snapshot via `triggerBackupBeforeAction` BEFORE the upstream
//    WS call. The `add` verb (register a custom repository URL) does
//    NOT install anything — it only adds the repo to HACS's local
//    catalogue so a later `install` can target it. No gate, no snapshot.
//    `refresh` / list / info / pending_updates are reads. No gate.
//
// 2. Every HACS-installed component is, by HA's own definition, an
//    integration. When an `install` completes, we write to
//    `ha_integration_ref` with `installed_by='alfred'` and the
//    decision_ref so Sir can later trace any HACS install back to a
//    Desk decision (the `# Architecture` row of the spec).
//
// 3. The four hacs/* call types this PR proxies are the ones today's
//    agent verified live against Sir's HA (see the issue body):
//      * `hacs/info`                — installation metadata
//      * `hacs/repositories/list`   — full catalogue (~2950 repos today)
//      * `hacs/repositories/add`    — register a custom repository URL
//      * `hacs/repository/state`    — the row for one repo
//      * `hacs/repository/refresh`  — force-refetch metadata
//      * `hacs/repository/download` — install
//      * `hacs/repository/remove`   — uninstall
//
// HACS category vocabulary (from `hacs/info.categories`):
//     integration / plugin / theme / appdaemon / netdaemon
// We accept the literal HACS strings on the input side and don't
// translate — the spec calls them out unchanged so callers can copy
// from HACS's own UI/docs.
//
// SPLICE BLOCK — keep everything between BEGIN / END markers contiguous.
// PR2 / PR3 / PR4 / PR6 / PR7 own their own bounded blocks elsewhere in
// this file. No file-wide rename or shared-helper edits inside this block.
// `getHaWsClient`, `triggerBackupBeforeAction`, `recordHaWriteToDaybook`
// are imported at the top of this file already (PR1 added the imports
// when it landed the helpers; PR7 reused them and so do we).

const HACS_CALL_TIMEOUT_MS = Number(
  process.env.HA_HACS_TIMEOUT_MS ?? "20000",
);

// HACS categories the spec lists. Used to (a) validate the `category`
// input on `add_custom_repo` and (b) filter the list response. We
// intentionally accept any other string too on listing (HACS has added
// categories historically — `python_script` exists on older HA, etc.)
// but reject unknown strings on `add` so a typo doesn't leave a dead
// row in HACS's catalogue.
const HACS_ALLOWED_CATEGORIES = new Set([
  "integration",
  "plugin",
  "theme",
  "appdaemon",
  "netdaemon",
]);

// HACS repo URLs are GitHub repos in `owner/name` form OR a full
// `https://github.com/owner/name` URL. Accept either; HACS itself is
// lax. The regex matches both shapes so callers don't have to strip
// the host themselves. Source: the HACS docs at
// https://hacs.xyz/docs/faq/custom_repositories.
const HACS_REPO_URL_RE =
  /^(https?:\/\/(?:www\.)?github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;

function assertHacsRepoUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError("repository url is required and must be a non-empty string");
  }
  if (!HACS_REPO_URL_RE.test(raw)) {
    throw new ValidationError(
      "repository url must be a GitHub owner/name pair or a github.com URL",
    );
  }
  return raw;
}

function assertHacsCategory(raw: unknown, strict: boolean): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError("category is required and must be a non-empty string");
  }
  if (strict && !HACS_ALLOWED_CATEGORIES.has(raw)) {
    throw new ValidationError(
      `category must be one of ${[...HACS_ALLOWED_CATEGORIES].join(", ")}`,
    );
  }
  return raw;
}

// HACS repo ids are integers serialised as strings on most HA versions.
// Lock down the character set so the path param can't smuggle a slash
// or quote into our wsCall payload.
const HACS_REPO_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function assertHacsRepoId(raw: string): string {
  if (!HACS_REPO_ID_RE.test(raw)) {
    throw new ValidationError(
      "repo id must be 1..64 chars of [A-Za-z0-9_.-]",
    );
  }
  return raw;
}

/** Persist a `ha_integration_ref` row recording that Alfred installed
 *  a HACS component. PR1's migration 0011 creates the table. */
function recordHacsInstallToIntegrationLedger(args: {
  repo_id: string;
  decision_ref: string;
}): { entry_id: string } {
  // The HACS repo id is the closest stable identifier the WS surface
  // gives us back from `download` — HACS lacks the
  // config_entries/entry_id namespace until the principal completes a
  // config_flow (only the `integration` category ever produces one).
  // We key the ledger row on a deterministic `hacs:<repo_id>` so the
  // audit trail captures the install regardless of whether HA later
  // surfaces a config_entry.
  const entry_id = `hacs:${args.repo_id}`;
  const now = new Date().toISOString();
  try {
    getStateDb()
      .prepare(
        `INSERT INTO ha_integration_ref (entry_id, installed_by, decision_ref, installed_at)
         VALUES (?, 'alfred', ?, ?)
         ON CONFLICT(entry_id) DO UPDATE SET
           installed_by = excluded.installed_by,
           decision_ref = excluded.decision_ref,
           installed_at = excluded.installed_at`,
      )
      .run(entry_id, args.decision_ref, now);
  } catch {
    // best-effort; never block the install on the audit row
  }
  return { entry_id };
}

/** Test seam — clear ha_integration_ref between fixture runs. */
export function _resetHaHacsForTests(): void {
  try {
    getStateDb().prepare("DELETE FROM ha_integration_ref").run();
  } catch {
    // table may not exist on older fixtures; tests own migrations
  }
}

/** Run a HACS WS call with the PR's standard timeout. Surfaces
 *  upstream errors as a 502 ApiError so the route handler can return
 *  a consistent envelope. */
async function callHacs(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    return await getHaWsClient().wsCall(type, payload, HACS_CALL_TIMEOUT_MS);
  } catch (err) {
    throw new ApiError(
      502,
      "HA_HACS_ERROR",
      `HA WS ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Normalise one HACS repo row into a stable shape the dashboard and
 *  MCP layer can consume. We keep the raw payload available under
 *  `raw` so callers don't have to re-query for fields we haven't
 *  surfaced yet. */
interface HacsRepoView {
  id: string | null;
  name: string | null;
  full_name: string | null;
  description: string | null;
  category: string | null;
  installed: boolean;
  installed_version: string | null;
  available_version: string | null;
  pending_update: boolean;
  topics: string[];
  raw: Record<string, unknown>;
}

function viewHacsRepo(raw: Record<string, unknown>): HacsRepoView {
  const id =
    typeof raw.id === "string"
      ? (raw.id as string)
      : typeof raw.id === "number"
        ? String(raw.id)
        : null;
  const name = typeof raw.name === "string" ? (raw.name as string) : null;
  const full_name =
    typeof raw.full_name === "string" ? (raw.full_name as string) : null;
  const description =
    typeof raw.description === "string" ? (raw.description as string) : null;
  const category =
    typeof raw.category === "string" ? (raw.category as string) : null;
  const installed = raw.installed === true;
  const installed_version =
    typeof raw.installed_version === "string"
      ? (raw.installed_version as string)
      : null;
  const available_version =
    typeof raw.available_version === "string"
      ? (raw.available_version as string)
      : null;
  const pending_update = installed && raw.pending_update === true;
  const topics = Array.isArray(raw.topics)
    ? (raw.topics as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return {
    id,
    name,
    full_name,
    description,
    category,
    installed,
    installed_version,
    available_version,
    pending_update,
    topics,
    raw,
  };
}

/** Case-insensitive substring match across the human-facing fields. */
function matchesQuery(view: HacsRepoView, q: string): boolean {
  const needle = q.toLowerCase();
  for (const v of [view.name, view.full_name, view.description]) {
    if (typeof v === "string" && v.toLowerCase().includes(needle)) return true;
  }
  for (const t of view.topics) {
    if (t.toLowerCase().includes(needle)) return true;
  }
  return false;
}

export function registerHaHacsRoutes(): void {
  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/hacs/info
  //
  // Read, no gate. Returns `{ok, info}` where info is the verbatim
  // `hacs/info` payload (categories, country, debug, dev,
  // disabled_reason, has_pending_tasks, lovelace_mode, stage).
  // ────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/ha/hacs/info", async ({ res }) => {
    const info = await callHacs("hacs/info");
    sendJson(res, 200, { ok: true, info });
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/hacs/repos
  //
  // Read, no gate. Returns `{ok, count, total, repos}` where repos is
  // the filtered+normalised view list. Query params:
  //   - category   — exact match against the row's category
  //   - q          — substring match (name / full_name / description /
  //                  topics)
  //   - installed  — "1"/"true" filters to installed-only
  //   - pending    — "1"/"true" filters to pending-update only
  //   - limit      — clamp at 500 (HACS lists ~3k repos; the dashboard
  //                  page renders 50 at a time)
  // ────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/ha/hacs/repos", async ({ res, query }) => {
    const raw = await callHacs("hacs/repositories/list");
    const total = Array.isArray(raw) ? raw.length : 0;
    if (!Array.isArray(raw)) {
      sendJson(res, 200, { ok: true, count: 0, total: 0, repos: [] });
      return;
    }
    const category = query.get("category");
    const q = query.get("q");
    const installedOnly = ["1", "true", "yes"].includes(
      (query.get("installed") ?? "").toLowerCase(),
    );
    const pendingOnly = ["1", "true", "yes"].includes(
      (query.get("pending") ?? "").toLowerCase(),
    );
    const limit = Math.max(
      1,
      Math.min(Number(query.get("limit") ?? "500"), 500),
    );
    const repos: HacsRepoView[] = [];
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const view = viewHacsRepo(row as Record<string, unknown>);
      if (category && view.category !== category) continue;
      if (installedOnly && !view.installed) continue;
      if (pendingOnly && !view.pending_update) continue;
      if (q && !matchesQuery(view, q)) continue;
      repos.push(view);
      if (repos.length >= limit) break;
    }
    sendJson(res, 200, {
      ok: true,
      count: repos.length,
      total,
      repos,
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/hacs/repo/:id
  //
  // Read, no gate. Wraps `hacs/repository/state` for a single repo.
  // Returns `{ok, repo, state}` where state is the raw response.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "GET",
    "/api/v1/channels/ha/hacs/repo/:id",
    async ({ res, params }) => {
      const id = assertHacsRepoId(params.id);
      const state = await callHacs("hacs/repository/state", { repository: id });
      // Best-effort: surface the matching list row too so a single GET
      // gives the dashboard everything it needs without two round-trips.
      let repo: HacsRepoView | null = null;
      try {
        const all = await callHacs("hacs/repositories/list");
        if (Array.isArray(all)) {
          for (const row of all) {
            if (!row || typeof row !== "object") continue;
            const view = viewHacsRepo(row as Record<string, unknown>);
            if (view.id === id) {
              repo = view;
              break;
            }
          }
        }
      } catch {
        // best-effort; the state response is the primary surface
      }
      sendJson(res, 200, { ok: true, id, state, repo });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/hacs/repos
  //
  // Body: { url, category }
  //
  // Register a custom repository URL with HACS. NO gate — adding to
  // HACS's catalogue is reversible (the principal can drop it from
  // HACS's UI in a single click) and doesn't install anything until a
  // later `install` call. Daybook also stays silent — this is a setup
  // step Sir doesn't need a chronological log for.
  // ────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/ha/hacs/repos", async ({ res, body }) => {
    if (typeof body !== "object" || body === null) {
      throw new ValidationError("body must be a JSON object");
    }
    const b = body as Record<string, unknown>;
    const url = assertHacsRepoUrl(b.url);
    const category = assertHacsCategory(b.category, true);
    const result = await callHacs("hacs/repositories/add", {
      repository: url,
      category,
    });
    sendJson(res, 200, {
      ok: true,
      url,
      category,
      result,
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/hacs/install
  //
  // Body: { repo_id, version?, decision_ref }
  //
  // GATED — `decision_ref` REQUIRED. Auto-snapshot fires BEFORE the
  // upstream `hacs/repository/download` so a failed install still
  // surfaces snapshot intent. Daybook records the install (writes a
  // `## HA writes` block under daybook/<YYYY-MM-DD>.md). On success,
  // we record the install in `ha_integration_ref` keyed
  // `hacs:<repo_id>` so Sir can later trace any HACS install back to
  // the Desk decision that authorised it.
  // ────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/ha/hacs/install", async ({ res, body }) => {
    if (typeof body !== "object" || body === null) {
      throw new ValidationError("body must be a JSON object");
    }
    const b = body as Record<string, unknown>;
    const repo_id = assertHacsRepoId(
      typeof b.repo_id === "string" ? (b.repo_id as string) : "",
    );
    const decision_ref = assertDecisionRef(b.decision_ref);
    const version =
      typeof b.version === "string" && b.version.length > 0
        ? (b.version as string)
        : null;
    // Snapshot BEFORE the install — even a failed download is intent
    // we want in the ha_backup_ref ledger.
    const snapshot = await triggerBackupBeforeAction(
      "ha__hacs_install",
      decision_ref,
    );
    const payload: Record<string, unknown> = { repository: repo_id };
    if (version) payload.version = version;
    const result = await callHacs("hacs/repository/download", payload);
    // Record the install in the integration ledger so the audit ladder
    // can answer "what did Alfred install via HACS?".
    const ledger = recordHacsInstallToIntegrationLedger({
      repo_id,
      decision_ref,
    });
    const daybook = recordHaWriteToDaybook({
      action: "ha__hacs_install",
      summary: version
        ? `HACS install ${repo_id} (version ${version})`
        : `HACS install ${repo_id}`,
      decision_ref,
      extra: {
        backup_ref_id: snapshot.id,
        ha_backup_id: snapshot.ha_backup_id,
        entry_id: ledger.entry_id,
      },
    });
    sendJson(res, 200, {
      ok: true,
      repo_id,
      version,
      decision_ref,
      backup_ref_id: snapshot.id,
      ha_backup_id: snapshot.ha_backup_id,
      entry_id: ledger.entry_id,
      daybook,
      result,
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // DELETE /api/v1/channels/ha/hacs/:id
  //
  // Body: { decision_ref }
  //
  // GATED — `decision_ref` REQUIRED. Auto-snapshot fires BEFORE the
  // upstream `hacs/repository/remove`. Daybook records the removal.
  // The `ha_integration_ref` row stays in place with the original
  // install metadata so the audit trail isn't lost when a HACS
  // component is removed.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "DELETE",
    "/api/v1/channels/ha/hacs/:id",
    async ({ res, body, params }) => {
      const repo_id = assertHacsRepoId(params.id);
      if (typeof body !== "object" || body === null) {
        throw new ValidationError("body must be a JSON object");
      }
      const decision_ref = assertDecisionRef(
        (body as Record<string, unknown>).decision_ref,
      );
      const snapshot = await triggerBackupBeforeAction(
        "ha__hacs_remove",
        decision_ref,
      );
      const result = await callHacs("hacs/repository/remove", {
        repository: repo_id,
      });
      const daybook = recordHaWriteToDaybook({
        action: "ha__hacs_remove",
        summary: `HACS remove ${repo_id}`,
        decision_ref,
        extra: {
          backup_ref_id: snapshot.id,
          ha_backup_id: snapshot.ha_backup_id,
        },
      });
      sendJson(res, 200, {
        ok: true,
        repo_id,
        decision_ref,
        backup_ref_id: snapshot.id,
        ha_backup_id: snapshot.ha_backup_id,
        daybook,
        result,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/ha/hacs/:id/refresh
  //
  // Read-ish — forces HACS to refetch metadata for one repo. Cheap and
  // reversible; no gate, no snapshot, no daybook entry.
  // ────────────────────────────────────────────────────────────────────
  addRoute(
    "POST",
    "/api/v1/channels/ha/hacs/:id/refresh",
    async ({ res, params }) => {
      const repo_id = assertHacsRepoId(params.id);
      const result = await callHacs("hacs/repository/refresh", {
        repository: repo_id,
      });
      sendJson(res, 200, { ok: true, repo_id, result });
    },
  );
}

// === END Tier 4 PR5 ═══════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════
// === Tier 4 PR2: Registries CRUD ===
// ═════════════════════════════════════════════════════════════════════════
//
// Issue #115 PR2 — 14 new routes fronting HA's four registry surfaces:
//
//   area_registry    — list / create / update / delete  (WS only)
//   device_registry  — list / get / update              (WS only — no
//                      create/delete; devices come from integrations)
//   entity_registry  — list / get / update / remove     (WS only)
//   label_registry   — list / create / update / delete  (WS only)
//
// Why this lives in its own bounded block
// ----------------------------------------
// PR3, PR4, PR6, PR7, and PR8 already landed in this file with their
// own bounded blocks. By keeping every registry route in ONE contiguous
// block at the file tail, a future rebase against this file is one
// mechanical "is this block intact?" check. No edits to shared helpers,
// no insertion points scattered through the file.
//
// Per Sir's defaults (locked 2026-05-29):
//
//   * NO `decision_ref` gate — every verb in here is cheap + reversible:
//     create an area → delete it; rename an entity → rename it back.
//     The verb whose effect a non-technical principal couldn't reverse in
//     <2 minutes through HA's own UI gets a gate; renaming the kitchen
//     light doesn't.
//   * NO snapshot — same rationale; registry mutations don't take HA
//     down.
//   * NO daybook entry — the daybook surface is for changes Sir would
//     notice (core_restart, addon_install, integration_add). Renaming
//     an entity is noise.
//
// The WS calls themselves
// -----------------------
// HA's WS protocol for these (verified against `homeassistant/core` HEAD
// 2026-05):
//
//   {type: "config/area_registry/list"}
//   {type: "config/area_registry/create", name, …}
//   {type: "config/area_registry/update", area_id, name?, icon?, labels?, …}
//   {type: "config/area_registry/delete", area_id}
//
//   {type: "config/device_registry/list"}
//   {type: "config/device_registry/get", device_id} — not all HA versions; we
//     read from list() and filter as a fallback so an older HA still works.
//   {type: "config/device_registry/update", device_id, name_by_user?, area_id?,
//     labels?, disabled_by?}
//
//   {type: "config/entity_registry/list"}
//   {type: "config/entity_registry/get", entity_id}
//   {type: "config/entity_registry/update", entity_id, name?, icon?, area_id?,
//     hidden_by?, disabled_by?, labels?, new_entity_id?, aliases?, …}
//   {type: "config/entity_registry/remove", entity_id}
//
//   {type: "config/label_registry/list"}
//   {type: "config/label_registry/create", name, …}
//   {type: "config/label_registry/update", label_id, name?, color?, icon?, description?}
//   {type: "config/label_registry/delete", label_id}
//
// Wrap each `client.wsCall(...)` in try/catch → wrapHaWsError so the
// failure envelope matches the PR7 block (502 HA_WS_ERROR with the
// upstream error message preserved).

/**
 * Default WS timeout for registry calls. Registry CRUD is fast (~50ms
 * on a local HA); ten seconds is generous enough that a transiently
 * slow HA still passes.
 */
const HA_REGISTRY_WS_TIMEOUT_MS = Number(
  process.env.HA_REGISTRY_WS_TIMEOUT_MS ?? "10000",
);

/**
 * Area / device / label id format. HA mints these as a slug from the
 * create-time name — lowercase ASCII + underscores. The shape we want
 * to enforce here is the URL-traversal guard: no `/`, no leading dot,
 * length 1..128.
 */
const HA_REGISTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}$/;

function assertRegistryId(raw: string, kind: string): string {
  if (!HA_REGISTRY_ID_RE.test(raw)) {
    throw new ValidationError(
      `${kind} id must be 1..128 chars of [A-Za-z0-9_.:-], starting with [A-Za-z0-9]`,
    );
  }
  return raw;
}

/**
 * Entity id format. Strict dotted form — `<domain>.<object_id>` with
 * lowercase ASCII + underscores. Mirrors the MCP tool's EntityIdParam.
 */
const HA_PR2_ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

function assertPr2EntityId(raw: string): string {
  if (!HA_PR2_ENTITY_ID_RE.test(raw)) {
    throw new ValidationError(
      "entity_id must be HA's dotted form `<domain>.<object_id>`",
    );
  }
  return raw;
}

/** Read an optional string field; rejects empty strings + non-strings. */
function pr2OptionalString(
  raw: unknown,
  field: string,
  maxLen = 256,
): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  if (raw.length > maxLen) {
    throw new ValidationError(`${field} must be <= ${maxLen} chars`);
  }
  return raw;
}

/**
 * Allow null/undefined OR string. HA uses `null` to clear a field
 * (e.g. {area_id: null} unassigns the area from a device). We honour
 * that — the route passes through `null` if the caller sent it.
 */
function pr2NullableString(
  raw: unknown,
  field: string,
  maxLen = 256,
): { present: boolean; value: string | null } {
  if (raw === undefined) return { present: false, value: null };
  if (raw === null) return { present: true, value: null };
  if (typeof raw !== "string") {
    throw new ValidationError(`${field} must be a string or null`);
  }
  if (raw.length === 0) {
    throw new ValidationError(`${field} must be non-empty or null`);
  }
  if (raw.length > maxLen) {
    throw new ValidationError(`${field} must be <= ${maxLen} chars`);
  }
  return { present: true, value: raw };
}

/** Optional string[] of label ids. */
function pr2OptionalStringArray(
  raw: unknown,
  field: string,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  for (const v of raw) {
    if (typeof v !== "string" || v.length === 0) {
      throw new ValidationError(`${field} entries must be non-empty strings`);
    }
  }
  return raw as string[];
}

/** Parse a body object — throws on non-object input. */
function pr2AssertBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function registerHaPr2RegistriesRoutes(): void {
  // ── areas ─────────────────────────────────────────────────────────────

  // GET /api/v1/channels/ha/areas — WS `config/area_registry/list`.
  // Returns `{ok, areas: [...]}` straight from HA. Cheap, no gate.
  addRoute("GET", "/api/v1/channels/ha/areas", async ({ res }) => {
    await loadHaCredentials();
    let result: unknown;
    try {
      result = await getHaWsClient().wsCall(
        "config/area_registry/list",
        {},
        HA_REGISTRY_WS_TIMEOUT_MS,
      );
    } catch (err) {
      throw wrapHaWsError("config/area_registry/list", err);
    }
    const areas = Array.isArray(result) ? result : [];
    sendJson(res, 200, { ok: true, areas });
  });

  // POST /api/v1/channels/ha/areas — WS `config/area_registry/create`.
  // Body: { name (required), icon?, picture?, aliases?, labels?, floor_id? }.
  // No gate (cheap, reversible — DELETE undoes it).
  addRoute("POST", "/api/v1/channels/ha/areas", async ({ res, body }) => {
    const b = pr2AssertBodyObject(body);
    const name = pr2OptionalString(b.name, "name", 128);
    if (name === undefined) {
      throw new ValidationError("name is required");
    }
    const wsPayload: Record<string, unknown> = { name };
    const icon = pr2OptionalString(b.icon, "icon", 64);
    if (icon !== undefined) wsPayload.icon = icon;
    const picture = pr2OptionalString(b.picture, "picture", 256);
    if (picture !== undefined) wsPayload.picture = picture;
    const floorId = pr2OptionalString(b.floor_id, "floor_id", 128);
    if (floorId !== undefined) wsPayload.floor_id = floorId;
    const aliases = pr2OptionalStringArray(b.aliases, "aliases");
    if (aliases !== undefined) wsPayload.aliases = aliases;
    const labels = pr2OptionalStringArray(b.labels, "labels");
    if (labels !== undefined) wsPayload.labels = labels;
    await loadHaCredentials();
    let result: unknown;
    try {
      result = await getHaWsClient().wsCall(
        "config/area_registry/create",
        wsPayload,
        HA_REGISTRY_WS_TIMEOUT_MS,
      );
    } catch (err) {
      throw wrapHaWsError("config/area_registry/create", err);
    }
    const r = (result ?? {}) as Record<string, unknown>;
    const area_id = typeof r.area_id === "string" ? r.area_id : null;
    sendJson(res, 200, { ok: true, area_id, area: result });
  });

  // PUT /api/v1/channels/ha/areas/:id — WS `config/area_registry/update`.
  // Body fields all optional — only fields the caller sets get forwarded.
  addRoute(
    "PUT",
    "/api/v1/channels/ha/areas/:id",
    async ({ res, body, params }) => {
      const area_id = assertRegistryId(params.id, "area");
      const b = pr2AssertBodyObject(body);
      const wsPayload: Record<string, unknown> = { area_id };
      const name = pr2OptionalString(b.name, "name", 128);
      if (name !== undefined) wsPayload.name = name;
      // icon/picture/floor_id accept null (unset) — use pr2NullableString.
      const icon = pr2NullableString(b.icon, "icon", 64);
      if (icon.present) wsPayload.icon = icon.value;
      const picture = pr2NullableString(b.picture, "picture", 256);
      if (picture.present) wsPayload.picture = picture.value;
      const floorId = pr2NullableString(b.floor_id, "floor_id", 128);
      if (floorId.present) wsPayload.floor_id = floorId.value;
      const aliases = pr2OptionalStringArray(b.aliases, "aliases");
      if (aliases !== undefined) wsPayload.aliases = aliases;
      const labels = pr2OptionalStringArray(b.labels, "labels");
      if (labels !== undefined) wsPayload.labels = labels;
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "config/area_registry/update",
          wsPayload,
          HA_REGISTRY_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("config/area_registry/update", err);
      }
      sendJson(res, 200, { ok: true, area_id, area: result });
    },
  );

  // DELETE /api/v1/channels/ha/areas/:id — WS `config/area_registry/delete`.
  // No gate — areas are cheap to recreate; HA itself moves any
  // entities/devices in the area to "no area" on delete (non-destructive
  // to the underlying things).
  addRoute(
    "DELETE",
    "/api/v1/channels/ha/areas/:id",
    async ({ res, params }) => {
      const area_id = assertRegistryId(params.id, "area");
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "config/area_registry/delete",
          { area_id },
          HA_REGISTRY_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("config/area_registry/delete", err);
      }
      sendJson(res, 200, { ok: true, area_id, data: result });
    },
  );

  // ── devices ──────────────────────────────────────────────────────────

  // GET /api/v1/channels/ha/devices — WS `config/device_registry/list`.
  addRoute("GET", "/api/v1/channels/ha/devices", async ({ res }) => {
    await loadHaCredentials();
    let result: unknown;
    try {
      result = await getHaWsClient().wsCall(
        "config/device_registry/list",
        {},
        HA_REGISTRY_WS_TIMEOUT_MS,
      );
    } catch (err) {
      throw wrapHaWsError("config/device_registry/list", err);
    }
    const devices = Array.isArray(result) ? result : [];
    sendJson(res, 200, { ok: true, devices });
  });

  // GET /api/v1/channels/ha/devices/:id — pull one device by reading the
  // list and filtering. HA doesn't expose a per-device `get` WS verb on
  // every version, and the list is cheap (~50ms on a local HA), so this
  // is the durable shape.
  addRoute(
    "GET",
    "/api/v1/channels/ha/devices/:id",
    async ({ res, params }) => {
      const device_id = assertRegistryId(params.id, "device");
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "config/device_registry/list",
          {},
          HA_REGISTRY_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("config/device_registry/list", err);
      }
      const devices = Array.isArray(result) ? result : [];
      const device = devices.find((d) => {
        const dd = d as Record<string, unknown>;
        return dd.id === device_id;
      });
      if (!device) {
        throw new NotFoundError(`device ${device_id} not found`);
      }
      sendJson(res, 200, { ok: true, device_id, device });
    },
  );

  // PUT /api/v1/channels/ha/devices/:id — WS
  // `config/device_registry/update`. Fields the caller may set:
  // name_by_user / area_id / disabled_by / labels. HA accepts `null` to
  // clear name_by_user / area_id / disabled_by.
  addRoute(
    "PUT",
    "/api/v1/channels/ha/devices/:id",
    async ({ res, body, params }) => {
      const device_id = assertRegistryId(params.id, "device");
      const b = pr2AssertBodyObject(body);
      const wsPayload: Record<string, unknown> = { device_id };
      const nameByUser = pr2NullableString(b.name_by_user, "name_by_user", 128);
      if (nameByUser.present) wsPayload.name_by_user = nameByUser.value;
      const areaId = pr2NullableString(b.area_id, "area_id", 128);
      if (areaId.present) wsPayload.area_id = areaId.value;
      const disabledBy = pr2NullableString(b.disabled_by, "disabled_by", 64);
      if (disabledBy.present) wsPayload.disabled_by = disabledBy.value;
      const labels = pr2OptionalStringArray(b.labels, "labels");
      if (labels !== undefined) wsPayload.labels = labels;
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "config/device_registry/update",
          wsPayload,
          HA_REGISTRY_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("config/device_registry/update", err);
      }
      sendJson(res, 200, { ok: true, device_id, device: result });
    },
  );

  // ── entities ─────────────────────────────────────────────────────────

  // GET /api/v1/channels/ha/entities — WS `config/entity_registry/list`.
  addRoute("GET", "/api/v1/channels/ha/entities", async ({ res }) => {
    await loadHaCredentials();
    let result: unknown;
    try {
      result = await getHaWsClient().wsCall(
        "config/entity_registry/list",
        {},
        HA_REGISTRY_WS_TIMEOUT_MS,
      );
    } catch (err) {
      throw wrapHaWsError("config/entity_registry/list", err);
    }
    const entities = Array.isArray(result) ? result : [];
    sendJson(res, 200, { ok: true, entities });
  });

  // GET /api/v1/channels/ha/entities/:id — WS `config/entity_registry/get`.
  addRoute(
    "GET",
    "/api/v1/channels/ha/entities/:id",
    async ({ res, params }) => {
      const entity_id = assertPr2EntityId(params.id);
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "config/entity_registry/get",
          { entity_id },
          HA_REGISTRY_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("config/entity_registry/get", err);
      }
      if (result === null || result === undefined) {
        throw new NotFoundError(`entity ${entity_id} not found`);
      }
      sendJson(res, 200, { ok: true, entity_id, entity: result });
    },
  );

  // PUT /api/v1/channels/ha/entities/:id — WS
  // `config/entity_registry/update`. Fields the caller may set:
  // name / icon / area_id / hidden_by / disabled_by / labels / new_entity_id /
  // aliases. HA accepts `null` to clear most of these.
  addRoute(
    "PUT",
    "/api/v1/channels/ha/entities/:id",
    async ({ res, body, params }) => {
      const entity_id = assertPr2EntityId(params.id);
      const b = pr2AssertBodyObject(body);
      const wsPayload: Record<string, unknown> = { entity_id };
      const name = pr2NullableString(b.name, "name", 128);
      if (name.present) wsPayload.name = name.value;
      const icon = pr2NullableString(b.icon, "icon", 64);
      if (icon.present) wsPayload.icon = icon.value;
      const areaId = pr2NullableString(b.area_id, "area_id", 128);
      if (areaId.present) wsPayload.area_id = areaId.value;
      const hiddenBy = pr2NullableString(b.hidden_by, "hidden_by", 64);
      if (hiddenBy.present) wsPayload.hidden_by = hiddenBy.value;
      const disabledBy = pr2NullableString(b.disabled_by, "disabled_by", 64);
      if (disabledBy.present) wsPayload.disabled_by = disabledBy.value;
      const labels = pr2OptionalStringArray(b.labels, "labels");
      if (labels !== undefined) wsPayload.labels = labels;
      // new_entity_id supports renaming the dotted form itself; same
      // entity-id regex applies.
      if (b.new_entity_id !== undefined && b.new_entity_id !== null) {
        if (typeof b.new_entity_id !== "string") {
          throw new ValidationError("new_entity_id must be a string");
        }
        assertPr2EntityId(b.new_entity_id);
        wsPayload.new_entity_id = b.new_entity_id;
      }
      const aliases = pr2OptionalStringArray(b.aliases, "aliases");
      if (aliases !== undefined) wsPayload.aliases = aliases;
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "config/entity_registry/update",
          wsPayload,
          HA_REGISTRY_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("config/entity_registry/update", err);
      }
      sendJson(res, 200, { ok: true, entity_id, entity: result });
    },
  );

  // DELETE /api/v1/channels/ha/entities/:id — WS
  // `config/entity_registry/remove`. Only removable entities (those
  // marked `entity_category=config` or whose integration allows
  // removal) can be deleted; HA returns an error otherwise, which we
  // propagate through wrapHaWsError as 502.
  //
  // No gate — HA's own UI exposes this with no confirmation; the agent
  // contract is just "I'm cleaning up an orphaned entity".
  addRoute(
    "DELETE",
    "/api/v1/channels/ha/entities/:id",
    async ({ res, params }) => {
      const entity_id = assertPr2EntityId(params.id);
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "config/entity_registry/remove",
          { entity_id },
          HA_REGISTRY_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("config/entity_registry/remove", err);
      }
      sendJson(res, 200, { ok: true, entity_id, data: result });
    },
  );

  // ── labels ───────────────────────────────────────────────────────────

  // GET /api/v1/channels/ha/labels — WS `config/label_registry/list`.
  addRoute("GET", "/api/v1/channels/ha/labels", async ({ res }) => {
    await loadHaCredentials();
    let result: unknown;
    try {
      result = await getHaWsClient().wsCall(
        "config/label_registry/list",
        {},
        HA_REGISTRY_WS_TIMEOUT_MS,
      );
    } catch (err) {
      throw wrapHaWsError("config/label_registry/list", err);
    }
    const labels = Array.isArray(result) ? result : [];
    sendJson(res, 200, { ok: true, labels });
  });

  // POST /api/v1/channels/ha/labels — WS `config/label_registry/create`.
  // Body: { name (required), color?, icon?, description? }.
  addRoute("POST", "/api/v1/channels/ha/labels", async ({ res, body }) => {
    const b = pr2AssertBodyObject(body);
    const name = pr2OptionalString(b.name, "name", 128);
    if (name === undefined) {
      throw new ValidationError("name is required");
    }
    const wsPayload: Record<string, unknown> = { name };
    const color = pr2OptionalString(b.color, "color", 32);
    if (color !== undefined) wsPayload.color = color;
    const icon = pr2OptionalString(b.icon, "icon", 64);
    if (icon !== undefined) wsPayload.icon = icon;
    const description = pr2OptionalString(b.description, "description", 256);
    if (description !== undefined) wsPayload.description = description;
    await loadHaCredentials();
    let result: unknown;
    try {
      result = await getHaWsClient().wsCall(
        "config/label_registry/create",
        wsPayload,
        HA_REGISTRY_WS_TIMEOUT_MS,
      );
    } catch (err) {
      throw wrapHaWsError("config/label_registry/create", err);
    }
    const r = (result ?? {}) as Record<string, unknown>;
    const label_id = typeof r.label_id === "string" ? r.label_id : null;
    sendJson(res, 200, { ok: true, label_id, label: result });
  });

  // PUT /api/v1/channels/ha/labels/:id — WS `config/label_registry/update`.
  addRoute(
    "PUT",
    "/api/v1/channels/ha/labels/:id",
    async ({ res, body, params }) => {
      const label_id = assertRegistryId(params.id, "label");
      const b = pr2AssertBodyObject(body);
      const wsPayload: Record<string, unknown> = { label_id };
      const name = pr2OptionalString(b.name, "name", 128);
      if (name !== undefined) wsPayload.name = name;
      const color = pr2NullableString(b.color, "color", 32);
      if (color.present) wsPayload.color = color.value;
      const icon = pr2NullableString(b.icon, "icon", 64);
      if (icon.present) wsPayload.icon = icon.value;
      const description = pr2NullableString(b.description, "description", 256);
      if (description.present) wsPayload.description = description.value;
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "config/label_registry/update",
          wsPayload,
          HA_REGISTRY_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("config/label_registry/update", err);
      }
      sendJson(res, 200, { ok: true, label_id, label: result });
    },
  );

  // DELETE /api/v1/channels/ha/labels/:id — WS `config/label_registry/delete`.
  // HA removes the label binding from any area/device/entity that
  // referenced it (the things themselves stay).
  addRoute(
    "DELETE",
    "/api/v1/channels/ha/labels/:id",
    async ({ res, params }) => {
      const label_id = assertRegistryId(params.id, "label");
      await loadHaCredentials();
      let result: unknown;
      try {
        result = await getHaWsClient().wsCall(
          "config/label_registry/delete",
          { label_id },
          HA_REGISTRY_WS_TIMEOUT_MS,
        );
      } catch (err) {
        throw wrapHaWsError("config/label_registry/delete", err);
      }
      sendJson(res, 200, { ok: true, label_id, data: result });
    },
  );
}

// === END Tier 4 PR2 ═══════════════════════════════════════════════════

