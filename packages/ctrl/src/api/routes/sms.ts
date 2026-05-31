// Lane I — Twilio SMS channel routes (/api/v1/channels/sms/*).
//
// Mirrors the Telegram + Slack /channels lane pattern
// (packages/ctrl/src/api/routes/telegram.ts,
//  packages/ctrl/src/api/routes/slack.ts).
//
// Hermes' gateway reads Twilio config from the per-profile .env inside its
// data volume, NOT from container env:
//
//   $HERMES_HOME/profiles/main/.env  — TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//                                       TWILIO_PHONE_NUMBER, SMS_ALLOWED_USERS
//                                       (read by Hermes' Twilio adapter)
//   Vaultwarden                      — canonical source-of-truth items:
//                                       "Twilio Account SID",
//                                       "Twilio Auth Token",
//                                       "Twilio Phone Number"
//   HERMES_HOME=/hermes-state inside the runtime container (compose).
//
// Four surfaces:
//   GET    /api/v1/channels/sms/status        — current configured state
//   PUT    /api/v1/channels/sms/credentials   — validate against Twilio +
//                                               vault upsert + .env upsert +
//                                               debounced hermes restart
//   DELETE /api/v1/channels/sms/credentials   — wipe vault + drop env keys +
//                                               restart
//   POST   /api/v1/channels/sms/test          — fire a real Twilio Messages.json
//                                               send to the first allowlisted
//                                               E.164 number
//
// FAIL-SOFT POLICY mirrors Telegram/Slack: /status MUST NOT 5xx; the dashboard
// polls it. On any upstream failure return state:"error" + the message in
// `error` so the UI shows a "needs attention" card.
//
// `smsSend(text, to?)` is exported for /api/v1/alfred-deliver to use as the
// SMS arm of the unified delivery surface — orchestrator wires it.

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import {
  dockerExec,
  dockerExecWithStdin,
  dockerComposeCmd,
  HERMES_CONTAINER,
} from "../helpers.js";
import { getStateDb } from "../../db/state.js";
import {
  resolveProfileForChannel,
  assertWritableProfile,
} from "../../db/agentProfiles.js";
import { appendAudit } from "./state.js";
import { restartProfile } from "../../hermes/supervisor.js";

const VAULT_CLI_URL = process.env.VAULT_CLI_URL || "http://vault-cli:8087";
const HERMES_HOME =
  process.env.HERMES_HOME_IN_CONTAINER || "/hermes-state";

// Lane IV — per-profile paths. Each request resolves which profile owns the
// SMS channel (?profile=<slug> or the channel-default binding).
interface SmsProfilePaths {
  profileSlug: string;
  profileDir: string;
  envPath: string;
}

function pathsForProfile(slug: string): SmsProfilePaths {
  const profileDir = `${HERMES_HOME}/profiles/${slug}`;
  return {
    profileSlug: slug,
    profileDir,
    envPath: `${profileDir}/.env`,
  };
}

function resolveSmsProfile(query?: URLSearchParams): SmsProfilePaths {
  const explicit = query?.get("profile")?.trim() || null;
  if (explicit) return pathsForProfile(explicit);
  const slug = resolveProfileForChannel(getStateDb(), "sms", null);
  return pathsForProfile(slug);
}

const VAULT_SID_ITEM_NAME = "Twilio Account SID";
const VAULT_TOKEN_ITEM_NAME = "Twilio Auth Token";
const VAULT_PHONE_ITEM_NAME = "Twilio Phone Number";

// #120 Lane V — per-profile vault item naming. Main keeps the bare names
// for back-compat; non-main profiles use the suffix shape so each profile's
// Twilio creds are distinct Vaultwarden records.
function smsVaultItemNames(slug: string): { sid: string; token: string; phone: string } {
  if (slug === "main") {
    return {
      sid: VAULT_SID_ITEM_NAME,
      token: VAULT_TOKEN_ITEM_NAME,
      phone: VAULT_PHONE_ITEM_NAME,
    };
  }
  return {
    sid: `${VAULT_SID_ITEM_NAME} · ${slug}`,
    token: `${VAULT_TOKEN_ITEM_NAME} · ${slug}`,
    phone: `${VAULT_PHONE_ITEM_NAME} · ${slug}`,
  };
}

// Twilio canonical shapes:
//   Account SID: "AC" + 32 lowercase hex chars (Twilio's docs are explicit).
//   Auth Token : 32 lowercase hex chars.
//   Phone      : E.164 (+ then 1-15 digits).
const ACCOUNT_SID_RE = /^AC[a-f0-9]{32}$/;
const AUTH_TOKEN_RE = /^[a-f0-9]{32}$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;

type SmsState =
  | "unconfigured"
  | "configured_starting"
  | "configured_running"
  | "error";

interface SmsStatus {
  configured: boolean;
  state: SmsState;
  error: string | null;
  phone_number: string | null;
  account_sid_masked: string | null;
  allowed_users: string; // comma-separated E.164; "" if unset
  /** When true, SMS_ALLOW_ALL_USERS is on — anyone can text the number. */
  allow_all: boolean;
}

// ── vault-cli helpers (mirror of telegram.ts / slack.ts) ──────────────────

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

async function upsertVaultItem(name: string, secret: string): Promise<void> {
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
    existingLogin.password = secret;
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
      "Twilio SMS channel credential for Hermes (Alfred Black). Source of truth.",
    folderId: null,
    favorite: false,
    reprompt: 0,
    login: {
      username: null,
      password: secret,
      uris: [{ uri: "https://www.twilio.com/", match: null }],
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
// Same pattern as telegram.ts/slack.ts: read existing text, preserve comments
// + other keys, idempotently set/drop the 4 SMS keys. `null` value drops the
// key.

const SMS_ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "SMS_ALLOWED_USERS",
  "SMS_ALLOW_ALL_USERS",
  // Hermes' SMS adapter refuses to start without SMS_WEBHOOK_URL set and
  // defaults SMS_WEBHOOK_HOST to 127.0.0.1 (unreachable from other compose
  // containers — Caddy → hermes:8080 would 502). We write both alongside
  // the Twilio credentials so a fresh install never hits the "saved creds
  // but no inbound replies" trap; ${DOMAIN} comes from the compose .env.
  "SMS_WEBHOOK_URL",
  "SMS_WEBHOOK_HOST",
] as const;
type SmsEnvKey = (typeof SMS_ENV_KEYS)[number];

/** Public URL Hermes' SMS adapter validates X-Twilio-Signature against.
 *  Reads ${DOMAIN} so this works on every alfred-black host without code edits. */
function smsWebhookUrl(): string {
  const dom = (process.env.DOMAIN || "").trim();
  return dom ? `https://sms.${dom}/webhooks/twilio` : "";
}

async function readProfileEnv(
  paths: SmsProfilePaths,
): Promise<Record<string, string>> {
  const raw = await dockerExec(HERMES_CONTAINER, [
    "sh",
    "-c",
    `cat ${paths.envPath} 2>/dev/null || true`,
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
  paths: SmsProfilePaths,
  updates: Partial<Record<SmsEnvKey, string | null>>,
): Promise<void> {
  const raw = await dockerExec(HERMES_CONTAINER, [
    "sh",
    "-c",
    `cat ${paths.envPath} 2>/dev/null || true`,
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
      const v = updates[key as SmsEnvKey];
      if (v === null || v === undefined) continue; // drop
      out.push(`${key}=${v}`);
      continue;
    }
    out.push(line);
  }
  for (const k of SMS_ENV_KEYS) {
    if (seen.has(k)) continue;
    if (!(k in updates)) continue;
    const v = updates[k];
    if (v === null || v === undefined) continue;
    out.push(`${k}=${v}`);
  }
  const content = out.join("\n") + "\n";

  const tmp = `${paths.envPath}.tmp.${process.pid}.${Date.now()}`;
  await dockerExecWithStdin(
    HERMES_CONTAINER,
    [
      "sh",
      "-c",
      `mkdir -p ${paths.profileDir} && cat > ${tmp} && mv ${tmp} ${paths.envPath}`,
    ],
    content,
    30_000,
  );
}

// ── Twilio REST helpers ───────────────────────────────────────────────────

function basicAuth(sid: string, token: string): string {
  // Buffer is fine — ctrl-api runs on Node 22+.
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

/**
 * Validate Twilio credentials by GETting /Accounts/<sid>.json with HTTP
 * Basic auth. 200 → ok. Anything else → surface a useful error string.
 * Mirrors slack.ts::slackAuthTest, including a 60s cache so /status doesn't
 * hammer Twilio on every dashboard poll.
 */
interface TwilioAccountProbe {
  ok: boolean;
  friendly_name: string | null;
  status: string | null;
  error: string | null;
}

let _accountProbeCache:
  | { sid: string; token: string; result: TwilioAccountProbe; at: number }
  | null = null;
const ACCOUNT_PROBE_TTL_MS = 60_000;

async function probeTwilioAccount(
  sid: string,
  token: string,
): Promise<TwilioAccountProbe> {
  const now = Date.now();
  if (
    _accountProbeCache &&
    _accountProbeCache.sid === sid &&
    _accountProbeCache.token === token &&
    now - _accountProbeCache.at < ACCOUNT_PROBE_TTL_MS
  ) {
    return _accountProbeCache.result;
  }
  const empty: TwilioAccountProbe = {
    ok: false,
    friendly_name: null,
    status: null,
    error: null,
  };
  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
      {
        headers: { Authorization: basicAuth(sid, token) },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const j = (await r.json().catch(() => ({}))) as {
      sid?: string;
      friendly_name?: string;
      status?: string;
      message?: string;
      code?: number;
    };
    let result: TwilioAccountProbe;
    if (r.ok) {
      result = {
        ok: true,
        friendly_name: j.friendly_name ?? null,
        status: j.status ?? null,
        error: null,
      };
    } else {
      result = {
        ...empty,
        error: j.message ?? `Twilio returned HTTP ${r.status}`,
      };
    }
    _accountProbeCache = { sid, token, result, at: now };
    return result;
  } catch (e) {
    return {
      ...empty,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Send a one-shot SMS via Twilio. Used by /test and exported as `smsSend()`
 * for /api/v1/alfred-deliver's SMS arm.
 */
interface TwilioSendResult {
  ok: boolean;
  sid: string | null;
  error: string | null;
}

async function twilioSendMessage(
  accountSid: string,
  authToken: string,
  from: string,
  to: string,
  body: string,
): Promise<TwilioSendResult> {
  try {
    const form = new URLSearchParams();
    form.set("From", from);
    form.set("To", to);
    form.set("Body", body);
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: basicAuth(accountSid, authToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const j = (await r.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
      code?: number;
    };
    if (r.ok && typeof j.sid === "string") {
      return { ok: true, sid: j.sid, error: null };
    }
    return {
      ok: false,
      sid: null,
      error: j.message ?? `Twilio returned HTTP ${r.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      sid: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Exported sender for /api/v1/alfred-deliver. Resolves creds + the default
 * `to` (the first entry in SMS_ALLOWED_USERS, mirroring the /test fallback)
 * from the hermes per-profile .env. Caller passes the butler-voice text in
 * `text`; `to` is optional and overrides the default recipient.
 */
export async function smsSend(
  text: string,
  to?: string,
  profileSlug?: string,
): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  // Lane IV — resolve which profile's Twilio creds to use. The caller can
  // pin a profile explicitly; otherwise we read the SMS channel's default
  // binding (`main` until Lane III rebinds).
  const slug =
    profileSlug?.trim() ||
    resolveProfileForChannel(getStateDb(), "sms", to ?? null);
  const paths = pathsForProfile(slug);
  let env: Record<string, string>;
  try {
    env = await readProfileEnv(paths);
  } catch (e) {
    return {
      ok: false,
      error: `profile env unreadable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const sid = env.TWILIO_ACCOUNT_SID ?? "";
  const token = env.TWILIO_AUTH_TOKEN ?? "";
  const from = env.TWILIO_PHONE_NUMBER ?? "";
  if (!sid || !token || !from) {
    return {
      ok: false,
      error:
        "sms is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER missing in hermes profile)",
    };
  }
  let recipient = (to ?? "").trim();
  if (!recipient) {
    const allowed = (env.SMS_ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length > 0) recipient = allowed[0];
  }
  if (!recipient) {
    return {
      ok: false,
      error:
        "no recipient — pass `to` or set SMS_ALLOWED_USERS in the hermes profile",
    };
  }
  const r = await twilioSendMessage(sid, token, from, recipient, text);
  if (r.ok && r.sid) return { ok: true, sid: r.sid };
  return { ok: false, error: r.error ?? "twilio send failed" };
}

// ── Restart Hermes so it picks up the new .env ────────────────────────────

function restartHermes(): void {
  dockerComposeCmd(["restart", HERMES_CONTAINER]).catch((err) => {
    console.error("[sms] hermes restart failed:", err);
  });
}

// ── Mask helper for /status ───────────────────────────────────────────────
//
// "AC********...<last4>" — keep the "AC" prefix + 4 trailing chars so the
// UI can disambiguate two configured accounts at a glance, drop everything
// in between. Tests assert the shape /^AC\*+[0-9a-f]{4}$/.

function maskAccountSid(sid: string): string {
  if (sid.length < 6) return "AC" + "*".repeat(Math.max(0, sid.length - 2));
  const last4 = sid.slice(-4);
  const middleLen = sid.length - 2 /* "AC" */ - 4 /* last4 */;
  return "AC" + "*".repeat(Math.max(4, middleLen)) + last4;
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerSmsRoutes(): void {
  // GET /resolve?phone=<E.164> — Lane IV debug surface.
  addRoute("GET", "/api/v1/channels/sms/resolve", async ({ res, query }) => {
    const phone = query.get("phone")?.trim() || null;
    const { resolveProfileContextForChannel } = await import(
      "../../db/agentProfiles.js"
    );
    const ctx = resolveProfileContextForChannel(
      getStateDb(),
      "sms",
      phone,
    );
    sendJson(res, 200, {
      channel_kind: "sms",
      channel_identity: phone,
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
  addRoute("GET", "/api/v1/channels/sms/status", async ({ res, query }) => {
    const paths = resolveSmsProfile(query);
    let envMap: Record<string, string> = {};
    let envErr: string | null = null;
    try {
      envMap = await readProfileEnv(paths);
    } catch (e) {
      envErr = e instanceof Error ? e.message : String(e);
    }
    const sid = envMap.TWILIO_ACCOUNT_SID ?? "";
    const token = envMap.TWILIO_AUTH_TOKEN ?? "";
    const phone = envMap.TWILIO_PHONE_NUMBER ?? "";
    const allowed = envMap.SMS_ALLOWED_USERS ?? "";
    const allowAll = (envMap.SMS_ALLOW_ALL_USERS ?? "").toLowerCase() === "true";
    const configured = Boolean(sid && token && phone);

    if (envErr) {
      sendJson(res, 200, {
        configured: false,
        state: "error",
        error: `profile env: ${envErr}`,
        phone_number: null,
        account_sid_masked: null,
        allowed_users: "",
        allow_all: false,
      } satisfies SmsStatus);
      return;
    }
    if (!configured) {
      sendJson(res, 200, {
        configured: false,
        state: "unconfigured",
        error: null,
        phone_number: null,
        account_sid_masked: null,
        allowed_users: "",
        allow_all: false,
      } satisfies SmsStatus);
      return;
    }

    // Probe Twilio. If the creds are rejected, surface as error state so the
    // UI shows "Credentials rejected" rather than a perpetual "starting"
    // spinner. Mirrors slack.ts::slackAuthTest's role.
    const probe = await probeTwilioAccount(sid, token);
    if (!probe.ok) {
      sendJson(res, 200, {
        configured: true,
        state: "error",
        error: probe.error ?? "Twilio rejected the credentials",
        phone_number: phone,
        account_sid_masked: maskAccountSid(sid),
        allowed_users: allowed,
        allow_all: allowAll,
      } satisfies SmsStatus);
      return;
    }

    sendJson(res, 200, {
      configured: true,
      state: "configured_running",
      error: null,
      phone_number: phone,
      account_sid_masked: maskAccountSid(sid),
      allowed_users: allowed,
      allow_all: allowAll,
    } satisfies SmsStatus);
  });

  // PUT /allowlist — set SMS_ALLOWED_USERS + SMS_ALLOW_ALL_USERS without
  // re-validating credentials. Lets the UI toggle inbound-sender policy
  // independently from a credential rotation.
  addRoute(
    "PUT",
    "/api/v1/channels/sms/allowlist",
    async ({ res, body, query }) => {
      const paths = resolveSmsProfile(query);
      const b = (body ?? {}) as Record<string, unknown>;
      const allowAll = b.allow_all === true;
      let allowedUsers: string | null = null;
      if (!allowAll) {
        const raw = typeof b.allowed_users === "string" ? b.allowed_users.trim() : "";
        if (raw) {
          const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
          for (const p of parts) {
            if (!E164_RE.test(p)) {
              throw new ValidationError(
                `allowed_users must be comma-separated E.164 numbers — "${p}" is not`,
              );
            }
          }
          allowedUsers = parts.join(",");
        }
      }
      await writeProfileEnvKeys(paths, {
        SMS_ALLOWED_USERS: allowedUsers,
        SMS_ALLOW_ALL_USERS: allowAll ? "true" : null,
      });
      restartHermes();
      sendJson(res, 200, { ok: true, allow_all: allowAll, allowed_users: allowedUsers ?? "" });
    },
  );

  // PUT /credentials — validate against Twilio + vault upsert (3 items) +
  // .env upsert (4 keys) + debounced hermes restart.
  addRoute(
    "PUT",
    "/api/v1/channels/sms/credentials",
    async ({ res, body, query }) => {
      const paths = resolveSmsProfile(query);
      try {
        assertWritableProfile(getStateDb(), paths.profileSlug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }
    const b = (body ?? {}) as Record<string, unknown>;

    const sid = typeof b.account_sid === "string" ? b.account_sid.trim() : "";
    const token = typeof b.auth_token === "string" ? b.auth_token.trim() : "";
    const phone =
      typeof b.phone_number === "string" ? b.phone_number.trim() : "";
    if (!ACCOUNT_SID_RE.test(sid)) {
      throw new ValidationError(
        "account_sid must be a Twilio Account SID (AC + 32 lowercase hex chars)",
      );
    }
    if (!AUTH_TOKEN_RE.test(token)) {
      throw new ValidationError(
        "auth_token must be 32 lowercase hex chars (Twilio Auth Token)",
      );
    }
    if (!E164_RE.test(phone)) {
      throw new ValidationError(
        "phone_number must be E.164 (e.g. +15551234567)",
      );
    }
    let allowedUsers: string | null = null;
    if (typeof b.allowed_users === "string") {
      const trimmed = b.allowed_users.trim();
      if (trimmed) {
        const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
        for (const p of parts) {
          if (!E164_RE.test(p)) {
            throw new ValidationError(
              `allowed_users must be comma-separated E.164 numbers — "${p}" is not`,
            );
          }
        }
        allowedUsers = parts.join(",");
      } else {
        allowedUsers = null;
      }
    }

    // Validate the creds against Twilio. Anything but 2xx is a 400.
    const probe = await probeTwilioAccount(sid, token);
    if (!probe.ok) {
      sendJson(res, 400, {
        ok: false,
        error: probe.error ?? "Twilio rejected the credentials",
      });
      return;
    }

    // Vaultwarden = canonical store. All three items must succeed before we
    // touch the .env so a vault outage doesn't leave the .env half-saved.
    const itemNames = smsVaultItemNames(paths.profileSlug);
    await upsertVaultItem(itemNames.sid, sid);
    await upsertVaultItem(itemNames.token, token);
    await upsertVaultItem(itemNames.phone, phone);

    const updates: Partial<Record<SmsEnvKey, string | null>> = {
      TWILIO_ACCOUNT_SID: sid,
      TWILIO_AUTH_TOKEN: token,
      TWILIO_PHONE_NUMBER: phone,
      // Persist the two webhook bind variables alongside credentials so the
      // SMS adapter doesn't silently refuse to start (SMS_WEBHOOK_URL is
      // mandatory) or bind to 127.0.0.1 (the SMS_WEBHOOK_HOST default,
      // unreachable from sibling compose containers — Caddy → hermes:8080
      // would 502). Idempotent: existing operator-set values still take
      // precedence because writeProfileEnvKeys is a merge, not a replace.
      SMS_WEBHOOK_URL: smsWebhookUrl() || null,
      SMS_WEBHOOK_HOST: "0.0.0.0",
    };
    if (typeof b.allowed_users === "string") {
      updates.SMS_ALLOWED_USERS = allowedUsers;
    }
      await writeProfileEnvKeys(paths, updates);
      appendAudit({
        action_type: "channel_token_set",
        actor: "principal",
        source: "channels/sms/credentials",
        target_path: "channels/sms/credentials",
        target_kind: "channel",
        subject_ref: paths.profileSlug,
        summary: `SMS credentials set on profile '${paths.profileSlug}'`,
        payload: { profile_slug: paths.profileSlug, channel_kind: "sms" },
      });
      // Drop the probe cache so /status reflects the new creds immediately.
      _accountProbeCache = null;
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

  // DELETE /credentials — wipe all 3 vault items, drop all 4 env keys, restart.
  addRoute(
    "DELETE",
    "/api/v1/channels/sms/credentials",
    async ({ res, query }) => {
      const paths = resolveSmsProfile(query);
      try {
        assertWritableProfile(getStateDb(), paths.profileSlug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }
      const itemNames = smsVaultItemNames(paths.profileSlug);
      await deleteVaultItem(itemNames.sid);
      await deleteVaultItem(itemNames.token);
      await deleteVaultItem(itemNames.phone);
      await writeProfileEnvKeys(paths, {
        TWILIO_ACCOUNT_SID: null,
        TWILIO_AUTH_TOKEN: null,
        TWILIO_PHONE_NUMBER: null,
        SMS_ALLOWED_USERS: null,
      });
      appendAudit({
        action_type: "channel_token_cleared",
        actor: "principal",
        source: "channels/sms/credentials",
        target_path: "channels/sms/credentials",
        target_kind: "channel",
        subject_ref: paths.profileSlug,
        summary: `SMS credentials cleared on profile '${paths.profileSlug}'`,
        payload: { profile_slug: paths.profileSlug, channel_kind: "sms" },
      });
      _accountProbeCache = null;
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

  // POST /test — send a real test message via Twilio. Target: the first
  // entry in SMS_ALLOWED_USERS, mirroring smsSend()'s default recipient.
  addRoute("POST", "/api/v1/channels/sms/test", async ({ res, query }) => {
    const paths = resolveSmsProfile(query);
    const env = await readProfileEnv(paths).catch(
      () => ({}) as Record<string, string>,
    );
    const sid = env.TWILIO_ACCOUNT_SID ?? "";
    const token = env.TWILIO_AUTH_TOKEN ?? "";
    const from = env.TWILIO_PHONE_NUMBER ?? "";
    if (!sid || !token || !from) {
      throw new ValidationError(
        "sms is not configured (no Twilio creds in the hermes profile)",
      );
    }
    const allowed = (env.SMS_ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length === 0) {
      sendJson(res, 200, {
        ok: false,
        error:
          "no recipient — set SMS_ALLOWED_USERS (comma-separated E.164) so the test knows where to send",
      });
      return;
    }
    const to = allowed[0];
    const r = await twilioSendMessage(sid, token, from, to, "Alfred SMS test");
    if (r.ok && r.sid) {
      sendJson(res, 200, {
        ok: true,
        sid: r.sid,
        to,
        sent_at: new Date().toISOString(),
      });
    } else {
      sendJson(res, 200, { ok: false, error: r.error });
    }
  });
}
