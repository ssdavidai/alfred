// Lane I — Slack channel routes (/api/v1/channels/slack/*).
//
// Mirrors the Telegram route surface (packages/ctrl/src/api/routes/telegram.ts)
// for the /channels Slack card. The architectural shape is identical:
//
//   $HERMES_HOME/profiles/main/.env  — SLACK_BOT_TOKEN, SLACK_APP_TOKEN,
//                                       SLACK_ALLOWED_USERS, SLACK_HOME_CHANNEL,
//                                       SLACK_ALLOWED_CHANNELS
//                                       (read by Hermes' Socket Mode adapter)
//   Vaultwarden                      — canonical source-of-truth items:
//                                       "Slack Bot Token" + "Slack App Token"
//   HERMES_HOME=/hermes-state inside the runtime container (compose).
//
// Hermes-side facts (verified 2026-05-25 against the live image):
//   * gateway/platforms/slack.py uses Socket Mode (slack_bolt.adapter.socket_mode)
//     — requires BOTH SLACK_BOT_TOKEN (xoxb-…) for chat.postMessage AND
//     SLACK_APP_TOKEN (xapp-…) for the websocket connection.
//   * Multi-workspace is supported server-side (_team_clients dict); the
//     UI ships single-workspace for MVP.
//   * `hermes slack manifest` generates the Slack-app manifest JSON the
//     user pastes at api.slack.com/apps. We surface it via GET /manifest
//     so the dashboard wizard can offer "copy this JSON" without making the
//     user open a terminal.
//
// Six surfaces:
//   GET    /api/v1/channels/slack/status     — current configured state
//   GET    /api/v1/channels/slack/manifest   — the JSON the user pastes into
//                                              api.slack.com/apps to create
//                                              the bot
//   PUT    /api/v1/channels/slack/tokens     — write bot+app tokens + opts,
//                                              restart hermes
//   DELETE /api/v1/channels/slack/tokens     — wipe everything, restart hermes
//   POST   /api/v1/channels/slack/test       — send a test DM to the
//                                              SLACK_HOME_CHANNEL (fallback:
//                                              the bot's own user_id)
//
// FAIL-SOFT POLICY mirrors Telegram: /status MUST NOT 5xx; the dashboard
// polls it. On any upstream failure return state:"error" + the message in
// `error` so the UI shows a "needs attention" card.

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import {
  dockerExec,
  dockerExecWithStdin,
  dockerComposeCmd,
  HERMES_CONTAINER,
} from "../helpers.js";

const VAULT_CLI_URL = process.env.VAULT_CLI_URL || "http://vault-cli:8087";
const HERMES_HOME =
  process.env.HERMES_HOME_IN_CONTAINER || "/hermes-state";
const MAIN_PROFILE_DIR = `${HERMES_HOME}/profiles/main`;
const PROFILE_ENV_PATH = `${MAIN_PROFILE_DIR}/.env`;
const VAULT_BOT_ITEM_NAME = "Slack Bot Token";
const VAULT_APP_ITEM_NAME = "Slack App Token";

// Slack token shapes (canonical):
//   Bot User OAuth Token:  xoxb-<team_id>-<bot_id>-<secret>
//   App-Level Token:       xapp-<version>-<scope>-<id>-<secret>
// We accept the prefix + a permissive tail; Slack itself is the final arbiter.
const BOT_TOKEN_RE = /^xoxb-[0-9A-Za-z_-]{8,}$/;
const APP_TOKEN_RE = /^xapp-[0-9A-Za-z_-]{8,}$/;

type SlackState =
  | "unconfigured"
  | "configured_starting"
  | "configured_running"
  | "error";

interface SlackStatus {
  configured: boolean;
  state: SlackState;
  error: string | null;
  workspace: {
    team: string | null;       // Slack team display name (e.g. "Acme Inc.")
    team_id: string | null;    // Slack team id (e.g. "T01ABC2DEF3")
    bot_user: string | null;   // bot display name (e.g. "@alfred")
    bot_user_id: string | null;
    url: string | null;        // workspace URL (e.g. https://acme.slack.com)
  };
  allowed_users: string;       // comma-separated; empty = open
  home_channel: string;        // the chat_id Sir-facing notifications default to
  allowed_channels: string;    // comma-separated channel ids; empty = all
}

// ── vault-cli helpers (mirror of telegram.ts) ─────────────────────────────

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
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

function unwrap(
  body: unknown,
): { ok: true; data: unknown } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "vault-cli returned non-JSON body" };
  }
  const env = body as BwEnvelope;
  if (env.success === false)
    return { ok: false, message: env.message ?? "vault-cli error" };
  if (env.success === true && "data" in env) return { ok: true, data: env.data };
  return { ok: true, data: body };
}

async function findVaultItem(
  name: string,
): Promise<{ id: string; password: string | null } | null> {
  const r = await bwFetch(
    `/list/object/items?search=${encodeURIComponent(name)}`,
  );
  if (r.status >= 500)
    throw new Error(`vault-cli unreachable (HTTP ${r.status})`);
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
    if (it.name.toLowerCase() !== name.toLowerCase()) continue;
    const login =
      typeof it.login === "object" && it.login !== null
        ? (it.login as Record<string, unknown>)
        : null;
    const password =
      login && typeof login.password === "string" ? login.password : null;
    return { id: typeof it.id === "string" ? it.id : "", password };
  }
  return null;
}

async function upsertVaultItem(name: string, token: string): Promise<void> {
  const existing = await findVaultItem(name);
  if (existing && existing.id) {
    const cur = await bwFetch(`/object/item/${existing.id}`);
    const curU = unwrap(cur.body);
    if (!curU.ok) throw new Error(curU.message);
    const existingItem =
      (curU.data as Record<string, unknown>).data ?? curU.data;
    const e = existingItem as Record<string, unknown>;
    const existingLogin =
      typeof e.login === "object" && e.login !== null
        ? ({ ...(e.login as Record<string, unknown>) } as Record<string, unknown>)
        : { username: null, password: null, uris: [] };
    existingLogin.password = token;
    const merged = { ...e, name, login: existingLogin };
    const r = await bwFetch(`/object/item/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(merged),
    });
    const u = unwrap(r.body);
    if (!u.ok) throw new Error(u.message);
    return;
  }
  const payload = {
    type: 1,
    name,
    notes:
      "Slack channel credential for Hermes (Alfred Black). Source of truth.",
    folderId: null,
    favorite: false,
    reprompt: 0,
    login: {
      username: null,
      password: token,
      uris: [{ uri: "https://slack.com/", match: null }],
    },
  };
  const r = await bwFetch("/object/item", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const u = unwrap(r.body);
  if (!u.ok) throw new Error(u.message);
}

async function deleteVaultItem(name: string): Promise<void> {
  const existing = await findVaultItem(name);
  if (!existing || !existing.id) return; // idempotent
  const r = await bwFetch(`/object/item/${existing.id}`, { method: "DELETE" });
  const u = unwrap(r.body);
  if (!u.ok) throw new Error(u.message);
}

// ── per-profile .env merge-writer ─────────────────────────────────────────
//
// Same pattern as telegram.ts: read existing text, preserve comments + other
// keys, idempotently set/drop the SLACK_* triplet. `null` value drops the key.

const SLACK_ENV_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_ALLOWED_USERS",
  "SLACK_HOME_CHANNEL",
  "SLACK_ALLOWED_CHANNELS",
] as const;
type SlackEnvKey = (typeof SLACK_ENV_KEYS)[number];

async function readProfileEnv(): Promise<Record<string, string>> {
  const raw = await dockerExec(HERMES_CONTAINER, [
    "sh",
    "-c",
    `cat ${PROFILE_ENV_PATH} 2>/dev/null || true`,
  ]);
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.replace(/^﻿/, "");
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    if (!k || k.startsWith("#")) continue;
    let v = t.slice(eq + 1);
    if (v.endsWith("\r")) v = v.slice(0, -1);
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

async function writeProfileEnvKeys(
  updates: Partial<Record<SlackEnvKey, string | null>>,
): Promise<void> {
  const raw = await dockerExec(HERMES_CONTAINER, [
    "sh",
    "-c",
    `cat ${PROFILE_ENV_PATH} 2>/dev/null || true`,
  ]);
  const lines = raw === "" ? [] : raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const t = line.replace(/^﻿/, "");
    const eq = t.indexOf("=");
    const key = eq > 0 ? t.slice(0, eq).trim() : "";
    if (key && key in updates) {
      seen.add(key);
      const v = updates[key as SlackEnvKey];
      if (v === null || v === undefined) continue; // drop
      out.push(`${key}=${v}`);
      continue;
    }
    out.push(line);
  }
  for (const k of SLACK_ENV_KEYS) {
    if (seen.has(k)) continue;
    if (!(k in updates)) continue;
    const v = updates[k];
    if (v === null || v === undefined) continue;
    out.push(`${k}=${v}`);
  }
  const content = out.join("\n") + "\n";

  const tmp = `${PROFILE_ENV_PATH}.tmp.${process.pid}.${Date.now()}`;
  await dockerExecWithStdin(
    HERMES_CONTAINER,
    [
      "sh",
      "-c",
      `mkdir -p ${MAIN_PROFILE_DIR} && cat > ${tmp} && mv ${tmp} ${PROFILE_ENV_PATH}`,
    ],
    content,
    30_000,
  );
}

// ── Slack Web API helpers (the deliverSlack equivalents) ──────────────────

interface AuthTestResult {
  ok: boolean;
  team: string | null;
  team_id: string | null;
  user: string | null;
  user_id: string | null;
  url: string | null;
  error: string | null;
}

/** Resolve workspace identity via Slack `auth.test`. Caches for 60s. */
let _authTestCache: { token: string; result: AuthTestResult; at: number } | null = null;
const AUTH_TEST_TTL_MS = 60_000;

async function slackAuthTest(botToken: string): Promise<AuthTestResult> {
  const now = Date.now();
  if (
    _authTestCache &&
    _authTestCache.token === botToken &&
    now - _authTestCache.at < AUTH_TEST_TTL_MS
  ) {
    return _authTestCache.result;
  }
  const empty: AuthTestResult = {
    ok: false,
    team: null,
    team_id: null,
    user: null,
    user_id: null,
    url: null,
    error: null,
  };
  try {
    const r = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    const j = (await r.json()) as {
      ok?: boolean;
      team?: string;
      team_id?: string;
      user?: string;
      user_id?: string;
      url?: string;
      error?: string;
    };
    const out: AuthTestResult = {
      ok: Boolean(j.ok),
      team: j.team ?? null,
      team_id: j.team_id ?? null,
      user: j.user ?? null,
      user_id: j.user_id ?? null,
      url: j.url ?? null,
      error: j.ok ? null : j.error ?? `HTTP ${r.status}`,
    };
    _authTestCache = { token: botToken, result: out, at: now };
    return out;
  } catch (e) {
    return {
      ...empty,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Send a chat message via Slack Web API. Used by /test + alfred-deliver. */
export async function slackPostMessage(
  botToken: string,
  channel: string,
  text: string,
): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text, mrkdwn: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      ts?: string;
      error?: string;
    };
    if (j?.ok && typeof j.ts === "string") return { ok: true, ts: j.ts };
    return {
      ok: false,
      error: j?.error ?? `Slack returned HTTP ${r.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Restart Hermes so it picks up the new .env ────────────────────────────

function restartHermes(): void {
  dockerComposeCmd(["restart", HERMES_CONTAINER]).catch((err) => {
    console.error("[slack] hermes restart failed:", err);
  });
}

// ── Slack app manifest ────────────────────────────────────────────────────
//
// Generated via `hermes slack manifest` inside the hermes container. Cached
// for the life of the ctrl-api process — the manifest is deterministic given
// Hermes' command registry, which doesn't change at runtime. On a Hermes
// version bump the ctrl-api restart picks up the fresh manifest.

let _manifestCache: string | null = null;

async function getSlackManifest(): Promise<string> {
  if (_manifestCache) return _manifestCache;
  try {
    // The `hermes slack manifest` CLI prints the JSON to stdout. Capture +
    // return verbatim so the UI can show it in a copy-to-clipboard block.
    const out = await dockerExec(HERMES_CONTAINER, [
      "hermes", "-p", "main", "slack", "manifest",
    ]);
    _manifestCache = out.trim();
    return _manifestCache;
  } catch (e) {
    // Fallback to a hand-coded minimal manifest so the UI is never blank.
    // Matches what `hermes slack manifest` produces in the common shape.
    const fallback = {
      display_information: { name: "Alfred Black" },
      features: {
        bot_user: { display_name: "Alfred", always_online: true },
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read", "channels:history", "channels:read",
            "chat:write", "commands", "files:read", "files:write",
            "groups:history", "groups:read", "im:history", "im:read",
            "im:write", "users:read",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: [
            "app_mention", "message.channels", "message.groups", "message.im",
          ],
        },
        interactivity: { is_enabled: true },
        socket_mode_enabled: true,
        org_deploy_enabled: false,
        token_rotation_enabled: false,
      },
    };
    console.warn(
      "[slack] manifest CLI failed, returning fallback:",
      e instanceof Error ? e.message : e,
    );
    return JSON.stringify(fallback, null, 2);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerSlackRoutes(): void {
  // GET /status — fail-soft. NEVER 5xx (dashboard polls it).
  addRoute("GET", "/api/v1/channels/slack/status", async ({ res }) => {
    let envMap: Record<string, string> = {};
    let envErr: string | null = null;
    try {
      envMap = await readProfileEnv();
    } catch (e) {
      envErr = e instanceof Error ? e.message : String(e);
    }
    const botToken = envMap.SLACK_BOT_TOKEN ?? "";
    const appToken = envMap.SLACK_APP_TOKEN ?? "";
    const configured = Boolean(botToken && appToken);
    const allowed_users = envMap.SLACK_ALLOWED_USERS ?? "";
    const home_channel = envMap.SLACK_HOME_CHANNEL ?? "";
    const allowed_channels = envMap.SLACK_ALLOWED_CHANNELS ?? "";

    const emptyWorkspace = {
      team: null,
      team_id: null,
      bot_user: null,
      bot_user_id: null,
      url: null,
    };

    if (envErr) {
      sendJson(res, 200, {
        configured: false,
        state: "error",
        error: `profile env: ${envErr}`,
        workspace: emptyWorkspace,
        allowed_users: "",
        home_channel: "",
        allowed_channels: "",
      } satisfies SlackStatus);
      return;
    }
    if (!configured) {
      sendJson(res, 200, {
        configured: false,
        state: "unconfigured",
        error: null,
        workspace: emptyWorkspace,
        allowed_users: "",
        home_channel: "",
        allowed_channels: "",
      } satisfies SlackStatus);
      return;
    }

    // Probe Slack for workspace identity. If auth.test fails the bot token
    // is invalid; surface as error state so the UI shows a clear "Token
    // rejected" message instead of a perpetual "starting" spinner.
    const auth = await slackAuthTest(botToken);
    if (!auth.ok) {
      sendJson(res, 200, {
        configured: true,
        state: "error",
        error: auth.error ?? "auth.test failed",
        workspace: emptyWorkspace,
        allowed_users,
        home_channel,
        allowed_channels,
      } satisfies SlackStatus);
      return;
    }

    // auth.test ok — Slack accepts the bot token. The Socket Mode side
    // (SLACK_APP_TOKEN) is harder to probe without opening a websocket,
    // so we report `configured_running` once the bot token authenticates.
    // If the app token is bad, Hermes' adapter will log it; we keep the
    // UI honest by surfacing that state via auth.test workspace info.
    sendJson(res, 200, {
      configured: true,
      state: "configured_running",
      error: null,
      workspace: {
        team: auth.team,
        team_id: auth.team_id,
        bot_user: auth.user ? `@${auth.user}` : null,
        bot_user_id: auth.user_id,
        url: auth.url,
      },
      allowed_users,
      home_channel,
      allowed_channels,
    } satisfies SlackStatus);
  });

  // GET /manifest — return the Slack app manifest JSON. The dashboard
  // displays it in the setup wizard for the user to copy-paste into
  // api.slack.com/apps → "Create New App" → "From an app manifest".
  addRoute("GET", "/api/v1/channels/slack/manifest", async ({ res }) => {
    try {
      const manifest = await getSlackManifest();
      // Return as JSON-wrapped so the UI can also receive metadata later.
      sendJson(res, 200, { manifest });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 200, {
        manifest: "",
        error: msg,
      });
    }
  });

  // PUT /tokens — write bot + app tokens + opts to .env + vault, restart hermes.
  addRoute("PUT", "/api/v1/channels/slack/tokens", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;

    const botToken =
      typeof b.bot_token === "string" ? b.bot_token.trim() : "";
    const appToken =
      typeof b.app_token === "string" ? b.app_token.trim() : "";
    if (!BOT_TOKEN_RE.test(botToken)) {
      throw new ValidationError(
        "bot_token must look like xoxb-… (Slack Bot User OAuth Token from " +
          "OAuth & Permissions in your app)",
      );
    }
    if (!APP_TOKEN_RE.test(appToken)) {
      throw new ValidationError(
        "app_token must look like xapp-… (App-Level Token with " +
          "connections:write scope, generated under Settings → Basic Information)",
      );
    }

    // Optional Phase-2 fields.
    const updates: Partial<Record<SlackEnvKey, string | null>> = {
      SLACK_BOT_TOKEN: botToken,
      SLACK_APP_TOKEN: appToken,
    };
    if (typeof b.allowed_users === "string") {
      updates.SLACK_ALLOWED_USERS = b.allowed_users.trim() || null;
    }
    if (typeof b.home_channel === "string") {
      updates.SLACK_HOME_CHANNEL = b.home_channel.trim() || null;
    }
    if (typeof b.allowed_channels === "string") {
      updates.SLACK_ALLOWED_CHANNELS = b.allowed_channels.trim() || null;
    }

    // Vaultwarden = canonical store. Two items (bot + app). Both must succeed
    // before we touch the .env so a vault outage doesn't leave us with the
    // tokens half-saved (.env set, vault missing).
    await upsertVaultItem(VAULT_BOT_ITEM_NAME, botToken);
    await upsertVaultItem(VAULT_APP_ITEM_NAME, appToken);
    await writeProfileEnvKeys(updates);
    // Drop the auth.test cache so /status reflects the new token immediately.
    _authTestCache = null;
    restartHermes();
    sendJson(res, 200, { ok: true, state: "configured_starting" });
  });

  // DELETE /tokens — wipe vault items + drop all SLACK_* env keys + restart.
  addRoute("DELETE", "/api/v1/channels/slack/tokens", async ({ res }) => {
    await deleteVaultItem(VAULT_BOT_ITEM_NAME);
    await deleteVaultItem(VAULT_APP_ITEM_NAME);
    await writeProfileEnvKeys({
      SLACK_BOT_TOKEN: null,
      SLACK_APP_TOKEN: null,
      SLACK_ALLOWED_USERS: null,
      SLACK_HOME_CHANNEL: null,
      SLACK_ALLOWED_CHANNELS: null,
    });
    _authTestCache = null;
    restartHermes();
    sendJson(res, 200, { ok: true, state: "unconfigured" });
  });

  // POST /test — send a real test message via Slack Web API.
  // Target: SLACK_HOME_CHANNEL if set, else the bot's own user_id (DM-to-self).
  addRoute("POST", "/api/v1/channels/slack/test", async ({ res }) => {
    const envMap = await readProfileEnv().catch(() => ({}) as Record<string, string>);
    const botToken = envMap.SLACK_BOT_TOKEN ?? "";
    if (!botToken) {
      throw new ValidationError(
        "slack is not configured (no bot token in the hermes profile)",
      );
    }
    let channel = envMap.SLACK_HOME_CHANNEL ?? "";
    if (!channel) {
      const auth = await slackAuthTest(botToken);
      if (auth.ok && auth.user_id) channel = auth.user_id;
    }
    if (!channel) {
      sendJson(res, 200, {
        ok: false,
        error:
          "no chat to send to — set SLACK_HOME_CHANNEL or have a workspace user DM the bot first",
      });
      return;
    }
    const stamp = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const result = await slackPostMessage(
      botToken,
      channel,
      `🤵 Test message from your Alfred dashboard · ${stamp}`,
    );
    if (result.ok) {
      sendJson(res, 200, {
        ok: true,
        channel,
        ts: result.ts,
        sent_at: new Date().toISOString(),
      });
    } else {
      sendJson(res, 200, { ok: false, error: result.error });
    }
  });
}
