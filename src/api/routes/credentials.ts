import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerComposeCmd, COMPOSE_DIR } from "../helpers.js";

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

/** Write key-value map back to .env. */
function writeEnv(env: Record<string, string>): void {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf-8");
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

    const env = readEnv();

    for (const [key, value] of Object.entries(b)) {
      if (value === null) {
        delete env[key];
      } else {
        if (typeof value !== "string") {
          throw new ValidationError(`Value for ${key} must be a string or null`);
        }
        env[key] = value;
      }
    }

    writeEnv(env);

    // Restart containers that read env vars for provider auth
    await dockerComposeCmd(["up", "-d", "alfred", "openclaw"]);

    sendJson(res, 200, {
      message: "Credentials updated",
      restarted: ["alfred", "openclaw"],
    });
  });
}
