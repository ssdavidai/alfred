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
//   3. Adding a new chat is "DM the bot first, then it appears here" —
//      Hermes' `TELEGRAM_ALLOWED_USERS` allowlist handles authorisation.
//      We do NOT mint pairing codes (that subcommand never existed in
//      hermes; the earlier /pair route 500'd because of it). 2026-05-25.
//
// Five surfaces:
//   GET    /api/v1/channels/telegram/status
//   PUT    /api/v1/channels/telegram/token
//   DELETE /api/v1/channels/telegram/token            — disconnect the bot
//   POST   /api/v1/channels/telegram/test             — send a real test msg
//   DELETE /api/v1/channels/telegram/chats/:user_id   — revoke a paired chat
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
import { getStateDb } from "../../db/state.js";
import {
  resolveProfileForChannel,
  assertWritableProfile,
} from "../../db/agentProfiles.js";
import { appendAudit } from "./state.js";
import { restartProfile } from "../../hermes/supervisor.js";

// ── #206 Lane IV — per-(profile, channel_kind) identity override ──────────
// Lane I's channel_identity table + resolver landed via #221; use the real
// helper (stub removed — staging-verified the override resolves live).
import {
  resolveChannelIdentity,
  type ResolvedChannelIdentity,
} from "../../db/channelIdentity.js";

const VAULT_CLI_URL = process.env.VAULT_CLI_URL || "http://vault-cli:8087";
// Path INSIDE the hermes runtime container. HERMES_HOME=/hermes-state in
// docker-compose; profiles live at $HERMES_HOME/profiles/<name>/.
const HERMES_HOME = process.env.HERMES_HOME_IN_CONTAINER || "/hermes-state";

// Lane IV — per-profile file paths. The legacy MAIN_PROFILE_DIR etc. used
// to be module-level constants pointing at .../profiles/main; they're now
// derived per-request from the channel→profile binding.
interface TelegramProfilePaths {
  profileSlug: string;
  profileDir: string;
  envPath: string;
  gatewayStatePath: string;
  channelDirPath: string;
}

function pathsForProfile(slug: string): TelegramProfilePaths {
  const profileDir = `${HERMES_HOME}/profiles/${slug}`;
  return {
    profileSlug: slug,
    profileDir,
    envPath: `${profileDir}/.env`,
    gatewayStatePath: `${profileDir}/gateway_state.json`,
    channelDirPath: `${profileDir}/channel_directory.json`,
  };
}

/**
 * Resolve which profile this telegram request targets. The principal can
 * pin a specific profile via `?profile=<slug>`; otherwise we fall back to
 * the channel's default binding (`telegram` → main by Lane I seed).
 */
function resolveTelegramProfile(query?: URLSearchParams): TelegramProfilePaths {
  const explicit = query?.get("profile")?.trim() ?? null;
  if (explicit) return pathsForProfile(explicit);
  const slug = resolveProfileForChannel(getStateDb(), "telegram", null);
  return pathsForProfile(slug);
}
const VAULT_ITEM_NAME = "Telegram Bot Token";

// #120 Lane V — vault item name per profile. Main keeps the original
// "Telegram Bot Token" name for back-compat (existing tenants have items
// under that name already); non-main profiles use the suffix shape
// "Telegram Bot Token · <slug>" so each profile's token is a distinct
// Vaultwarden record and Sentinel doesn't clobber Main's stored token.
function vaultItemNameForProfile(slug: string): string {
  return slug === "main" ? VAULT_ITEM_NAME : `${VAULT_ITEM_NAME} · ${slug}`;
}
// BotFather token shape: <bot_id digits>:<secret>. The original BotFather
// format was 8-12 digits + exactly 35 char secret; Telegram has since
// expanded both halves over time and modern tokens commonly exceed 35
// chars. Hermes' own setup wizard uses the more permissive
// `^\d+:[A-Za-z0-9_-]{30,}$` (hermes_cli/setup.py) — we mirror that here
// so a token Hermes accepts is one we accept. 2026-05-25: Sir hit a 400
// on his real token under the stricter 35-char rule; relaxing to ≥30,
// open-ended. Mirrored on the web side as isProbablyValidBotToken in
// telegramCardCore.ts.
const BOT_TOKEN_RE = /^\d{8,15}:[A-Za-z0-9_-]{30,}$/;

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

async function findTelegramVaultItem(itemName: string = VAULT_ITEM_NAME): Promise<{ id: string; password: string | null } | null> {
  const r = await bwFetch(`/list/object/items?search=${encodeURIComponent(itemName)}`);
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
    if (it.name.toLowerCase() !== itemName.toLowerCase()) continue;
    const login = typeof it.login === "object" && it.login !== null
      ? (it.login as Record<string, unknown>) : null;
    const password = login && typeof login.password === "string" ? login.password : null;
    return { id: typeof it.id === "string" ? it.id : "", password };
  }
  return null;
}

async function upsertTelegramVaultItem(token: string, itemName: string = VAULT_ITEM_NAME): Promise<void> {
  const existing = await findTelegramVaultItem(itemName);
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
    const merged = { ...e, name: itemName, login: existingLogin };
    const r = await bwFetch(`/object/item/${existing.id}`, { method: "PUT", body: JSON.stringify(merged) });
    const u = unwrap(r.body);
    if (!u.ok) throw new Error(u.message);
    return;
  }
  const payload = {
    type: 1,
    name: itemName,
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

async function deleteTelegramVaultItem(itemName: string = VAULT_ITEM_NAME): Promise<void> {
  const existing = await findTelegramVaultItem(itemName);
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

async function readProfileEnv(
  paths: TelegramProfilePaths,
): Promise<Record<string, string>> {
  // `cat` returns non-zero if the file is missing; tolerate that by reading
  // through `sh -c` and forcing exit 0 on ENOENT — an absent file = no keys.
  const raw = await dockerExec(HERMES_CONTAINER, [
    "sh", "-c", `cat ${paths.envPath} 2>/dev/null || true`,
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
  paths: TelegramProfilePaths,
  updates: Partial<Record<TelegramEnvKey, string | null>>,
): Promise<void> {
  // Read existing content as TEXT, so we preserve comments / ordering.
  const raw = await dockerExec(HERMES_CONTAINER, [
    "sh", "-c", `cat ${paths.envPath} 2>/dev/null || true`,
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

  const tmp = `${paths.envPath}.tmp.${process.pid}.${Date.now()}`;
  // `mkdir -p` the profile dir so a brand-new profile (no .env yet) still
  // accepts the write — `tee` would otherwise fail on the missing parent.
  await dockerExecWithStdin(
    HERMES_CONTAINER,
    [
      "sh", "-c",
      `mkdir -p ${paths.profileDir} && cat > ${tmp} && mv ${tmp} ${paths.envPath}`,
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

// ── Telegram bot API: sendMessage (for the "Send test message" button) ────
//
// Calls api.telegram.org/bot<token>/sendMessage directly — the Telegram
// servers are public-internet, no Hermes round-trip needed. The bot only
// needs the chat_id to send to, which lives in TELEGRAM_HOME_CHANNEL (the
// user's own chat) for the dashboard's test path. If TELEGRAM_HOME_CHANNEL
// isn't set we fall back to the first paired chat we can find.
async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<{ ok: true; message_id: number } | { ok: false; description: string }> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(8_000),
    });
    const j = (await r.json()) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    if (j?.ok && typeof j.result?.message_id === "number") {
      return { ok: true, message_id: j.result.message_id };
    }
    return { ok: false, description: j?.description ?? `HTTP ${r.status}` };
  } catch (e) {
    return {
      ok: false,
      description: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Revoke a paired chat ──────────────────────────────────────────────────
//
// Two stores agree-or-die: (a) `channel_directory.json` is the live
// hermes-side directory, and (b) `TELEGRAM_ALLOWED_USERS` in the per-profile
// .env is the allowlist the gateway enforces on incoming messages. To
// actually revoke someone we strip them from BOTH and bounce Hermes so the
// next message from that chat is rejected.
async function revokeChatFromDirectory(
  paths: TelegramProfilePaths,
  userId: string,
): Promise<void> {
  // 1) drop from channel_directory.json
  const dirBlob = await readJsonFromContainer(paths.channelDirPath);
  if (dirBlob && typeof dirBlob === "object") {
    const root = dirBlob as Record<string, unknown>;
    const platforms = root.platforms as Record<string, unknown> | undefined;
    const list = (platforms?.telegram as unknown[]) ?? [];
    if (Array.isArray(list)) {
      const filtered = list.filter((it) => {
        if (typeof it !== "object" || it === null) return true;
        const ii = it as Record<string, unknown>;
        const id = String(ii.chat_id ?? ii.id ?? "");
        return id !== userId;
      });
      if (platforms && filtered.length !== list.length) {
        platforms.telegram = filtered;
        (root as Record<string, unknown>).updated_at = new Date().toISOString();
        const tmp = `${paths.channelDirPath}.tmp.${process.pid}.${Date.now()}`;
        await dockerExecWithStdin(
          HERMES_CONTAINER,
          ["sh", "-c", `cat > ${tmp} && mv ${tmp} ${paths.channelDirPath}`],
          JSON.stringify(root, null, 2) + "\n",
          15_000,
        );
      }
    }
  }
  // 2) drop from the .env allowlist (TELEGRAM_ALLOWED_USERS is comma-separated)
  const envMap: Record<string, string> = await readProfileEnv(paths).catch(
    () => ({}) as Record<string, string>,
  );
  const current = envMap.TELEGRAM_ALLOWED_USERS ?? "";
  if (current) {
    const next = current
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s && s !== userId)
      .join(",");
    if (next !== current) {
      await writeProfileEnvKeys(paths, {
        TELEGRAM_ALLOWED_USERS: next || null,
      });
    }
  }
}

// ── #206 Lane IV — apply identity override on Telegram bot ────────────────
//
// Telegram exposes two relevant Bot API methods we honour at outbound time:
//   * setMyName?name=<display>            — global bot display name
//   * setMyPhoto + setUserProfilePhotos   — bot's avatar (multipart upload)
//
// Both are global per bot (not per-message), so we cache the last-applied
// override per profile slug in process memory and only push to Telegram
// when the override actually changed. Sending a message to Telegram does
// NOT re-apply identity by itself — that's a separate API call we issue
// here BEFORE the outbound message.
//
// Reserved profiles (`main`, `workers`, `heavy`, `codex-builder`) are
// out of scope for #206; Lane I refuses to write the row, but as a
// defensive belt-and-braces the helper short-circuits on null override
// anyway.

const RESERVED_PROFILES_FOR_IDENTITY: ReadonlySet<string> = new Set([
  "main",
  "workers",
  "heavy",
  "codex-builder",
]);

interface TelegramAppliedIdentity {
  display_name: string | null;
  avatar_path: string | null;
}

// Process-memory cache of the last-applied (display_name, avatar_path) per
// profile so we don't hammer api.telegram.org on every message. Cleared on
// ctrl-api restart, which is fine — Telegram's setMyName is idempotent.
const _telegramIdentityCache = new Map<string, TelegramAppliedIdentity>();

/**
 * Build the set of Telegram Bot API calls needed to apply this identity
 * override. Returns an array of {url, method, multipart?} so it's
 * testable without firing real fetches. The caller (`applyTelegramIdentity`)
 * actually issues the calls.
 *
 * Exported for the unit test — the test asserts the URL/method shape
 * without mocking `fetch`.
 */
export function buildTelegramIdentityCalls(
  token: string,
  override: ResolvedChannelIdentity,
  last: TelegramAppliedIdentity | null,
): Array<{ kind: "setMyName" | "setUserProfilePhotos"; url: string; avatar_path?: string }> {
  const calls: Array<{ kind: "setMyName" | "setUserProfilePhotos"; url: string; avatar_path?: string }> = [];
  const nameChanged =
    override.display_name != null &&
    override.display_name !== (last?.display_name ?? null);
  if (nameChanged && override.display_name) {
    calls.push({
      kind: "setMyName",
      url:
        `https://api.telegram.org/bot${token}/setMyName?name=` +
        encodeURIComponent(override.display_name),
    });
  }
  const avatarChanged =
    override.avatar_path != null &&
    override.avatar_path !== (last?.avatar_path ?? null);
  if (avatarChanged && override.avatar_path) {
    calls.push({
      kind: "setUserProfilePhotos",
      url: `https://api.telegram.org/bot${token}/setUserProfilePhotos`,
      avatar_path: override.avatar_path,
    });
  }
  return calls;
}

/**
 * Resolve + apply the identity override for a profile's Telegram bot.
 * Fire-and-forget — if Telegram returns an error we log and proceed so
 * the actual outbound message still goes through.
 */
async function applyTelegramIdentity(
  profileSlug: string,
  botToken: string,
): Promise<void> {
  if (RESERVED_PROFILES_FOR_IDENTITY.has(profileSlug)) return;
  const override = resolveChannelIdentity(
    getStateDb(),
    profileSlug,
    "telegram",
  );
  if (!override) return;
  const last = _telegramIdentityCache.get(profileSlug) ?? null;
  const calls = buildTelegramIdentityCalls(botToken, override, last);
  if (calls.length === 0) return;
  for (const c of calls) {
    try {
      if (c.kind === "setMyName") {
        await fetch(c.url, {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
        });
      } else if (c.kind === "setUserProfilePhotos" && c.avatar_path) {
        // Telegram setUserProfilePhotos expects multipart/form-data with
        // `photo=@<file>`. We use the Node 22 native fetch + Blob path so
        // there's no extra dep. Skipped if the file doesn't exist (the DB
        // can hold a stale path; we don't want to crash the send).
        const fs = await import("node:fs/promises");
        let buf: Buffer;
        try {
          buf = await fs.readFile(c.avatar_path);
        } catch {
          console.warn(
            `[telegram] avatar file missing for profile '${profileSlug}': ${c.avatar_path}`,
          );
          continue;
        }
        const form = new FormData();
        // Node's Buffer<ArrayBufferLike> is structurally compatible with
        // the lib.dom Blob constructor at runtime, but @types/node's
        // tsbuffer typing produces an ArrayBuffer/SharedArrayBuffer union
        // the dom typings reject. Cast through `BlobPart` to match the
        // pre-existing pattern in voice_esphome.ts at the same boundary.
        form.append(
          "photo",
          new Blob([buf as unknown as BlobPart], {
            type: override.avatar_mime ?? "image/png",
          }),
          c.avatar_path.split("/").pop() ?? "avatar",
        );
        await fetch(c.url, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch (e) {
      console.warn(
        `[telegram] identity apply failed for profile '${profileSlug}' (${c.kind}):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  _telegramIdentityCache.set(profileSlug, {
    display_name: override.display_name,
    avatar_path: override.avatar_path,
  });
}

// Test-only hook: clear the in-memory cache so unit tests don't bleed
// state across cases. Not part of the public surface.
export function _resetTelegramIdentityCacheForTests(): void {
  _telegramIdentityCache.clear();
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerTelegramRoutes(): void {
  // GET /resolve?chat_id=<id> — Lane IV debug surface. Returns the resolved
  // profile context for a given chat_id without side effects. Used by the
  // smoke runbook to prove channel→profile binding works end-to-end.
  addRoute("GET", "/api/v1/channels/telegram/resolve", async ({ res, query }) => {
    const chatId = query.get("chat_id")?.trim() || null;
    // Import lazily to avoid a circular dep with state.js at module init.
    const { resolveProfileContextForChannel } = await import(
      "../../db/agentProfiles.js"
    );
    const ctx = resolveProfileContextForChannel(
      getStateDb(),
      "telegram",
      chatId,
    );
    sendJson(res, 200, {
      channel_kind: "telegram",
      channel_identity: chatId,
      profile: ctx.slug,
      bound_profile: ctx.bound_slug,
      cascaded: ctx.cascaded,
      api_server_port: ctx.api_server_port,
      api_server_key_present: ctx.api_server_key != null,
      profile_dir: ctx.profile_dir,
      journal_scope: ctx.journal_scope_key,
    });
  });

  // GET /status — fail-soft. NEVER 5xx (dashboard polls it).
  // Accepts ?profile=<slug>; defaults to the default binding for telegram.
  addRoute("GET", "/api/v1/channels/telegram/status", async ({ res, query }) => {
    const paths = resolveTelegramProfile(query);
    let envMap: Record<string, string> = {};
    let envErr: string | null = null;
    try {
      envMap = await readProfileEnv(paths);
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
      readJsonFromContainer(paths.gatewayStatePath),
      readJsonFromContainer(paths.channelDirPath),
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
  addRoute(
    "PUT",
    "/api/v1/channels/telegram/token",
    async ({ res, body, query }) => {
      const paths = resolveTelegramProfile(query);
      // #120 Lane V — validate the profile is writable before any side
      // effect. Throws a ValidationError-ish "profile X is archived" when
      // the explicit ?profile= points at an archived row.
      try {
        assertWritableProfile(getStateDb(), paths.profileSlug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }
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

      const itemName = vaultItemNameForProfile(paths.profileSlug);
      await upsertTelegramVaultItem(token, itemName);    // canonical store
      await writeProfileEnvKeys(paths, updates); // the file Hermes actually reads
      // #120 Lane V — audit row. action_type uses canonical underscore.
      appendAudit({
        action_type: "channel_token_set",
        actor: "principal",
        source: "channels/telegram/token",
        target_path: "channels/telegram/token",
        target_kind: "channel",
        subject_ref: paths.profileSlug,
        summary: `Telegram token set on profile '${paths.profileSlug}'`,
        payload: { profile_slug: paths.profileSlug, channel_kind: "telegram" },
      });
      // #120 Lane V — scoped restart for THIS profile only. The fallback
      // to a whole-container reload is wider than ideal — flag it via
      // restart_scope so the UI can warn.
      const restart = restartProfile(paths.profileSlug, {
        allowComposeFallback: true,
      });
      sendJson(res, 200, {
        ok: true,
        state: "configured_starting",
        profile: paths.profileSlug,
        restart_scope: restart.scope,
        restart_warning: restart.warning,
      });
    },
  );

  // DELETE /token — wipe vault + drop the 3 .env keys + restart.
  addRoute(
    "DELETE",
    "/api/v1/channels/telegram/token",
    async ({ res, query }) => {
      const paths = resolveTelegramProfile(query);
      try {
        assertWritableProfile(getStateDb(), paths.profileSlug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }
      const itemName = vaultItemNameForProfile(paths.profileSlug);
      await deleteTelegramVaultItem(itemName); // idempotent
      await writeProfileEnvKeys(paths, {
        TELEGRAM_BOT_TOKEN: null,
        TELEGRAM_ALLOWED_USERS: null,
        TELEGRAM_HOME_CHANNEL: null,
      });
      appendAudit({
        action_type: "channel_token_cleared",
        actor: "principal",
        source: "channels/telegram/token",
        target_path: "channels/telegram/token",
        target_kind: "channel",
        subject_ref: paths.profileSlug,
        summary: `Telegram token cleared on profile '${paths.profileSlug}'`,
        payload: { profile_slug: paths.profileSlug, channel_kind: "telegram" },
      });
      const restart = restartProfile(paths.profileSlug, {
        allowComposeFallback: true,
      });
      sendJson(res, 200, {
        ok: true,
        state: "unconfigured",
        profile: paths.profileSlug,
        restart_scope: restart.scope,
        restart_warning: restart.warning,
      });
    },
  );

  // POST /test — send a one-shot test message to TELEGRAM_HOME_CHANNEL via
  // the Telegram bot API. Used by the /channels "Send test message" button so
  // the user can confirm the bot can actually deliver. We deliberately don't
  // route through Hermes — this is a pure liveness check.
  addRoute(
    "POST",
    "/api/v1/channels/telegram/test",
    async ({ res, query }) => {
      const paths = resolveTelegramProfile(query);
      const envMap: Record<string, string> = await readProfileEnv(paths).catch(
        () => ({}) as Record<string, string>,
      );
      const token = envMap.TELEGRAM_BOT_TOKEN ?? "";
      if (!token) {
        throw new ValidationError(
          "telegram is not configured (no bot token in the hermes profile)",
        );
      }
      // Prefer TELEGRAM_HOME_CHANNEL; fall back to the first paired chat we
      // know about so a user who set up via DM-pairing alone still gets a test.
      let chatId = envMap.TELEGRAM_HOME_CHANNEL ?? "";
      if (!chatId) {
        const dirBlob = await readJsonFromContainer(paths.channelDirPath);
        const paired = parseChannelDirectory(dirBlob);
        if (paired.length > 0) chatId = String(paired[0].id);
      }
      if (!chatId) {
        sendJson(res, 200, {
          ok: false,
          error:
            "no chat to send to — DM the bot once from your phone so it knows your chat_id, then try again",
        });
        return;
      }
      const stamp = new Date().toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      // #206 Lane IV — push per-profile display_name/avatar to Telegram
      // before the test send, so the recipient sees this profile's
      // identity. Fire-and-forget: never block the outbound on it.
      await applyTelegramIdentity(paths.profileSlug, token);
      const result = await sendTelegramMessage(
        token,
        chatId,
        `🤵 Test message from your Alfred dashboard · ${stamp}`,
      );
      if (result.ok) {
        sendJson(res, 200, {
          ok: true,
          chat_id: chatId,
          message_id: result.message_id,
          sent_at: new Date().toISOString(),
        });
      } else {
        sendJson(res, 200, { ok: false, error: result.description });
      }
    },
  );

  // DELETE /chats/:user_id — revoke a paired chat. Removes from
  // channel_directory.json AND from TELEGRAM_ALLOWED_USERS, then bounces
  // Hermes so the next message from that chat lands on the cold path.
  addRoute(
    "DELETE",
    "/api/v1/channels/telegram/chats/:user_id",
    async ({ res, params, query }) => {
      const paths = resolveTelegramProfile(query);
      const userId = String(params.user_id ?? "").trim();
      if (!userId || !/^[0-9-]{1,20}$/.test(userId)) {
        throw new ValidationError("user_id must be a numeric Telegram chat id");
      }
      await revokeChatFromDirectory(paths, userId);
      restartHermes();
      sendJson(res, 200, { ok: true, revoked: userId });
    },
  );
}
