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
import { sendJson, ValidationError, ApiError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { appendJournal } from "../../db/alfredJournal.js";
import { channelTokenBearer } from "../auth.js";
import fs from "node:fs";

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
  const createJson = (await create.json()) as {
    data?: { data?: { id?: string } };
  };
  const id = createJson?.data?.data?.id;
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
    const curJson = (await cur.json()) as {
      data?: { data?: Record<string, unknown> };
    };
    const item = (curJson?.data?.data ?? {}) as Record<string, unknown>;
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
  const createJson = (await create.json()) as {
    data?: { data?: { id?: string } };
  };
  const id = createJson?.data?.data?.id;
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
