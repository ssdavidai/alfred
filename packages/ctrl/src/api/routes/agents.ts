import { spawn } from "node:child_process";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { execAsync, dockerExec, dockerComposeCmd, OPENCLAW_CMD } from "../helpers.js";

const CONFIG_PATH = "/mnt/encrypted/alfred/config.yaml";

const AGENTS = [
  { id: "main", label: "Alfred", description: "Default agent for device interactions", agentDir: "/home/node/.openclaw/agents/main/agent" },
  { id: "learn-clerk", label: "Clerk", description: "Stateless LLM worker for learning workflows", agentDir: "/home/node/.openclaw/agents/learn-clerk/agent" },
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

const OPENCLAW_JSON = "/home/node/.openclaw/openclaw.json";

/** Read per-agent model from openclaw.json, then enrich with live provider auth. */
async function getAgentModelStatus(agentDef: typeof AGENTS[number]): Promise<Record<string, any>> {
  try {
    // Read model from openclaw.json (source of truth for per-agent config)
    const readScript = [
      "import json",
      `d = json.load(open("${OPENCLAW_JSON}"))`,
      `aid = "${agentDef.id}"`,
      "agents = d.get('agents', {}).get('list', [])",
      "defaults = d.get('agents', {}).get('defaults', {}).get('model', {})",
      "agent_model = None",
      "for a in agents:",
      "  if a.get('id') == aid:",
      "    m = a.get('model')",
      "    agent_model = m.get('primary') if isinstance(m, dict) else m",
      "    break",
      "print(json.dumps({'model': agent_model, 'default': defaults.get('primary')}))",
    ].join("\n");
    const modelResult = await dockerExec("openclaw", ["python3", "-c", readScript]);
    const modelInfo = JSON.parse(modelResult.trim());

    const agentModel = modelInfo.model || modelInfo.default || null;

    // Try to get live provider auth status (non-critical)
    let providers: any[] = [];
    let missingProviders: string[] = [];
    try {
      const raw = await dockerExec("openclaw", [...OPENCLAW_CMD, "models", "status", "--agent", agentDef.id, "--json"]);
      const status: AgentModelStatus = JSON.parse(raw.trim());
      providers = status.auth?.providers || [];
      missingProviders = status.auth?.missingProvidersInUse || [];
    } catch {
      // OpenClaw may be starting up
    }

    return {
      id: agentDef.id,
      label: agentDef.label,
      description: agentDef.description,
      defaultModel: agentModel,
      resolvedDefault: agentModel,
      fallbacks: [],
      providers,
      missingProviders,
    };
  } catch (err: any) {
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

    // Directly patch openclaw.json to set the per-agent model.
    // `openclaw models set` only sets the global default, not per-agent.
    const patchScript = [
      "import json, sys, shutil",
      `p = "${OPENCLAW_JSON}"`,
      "d = json.load(open(p))",
      `aid = "${agentDef.id}"`,
      `model = "${model}"`,
      "agents = d.get('agents', {}).get('list', [])",
      "found = False",
      "for a in agents:",
      "  if a.get('id') == aid:",
      "    a['model'] = {'primary': model}",
      "    found = True",
      "    break",
      "if not found:",
      "  print(json.dumps({'error': f'Agent {aid} not found in openclaw.json'}))",
      "  sys.exit(1)",
      "# Also update the global defaults so sessions_spawn uses the right model",
      "defaults = d.get('agents', {}).get('defaults', {})",
      "if 'model' not in defaults: defaults['model'] = {}",
      "defaults['model']['primary'] = model",
      "d.setdefault('agents', {})['defaults'] = defaults",
      "shutil.copy2(p, p + '.bak')",
      "with open(p, 'w') as f:",
      "  json.dump(d, f, indent=2)",
      "print(json.dumps({'ok': True, 'agent': aid, 'model': model}))",
    ].join("\n");

    const patchResult = await dockerExec("openclaw", ["python3", "-c", patchScript]);
    const parsed = JSON.parse(patchResult.trim());
    if (parsed.error) {
      throw new ValidationError(parsed.error);
    }

    // Restart OpenClaw to pick up the new model config
    try {
      await dockerComposeCmd(["restart", "openclaw"]);
    } catch {
      // Best effort — gateway may pick up changes on next request
    }

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

  // POST /api/v1/agents/main/task
  //
  // Submit a one-shot task to the main Alfred agent and (by default)
  // deliver his reply to his configured channel (Slack/Telegram/etc.).
  //
  // Under the hood this creates an openclaw cron job with `--at <Ns>` +
  // `--delete-after-run`: the job fires almost immediately, runs on an
  // isolated main-agent session with Alfred's full workspace bootstrapped
  // (all skills + TOOLS.md injected), and self-deletes. The main
  // agent's model, memory, and channel bindings are used natively — no
  // subagent, no workers clerk, no re-routing. The same path `openclaw
  // cron add` uses from the CLI.
  //
  // Used by platform code that needs Alfred to DO something on its
  // behalf and (optionally) tell Sir about the result. Today: the daily
  // morning briefing chore — Temporal fires at 05:30 CET, chore
  // workflow calls this endpoint with a task like "deliver the morning
  // briefing per the alfred-daily-briefing skill", Alfred runs the
  // skill, posts to Slack.
  //
  // Body:
  //   task:        string   required — the prompt Alfred sees
  //   channel?:    string   default "last" (the agent's most-recent
  //                         active channel). "slack" / "telegram" /
  //                         etc. to force a specific one.
  //   at_seconds?: number   default 1 — seconds from now before fire.
  //   name?:       string   default "agent-task-<ts>-<rand>".
  //   announce?:   boolean  default true. false = run silently (no
  //                         delivery; used when the agent's job is
  //                         background work that shouldn't DM Sir).
  addRoute("POST", "/api/v1/agents/main/task", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.task !== "string" || !(b.task as string).trim()) {
      throw new ValidationError("task is required (non-empty string)");
    }
    const task = b.task as string;
    const channel = typeof b.channel === "string" && (b.channel as string).length > 0
      ? (b.channel as string)
      : "last";
    const atSeconds = typeof b.at_seconds === "number" && (b.at_seconds as number) > 0
      ? Math.floor(b.at_seconds as number)
      : 1;
    const announce = b.announce !== false;
    const jobName = typeof b.name === "string" && (b.name as string).length > 0
      ? (b.name as string)
      : `agent-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const args = [
      ...OPENCLAW_CMD,
      "cron", "add",
      "--name", jobName,
      "--agent", "main",
      "--at", `${atSeconds}s`,
      "--delete-after-run",
      "--message", task,
      "--best-effort-deliver",
      "--json",
    ];
    if (announce) {
      args.push("--announce", "--channel", channel);
    } else {
      args.push("--no-deliver");
    }

    try {
      const stdout = await dockerExec("openclaw", args);
      let envelope: unknown = null;
      try {
        envelope = JSON.parse(stdout.trim() || "{}");
      } catch {
        envelope = { raw: stdout.trim().slice(0, 2000) };
      }
      sendJson(res, 202, {
        status: "scheduled",
        name: jobName,
        channel: announce ? channel : null,
        at_seconds: atSeconds,
        job: envelope,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { status: "error", error: message });
    }
  });
}
