// #120 Lane Vb — per-profile voice channel routes (/api/v1/channels/voice/*).
//
// Sir's spec: "voice MUST be per profile. it isn't realistic that I would
// interact with multiple profiles and want them in separate channels."
//
// Lane V's Voice card was a partial — voice-bridge stayed a single compose
// sibling per VM, and Twilio creds + OpenAI key lived in the compose .env.
// Lane Vb wires per-profile routing on top: the container stays singular,
// but its Twilio webhook + WSS handler resolve the profile slug at call
// time, and each profile owns its own Twilio number + creds in its own
// /hermes-state/profiles/<slug>/.env.
//
// Routes:
//   GET    /api/v1/channels/voice/status?profile=<slug>      — per-profile config snapshot
//   PUT    /api/v1/channels/voice/credentials?profile=<slug> — set Twilio + (optional) OpenAI creds
//   DELETE /api/v1/channels/voice/credentials?profile=<slug> — wipe per-profile creds
//   POST   /api/v1/channels/voice/test?profile=<slug>        — validate creds via Twilio probe
//   PUT    /api/v1/channels/voice/allowlist?profile=<slug>   — per-profile caller allowlist
//   POST   /api/v1/channels/voice/inbound                    — Twilio webhook landing pad
//                                                              (mock TwiML emitter — Sir's
//                                                              actual Twilio number points
//                                                              at voice-bridge/twiml/inbound;
//                                                              this route is for smoke/test
//                                                              + future routing decisions)
//
// PER-PROFILE .env keys (mirror sms.ts):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VOICE_FROM_NUMBER
//   OPENAI_API_KEY (optional — falls back to main's if blank)
//
// We intentionally use TWILIO_VOICE_FROM_NUMBER (not TWILIO_PHONE_NUMBER)
// so a profile can have a separate voice number from its SMS number. When
// only TWILIO_PHONE_NUMBER is set (SMS configured but voice not separately),
// /status surfaces the SMS number as the calling_number (back-compat with
// Lane I's single-number assumption).
//
// FAIL-SOFT POLICY. /status MUST NOT 5xx — the dashboard polls it.
//
// AUDIT contract: every mutation appends a row with profile_slug in the
// payload. action_type uses canonical underscore form
// (channel_token_set / channel_token_cleared) so Lane V's audit queries
// keep finding voice writes the same way they find telegram / sms ones.

import fs from "node:fs";

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import {
  dockerExec,
  dockerExecWithStdin,
  dockerComposeCmd,
  HERMES_CONTAINER,
  COMPOSE_DIR,
} from "../helpers.js";
import { getStateDb } from "../../db/state.js";
import {
  resolveProfileForChannel,
  assertWritableProfile,
} from "../../db/agentProfiles.js";
import { appendAudit } from "./state.js";
import { restartProfile } from "../../hermes/supervisor.js";

// Path INSIDE the hermes runtime container. HERMES_HOME=/hermes-state in
// docker-compose; profiles live at $HERMES_HOME/profiles/<name>/.
const HERMES_HOME = process.env.HERMES_HOME_IN_CONTAINER || "/hermes-state";

// The compose service we're probing.
const VOICE_COMPOSE_SERVICE = "voice-bridge";

// ── Per-profile path resolution (mirrors sms.ts/telegram.ts) ─────────────

interface VoiceProfilePaths {
  profileSlug: string;
  profileDir: string;
  envPath: string;
}

function pathsForProfile(slug: string): VoiceProfilePaths {
  const profileDir = `${HERMES_HOME}/profiles/${slug}`;
  return {
    profileSlug: slug,
    profileDir,
    envPath: `${profileDir}/.env`,
  };
}

function resolveVoiceProfile(query?: URLSearchParams): VoiceProfilePaths {
  const explicit = query?.get("profile")?.trim() || null;
  if (explicit) return pathsForProfile(explicit);
  // Defensive: in tests the state.db isn't always available, and the
  // resolveProfileForChannel default of "main" is the same shape we want
  // anyway when no explicit profile is given. Surface "main" on any DB
  // miss rather than 5xx-ing the /status route the dashboard polls.
  try {
    const slug = resolveProfileForChannel(getStateDb(), "voice", null);
    return pathsForProfile(slug);
  } catch {
    return pathsForProfile("main");
  }
}

// ── Twilio shapes (mirror sms.ts) ────────────────────────────────────────

const ACCOUNT_SID_RE = /^AC[a-f0-9]{32}$/;
const AUTH_TOKEN_RE = /^[a-f0-9]{32}$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;
// OpenAI keys start with sk-; relaxed shape so future formats (sk-proj-…)
// keep validating. Reject anything with whitespace as a clear typo.
const OPENAI_KEY_RE = /^sk-[A-Za-z0-9_-]{20,}$/;

type VoiceState =
  | "unconfigured"
  | "configured_starting"
  | "configured_running"
  | "error";

interface VoiceStatus {
  configured: boolean;
  state: VoiceState;
  error: string | null;
  calling_number: string | null;
  account_sid_masked: string | null;
  /** True iff per-profile OPENAI_API_KEY is in the profile's .env. UI surfaces
   *  a hint when missing (voice falls back to main's key). */
  openai_key_set: boolean;
  /** True iff this is the 'main' profile and the compose-level .env still
   *  carries OPENAI_API_KEY. For non-main profiles always false (compose .env
   *  is shared instance state — not a profile-scoped surface). */
  openai_key_set_compose: boolean;
  compose_service_exists: boolean;
  allowed_callers: string;
  allow_all: boolean;
  webhook_url: string | null;
  profile_slug: string;
}

// ── Per-profile .env reader + writer (mirror sms.ts shape) ───────────────

const VOICE_ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_VOICE_FROM_NUMBER",
  "OPENAI_API_KEY",
  "VOICE_ALLOWED_CALLERS",
  "VOICE_ALLOW_ALL_CALLERS",
] as const;
type VoiceEnvKey = (typeof VOICE_ENV_KEYS)[number];

async function readProfileEnv(
  paths: VoiceProfilePaths,
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
  paths: VoiceProfilePaths,
  updates: Partial<Record<VoiceEnvKey, string | null>>,
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
      const v = updates[key as VoiceEnvKey];
      if (v === null || v === undefined) continue; // drop
      out.push(`${key}=${v}`);
      continue;
    }
    out.push(line);
  }
  for (const k of VOICE_ENV_KEYS) {
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

// ── Compose-level .env reader (back-compat for main's OPENAI_API_KEY) ────
//
// Pre-Lane-Vb voice-bridge read OPENAI_API_KEY from the compose .env via
// env_file. We keep reading it for main's status so the existing
// "configure OpenAI on /channels" UI doesn't regress. Non-main profiles
// MUST set their own per-profile OPENAI key — the compose-level value is
// instance-shared state, not a profile-scoped surface.

function readComposeEnvKey(key: string): string {
  const composeDir = process.env.COMPOSE_DIR ?? COMPOSE_DIR;
  const path = `${composeDir}/.env`;
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch {
    return "";
  }
  for (const line of raw.split("\n")) {
    const t = line.replace(/^﻿/, "");
    if (!t || t.trimStart().startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    if (k !== key) continue;
    let v = t.slice(eq + 1);
    if (v.endsWith("\r")) v = v.slice(0, -1);
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    return v.trim();
  }
  return "";
}

// ── Compose probe (unchanged from Lane I) ────────────────────────────────

interface ComposePsRow {
  Name?: string;
  Service?: string;
  State?: string;
  Health?: string;
}

interface ComposeProbe {
  exists: boolean;
  row: ComposePsRow | null;
  error: string | null;
}

function looksLikeNoSuchService(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("no such service") ||
    (m.includes("service ") && m.includes(" not found")) ||
    m.includes("has no service")
  );
}

async function probeComposeService(): Promise<ComposeProbe> {
  let raw: string;
  try {
    raw = await dockerComposeCmd([
      "ps",
      VOICE_COMPOSE_SERVICE,
      "--format",
      "json",
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (looksLikeNoSuchService(msg)) {
      return { exists: false, row: null, error: null };
    }
    return { exists: false, row: null, error: `compose ps failed: ${msg}` };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { exists: false, row: null, error: null };
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as ComposePsRow | ComposePsRow[];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows) {
        if (!row.Service || row.Service === VOICE_COMPOSE_SERVICE) {
          return { exists: true, row, error: null };
        }
      }
    } catch {
      // not JSON — fall through
    }
  }
  return { exists: true, row: null, error: null };
}

async function tailVoiceBridgeLogs(): Promise<string> {
  try {
    const raw = await dockerComposeCmd([
      "logs",
      "--tail",
      "20",
      "--no-color",
      VOICE_COMPOSE_SERVICE,
    ]);
    return raw.trim();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ── Twilio account probe (mirror sms.ts) ─────────────────────────────────

function basicAuth(sid: string, token: string): string {
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

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
  let r: Response;
  try {
    r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
      {
        method: "GET",
        headers: { Authorization: basicAuth(sid, token) },
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch (e) {
    const result: TwilioAccountProbe = {
      ...empty,
      error: `Twilio unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
    _accountProbeCache = { sid, token, result, at: now };
    return result;
  }
  if (r.status === 200) {
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      /* ignore */
    }
    const result: TwilioAccountProbe = {
      ok: true,
      friendly_name:
        typeof body?.friendly_name === "string" ? body.friendly_name : null,
      status: typeof body?.status === "string" ? body.status : null,
      error: null,
    };
    _accountProbeCache = { sid, token, result, at: now };
    return result;
  }
  let result: TwilioAccountProbe;
  try {
    const j = await r.json();
    result = {
      ok: false,
      friendly_name: null,
      status: null,
      error: j.message ?? `Twilio returned HTTP ${r.status}`,
    };
  } catch {
    result = {
      ok: false,
      friendly_name: null,
      status: null,
      error: `Twilio returned HTTP ${r.status}`,
    };
  }
  _accountProbeCache = { sid, token, result, at: now };
  return result;
}

// ── Mask + webhook URL helpers ───────────────────────────────────────────

function maskAccountSid(sid: string): string {
  if (sid.length < 6) return "AC" + "*".repeat(Math.max(0, sid.length - 2));
  const last4 = sid.slice(-4);
  const middleLen = sid.length - 2 - 4;
  return "AC" + "*".repeat(Math.max(4, middleLen)) + last4;
}

/** Twilio "A CALL COMES IN" webhook the principal pastes into the Twilio
 *  Console for a profile-specific number. Voice-bridge's /twiml/inbound
 *  reads `?profile=<slug>` and emits the appropriate per-profile TwiML.
 *  Empty when DOMAIN isn't set (single-VM bring-up). */
function voiceWebhookUrl(slug: string): string {
  const dom = (process.env.DOMAIN || "").trim();
  if (!dom) return "";
  return `https://voice.${dom}/twiml/inbound?profile=${encodeURIComponent(slug)}`;
}

// ── Restart Hermes (used as a fallback path; voice-bridge itself does NOT
//    need a restart — it reads creds on every inbound call) ───────────────

function restartVoiceBridge(): void {
  // Voice-bridge reads per-profile creds via ctrl-api on every inbound call
  // (see voice-bridge/src/tenant.ts) — no env baked in. So credential writes
  // do NOT require a voice-bridge restart. We intentionally do NOT fire a
  // compose restart here; restartProfile() drops the per-profile flag and
  // the next inbound call picks up the new creds.
}
void restartVoiceBridge;

// ── Routes ────────────────────────────────────────────────────────────────

export function registerVoiceRoutes(): void {
  // GET /resolve?to=<E.164> — Lane Vb debug surface, mirrors sms /resolve.
  // Lets the principal verify which profile a Twilio "To" number resolves to.
  addRoute("GET", "/api/v1/channels/voice/resolve", async ({ res, query }) => {
    const toNumber = query.get("to")?.trim() || null;
    const { resolveProfileContextForChannel } = await import(
      "../../db/agentProfiles.js"
    );
    const ctx = resolveProfileContextForChannel(
      getStateDb(),
      "voice",
      toNumber,
    );
    sendJson(res, 200, {
      channel_kind: "voice",
      channel_identity: toNumber,
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
  // Accepts ?profile=<slug>; defaults to the default binding for voice.
  addRoute("GET", "/api/v1/channels/voice/status", async ({ res, query }) => {
    const paths = resolveVoiceProfile(query);
    const probe = await probeComposeService();

    let envMap: Record<string, string> = {};
    let envErr: string | null = null;
    try {
      envMap = await readProfileEnv(paths);
    } catch (e) {
      envErr = e instanceof Error ? e.message : String(e);
    }

    const sid = envMap.TWILIO_ACCOUNT_SID ?? "";
    const token = envMap.TWILIO_AUTH_TOKEN ?? "";
    // Prefer the voice-specific from-number; fall back to TWILIO_PHONE_NUMBER
    // (the SMS one) so a profile with SMS configured but no separate voice
    // number still surfaces the calling number.
    const voiceFrom = envMap.TWILIO_VOICE_FROM_NUMBER ?? "";
    const smsFrom = envMap.TWILIO_PHONE_NUMBER ?? "";
    const phone = voiceFrom || smsFrom;
    const allowedCallers = envMap.VOICE_ALLOWED_CALLERS ?? "";
    const allowAll =
      (envMap.VOICE_ALLOW_ALL_CALLERS ?? "").toLowerCase() === "true";

    const openaiKeySetProfile = (envMap.OPENAI_API_KEY ?? "").length > 0;
    const openaiKeySetCompose =
      paths.profileSlug === "main"
        ? readComposeEnvKey("OPENAI_API_KEY").length > 0
        : false;
    const openaiKeySet = openaiKeySetProfile || openaiKeySetCompose;
    const webhook_url = voiceWebhookUrl(paths.profileSlug) || null;

    const baseFields = {
      calling_number: phone || null,
      account_sid_masked: sid ? maskAccountSid(sid) : null,
      compose_service_exists: probe.exists,
      openai_key_set: openaiKeySetProfile,
      openai_key_set_compose: openaiKeySetCompose,
      allowed_callers: allowedCallers,
      allow_all: allowAll,
      webhook_url,
      profile_slug: paths.profileSlug,
    } as const;

    if (envErr) {
      sendJson(res, 200, {
        configured: false,
        state: "error",
        error: `profile env: ${envErr}`,
        ...baseFields,
      } satisfies VoiceStatus);
      return;
    }

    // Case 1: voice-bridge service isn't deployed on this VM yet.
    if (!probe.exists && probe.error === null) {
      sendJson(res, 200, {
        configured: false,
        state: "unconfigured",
        error: null,
        ...baseFields,
      } satisfies VoiceStatus);
      return;
    }

    // Case 1b: compose itself failed (not "no such service").
    if (probe.error !== null) {
      sendJson(res, 200, {
        configured: false,
        state: "error",
        error: probe.error,
        ...baseFields,
      } satisfies VoiceStatus);
      return;
    }

    const configured = Boolean(sid && token && phone);

    if (!configured) {
      sendJson(res, 200, {
        configured: false,
        state: "unconfigured",
        error: null,
        ...baseFields,
      } satisfies VoiceStatus);
      return;
    }

    if (!openaiKeySet) {
      // Configured-but-no-OpenAI: surface as unconfigured so the UI shows the
      // inline OpenAI input rather than a perpetual spinner.
      sendJson(res, 200, {
        configured: true,
        state: "unconfigured",
        error: null,
        ...baseFields,
      } satisfies VoiceStatus);
      return;
    }

    // Configured + has an OpenAI key — pivot on container Health / State.
    const health = (probe.row?.Health ?? "").toLowerCase();
    const state = (probe.row?.State ?? "").toLowerCase();

    let voiceState: VoiceState;
    let error: string | null = null;

    if (health === "healthy" || (health === "" && state === "running")) {
      voiceState = "configured_running";
    } else if (
      health === "starting" ||
      state === "starting" ||
      state === "restarting" ||
      state === "created"
    ) {
      voiceState = "configured_starting";
    } else {
      voiceState = "error";
      const tail = await tailVoiceBridgeLogs();
      error = tail
        ? tail.slice(-2000)
        : `voice-bridge state=${state || "unknown"} health=${health || "unknown"}`;
    }

    sendJson(res, 200, {
      configured: true,
      state: voiceState,
      error,
      ...baseFields,
    } satisfies VoiceStatus);
  });

  // PUT /credentials — set Twilio + (optional) OpenAI creds on the profile's .env.
  addRoute(
    "PUT",
    "/api/v1/channels/voice/credentials",
    async ({ res, body, query }) => {
      const paths = resolveVoiceProfile(query);
      try {
        assertWritableProfile(getStateDb(), paths.profileSlug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }
      const b = (body ?? {}) as Record<string, unknown>;

      const sid = typeof b.account_sid === "string" ? b.account_sid.trim() : "";
      const token = typeof b.auth_token === "string" ? b.auth_token.trim() : "";
      const fromNumber =
        typeof b.from_number === "string" ? b.from_number.trim() : "";
      const openaiKey =
        typeof b.openai_key === "string" ? b.openai_key.trim() : "";

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
      if (!E164_RE.test(fromNumber)) {
        throw new ValidationError(
          "from_number must be E.164 (e.g. +15551234567)",
        );
      }
      if (openaiKey && !OPENAI_KEY_RE.test(openaiKey)) {
        throw new ValidationError(
          "openai_key must look like an OpenAI key (sk-…); leave blank to inherit main's key",
        );
      }

      // Twilio probe — confirm the creds are valid before writing. Skip
      // when ?skip_validate=true is set (smoke + ops dry-run path; the
      // operator takes responsibility for the creds in that case). Default
      // is probe-on so a typo doesn't silently land a broken cred in the
      // profile's .env.
      const skipValidate = query.get("skip_validate") === "true";
      if (!skipValidate) {
        const probe = await probeTwilioAccount(sid, token);
        if (!probe.ok) {
          sendJson(res, 400, {
            ok: false,
            error: probe.error ?? "Twilio rejected the credentials",
          });
          return;
        }
      }

      const updates: Partial<Record<VoiceEnvKey, string | null>> = {
        TWILIO_ACCOUNT_SID: sid,
        TWILIO_AUTH_TOKEN: token,
        TWILIO_VOICE_FROM_NUMBER: fromNumber,
      };
      if (openaiKey) {
        updates.OPENAI_API_KEY = openaiKey;
      }

      await writeProfileEnvKeys(paths, updates);
      appendAudit({
        action_type: "channel_token_set",
        actor: "principal",
        source: "channels/voice/credentials",
        target_path: "channels/voice/credentials",
        target_kind: "channel",
        subject_ref: paths.profileSlug,
        summary: `Voice credentials set on profile '${paths.profileSlug}'`,
        payload: {
          profile_slug: paths.profileSlug,
          channel_kind: "voice",
          openai_key_set: Boolean(openaiKey),
        },
      });
      _accountProbeCache = null;

      // Voice-bridge does NOT need a restart — it reads creds via ctrl-api on
      // every inbound call. We still drop a per-profile restart flag so
      // observers (Lane V tests + supervisor reconcile) see the credential
      // rotation as a profile-scoped event. The 'noop' scope is the right
      // wire shape: no gateway needs to bounce.
      const restart = restartProfile(paths.profileSlug, {
        allowComposeFallback: false,
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

  // DELETE /credentials — wipe the 3 Twilio keys + the optional OpenAI key.
  // Compose-level OPENAI_API_KEY (main's instance-shared key) is NOT touched.
  addRoute(
    "DELETE",
    "/api/v1/channels/voice/credentials",
    async ({ res, query }) => {
      const paths = resolveVoiceProfile(query);
      try {
        assertWritableProfile(getStateDb(), paths.profileSlug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }
      await writeProfileEnvKeys(paths, {
        TWILIO_ACCOUNT_SID: null,
        TWILIO_AUTH_TOKEN: null,
        TWILIO_VOICE_FROM_NUMBER: null,
        OPENAI_API_KEY: null,
      });
      appendAudit({
        action_type: "channel_token_cleared",
        actor: "principal",
        source: "channels/voice/credentials",
        target_path: "channels/voice/credentials",
        target_kind: "channel",
        subject_ref: paths.profileSlug,
        summary: `Voice credentials cleared on profile '${paths.profileSlug}'`,
        payload: { profile_slug: paths.profileSlug, channel_kind: "voice" },
      });
      _accountProbeCache = null;
      const restart = restartProfile(paths.profileSlug, {
        allowComposeFallback: false,
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

  // POST /test — probe Twilio with the profile's stored creds. Cheap (no
  // outbound call placed); confirms account_sid + auth_token are valid.
  addRoute("POST", "/api/v1/channels/voice/test", async ({ res, query }) => {
    const paths = resolveVoiceProfile(query);
    const env = await readProfileEnv(paths).catch(
      () => ({}) as Record<string, string>,
    );
    const sid = env.TWILIO_ACCOUNT_SID ?? "";
    const token = env.TWILIO_AUTH_TOKEN ?? "";
    if (!sid || !token) {
      throw new ValidationError(
        "voice is not configured (no Twilio creds in the hermes profile)",
      );
    }
    const probe = await probeTwilioAccount(sid, token);
    if (probe.ok) {
      sendJson(res, 200, {
        ok: true,
        account_sid_masked: maskAccountSid(sid),
        friendly_name: probe.friendly_name,
        status: probe.status,
        tested_at: new Date().toISOString(),
      });
    } else {
      sendJson(res, 200, {
        ok: false,
        error: probe.error ?? "Twilio rejected the credentials",
      });
    }
  });

  // PUT /allowlist — per-profile caller allowlist (VOICE_ALLOWED_CALLERS /
  // VOICE_ALLOW_ALL_CALLERS) written to the profile's .env. voice-bridge's
  // TwiML responder reads these per-call (resolves the profile from the
  // ?profile= query, then reads its .env keys).
  addRoute(
    "PUT",
    "/api/v1/channels/voice/allowlist",
    async ({ res, body, query }) => {
      const paths = resolveVoiceProfile(query);
      try {
        assertWritableProfile(getStateDb(), paths.profileSlug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }
      const b = (body ?? {}) as Record<string, unknown>;
      const allowAll = b.allow_all === true;
      let allowedCallers: string | null = null;
      if (!allowAll) {
        const raw =
          typeof b.allowed_callers === "string"
            ? b.allowed_callers.trim()
            : "";
        if (raw) {
          const parts = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          for (const p of parts) {
            if (!E164_RE.test(p)) {
              throw new ValidationError(
                `allowed_callers must be comma-separated E.164 numbers — "${p}" is not`,
              );
            }
          }
          allowedCallers = parts.join(",");
        }
      }
      await writeProfileEnvKeys(paths, {
        VOICE_ALLOWED_CALLERS: allowedCallers,
        VOICE_ALLOW_ALL_CALLERS: allowAll ? "true" : null,
      });
      appendAudit({
        action_type: "channel_settings_updated",
        actor: "principal",
        source: "channels/voice/allowlist",
        target_path: "channels/voice/allowlist",
        target_kind: "channel",
        subject_ref: paths.profileSlug,
        summary: `Voice allowlist updated on profile '${paths.profileSlug}'`,
        payload: {
          profile_slug: paths.profileSlug,
          channel_kind: "voice",
          allow_all: allowAll,
        },
      });
      sendJson(res, 200, {
        ok: true,
        allow_all: allowAll,
        allowed_callers: allowedCallers ?? "",
        profile: paths.profileSlug,
      });
    },
  );

  // GET /internal/openai-key?profile=<slug> — voice-bridge-only.
  //
  // The bridge calls this on every inbound call to learn which OPENAI_API_KEY
  // to use for the Realtime session. ctrl-api's auth.ts allowlist scopes the
  // VOICE_BRIDGE bearer to this exact pathname; any other caller 401s. The
  // pre-Vb behaviour stays — the boot-time OPENAI key in voice-bridge's env
  // is the fallback when this returns null (e.g. non-main profile without
  // its own key).
  addRoute(
    "GET",
    "/api/v1/channels/voice/internal/openai-key",
    async ({ res, query }) => {
      const paths = resolveVoiceProfile(query);
      const env = await readProfileEnv(paths).catch(
        () => ({}) as Record<string, string>,
      );
      const key = env.OPENAI_API_KEY?.trim() || null;
      // Non-main profiles intentionally do NOT inherit the compose-level
      // key here — voice-bridge already has it from its boot env and uses
      // it as the fallback. Returning null is the signal to use the
      // fallback. Main returns the compose key as a back-compat path so
      // the pre-Vb deployment with OPENAI_API_KEY in the compose .env keeps
      // working without re-pasting the key into main's per-profile .env.
      let resolvedKey = key;
      if (!resolvedKey && paths.profileSlug === "main") {
        const composeKey = readComposeEnvKey("OPENAI_API_KEY");
        if (composeKey) resolvedKey = composeKey;
      }
      sendJson(res, 200, {
        profile: paths.profileSlug,
        openai_api_key: resolvedKey,
      });
    },
  );

  // POST /inbound — Twilio webhook landing pad + routing decision endpoint.
  //
  // In production the principal points Twilio at
  //   https://voice.<domain>/twiml/inbound?profile=<slug>
  // which lands on voice-bridge directly (faster TwiML, no extra hop).
  //
  // This ctrl-api route exists for THREE reasons:
  //   1. Smoke testing — assert the routing decision without Twilio.
  //   2. Operators who'd rather configure ctrl-api as the webhook and
  //      have ctrl-api emit TwiML (one less surface to remember).
  //   3. Future routing decisions that need state.db access (allow-
  //      list lookups, per-To dispatch) before reaching voice-bridge.
  //
  // Accepts:
  //   - ?profile=<slug> (preferred, explicit)
  //   - OR form field "To"=<E.164> → resolved via channel_profile_binding
  //   - OR no hint → falls back to main
  // Returns TwiML that points at voice-bridge's WSS endpoint with the
  // resolved profile slug embedded in the path.
  addRoute("POST", "/api/v1/channels/voice/inbound", async ({ req, res, body, query }) => {
    // Twilio POSTs application/x-www-form-urlencoded. ctrl-api's default
    // body parser short-circuits on non-JSON, so `body` arrives as undefined
    // for the wire shape Twilio actually sends. Read the raw body inline
    // here when body is undefined; otherwise accept JSON (smoke tests POST
    // JSON for clarity).
    let toNumber: string | null = null;
    let fromNumber: string | null = null;
    let callSid: string | null = null;

    const contentType = (req.headers?.["content-type"] as string | undefined) ?? "";
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.To === "string") toNumber = b.To;
      if (typeof b.From === "string") fromNumber = b.From;
      if (typeof b.CallSid === "string") callSid = b.CallSid;
    } else if (typeof body === "string") {
      const params = new URLSearchParams(body);
      toNumber = params.get("To");
      fromNumber = params.get("From");
      callSid = params.get("CallSid");
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      // Drain the raw body — parseBody bailed on the non-JSON content-type.
      const raw = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", reject);
      });
      const params = new URLSearchParams(raw);
      toNumber = params.get("To");
      fromNumber = params.get("From");
      callSid = params.get("CallSid");
    }

    // Resolve the profile. Precedence:
    //   1. explicit ?profile=<slug> in the URL (Sir's chosen routing key)
    //   2. binding lookup by Twilio "To" form field
    //   3. main (default)
    const explicit = query.get("profile")?.trim() || null;
    let resolved: string;
    let resolvedBy: "query" | "to-binding" | "default";
    if (explicit) {
      resolved = explicit;
      resolvedBy = "query";
    } else if (toNumber) {
      const bound = resolveProfileForChannel(getStateDb(), "voice", toNumber);
      resolved = bound;
      resolvedBy = "to-binding";
    } else {
      resolved = resolveProfileForChannel(getStateDb(), "voice", null);
      resolvedBy = "default";
    }

    // Build the TwiML response. Voice-bridge's WSS handler will read the
    // profile slug from the path segment.
    const domain = (process.env.DOMAIN || "").trim();
    const wssHost = domain ? `voice.${domain}` : "voice.example";
    const wssUrl = `wss://${wssHost}/voice/${encodeURIComponent(resolved)}`;
    const escapedTo = (toNumber ?? "").replace(/[&<>"']/g, (c) =>
      c === "&"
        ? "&amp;"
        : c === "<"
          ? "&lt;"
          : c === ">"
            ? "&gt;"
            : c === '"'
              ? "&quot;"
              : "&apos;",
    );
    const escapedFrom = (fromNumber ?? "").replace(/[&<>"']/g, (c) =>
      c === "&"
        ? "&amp;"
        : c === "<"
          ? "&lt;"
          : c === ">"
            ? "&gt;"
            : c === '"'
              ? "&quot;"
              : "&apos;",
    );

    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      "<Response>\n" +
      "  <Connect>\n" +
      `    <Stream url="${wssUrl}">\n` +
      `      <Parameter name="profile" value="${resolved}"/>\n` +
      `      <Parameter name="from" value="${escapedFrom}"/>\n` +
      `      <Parameter name="to" value="${escapedTo}"/>\n` +
      "    </Stream>\n" +
      "  </Connect>\n" +
      "</Response>\n";

    // Smoke endpoints want a JSON view. Default = TwiML XML (so Sir CAN
    // point Twilio at this endpoint). Toggle via Accept header or ?format=
    // (smoke tests pass ?format=json).
    const wantsJson =
      query.get("format") === "json" ||
      (req.headers?.["accept"] as string | undefined)?.includes(
        "application/json",
      );
    if (wantsJson) {
      sendJson(res, 200, {
        ok: true,
        resolved_profile: resolved,
        resolved_by: resolvedBy,
        wss_url: wssUrl,
        twiml,
        twilio: { To: toNumber, From: fromNumber, CallSid: callSid },
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(twiml);
  });
}
