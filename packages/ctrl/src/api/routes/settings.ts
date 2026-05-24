// Settings endpoints — persist principal-facing toggles into a single
// JSON file at /alfred-data/settings.json (override via ALFRED_DATA_DIR
// for tests).
//
// Today's only consumer is Gap 3b — Lane II's _resolve_mode reads
// `signal_action_mode` from this same file. ctrl owns the write side so
// the SaaS dashboard can flip live↔shadow without shelling onto the box.
//
// Read precedence (mirrors Lane II's _resolve_mode):
//   1. env STEWARD_SIGNAL_ACTION_LIVE_MODE  (operator override, wins always)
//   2. settings.json `signal_action_mode`   (principal-chosen)
//   3. default `"live"`
//
// Write strategy: temp file + atomic rename. No real lockfile — this API
// is single-process (one ctrl-api per tenant) and the temp+rename pair
// guarantees the reader never sees a torn JSON. Other keys in
// settings.json are preserved across writes.
import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

const DATA_DIR = process.env.ALFRED_DATA_DIR || "/alfred-data";

/** Absolute path to the settings file. Exported for tests; the file is
 *  not required to exist — GET tolerates a missing file. */
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const ENV_OVERRIDE = "STEWARD_SIGNAL_ACTION_LIVE_MODE";

type Mode = "live" | "shadow";
type Source = "default" | "settings_file" | "env_override";

function isMode(v: unknown): v is Mode {
  return v === "live" || v === "shadow";
}

interface ResolvedMode {
  mode: Mode;
  source: Source;
  env_override_active: boolean;
}

/** Load the settings file. Missing or malformed → `{}` + warn (so the
 *  endpoint still responds, never 500s on a torn file). */
function readSettings(): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    console.warn(
      `[settings] ${SETTINGS_FILE} did not parse to a JSON object; ignoring`,
    );
    return {};
  } catch (err) {
    console.warn(
      `[settings] ${SETTINGS_FILE} is malformed JSON; falling back to defaults (${(err as Error).message})`,
    );
    return {};
  }
}

/** Atomic write: tmp → rename. Single-writer-process assumption holds for
 *  ctrl-api so a renameSync is sufficient torn-read protection. */
function writeSettings(next: Record<string, unknown>): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmp = SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, SETTINGS_FILE);
}

/** Resolve the effective mode with the three-level precedence. Mirrors
 *  Lane II's _resolve_mode so GET reports exactly what the consumer sees. */
function resolveMode(): ResolvedMode {
  const envRaw = process.env[ENV_OVERRIDE];
  if (envRaw !== undefined && envRaw !== "") {
    const envMode = envRaw.trim().toLowerCase();
    if (isMode(envMode)) {
      return { mode: envMode, source: "env_override", env_override_active: true };
    }
    // Env present but garbage — treat as no override (and let GET say so).
    console.warn(
      `[settings] ${ENV_OVERRIDE}=${envRaw} is not 'live' or 'shadow'; ignoring`,
    );
  }
  const settings = readSettings();
  const fileMode = settings.signal_action_mode;
  if (isMode(fileMode)) {
    return { mode: fileMode, source: "settings_file", env_override_active: false };
  }
  return { mode: "live", source: "default", env_override_active: false };
}

export function registerSettingsRoutes(): void {
  addRoute(
    "GET",
    "/api/v1/settings/signal-action-mode",
    async ({ res }) => {
      sendJson(res, 200, resolveMode());
    },
  );

  addRoute(
    "PUT",
    "/api/v1/settings/signal-action-mode",
    async ({ res, body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const requested = b.mode;
      if (!isMode(requested)) {
        throw new ValidationError(
          `mode must be 'live' or 'shadow', got ${JSON.stringify(requested)}`,
        );
      }
      const current = readSettings();
      // Preserve any other keys (other toggles may share this file).
      current.signal_action_mode = requested;
      writeSettings(current);
      sendJson(res, 200, resolveMode());
    },
  );
}
