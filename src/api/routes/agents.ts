import { spawn } from "node:child_process";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { execAsync, dockerExec, OPENCLAW_CMD } from "../helpers.js";

const CONFIG_PATH = "/mnt/encrypted/alfred/config.yaml";

const AGENTS = [
  { id: "main", label: "Alfred", description: "Default agent for device interactions", agentDir: "/home/node/.openclaw/agents/main/agent" },
  { id: "vault-curator", label: "Curator", description: "Processes inbox into structured vault records", agentDir: "/home/node/.openclaw/agents/vault-curator/agent" },
  { id: "vault-janitor", label: "Janitor", description: "Fixes structural vault issues", agentDir: "/home/node/.openclaw/agents/vault-janitor/agent" },
  { id: "vault-distiller", label: "Distiller", description: "Extracts latent knowledge from records", agentDir: "/home/node/.openclaw/agents/vault-distiller/agent" },
];

/** Read config.yaml via Python's yaml module and return parsed JSON. */
async function readConfig(): Promise<Record<string, any>> {
  const script = `
import yaml, json, sys
try:
    with open("${CONFIG_PATH}") as f:
        data = yaml.safe_load(f) or {}
    print(json.dumps(data))
except FileNotFoundError:
    print("{}")
    sys.exit(0)
except Exception as e:
    print(json.dumps({"_error": str(e)}))
    sys.exit(1)
`.trim();
  const { stdout } = await execAsync("python3", ["-c", script]);
  const parsed = JSON.parse(stdout.trim());
  if (parsed._error) throw new Error(parsed._error);
  return parsed;
}

/** Write config back to config.yaml via Python, piping JSON through stdin. */
async function writeConfig(config: Record<string, any>): Promise<void> {
  const configJson = JSON.stringify(config);
  const script = [
    "import yaml, json, sys",
    "config = json.loads(sys.stdin.read())",
    `with open("${CONFIG_PATH}", "w") as f:`,
    "    yaml.dump(config, f, default_flow_style=False, sort_keys=False, allow_unicode=True)",
  ].join("\n");

  return new Promise<void>((resolve, reject) => {
    const proc = spawn("python3", ["-c", script], { timeout: 10_000 });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`python3 write failed (${code}): ${stderr}`));
      else resolve();
    });
    proc.on("error", reject);
    proc.stdin.write(configJson);
    proc.stdin.end();
  });
}

interface AgentModelStatus {
  defaultModel?: string;
  resolvedDefault?: string;
  fallbacks?: string[];
  auth?: {
    providers?: Array<{ provider: string; status: string; source?: string }>;
    missingProvidersInUse?: string[];
  };
}

/** Query OpenClaw for a single agent's model status. */
async function getAgentModelStatus(agentDef: typeof AGENTS[number]): Promise<Record<string, any>> {
  try {
    const raw = await dockerExec("openclaw", [...OPENCLAW_CMD, "models", "status", "--agent", agentDef.id, "--json"]);
    const status: AgentModelStatus = JSON.parse(raw.trim());
    return {
      id: agentDef.id,
      label: agentDef.label,
      description: agentDef.description,
      defaultModel: status.defaultModel || null,
      resolvedDefault: status.resolvedDefault || status.defaultModel || null,
      fallbacks: status.fallbacks || [],
      providers: status.auth?.providers || [],
      missingProviders: status.auth?.missingProvidersInUse || [],
    };
  } catch (err: any) {
    // Agent may not exist yet or openclaw may be down
    return {
      id: agentDef.id,
      label: agentDef.label,
      description: agentDef.description,
      defaultModel: null,
      resolvedDefault: null,
      fallbacks: [],
      providers: [],
      missingProviders: [],
      error: err.message?.slice(0, 200),
    };
  }
}

/** Get surveyor config from config.yaml. */
function getSurveyorConfig(config: Record<string, any>): Record<string, any> {
  const surveyor = config.surveyor || {};
  return {
    labeler_model: surveyor.openrouter?.model || "x-ai/grok-4.1-fast",
    embedder_model: surveyor.ollama?.model || "nomic-embed-text",
    embedder_source: surveyor.ollama?.api_key ? "openrouter" : "ollama",
  };
}

export function registerAgentRoutes(): void {
  // GET /api/v1/admin/agents — lightweight agent list (no docker exec)
  addRoute("GET", "/api/v1/admin/agents", async ({ res }) => {
    const config = await readConfig();

    sendJson(res, 200, {
      agents: AGENTS.map((a) => ({
        id: a.id,
        label: a.label,
        description: a.description,
      })),
      surveyor: getSurveyorConfig(config),
    });
  });

  // GET /api/v1/admin/agents/:agentId — single agent's full model status
  addRoute("GET", "/api/v1/admin/agents/:agentId", async ({ res, params }) => {
    const { agentId } = params;

    // Surveyor is config-based, no docker exec needed
    if (agentId === "surveyor") {
      const config = await readConfig();
      sendJson(res, 200, getSurveyorConfig(config));
      return;
    }

    const agentDef = AGENTS.find((a) => a.id === agentId);
    if (!agentDef) {
      throw new ValidationError(
        `Unknown agent: ${agentId}. Known agents: ${AGENTS.map((a) => a.id).join(", ")}, surveyor`,
      );
    }

    const status = await getAgentModelStatus(agentDef);
    sendJson(res, 200, status);
  });

  // PATCH /api/v1/admin/agents/:agentId/model — set model for an agent
  addRoute("PATCH", "/api/v1/admin/agents/:agentId/model", async ({ res, params, body }) => {
    const { agentId } = params;
    const b = body as Record<string, any> | undefined;
    if (!b || typeof b.model !== "string" || !b.model.trim()) {
      throw new ValidationError("Request body must include a non-empty 'model' string");
    }
    const model = b.model.trim();

    // Handle surveyor separately — it's config.yaml, not OpenClaw
    if (agentId === "surveyor") {
      const config = await readConfig();
      if (!config.surveyor) config.surveyor = {};

      // Determine which field to update based on a hint or default to labeler
      if (b.field === "embedder_model") {
        if (!config.surveyor.ollama) config.surveyor.ollama = {};
        config.surveyor.ollama.model = model;
      } else {
        if (!config.surveyor.openrouter) config.surveyor.openrouter = {};
        config.surveyor.openrouter.model = model;
      }

      await writeConfig(config);

      sendJson(res, 200, {
        message: `Surveyor ${b.field === "embedder_model" ? "embedder" : "labeler"} model updated to ${model}`,
        surveyor: getSurveyorConfig(config),
      });
      return;
    }

    // Validate it's a known OpenClaw agent
    const agentDef = AGENTS.find((a) => a.id === agentId);
    if (!agentDef) {
      throw new ValidationError(`Unknown agent: ${agentId}. Known agents: ${AGENTS.map((a) => a.id).join(", ")}, surveyor`);
    }

    // Set model via OpenClaw CLI with OPENCLAW_AGENT_DIR env var
    await dockerExec("openclaw", [...OPENCLAW_CMD, "models", "set", model], {
      OPENCLAW_AGENT_DIR: agentDef.agentDir,
    });

    // Return optimistic response — reading back immediately would race
    // against OpenClaw's async config flush and return stale data.
    sendJson(res, 200, {
      message: `Model for ${agentDef.label} updated to ${model}`,
      agent: {
        id: agentDef.id,
        label: agentDef.label,
        description: agentDef.description,
        defaultModel: model,
        resolvedDefault: model,
        fallbacks: [],
        providers: [],
        missingProviders: [],
      },
    });
  });
}
