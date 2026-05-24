// Settings endpoints — persist principal-facing live↔shadow toggles into a
// single JSON file at /alfred-data/settings.json (override via ALFRED_DATA_DIR
// for tests).
//
// This started life as the Gap-3b endpoint for `signal_action_mode` alone. It
// has since grown to cover the wider family of mode flags Lane II's resolvers
// look at (sir-matter-task #5). The registry below is the single place where
// new flags get wired up — adding one means listing its env var, default, and
// the valid value set. Endpoints and tests follow automatically.
//
// Today's consumers:
//   - signal_action_mode     → Lane II's _resolve_signal_action_mode
//                              (env STEWARD_SIGNAL_ACTION_LIVE_MODE)
//   - state_mutator_mode     → Lane II Fix C (env STEWARD_LIVE_MODE)
//   - auto_task_create_mode  → Lane II Fix D (env STEWARD_SIGNAL_AUTOCREATE_TASKS)
//
// Read precedence (mirrors Lane II's resolvers):
//   1. env <ENV_VAR>           — operator override, wins always
//   2. settings.json `<key>`   — principal-chosen, set via the SaaS dashboard
//   3. registered default
//
// Endpoints:
//   GET  /api/v1/settings        → { <key>: ResolvedMode, ... } for every key
//   GET  /api/v1/settings/:key   → single ResolvedMode
//   PUT  /api/v1/settings/:key   → body { mode } → writes settings.json
//
//   Legacy: GET/PUT /api/v1/settings/signal-action-mode (hyphenated)
//   is kept as an alias for /api/v1/settings/signal_action_mode so Lane III's
//   already-deployed UI keeps working.
//
// Write strategy: temp file + atomic rename. No real lockfile — this API is
// single-process (one ctrl-api per tenant) and the temp+rename pair guarantees
// the reader never sees a torn JSON. Read-modify-write so unrelated keys
// already in settings.json are preserved across writes.
import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

const DATA_DIR = process.env.ALFRED_DATA_DIR || "/alfred-data";

/** Absolute path to the settings file. Exported for tests; the file is
 *  not required to exist — GET tolerates a missing file. */
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

type Mode = "live" | "shadow";
type Source = "default" | "settings_file" | "env_override";

interface KeyConfig {
  env_var: string;
  default: Mode;
  valid: readonly Mode[];
}

/** The single registry of supported settings keys. Add new flags here. */
const SETTINGS_KEYS = {
  signal_action_mode: {
    env_var: "STEWARD_SIGNAL_ACTION_LIVE_MODE",
    default: "live",
    valid: ["live", "shadow"],
  },
  state_mutator_mode: {
    env_var: "STEWARD_LIVE_MODE",
    default: "live",
    valid: ["live", "shadow"],
  },
  auto_task_create_mode: {
    env_var: "STEWARD_SIGNAL_AUTOCREATE_TASKS",
    default: "live",
    valid: ["live", "shadow"],
  },
} as const satisfies Record<string, KeyConfig>;

type RegisteredKey = keyof typeof SETTINGS_KEYS;

interface ResolvedMode {
  mode: Mode;
  source: Source;
  env_override_active: boolean;
}

/** Normalise the URL param: accept both hyphenated (legacy `signal-action-mode`)
 *  and underscored (canonical `signal_action_mode`) forms. Lookup is then a
 *  simple `key in SETTINGS_KEYS` check. */
function normaliseKey(raw: string): string {
  return raw.replace(/-/g, "_");
}

function isRegisteredKey(k: string): k is RegisteredKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_KEYS, k);
}

function isValidValue(key: RegisteredKey, v: unknown): v is Mode {
  const cfg = SETTINGS_KEYS[key];
  return typeof v === "string" && (cfg.valid as readonly string[]).includes(v);
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

/** Resolve one key's effective mode with the three-level precedence. */
function resolveKey(
  key: RegisteredKey,
  settings: Record<string, unknown>,
): ResolvedMode {
  const cfg = SETTINGS_KEYS[key];
  const envRaw = process.env[cfg.env_var];
  if (envRaw !== undefined && envRaw !== "") {
    const envMode = envRaw.trim().toLowerCase();
    if ((cfg.valid as readonly string[]).includes(envMode)) {
      return {
        mode: envMode as Mode,
        source: "env_override",
        env_override_active: true,
      };
    }
    // Env present but garbage — treat as no override (and warn).
    console.warn(
      `[settings] ${cfg.env_var}=${envRaw} is not one of ${cfg.valid.join("|")}; ignoring`,
    );
  }
  const fileVal = settings[key];
  if ((cfg.valid as readonly string[]).includes(fileVal as string)) {
    return {
      mode: fileVal as Mode,
      source: "settings_file",
      env_override_active: false,
    };
  }
  return { mode: cfg.default, source: "default", env_override_active: false };
}

function resolveAll(): Record<RegisteredKey, ResolvedMode> {
  const settings = readSettings();
  const out = {} as Record<RegisteredKey, ResolvedMode>;
  for (const k of Object.keys(SETTINGS_KEYS) as RegisteredKey[]) {
    out[k] = resolveKey(k, settings);
  }
  return out;
}

export function registerSettingsRoutes(): void {
  // ── Combined view ───────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/settings", async ({ res }) => {
    sendJson(res, 200, resolveAll());
  });

  // ── Per-key GET (canonical + hyphenated alias) ──────────────────────────
  addRoute("GET", "/api/v1/settings/:key", async ({ res, params }) => {
    const key = normaliseKey(params.key);
    if (!isRegisteredKey(key)) {
      throw new ValidationError(
        `unknown settings key ${JSON.stringify(params.key)}; known: ${Object.keys(SETTINGS_KEYS).join(", ")}`,
      );
    }
    sendJson(res, 200, resolveKey(key, readSettings()));
  });

  // ── Per-key PUT (canonical + hyphenated alias) ──────────────────────────
  addRoute("PUT", "/api/v1/settings/:key", async ({ res, params, body }) => {
    const key = normaliseKey(params.key);
    if (!isRegisteredKey(key)) {
      throw new ValidationError(
        `unknown settings key ${JSON.stringify(params.key)}; known: ${Object.keys(SETTINGS_KEYS).join(", ")}`,
      );
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const requested = b.mode;
    if (!isValidValue(key, requested)) {
      throw new ValidationError(
        `mode must be one of ${SETTINGS_KEYS[key].valid.join("|")} for key '${key}', got ${JSON.stringify(requested)}`,
      );
    }
    const current = readSettings();
    // Preserve any other keys (other toggles + Gap-3b legacy content).
    current[key] = requested;
    writeSettings(current);
    sendJson(res, 200, resolveKey(key, current));
  });
}
