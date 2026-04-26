import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerComposeCmd, COMPOSE_DIR } from "../helpers.js";
import { invalidateModelCatalogCache } from "./models.js";

const ENV_PATH = `${COMPOSE_DIR}/.env`;

interface CredentialDef {
  key: string;
  label: string;
  description: string;
  used_by: string[];
}

const KNOWN_CREDENTIALS: CredentialDef[] = [
  {
    key: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    description: "Routes to 200+ models. Primary provider for all OpenClaw agents",
    used_by: ["OpenClaw agents (all)", "Surveyor (labeler)", "Surveyor (embedder, if configured)"],
  },
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    description: "Direct Claude access. Required when using anthropic/ models directly",
    used_by: ["OpenClaw agents (if model requires it)"],
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI",
    description: "GPT-4, GPT-4o, and other OpenAI models",
    used_by: ["OpenClaw agents (if model requires it)"],
  },
  {
    key: "XAI_API_KEY",
    label: "xAI",
    description: "Grok models from xAI",
    used_by: ["OpenClaw agents (if model requires it)"],
  },
  {
    key: "GOOGLE_API_KEY",
    label: "Google",
    description: "Gemini and other Google AI models",
    used_by: ["OpenClaw agents (if model requires it)"],
  },
  {
    key: "KIMI_API_KEY",
    label: "Kimi Code",
    description: "Moonshot Kimi Code subscription. Required for the main agent when set to a kimi/* model (kimi/kimi-code, kimi/k2p5). Get a key at https://platform.moonshot.ai/console/keys",
    used_by: ["OpenClaw agents (if model requires it)"],
  },
];

/** Protected keys that cannot be modified via this endpoint. */
const PROTECTED_KEYS = new Set(["AAS_API_KEY"]);

/** Mask a secret value: show first 8 and last 4 chars. */
function maskValue(value: string): string {
  if (value.length <= 12) return "****";
  return value.slice(0, 8) + "..." + value.slice(-4);
}

/** Read .env file into a key-value map. */
function readEnv(): Record<string, string> {
  let content = "";
  try {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return env;
}

/**
 * Surgically update specific keys in the .env file, preserving all
 * comments, blank lines, ordering, and unrelated keys.
 * Set a value to null to remove that key.
 */
function patchEnv(updates: Record<string, string | null>): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  } catch {
    lines = [];
  }

  const remaining = new Map(Object.entries(updates));

  // Update or remove existing lines
  const result = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!remaining.has(key)) return line;
    const newValue = remaining.get(key);
    remaining.delete(key);
    if (newValue === null) return null; // remove line
    return `${key}=${newValue}`;
  }).filter((line): line is string => line !== null);

  // Append any new keys not already in the file
  for (const [key, value] of remaining) {
    if (value !== null) {
      result.push(`${key}=${value}`);
    }
  }

  // Ensure trailing newline
  const content = result.join("\n");
  fs.writeFileSync(ENV_PATH, content.endsWith("\n") ? content : content + "\n", "utf-8");
}

export function registerCredentialRoutes(): void {
  // GET /api/v1/admin/credentials — list known credentials with masked values
  addRoute("GET", "/api/v1/admin/credentials", async ({ res }) => {
    const env = readEnv();

    const credentials = KNOWN_CREDENTIALS.map((def) => {
      const value = env[def.key];
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        set: !!value,
        masked: value ? maskValue(value) : null,
        used_by: def.used_by,
      };
    });

    sendJson(res, 200, { credentials });
  });

  // PATCH /api/v1/admin/credentials — update credential values
  addRoute("PATCH", "/api/v1/admin/credentials", async ({ res, body }) => {
    const b = body as Record<string, string | null> | undefined;
    if (!b || typeof b !== "object") {
      throw new ValidationError("Request body must be an object of key-value pairs");
    }

    // Validate all keys are known credentials
    const knownKeys = new Set(KNOWN_CREDENTIALS.map((d) => d.key));
    for (const key of Object.keys(b)) {
      if (PROTECTED_KEYS.has(key)) {
        throw new ValidationError(`Cannot modify protected key: ${key}`);
      }
      if (!knownKeys.has(key)) {
        throw new ValidationError(`Unknown credential key: ${key}. Known keys: ${[...knownKeys].join(", ")}`);
      }
    }

    const updates: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(b)) {
      if (value === null) {
        updates[key] = null;
      } else {
        if (typeof value !== "string") {
          throw new ValidationError(`Value for ${key} must be a string or null`);
        }
        updates[key] = value;
      }
    }

    patchEnv(updates);

    // Drop the in-memory model catalog cache so the next GET /admin/models
    // reflects the newly-available (or removed) providers immediately
    // instead of waiting up to an hour for the cache to expire.
    invalidateModelCatalogCache();

    // Respond immediately, then restart only the containers that need
    // the new API keys. CRITICAL: ctrl-api also uses env_file: .env,
    // so `docker compose up -d` would recreate ALL containers including
    // ctrl-api itself — causing a 502 cascade. Instead, selectively
    // recreate only openclaw and alfred using --no-deps to prevent
    // Docker Compose from also recreating their dependencies (ctrl-api).
    sendJson(res, 200, {
      message: "Credentials updated. Services are restarting (may take ~30s).",
      restarted: ["openclaw", "alfred"],
    });

    // Fire-and-forget: recreate only openclaw and alfred with new env.
    // --no-deps prevents Docker from touching ctrl-api or temporal.
    // Sequential: openclaw must be healthy before alfred can start.
    dockerComposeCmd(["up", "-d", "--no-deps", "--force-recreate", "openclaw"]).then(() =>
      dockerComposeCmd(["up", "-d", "--no-deps", "--force-recreate", "alfred"])
    ).catch((err) => {
      console.error("Background container restart failed:", err);
    });
  });
}
