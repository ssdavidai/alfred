// Lane I — voice-bridge deploy-readiness status route.
//
//   GET /api/v1/channels/voice/status
//
// A read-only status endpoint for the Phase-2 voice card. There is NO
// PUT / DELETE / test on this surface — voice doesn't have its own
// credentials, it reuses the SMS configuration (specifically
// TWILIO_PHONE_NUMBER from the hermes-main per-profile .env). The whole
// point of the route is to tell the dashboard whether the voice-bridge
// container is deployed-and-healthy on this VM, so the redesigned
// /channels card knows whether to show "Voice not deployed yet" or
// "Voice connected, calling number +1…".
//
// Resolution table (frozen contract from the Phase-2 spec):
//
//   compose_service_exists=false                           → state="unconfigured"
//   compose_service_exists=true  && !configured           → state="unconfigured"
//   compose_service_exists=true  && configured && healthy → state="configured_running"
//   compose_service_exists=true  && configured && starting → state="configured_starting"
//   compose_service_exists=true  && configured && unhealthy → state="error"
//
// `configured`     = TWILIO_PHONE_NUMBER is set in the hermes-main /.env.
// `calling_number` = the value of TWILIO_PHONE_NUMBER (reuses SMS).
//
// FAIL-SOFT POLICY: /status MUST NOT 5xx — the dashboard polls it. On any
// upstream failure return state:"error" with the message in `error`. The
// "voice-bridge service missing from compose" case specifically is NOT an
// error — it's the expected pre-deploy state (Phase-2 orchestrator hasn't
// merged the compose change yet), so it MUST resolve to state="unconfigured"
// with error=null.

import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";
import { dockerExec, dockerComposeCmd } from "../helpers.js";

// Hermes-main per-profile .env path INSIDE the hermes runtime container.
// Mirrors the SMS / Telegram routes — `HERMES_HOME=/hermes-state` is the
// canonical mount in docker-compose.yaml.
const HERMES_CONTAINER = "hermes";
const HERMES_HOME = process.env.HERMES_HOME_IN_CONTAINER || "/hermes-state";
const MAIN_PROFILE_DIR = `${HERMES_HOME}/profiles/main`;
const PROFILE_ENV_PATH = `${MAIN_PROFILE_DIR}/.env`;

// The compose service we're probing.
const VOICE_COMPOSE_SERVICE = "voice-bridge";

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
  compose_service_exists: boolean;
}

// ── Compose probe ─────────────────────────────────────────────────────────
//
// `docker compose ps <service> --format json` is the canonical way to ask
// "is this service in the project?". Compose ≥ v2.21 returns JSONL (one
// JSON object per service); older compose throws "no such service" with
// non-zero exit. We tolerate both:
//   * throw                → service missing
//   * empty stdout         → service missing
//   * stdout with a JSON line → service present, parse State/Health

interface ComposePsRow {
  Name?: string;
  Service?: string;
  State?: string;   // "running" / "exited" / "restarting" / "created" / "starting"
  Health?: string;  // "healthy" / "unhealthy" / "starting" / "" / undefined
}

interface ComposeProbe {
  exists: boolean;
  row: ComposePsRow | null;
  // `error` is set ONLY when the compose CLI errored AND the message did
  // not look like "no such service". Genuinely-missing services return
  // exists=false / error=null.
  error: string | null;
}

function looksLikeNoSuchService(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("no such service") ||
    m.includes("service ") && m.includes(" not found") ||
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
    // Genuine compose failure — surface it as an error so the UI can
    // distinguish "voice-bridge not deployed" from "compose itself is
    // broken".
    return { exists: false, row: null, error: `compose ps failed: ${msg}` };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    // Newer compose: empty stdout = service not in this project.
    return { exists: false, row: null, error: null };
  }
  // JSONL (newer compose) — one object per line. Find the voice-bridge row.
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as ComposePsRow | ComposePsRow[];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows) {
        if (
          !row.Service ||
          row.Service === VOICE_COMPOSE_SERVICE
        ) {
          return { exists: true, row, error: null };
        }
      }
    } catch {
      // not JSON — fall through
    }
  }
  // Stdout had content but nothing we could parse as a row — treat as
  // present-but-opaque so we don't false-negative the deploy check.
  return { exists: true, row: null, error: null };
}

// ── Per-profile .env reader (mirrors telegram.ts / sms.ts) ────────────────
//
// We read TWILIO_PHONE_NUMBER from the same source SMS uses so the voice
// card surfaces the same number — Twilio routes inbound voice + SMS to the
// same E.164 by default, no separate voice-number provisioning needed.

async function readProfileEnvKey(key: string): Promise<string> {
  let raw: string;
  try {
    raw = await dockerExec(HERMES_CONTAINER, [
      "sh",
      "-c",
      `cat ${PROFILE_ENV_PATH} 2>/dev/null || true`,
    ]);
  } catch {
    // The hermes container is missing too — we can still answer the
    // question, just with no creds. Treat as "not configured".
    return "";
  }
  for (const line of raw.split("\n")) {
    const t = line.replace(/^﻿/, ""); // strip BOM if any
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
    return v;
  }
  return "";
}

// ── Container logs tail (for state="error" details) ───────────────────────

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

// ── Route ─────────────────────────────────────────────────────────────────

export function registerVoiceRoutes(): void {
  // GET /status — fail-soft. NEVER 5xx (dashboard polls it).
  addRoute("GET", "/api/v1/channels/voice/status", async ({ res }) => {
    const probe = await probeComposeService();

    // Case 1: voice-bridge service isn't deployed on this VM yet. This is
    // the "Phase-2 orchestrator hasn't merged the compose change" state —
    // benign, NOT an error. The UI surfaces a "Voice not deployed" card.
    if (!probe.exists && probe.error === null) {
      sendJson(res, 200, {
        configured: false,
        state: "unconfigured",
        error: null,
        calling_number: null,
        compose_service_exists: false,
      } satisfies VoiceStatus);
      return;
    }

    // Case 1b: compose itself failed (not "no such service"). Surface as
    // error so the operator knows the probe is broken.
    if (probe.error !== null) {
      sendJson(res, 200, {
        configured: false,
        state: "error",
        error: probe.error,
        calling_number: null,
        compose_service_exists: false,
      } satisfies VoiceStatus);
      return;
    }

    // Service exists — resolve credentials + container health.
    const phone = (await readProfileEnvKey("TWILIO_PHONE_NUMBER")).trim();
    const configured = phone.length > 0;

    if (!configured) {
      // Deployed but no Twilio number yet — UI shows "Configure SMS first".
      sendJson(res, 200, {
        configured: false,
        state: "unconfigured",
        error: null,
        calling_number: null,
        compose_service_exists: true,
      } satisfies VoiceStatus);
      return;
    }

    // Configured — pivot on container Health / State.
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
      // unhealthy / exited / dead / unknown
      voiceState = "error";
      const tail = await tailVoiceBridgeLogs();
      // Prefer the logs tail when we have one — operator-actionable. Fall
      // back to a synthetic message if logs were empty.
      error = tail
        ? tail.slice(-2000)
        : `voice-bridge state=${state || "unknown"} health=${health || "unknown"}`;
    }

    sendJson(res, 200, {
      configured: true,
      state: voiceState,
      error,
      calling_number: phone,
      compose_service_exists: true,
    } satisfies VoiceStatus);
  });
}
