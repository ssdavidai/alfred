// Lane I — Telegram channel routes (/api/v1/channels/telegram/*).
//
// Hermes natively supports Telegram via `gateway/platforms/telegram.py`. The
// bot token is the only secret; Hermes reads it from TELEGRAM_BOT_TOKEN on
// boot (Lane V wired the compose passthrough + main-profile config.yaml).
//
// Sir's locked decisions:
//   1. Vaultwarden is the canonical home. Item is named exactly
//      "Telegram Bot Token" — that name is the lookup key.
//   2. Token is also cached as TELEGRAM_BOT_TOKEN=<token> in
//      `${COMPOSE_DIR}/.env` (mounted from /opt/alfred/.env). Compose passes
//      that into Hermes; vault is source-of-truth for rotation/recovery.
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

import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import {
  COMPOSE_DIR,
  dockerExec,
  dockerComposeCmd,
  HERMES_CMD,
  HERMES_CONTAINER,
} from "../helpers.js";

const VAULT_CLI_URL = process.env.VAULT_CLI_URL || "http://vault-cli:8087";
const ENV_PATH = `${COMPOSE_DIR}/.env`;
const VAULT_ITEM_NAME = "Telegram Bot Token";
// BotFather token shape: <8-12 digit bot id>:<35-char secret>. Mirrored on
// the web side as isProbablyValidBotToken in telegramCardCore.ts.
const BOT_TOKEN_RE = /^\d{8,12}:[A-Za-z0-9_-]{35}$/;

type TelegramState =
  | "unconfigured"
  | "configured_starting"
  | "configured_running"
  | "error";

interface TelegramStatus {
  configured: boolean;
  bot_handle: string | null;
  last_message_at: string | null;
  state: TelegramState;
  error: string | null;
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

/**
 * Look up the canonical "Telegram Bot Token" item by exact (case-insensitive)
 * name. Returns id + password or null. bw serve's `search=` is substring on
 * name; we filter back to exact so "Telegram Bot Token (backup)" can't shadow.
 */
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

/** Upsert the canonical "Telegram Bot Token" item with the given secret. */
async function upsertTelegramVaultItem(token: string): Promise<void> {
  const existing = await findTelegramVaultItem();
  if (existing && existing.id) {
    // bw serve PUT replaces the whole record — fetch first, patch login.password.
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

// ── .env mutation (same shape as vexa.ts) ─────────────────────────────────
// Idempotent upsert. `null` token → drop the line entirely (DELETE path).
function writeTelegramTokenEnv(token: string | null): void {
  let lines: string[];
  try { lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n"); }
  catch { lines = []; }
  let found = false;
  const out: string[] = [];
  for (const raw of lines) {
    if (raw.trim().startsWith("TELEGRAM_BOT_TOKEN=")) {
      found = true;
      if (token === null) continue;
      out.push(`TELEGRAM_BOT_TOKEN=${token}`);
      continue;
    }
    out.push(raw);
  }
  if (!found && token !== null) out.push(`TELEGRAM_BOT_TOKEN=${token}`);
  const content = out.join("\n");
  fs.writeFileSync(ENV_PATH, content.endsWith("\n") ? content : content + "\n", "utf-8");
}

// ── Hermes interactions ───────────────────────────────────────────────────

/** Background hermes restart — caller doesn't block on the ~3-5s compose call. */
function restartHermes(): void {
  dockerComposeCmd(["restart", HERMES_CONTAINER]).catch((err) => {
    console.error("[telegram] hermes restart failed:", err);
  });
}

/**
 * Probe `hermes gateway status` for Telegram running state + bot handle.
 * Returns null on any error so /status can keep going as "error".
 */
async function probeHermesTelegram(): Promise<{
  running: boolean;
  bot_handle: string | null;
  last_message_at: string | null;
} | null> {
  try {
    const stdout = await dockerExec(HERMES_CONTAINER, [...HERMES_CMD, "gateway", "status"]);
    let parsed: any;
    try { parsed = JSON.parse(stdout); }
    catch {
      // Text-mode fallback. Older hermes versions print free-form text.
      const handle = stdout.match(/@([A-Za-z0-9_]{3,32}_?bot)/i);
      return {
        running: /telegram[^\n]*running/i.test(stdout),
        bot_handle: handle ? `@${handle[1]}` : null,
        last_message_at: null,
      };
    }
    const tg = parsed?.platforms?.telegram ?? parsed?.gateway?.platforms?.telegram ?? null;
    if (!tg) return { running: false, bot_handle: null, last_message_at: null };
    const handleRaw = tg.bot_handle ?? tg.username ?? null;
    const handle = handleRaw
      ? (String(handleRaw).startsWith("@") ? String(handleRaw) : `@${String(handleRaw)}`)
      : null;
    return {
      running: Boolean(tg.running ?? tg.connected ?? false),
      bot_handle: handle,
      last_message_at: typeof tg.last_message_at === "string" ? tg.last_message_at : null,
    };
  } catch (e) {
    console.warn("[telegram] hermes gateway status failed:", e);
    return null;
  }
}

/**
 * Mint a fresh DM-pairing code for telegram via `hermes pairing`. Tolerates
 * the CLI's subcommand name not being pinned ("generate" today; "new" / "mint"
 * on older builds) so the route doesn't hard-pin a single Hermes minor.
 * Synthesises expires_at = now + 1h (Hermes' documented default TTL).
 */
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
  // GET /status — fail-soft.
  addRoute("GET", "/api/v1/channels/telegram/status", async ({ res }) => {
    let configured = false;
    let vaultErr: string | null = null;
    try {
      const item = await findTelegramVaultItem();
      configured = item !== null && !!item.password;
    } catch (e) {
      vaultErr = e instanceof Error ? e.message : String(e);
    }

    if (!configured && !vaultErr) {
      sendJson(res, 200, {
        configured: false, bot_handle: null, last_message_at: null,
        state: "unconfigured", error: null,
      } satisfies TelegramStatus);
      return;
    }
    if (vaultErr) {
      sendJson(res, 200, {
        configured: false, bot_handle: null, last_message_at: null,
        state: "error", error: `vault: ${vaultErr}`,
      } satisfies TelegramStatus);
      return;
    }

    const hermes = await probeHermesTelegram();
    if (!hermes) {
      // Configured but Hermes unreachable — treat as restart-in-flight.
      sendJson(res, 200, {
        configured: true, bot_handle: null, last_message_at: null,
        state: "configured_starting", error: null,
      } satisfies TelegramStatus);
      return;
    }
    sendJson(res, 200, {
      configured: true,
      bot_handle: hermes.bot_handle,
      last_message_at: hermes.last_message_at,
      state: hermes.running ? "configured_running" : "configured_starting",
      error: null,
    } satisfies TelegramStatus);
  });

  // PUT /token — write to vault + .env, restart hermes.
  addRoute("PUT", "/api/v1/channels/telegram/token", async ({ res, body }) => {
    const b = (body ?? {}) as { token?: unknown };
    if (typeof b.token !== "string" || !BOT_TOKEN_RE.test(b.token.trim())) {
      throw new ValidationError(
        "token must match BotFather shape: <8-12 digits>:<35 chars [A-Za-z0-9_-]>",
      );
    }
    const token = b.token.trim();
    await upsertTelegramVaultItem(token);   // canonical
    writeTelegramTokenEnv(token);           // cache
    restartHermes();                        // background
    sendJson(res, 200, { ok: true, state: "configured_starting" });
  });

  // DELETE /token — disconnect.
  addRoute("DELETE", "/api/v1/channels/telegram/token", async ({ res }) => {
    await deleteTelegramVaultItem(); // idempotent
    writeTelegramTokenEnv(null);     // drop the line; preserve siblings
    restartHermes();
    sendJson(res, 200, { ok: true, state: "unconfigured" });
  });

  // POST /pair — mint a DM-pairing code.
  addRoute("POST", "/api/v1/channels/telegram/pair", async ({ res }) => {
    const out = await generatePairingCode();
    sendJson(res, 200, out);
  });
}
