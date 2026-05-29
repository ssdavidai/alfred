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
