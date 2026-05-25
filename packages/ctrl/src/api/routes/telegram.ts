// Lane I — Telegram channel routes (/api/v1/channels/telegram/*).
//
// Hermes' gateway reads Telegram config from PER-PROFILE FILES inside its
// data volume, NOT from container environment variables:
//
//   $HERMES_HOME/profiles/main/.env                — TELEGRAM_BOT_TOKEN,
//                                                    TELEGRAM_ALLOWED_USERS,
//                                                    TELEGRAM_HOME_CHANNEL.
//   $HERMES_HOME/profiles/main/gateway_state.json  — live state per platform.
//   $HERMES_HOME/profiles/main/channel_directory.json — paired chats.
//
// HERMES_HOME inside the runtime container is `/hermes-state` (see
// docker-compose.yaml hermes service: `HERMES_HOME=/hermes-state`). The
// earlier campaign wrote to /opt/alfred/.env + a config.yaml platforms
// block — Hermes ignored both. This rewrite operates on the real files via
// `docker exec hermes …`. Live-confirmed against Sir's working bot 2026-05-25.
//
// Sir's locked decisions:
//   1. Vaultwarden is the canonical home. Item name is exactly
//      "Telegram Bot Token" — that name is the lookup key.
//   2. Token + per-platform settings live in the per-profile .env. Compose
//      env is NOT touched.
//   3. DM-pairing uses native `hermes pairing` CLI.
//
// Four surfaces:
//   GET    /api/v1/channels/telegram/status
//   PUT    /api/v1/channels/telegram/token
//   POST   /api/v1/channels/telegram/pair
//   DELETE /api/v1/channels/telegram/token
//
// FAIL-SOFT POLICY. /status MUST NOT 5xx — the dashboard polls it. On any
// upstream failure return state:"error" with the message in `error`; the UI
// surfaces it as a "needs attention" card (Lane III).

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import {
  dockerExec,
  dockerExecWithStdin,
  dockerComposeCmd,
  HERMES_CMD,
  HERMES_CONTAINER,
} from "../helpers.js";

const VAULT_CLI_URL = process.env.VAULT_CLI_URL || "http://vault-cli:8087";
// Path INSIDE the hermes runtime container. HERMES_HOME=/hermes-state in
// docker-compose; profiles live at $HERMES_HOME/profiles/<name>/.
const HERMES_HOME = process.env.HERMES_HOME_IN_CONTAINER || "/hermes-state";
const MAIN_PROFILE_DIR = `${HERMES_HOME}/profiles/main`;
const PROFILE_ENV_PATH = `${MAIN_PROFILE_DIR}/.env`;
const GATEWAY_STATE_PATH = `${MAIN_PROFILE_DIR}/gateway_state.json`;
const CHANNEL_DIR_PATH = `${MAIN_PROFILE_DIR}/channel_directory.json`;
const VAULT_ITEM_NAME = "Telegram Bot Token";
// BotFather token shape: <8-12 digit bot id>:<35-char secret>. Mirrored on
// the web side as isProbablyValidBotToken in telegramCardCore.ts.
const BOT_TOKEN_RE = /^\d{8,12}:[A-Za-z0-9_-]{35}$/;

type TelegramState =
  | "unconfigured"
  | "configured_starting"
  | "configured_running"
  | "error";

interface PairedChat {
  id: string | number;
  name: string | null;
  type: string | null;
}

interface TelegramStatus {
  configured: boolean;
  bot_handle: string | null;
  state: TelegramState;
  error: string | null;
  paired_chats: PairedChat[];
}

// ── vault-cli helpers (mirrors routes/vaultwarden.ts) ─────────────────────

interface BwEnvelope {
  success?: boolean;
  data?: unknown;
  message?: string;
}

async function bwFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${VAULT_CLI_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: text }; }
}

function unwrap(body: unknown): { ok: true; data: unknown } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "vault-cli returned non-JSON body" };
  }
  const env = body as BwEnvelope;
  if (env.success === false) return { ok: false, message: env.message ?? "vault-cli error" };
  if (env.success === true && "data" in env) return { ok: true, data: env.data };
  return { ok: true, data: body };
}

async function findTelegramVaultItem(): Promise<{ id: string; password: string | null } | null> {
  const r = await bwFetch(`/list/object/items?search=${encodeURIComponent(VAULT_ITEM_NAME)}`);
  if (r.status >= 500) throw new Error(`vault-cli unreachable (HTTP ${r.status})`);
  const u = unwrap(r.body);
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
    if (it.name.toLowerCase() !== VAULT_ITEM_NAME.toLowerCase()) continue;
    const login = typeof it.login === "object" && it.login !== null
      ? (it.login as Record<string, unknown>) : null;
    const password = login && typeof login.password === "string" ? login.password : null;
    return { id: typeof it.id === "string" ? it.id : "", password };
  }
  return null;
}

async function upsertTelegramVaultItem(token: string): Promise<void> {
  const existing = await findTelegramVaultItem();
  if (existing && existing.id) {
    const cur = await bwFetch(`/object/item/${existing.id}`);
    const curU = unwrap(cur.body);
    if (!curU.ok) throw new Error(curU.message);
    const existingItem = (curU.data as Record<string, unknown>).data ?? curU.data;
    const e = existingItem as Record<string, unknown>;
    const existingLogin = typeof e.login === "object" && e.login !== null
      ? ({ ...(e.login as Record<string, unknown>) } as Record<string, unknown>)
      : { username: null, password: null, uris: [] };
    existingLogin.password = token;
    const merged = { ...e, name: VAULT_ITEM_NAME, login: existingLogin };
    const r = await bwFetch(`/object/item/${existing.id}`, { method: "PUT", body: JSON.stringify(merged) });
    const u = unwrap(r.body);
    if (!u.ok) throw new Error(u.message);
    return;
  }
  const payload = {
    type: 1,
    name: VAULT_ITEM_NAME,
    notes: "Bot token for Hermes Telegram channel (Alfred Black). Source of truth.",
    folderId: null,
    favorite: false,
    reprompt: 0,
    login: { username: null, password: token, uris: [{ uri: "https://t.me/", match: null }] },
  };
  const r = await bwFetch("/object/item", { method: "POST", body: JSON.stringify(payload) });
  const u = unwrap(r.body);
  if (!u.ok) throw new Error(u.message);
}

async function deleteTelegramVaultItem(): Promise<void> {
  const existing = await findTelegramVaultItem();
  if (!existing || !existing.id) return; // idempotent
  const r = await bwFetch(`/object/item/${existing.id}`, { method: "DELETE" });
  const u = unwrap(r.body);
  if (!u.ok) throw new Error(u.message);
}

// ── per-profile .env (lives INSIDE the hermes container volume) ──────────
//
// We never touch the host filesystem here — the hermes_data named volume is
// not bind-mounted onto the ctrl-api container. All reads + writes go via
// `docker exec hermes` so the file is observed from the runtime's POV.

const TELEGRAM_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USERS",
  "TELEGRAM_HOME_CHANNEL",
] as const;
type TelegramEnvKey = (typeof TELEGRAM_ENV_KEYS)[number];

async function readProfileEnv(): Promise<Record<string, string>> {
  // `cat` returns non-zero if the file is missing; tolerate that by reading
  // through `sh -c` and forcing exit 0 on ENOENT — an absent file = no keys.
  const raw = await dockerExec(HERMES_CONTAINER, [
    "sh", "-c", `cat ${PROFILE_ENV_PATH} 2>/dev/null || true`,
  ]);
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.replace(/^﻿/, "");
    if (!t || t.trimStart().startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1);
    // Strip a trailing CR (CRLF tolerance) but preserve embedded spaces.
    if (v.endsWith("\r")) v = v.slice(0, -1);
    // Strip matching surrounding quotes — Hermes' python-dotenv reader does.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Idempotently upsert/remove the 3 telegram keys in the per-profile .env.
 * Other keys (and comments) are preserved verbatim. `null` = drop the key.
 *
 * Writes via `docker exec hermes sh -c 'cat > $TMP && mv $TMP $DST'` so the
 * file appears atomically to anyone reading it (the gateway's reload path).
 */
async function writeProfileEnvKeys(
  updates: Partial<Record<TelegramEnvKey, string | null>>,
): Promise<void> {
  // Read existing content as TEXT, so we preserve comments / ordering.
  const raw = await dockerExec(HERMES_CONTAINER, [
    "sh", "-c", `cat ${PROFILE_ENV_PATH} 2>/dev/null || true`,
  ]);
  const lines = raw === "" ? [] : raw.split("\n");
  // Drop a trailing empty token that comes from a final newline so we don't
  // grow an empty line on every write.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const t = line.replace(/^﻿/, "");
    const eq = t.indexOf("=");
    const key = eq > 0 ? t.slice(0, eq).trim() : "";
    if (key && key in updates) {
      seen.add(key);
      const v = updates[key as TelegramEnvKey];
      if (v === null || v === undefined) continue; // drop
      out.push(`${key}=${v}`);
      continue;
    }
    out.push(line);
  }
  for (const k of TELEGRAM_ENV_KEYS) {
    if (seen.has(k)) continue;
    if (!(k in updates)) continue;
    const v = updates[k];
    if (v === null || v === undefined) continue;
    out.push(`${k}=${v}`);
  }
  const content = out.join("\n") + "\n";

  const tmp = `${PROFILE_ENV_PATH}.tmp.${process.pid}.${Date.now()}`;
  // `mkdir -p` the profile dir so a brand-new profile (no .env yet) still
  // accepts the write — `tee` would otherwise fail on the missing parent.
  await dockerExecWithStdin(
    HERMES_CONTAINER,
    [
      "sh", "-c",
      `mkdir -p ${MAIN_PROFILE_DIR} && cat > ${tmp} && mv ${tmp} ${PROFILE_ENV_PATH}`,
    ],
    content,
    30_000,
  );
}

// ── gateway_state.json + channel_directory.json readers ───────────────────

async function readJsonFromContainer(path: string): Promise<unknown | null> {
  try {
    const raw = await dockerExec(HERMES_CONTAINER, [
      "sh", "-c", `cat ${path} 2>/dev/null || true`,
    ]);
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[telegram] read ${path} failed:`, e);
    return null;
  }
}

interface GatewayTelegramState {
  state: string | null; // "connected" / "starting" / "error" / "disconnected"
  error: string | null;
}

function parseGatewayState(blob: unknown): GatewayTelegramState {
  if (typeof blob !== "object" || blob === null) return { state: null, error: null };
  const root = blob as Record<string, unknown>;
  const platforms = (root.platforms ?? (root.gateway && (root.gateway as Record<string, unknown>).platforms)) as
    | Record<string, unknown>
    | undefined;
  const tg = platforms && typeof platforms === "object" ? (platforms.telegram as Record<string, unknown> | undefined) : undefined;
  if (!tg) return { state: null, error: null };
  const state = typeof tg.state === "string" ? tg.state : null;
  const error = typeof tg.error === "string" ? tg.error : null;
  return { state, error };
}

function parseChannelDirectory(blob: unknown): PairedChat[] {
  if (typeof blob !== "object" || blob === null) return [];
  const root = blob as Record<string, unknown>;
  // channel_directory.json has either { telegram: [...] } or
  // { platforms: { telegram: [...] } } across hermes versions. Tolerate both.
  let entries: unknown =
    root.telegram ??
    (root.platforms && (root.platforms as Record<string, unknown>).telegram) ??
    (root.channels && (root.channels as Record<string, unknown>).telegram);
  if (!Array.isArray(entries)) {
    // Some builds keep a flat map keyed by chat_id.
    if (typeof entries === "object" && entries !== null) {
      entries = Object.values(entries as Record<string, unknown>);
    } else {
      return [];
    }
  }
  const out: PairedChat[] = [];
  for (const raw of entries as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const it = raw as Record<string, unknown>;
    const id = (it.chat_id ?? it.id) as string | number | undefined;
    if (id === undefined) continue;
    const name =
      (typeof it.title === "string" && it.title) ||
      (typeof it.name === "string" && it.name) ||
      (typeof it.username === "string" && `@${it.username}`) ||
      null;
    const type = typeof it.type === "string" ? it.type : (typeof it.chat_type === "string" ? it.chat_type : null);
    out.push({ id, name, type });
  }
  return out;
}

// ── Telegram getMe (resolve bot_handle) — short-cached ────────────────────

let _botHandleCache: { token: string; handle: string | null; at: number } | null = null;
const BOT_HANDLE_TTL_MS = 60_000;

async function resolveBotHandle(token: string): Promise<string | null> {
  const now = Date.now();
  if (_botHandleCache && _botHandleCache.token === token && now - _botHandleCache.at < BOT_HANDLE_TTL_MS) {
    return _botHandleCache.handle;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) {
      _botHandleCache = { token, handle: null, at: now };
      return null;
    }
    const j = (await r.json()) as { ok?: boolean; result?: { username?: string } };
    const username = j?.result?.username ?? null;
    const handle = username ? `@${username}` : null;
    _botHandleCache = { token, handle, at: now };
    return handle;
  } catch {
    _botHandleCache = { token, handle: null, at: now };
    return null;
  }
}

// ── Restart Hermes so it picks up the new per-profile .env ─────────────────

function restartHermes(): void {
  // The hermes_data volume survives the container restart, so the new
  // .env we just wrote is in place by the time the gateway re-reads it.
  dockerComposeCmd(["restart", HERMES_CONTAINER]).catch((err) => {
    console.error("[telegram] hermes restart failed:", err);
  });
}

// ── hermes pairing CLI (DM pairing) — unchanged behaviour ─────────────────

async function generatePairingCode(): Promise<{ code: string; expires_at: string }> {
  let lastErr: unknown = null;
  for (const sub of ["generate", "new", "mint"]) {
    try {
      const stdout = await dockerExec(HERMES_CONTAINER, [
        ...HERMES_CMD, "-p", "main", "pairing", sub, "telegram",
      ]);
      const code = extractPairingCode(stdout);
      if (!code) {
        lastErr = new Error(`no code in output: ${stdout.slice(0, 120)}`);
        continue;
      }
      return { code, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error("hermes pairing: all variants failed");
}

function extractPairingCode(stdout: string): string | null {
  const dashed = stdout.match(/\b([A-Z0-9]{3,6}-[A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6})?)\b/);
  if (dashed) return dashed[1];
  const digits = stdout.match(/\b(\d{6})\b/);
  if (digits) return digits[1];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (/^[A-Z0-9-]{6,32}$/.test(t)) return t;
  }
  return null;
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerTelegramRoutes(): void {
  // GET /status — fail-soft. NEVER 5xx (dashboard polls it).
  addRoute("GET", "/api/v1/channels/telegram/status", async ({ res }) => {
    let envMap: Record<string, string> = {};
    let envErr: string | null = null;
    try {
      envMap = await readProfileEnv();
    } catch (e) {
      envErr = e instanceof Error ? e.message : String(e);
    }

    const token = envMap.TELEGRAM_BOT_TOKEN ?? "";
    const configured = Boolean(token);

    if (envErr) {
      sendJson(res, 200, {
        configured: false, bot_handle: null,
        state: "error", error: `profile env: ${envErr}`, paired_chats: [],
      } satisfies TelegramStatus);
      return;
    }
    if (!configured) {
      sendJson(res, 200, {
        configured: false, bot_handle: null,
        state: "unconfigured", error: null, paired_chats: [],
      } satisfies TelegramStatus);
      return;
    }

    // Configured — pull live state + directory + resolve handle (best effort).
    const [stateBlob, dirBlob, handle] = await Promise.all([
      readJsonFromContainer(GATEWAY_STATE_PATH),
      readJsonFromContainer(CHANNEL_DIR_PATH),
      resolveBotHandle(token),
    ]);
    const tg = parseGatewayState(stateBlob);
    const paired_chats = parseChannelDirectory(dirBlob);

    let state: TelegramState;
    let error: string | null = tg.error;
    switch (tg.state) {
      case "connected":
      case "running":
        state = "configured_running";
        break;
      case "error":
        state = "error";
        if (!error) error = "gateway reports telegram in error state";
        break;
      case "starting":
      case "disconnected":
      case null:
      case undefined:
      default:
        // Configured but gateway hasn't published a connected state yet —
        // either it's restarting or this hermes build doesn't write
        // gateway_state.json. Either way, fall back to "starting" so the UI
        // shows a benign spinner rather than a red error.
        state = "configured_starting";
        break;
    }
    sendJson(res, 200, {
      configured: true,
      bot_handle: handle,
      state,
      error,
      paired_chats,
    } satisfies TelegramStatus);
  });

  // PUT /token — write to vault + per-profile .env, restart hermes.
  addRoute("PUT", "/api/v1/channels/telegram/token", async ({ res, body }) => {
    const b = (body ?? {}) as {
      token?: unknown;
      allowed_users?: unknown;
      home_channel?: unknown;
    };
    if (typeof b.token !== "string" || !BOT_TOKEN_RE.test(b.token.trim())) {
      throw new ValidationError(
        "token must match BotFather shape: <8-12 digits>:<35 chars [A-Za-z0-9_-]>",
      );
    }
    const token = b.token.trim();
    const updates: Partial<Record<TelegramEnvKey, string | null>> = {
      TELEGRAM_BOT_TOKEN: token,
    };
    if (typeof b.allowed_users === "string") {
      updates.TELEGRAM_ALLOWED_USERS = b.allowed_users;
    }
    if (typeof b.home_channel === "string") {
      updates.TELEGRAM_HOME_CHANNEL = b.home_channel;
    }

    await upsertTelegramVaultItem(token);    // canonical store
    await writeProfileEnvKeys(updates);      // the file Hermes actually reads
    restartHermes();                         // background
    sendJson(res, 200, { ok: true, state: "configured_starting" });
  });

  // DELETE /token — wipe vault + drop the 3 .env keys + restart.
  addRoute("DELETE", "/api/v1/channels/telegram/token", async ({ res }) => {
    await deleteTelegramVaultItem(); // idempotent
    await writeProfileEnvKeys({
      TELEGRAM_BOT_TOKEN: null,
      TELEGRAM_ALLOWED_USERS: null,
      TELEGRAM_HOME_CHANNEL: null,
    });
    restartHermes();
    sendJson(res, 200, { ok: true, state: "unconfigured" });
  });

  // POST /pair — mint a DM-pairing code.
  addRoute("POST", "/api/v1/channels/telegram/pair", async ({ res }) => {
    const out = await generatePairingCode();
    sendJson(res, 200, out);
  });
}
