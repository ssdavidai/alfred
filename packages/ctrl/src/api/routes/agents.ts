import { spawn } from "node:child_process";
import fs from "node:fs";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { execAsync, dockerExec, dockerComposeCmd, HERMES_CMD, HERMES_CONTAINER } from "../helpers.js";
import { resolveDeliveryTarget } from "../hermes-sessions.js";

// alfred daemon config (the surveyor lives here, not in the Hermes config).
const ALFRED_DATA_DIR = process.env.ALFRED_DATA_DIR ?? "/alfred-data";
const CONFIG_PATH = `${ALFRED_DATA_DIR}/config.yaml`;

// Hermes profile config layout. Hermes resolves all profile state under
// HERMES_HOME (default /opt/data — see packages/hermes/Dockerfile); each
// profile's config.yaml lives at ${HERMES_HOME}/profiles/<profile>/config.yaml.
// ctrl-api reads these files READ-ONLY; the model is changed via the native
// `hermes config set` CLI, never by hand-patching this file.
const HERMES_HOME = process.env.HERMES_HOME ?? "/opt/data";
const HERMES_CONFIG_DIR = process.env.HERMES_CONFIG_DIR ?? `${HERMES_HOME}/profiles`;

/**
 * The agents the dashboard shows. alfred-black runs ONE `hermes` container
 * with two profiles — `main` (user-facing chat) and `workers` (background
 * agents). Hermes has no per-agent model knob; the model is a per-PROFILE
 * setting (`model.default`). So each dashboard "agent" maps to whichever
 * profile actually serves it:
 *   • `main`            → the `main` profile (the live chat surface).
 *   • the four workers  → the `workers` profile — learn-clerk, the vault
 *                          curator/janitor/distiller all run as `/v1/runs`
 *                          sessions against `hermes:18790`. They share the
 *                          `workers` profile model; changing one changes
 *                          all four (a true reflection of the runtime).
 */
const AGENTS = [
  { id: "main", label: "Alfred", description: "Default agent for device interactions", profile: "main" },
  { id: "learn-clerk", label: "Clerk", description: "Stateless LLM worker for learning workflows", profile: "workers" },
  { id: "vault-curator", label: "Curator", description: "Processes inbox into structured vault records", profile: "workers" },
  { id: "vault-janitor", label: "Janitor", description: "Fixes structural vault issues", profile: "workers" },
  { id: "vault-distiller", label: "Distiller", description: "Extracts latent knowledge from records", profile: "workers" },
];

/** Read a Hermes profile's `model.default` from its config.yaml (read-only). */
function readProfileModel(profile: string): string | null {
  try {
    const parsed = yaml.load(
      fs.readFileSync(`${HERMES_CONFIG_DIR}/${profile}/config.yaml`, "utf-8"),
    );
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const m = (parsed as Record<string, any>).model;
      if (m && typeof m === "object" && typeof m.default === "string") {
        return m.default;
      }
      if (typeof m === "string") return m;
    }
  } catch {
    /* missing / unparseable — caller treats null as "unknown" */
  }
  return null;
}

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

/** Resolve an agent's effective model: its profile's `model.default`, read
 *  read-only from the Hermes-owned profile config, enriched with live
 *  provider auth status from the native `hermes` CLI. */
async function getAgentModelStatus(agentDef: typeof AGENTS[number]): Promise<Record<string, any>> {
  // Model is a per-profile setting in Hermes. Read it straight from the
  // profile config.yaml that Hermes owns — no python, no hand-patching.
  const agentModel = readProfileModel(agentDef.profile);

  // Live provider auth status (non-critical). Hermes' `hermes config check`
  // surfaces missing-credential warnings; the model status here is best-effort.
  let providers: any[] = [];
  let missingProviders: string[] = [];
  try {
    const raw = await dockerExec(HERMES_CONTAINER, [
      ...HERMES_CMD, "-p", agentDef.profile, "models", "status", "--json",
    ]);
    const status: AgentModelStatus = JSON.parse(raw.trim());
    providers = status.auth?.providers || [];
    missingProviders = status.auth?.missingProvidersInUse || [];
  } catch {
    // Hermes may be starting up, or this Hermes build has no `models status`
    // subcommand — provider enrichment is optional, the model itself is not.
  }

  return {
    id: agentDef.id,
    label: agentDef.label,
    description: agentDef.description,
    profile: agentDef.profile,
    defaultModel: agentModel,
    resolvedDefault: agentModel,
    fallbacks: [],
    providers,
    missingProviders,
  };
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

    // Validate it's a known Hermes-backed agent.
    const agentDef = AGENTS.find((a) => a.id === agentId);
    if (!agentDef) {
      throw new ValidationError(`Unknown agent: ${agentId}. Known agents: ${AGENTS.map((a) => a.id).join(", ")}, surveyor`);
    }

    // Set the model via Hermes' OWN config CLI — `hermes -p <profile> config
    // set model.default <model>`. Hermes owns config.yaml; `config set` writes
    // it the canonical way (no hand-rolled YAML round-trip, no `.bak` files).
    // The model is a per-PROFILE setting, so this changes every agent the
    // profile serves (all four `workers` agents share one model — see AGENTS).
    try {
      await dockerExec(HERMES_CONTAINER, [
        ...HERMES_CMD, "-p", agentDef.profile, "config", "set", "model.default", model,
      ]);
    } catch (err: any) {
      throw new ValidationError(
        `hermes config set failed for profile ${agentDef.profile}: ${String(err?.message ?? err).slice(0, 200)}`,
      );
    }

    // The `model.default` key is not in Hermes' hot-reload set (only
    // `model.context_length` / `compression.*` reload live), so the gateway
    // must be restarted to pick up the new model. The restart is now driven
    // by a native `hermes config set`, not a hand-edit of config.yaml.
    try {
      await dockerComposeCmd(["restart", HERMES_CONTAINER]);
    } catch {
      // Best effort — gateway may pick up changes on next request.
    }

    sendJson(res, 200, {
      message: `Model for ${agentDef.label} updated to ${model}`,
      agent: {
        id: agentDef.id,
        label: agentDef.label,
        description: agentDef.description,
        profile: agentDef.profile,
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

    // Resolve delivery target. Hermes' `--channel last` doesn't auto-resolve
    // reliably across tenants — it works when Sir has an active recent
    // session on that channel but fails with "Delivering to Slack requires
    // target" when the resolution can't find a prior thread. So we explicitly
    // resolve: if caller passed `to`, use it; else find the most-recent
    // session on the requested channel from the native Hermes gateway session
    // index (sessions.json — see hermes-sessions.ts) and extract its delivery
    // target. Same resolveDeliveryTarget helper /api/v1/notifications uses.
    //
    // This replaced the retired hermes-shim `sessions_list` tool (issue #39).
    let toTarget: string | undefined = typeof b.to === "string" && (b.to as string).length > 0
      ? (b.to as string)
      : undefined;
    // resolveDeliveryTarget enumerates the most-recent session on the
    // requested channel (or any delivery-capable channel when channel is
    // "last") and returns its native chat_id. When the caller asked for
    // "last" and we landed on a concrete channel, re-infer effectiveChannel
    // so the cron job passes both --channel and --to concretely.
    let effectiveChannel = channel;
    if (announce && !toTarget) {
      try {
        const resolved = resolveDeliveryTarget(channel);
        if (resolved) {
          toTarget = resolved.to;
          if (channel === "last") {
            effectiveChannel = resolved.channel;
          }
        }
      } catch {
        /* fall through — hermes cron will error and we'll surface it */
      }
    }

    const args = [
      ...HERMES_CMD,
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
      args.push("--announce", "--channel", effectiveChannel);
      if (toTarget) {
        args.push("--to", toTarget);
      }
    } else {
      args.push("--no-deliver");
    }

    try {
      const stdout = await dockerExec(HERMES_CONTAINER, args);
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
