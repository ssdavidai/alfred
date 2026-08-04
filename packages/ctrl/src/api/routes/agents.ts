import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { execAsync, dockerExec, dockerComposeCmd, HERMES_CMD, HERMES_CONTAINER } from "../helpers.js";
import { resolveDeliveryTarget } from "../hermes-sessions.js";
import { getStateDb } from "../../db/state.js";
import {
  ANNOUNCE_DEDUP_WINDOW_MS,
  announceDedupKey,
  checkAnnounceDedup,
} from "../announceDedup.js";



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
 * with THREE profiles (F67):
 *   • `main`    (:18789) — the user-facing conversational chat surface.
 *   • `workers` (:18790) — cheap, high-volume background agents.
 *   • `heavy`   (:18791) — Opus-class heavy reasoning, used sparingly.
 * Hermes has no per-agent model knob; the model is a per-PROFILE setting
 * (`model.default`). So each dashboard "agent" maps to whichever profile
 * actually serves it, and changing a model changes every agent on that profile:
 *   • `main`            → the `main` profile (the live chat surface).
 *   • the four workers  → the `workers` profile — learn-clerk, the vault
 *                          curator/janitor/distiller all run as `/v1/runs`
 *                          sessions against `hermes:18790`. They share the
 *                          `workers` profile model; changing one changes all four.
 *   • onboarding/chore  → the `heavy` profile — onboarding facts/patterns
 *                          reasoning and chore heavy-reasoning run against
 *                          `hermes:18791` (Opus-class, slow/expensive).
 */
const AGENTS = [
  { id: "main", label: "Alfred", description: "Your conversational Alfred on every channel (Slack/Telegram/SMS), with memory", profile: "main" },
  { id: "learn-clerk", label: "Clerk", description: "Event classification/extraction/reflection — cheap, high-volume", profile: "workers" },
  { id: "vault-curator", label: "Curator", description: "Processes inbox into structured vault records", profile: "workers" },
  { id: "vault-janitor", label: "Janitor", description: "Fixes structural vault issues", profile: "workers" },
  { id: "vault-distiller", label: "Distiller", description: "Extracts latent knowledge from records", profile: "workers" },
  { id: "onboarding", label: "Onboarding", description: "Onboarding facts/patterns reasoning — Opus-class, runs once at setup", profile: "heavy" },
  { id: "chore", label: "Chore reasoning", description: "Heavy-reasoning chore execution — Opus-class, used sparingly", profile: "heavy" },
];

/**
 * The three Hermes profiles, in display order. Gateway ports and descriptions
 * are the runtime facts the model-config matrix renders (C17). The agents that
 * ride each profile are derived from the AGENTS catalog by `profile`.
 */
const PROFILES: { id: string; gateway_port: number; description: string }[] = [
  { id: "main", gateway_port: 18789, description: "Your conversational Alfred on every channel (Slack/Telegram/SMS), with memory." },
  { id: "workers", gateway_port: 18790, description: "Clerk (event classification/extraction/reflection), chore execution, surveyor labeling — cheap, high-volume." },
  { id: "heavy", gateway_port: 18791, description: "Onboarding facts/patterns + chore heavy-reasoning — Opus-class, slow and expensive, used sparingly." },
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

// ---------------------------------------------------------------------------
// Tool disposition (Phase B — runtime-flippable DIRECT vs DELEGATED per MCP
// server). Source of truth: state.db.tool_disposition (migration 0014).
//
// Two reads + one mutator drive the surface:
//   * GET  /api/v1/agents/tool-disposition         — dashboard + LLM "what's
//                                                    current?" probe
//   * POST /api/v1/agents/tool-disposition         — Sir/Alfred flip via the
//                                                    dashboard toggle OR the
//                                                    set_tool_disposition MCP
//                                                    tool. Triggers a
//                                                    debounced 10s Hermes
//                                                    restart so a flurry of
//                                                    flips coalesces into a
//                                                    single profile reload.
//   * POST /api/v1/agents/focused-subagent         — the `delegate_to_focused
//                                                    _agent` MCP tool's
//                                                    backing. Spawns a
//                                                    workers-profile session
//                                                    keyed by domain + hash,
//                                                    loads the right skill,
//                                                    returns plain-text.
//
// The 9 known servers mirror migration 0014's seed. Anything outside this
// allowlist is rejected — "files" still needs to be added by migration before
// it can be flipped, etc. ---------------------------------------------------
const KNOWN_MCP_SERVERS = [
  "alfred-ctrl",
  "alfred",
  "sure",
  "plane",
  "vaultwarden",
  "execute",
  "paperclip",
  "hass",
  "files",
] as const;
type KnownServer = (typeof KNOWN_MCP_SERVERS)[number];
const KNOWN_SERVER_SET: ReadonlySet<string> = new Set(KNOWN_MCP_SERVERS);

const VALID_DISPOSITIONS = ["direct", "delegated"] as const;
type Disposition = (typeof VALID_DISPOSITIONS)[number];
const VALID_DISPOSITION_SET: ReadonlySet<string> = new Set(VALID_DISPOSITIONS);

const VALID_UPDATED_BY = ["sir", "alfred", "init"] as const;
const VALID_UPDATED_BY_SET: ReadonlySet<string> = new Set(VALID_UPDATED_BY);

// Debounce window for the Hermes restart triggered after a disposition flip.
// A burst of flips inside this window coalesces into one `docker compose
// restart hermes` invocation (pay the ~10s cost once, not N times).
const HERMES_RESTART_DEBOUNCE_MS = 10_000;
let _hermesRestartTimer: NodeJS.Timeout | null = null;

/** Debounce coalesces flurries into one restart. Pulled out for test mocking. */
function scheduleDebouncedHermesRestart(): void {
  if (_hermesRestartTimer) clearTimeout(_hermesRestartTimer);
  _hermesRestartTimer = setTimeout(() => {
    _hermesRestartTimer = null;
    dockerComposeCmd(["restart", HERMES_CONTAINER]).catch(() => {
      // Best effort — operator can `docker compose restart hermes` manually
      // if needed; the disposition row is already persisted.
    });
  }, HERMES_RESTART_DEBOUNCE_MS);
  // unref so the timer doesn't keep the process alive on test teardown.
  _hermesRestartTimer.unref?.();
}

/** Test hook: cancel any pending debounced restart. */
export function _resetHermesRestartDebounceForTests(): void {
  if (_hermesRestartTimer) {
    clearTimeout(_hermesRestartTimer);
    _hermesRestartTimer = null;
  }
}

/** Test hook: is there a pending restart queued? */
export function _hermesRestartPendingForTests(): boolean {
  return _hermesRestartTimer !== null;
}

// Workers-profile gateway URL (focused-subagent target). The :18790 default
// matches the compose-template binding (see render_hermes.py + helpers.ts's
// HERMES_WORKERS_GATEWAY_URL fallback).
const HERMES_WORKERS_GATEWAY_URL =
  process.env.HERMES_WORKERS_GATEWAY_URL ?? "http://hermes:18790";

/** Wall-clock budget for one focused-agent delegation.
 *
 *  Focused runs are multi-step by design and routinely need more than a
 *  minute. The previous hard 60s cap aborted legitimate work — and reported
 *  the client-side abort as an unreachable gateway, which sent #325 chasing a
 *  gateway that was answering /health in 3ms. Tunable per deployment.
 */
const DELEGATE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HERMES_DELEGATE_TIMEOUT_MS ?? 300_000);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 300_000;
})();

/** Readiness-probe budget before a delegation commits the full timeout (#297).
 *
 *  Set to 0 to disable probing entirely — an escape hatch, so a flaky probe
 *  can never become a new way to refuse work that would have succeeded.
 */
const DELEGATE_PROBE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HERMES_DELEGATE_PROBE_TIMEOUT_MS ?? 3_000);
  if (!Number.isFinite(raw) || raw < 0) return 3_000;
  return raw === 0 ? 0 : Math.max(250, raw);
})();

/** Probe the workers gateway before spending a delegation budget on it.
 *
 *  An unhealthy gateway used to consume the ENTIRE request timeout per
 *  attempt, and callers that fall back to a second delegation compounded
 *  that minute by minute (#297). A sub-second probe converts "hang for the
 *  full budget, then report a misleading error" into "refuse immediately and
 *  say why".
 *
 *  Returns null when the gateway is ready, else a short human reason.
 */
async function probeWorkersGateway(): Promise<string | null> {
  if (DELEGATE_PROBE_TIMEOUT_MS === 0) return null; // probing disabled
  try {
    const resp = await fetch(`${HERMES_WORKERS_GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(DELEGATE_PROBE_TIMEOUT_MS),
    });
    if (!resp.ok) return `workers gateway /health returned ${resp.status}`;
    return null;
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return timedOut
      ? `workers gateway /health did not answer within ${DELEGATE_PROBE_TIMEOUT_MS}ms`
      : `workers gateway unreachable: ${String(err?.message ?? err).slice(0, 160)}`;
  }
}

/** Read API_SERVER_KEY for the workers profile out of its rendered .env.
 *
 *  Same key-resolution pattern as channels_paperclip.ts /
 *  channels_ha.ts / hermes.ts — the /opt/alfred/.env's
 *  HERMES_API_SERVER_KEY is a *seed* for first-boot; render_hermes.py
 *  may regenerate per-profile keys, so the live key lives in
 *  /hermes-state/profiles/workers/.env's API_SERVER_KEY. */
function readWorkersApiKey(): string | null {
  const envPath = `${HERMES_CONFIG_DIR}/workers/.env`;
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf-8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() === "API_SERVER_KEY") {
      return trimmed.slice(eq + 1).trim();
    }
  }
  return null;
}

/** Sanitise an arbitrary string into a session-key-safe slug. */
function _domainSlug(domain: string): string {
  return domain.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "any";
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
  // GET /api/v1/admin/agents — agent list (no docker exec). F68: enrich each
  // entry with `profile` + `default_model` (read read-only from the profile
  // config.yaml) so the model-config matrix can render without N+1 round-trips.
  addRoute("GET", "/api/v1/admin/agents", async ({ res }) => {
    const config = await readConfig();
    // Cache per-profile model reads so we don't re-parse a config.yaml per agent.
    const modelByProfile = new Map<string, string | null>();
    const profileModel = (profile: string): string | null => {
      if (!modelByProfile.has(profile)) modelByProfile.set(profile, readProfileModel(profile));
      return modelByProfile.get(profile) ?? null;
    };

    sendJson(res, 200, {
      agents: AGENTS.map((a) => ({
        id: a.id,
        label: a.label,
        description: a.description,
        profile: a.profile,
        default_model: profileModel(a.profile),
      })),
      surveyor: getSurveyorConfig(config),
    });
  });

  // GET /api/v1/admin/profiles — the model-config matrix source (C17). One
  // round-trip: the three Hermes profiles, each with its model + the agents
  // riding it, plus the surveyor (labeler/embedder).
  addRoute("GET", "/api/v1/admin/profiles", async ({ res }) => {
    const config = await readConfig();
    const profiles = PROFILES.map((p) => {
      const model = readProfileModel(p.id);
      return {
        id: p.id,
        gateway_port: p.gateway_port,
        default_model: model,
        resolved_model: model,
        description: p.description,
        agents: AGENTS.filter((a) => a.profile === p.id).map((a) => ({
          id: a.id,
          label: a.label,
          description: a.description,
        })),
      };
    });
    sendJson(res, 200, { profiles, surveyor: getSurveyorConfig(config) });
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
  //   announce?:   boolean  default FALSE — channel delivery is opt-in
  //                         (#288). It used to default true, which is the
  //                         right default for a principal-facing caller
  //                         ("tell Alfred to post X") and the wrong one for
  //                         every background worker — and nothing here can
  //                         tell the two apart. The vault-janitor's repair
  //                         pipeline spawned one-shots through this route
  //                         and dumped raw failure text into the
  //                         principal's Slack (13 deliveries, 0 silent),
  //                         re-spawning each sweep because the repairs
  //                         could never succeed. Silence-by-convention
  //                         ([SILENT] in the prompt) cannot hold: a failure
  //                         always looks report-worthy, so failures always
  //                         delivered. Callers that genuinely want the
  //                         principal notified now say so explicitly.
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
    // Opt-in, not opt-out (#288). Every shipped caller that wants delivery
    // already passes this explicitly (weekly_money_day.py, the
    // alfred-chore-authoring template); background callers never did.
    const announce = b.announce === true;
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

    // Hermes `cron create` CLI. The retired OpenClaw interface
    // (`cron add --agent/--at/--delete-after-run/--message/--best-effort-deliver
    // /--announce/--channel/--to/--no-deliver/--json`) no longer exists — the
    // current Hermes CLI rejects every one of those flags, so this endpoint
    // (and thus spawn_alfred_task) returned HTTP 500 on every tenant until this
    // fix. Real grammar (identical on 0.14 + 0.17):
    //   hermes -p main cron create <schedule> <prompt> --name <n> --deliver <t>
    // - `schedule` is a POSITIONAL duration string. Sub-minute is unsupported
    //   (`'5s'` → "Invalid schedule"), so the floor is 1m; the old `--at 1s`
    //   "≈immediate" becomes "≈1m" (the smallest one-shot the scheduler takes).
    // - One-shot DURATION jobs auto-remove after firing (no --delete-after-run).
    // - Delivery is a single `--deliver` target: `<platform>:<chat_id>` when
    //   announcing to a resolved channel, `origin` as a fallback, `local` for a
    //   silent background run (no external DM).
    // #416: collapse duplicate announce:true spawns to the same target
    // within the dedup window. Silent spawns bypass this — they never reach
    // the principal, so double-scheduling them is harmless.
    if (announce) {
      const dupKey = announceDedupKey(effectiveChannel, toTarget, task);
      const existing = checkAnnounceDedup(dupKey, jobName);
      if (existing) {
        sendJson(res, 202, {
          status: "deduplicated",
          reason: "an equivalent announce task was scheduled to this channel recently",
          existing_job: existing,
          channel,
          window_seconds: Math.round(ANNOUNCE_DEDUP_WINDOW_MS / 1000),
        });
        return;
      }
    }

    const scheduleMinutes = Math.max(1, Math.ceil(atSeconds / 60));
    const args = [
      ...HERMES_CMD,
      "-p", "main",
      "cron", "create",
      `${scheduleMinutes}m`,
      task,
      "--name", jobName,
    ];
    if (announce) {
      args.push("--deliver", toTarget ? `${effectiveChannel}:${toTarget}` : "origin");
    } else {
      args.push("--deliver", "local");
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

  // ─── Tool disposition (Phase B) ──────────────────────────────────────────
  //
  // GET  /api/v1/agents/tool-disposition           — list all dispositions
  // POST /api/v1/agents/tool-disposition           — flip one server
  // POST /api/v1/agents/focused-subagent           — delegate task to workers

  addRoute("GET", "/api/v1/agents/tool-disposition", async ({ res }) => {
    const db = getStateDb();
    const rows = db
      .prepare(
        "SELECT server, disposition, updated_at, updated_by FROM tool_disposition ORDER BY server",
      )
      .all() as Array<{
        server: string;
        disposition: string;
        updated_at: string;
        updated_by: string | null;
      }>;
    sendJson(res, 200, { dispositions: rows });
  });

  addRoute("POST", "/api/v1/agents/tool-disposition", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.server !== "string") {
      throw new ValidationError("`server` is required (string)");
    }
    if (typeof b.disposition !== "string") {
      throw new ValidationError("`disposition` is required (string)");
    }

    const server = b.server as string;
    const disposition = b.disposition as string;
    const updatedBy = typeof b.updated_by === "string" ? (b.updated_by as string) : "alfred";

    if (!KNOWN_SERVER_SET.has(server)) {
      throw new ValidationError(
        `Unknown server: ${server}. Known servers: ${[...KNOWN_MCP_SERVERS].join(", ")}`,
      );
    }
    if (!VALID_DISPOSITION_SET.has(disposition)) {
      throw new ValidationError(
        `Invalid disposition: ${disposition}. Must be one of: ${[...VALID_DISPOSITIONS].join(", ")}`,
      );
    }
    if (!VALID_UPDATED_BY_SET.has(updatedBy)) {
      throw new ValidationError(
        `Invalid updated_by: ${updatedBy}. Must be one of: ${[...VALID_UPDATED_BY].join(", ")}`,
      );
    }

    const db = getStateDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tool_disposition (server, disposition, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(server) DO UPDATE SET
         disposition = excluded.disposition,
         updated_at  = excluded.updated_at,
         updated_by  = excluded.updated_by`,
    ).run(server, disposition as Disposition, now, updatedBy);

    const row = db
      .prepare(
        "SELECT server, disposition, updated_at, updated_by FROM tool_disposition WHERE server = ?",
      )
      .get(server) as
        | { server: string; disposition: string; updated_at: string; updated_by: string | null }
        | undefined;

    // Debounced Hermes restart — the disposition change only takes effect
    // after init re-runs render_mcp_servers.py at boot, which is driven by
    // the compose restart. Coalesce a flurry into one.
    scheduleDebouncedHermesRestart();

    sendJson(res, 200, {
      ok: true,
      row,
      restart_scheduled: true,
      restart_debounce_ms: HERMES_RESTART_DEBOUNCE_MS,
    });
  });

  // POST /api/v1/agents/focused-subagent
  //
  // Spawn a short-lived focused subagent on the workers profile. Sister of
  // the existing `dispatch_action_to_agent` in alfred-learn — but synchronous,
  // and reachable from the LLM via the `delegate_to_focused_agent` MCP tool.
  //
  // Body:
  //   task:    string  required — what the subagent should do (plain prose)
  //   domain:  string  required — the tool surface label (sure / plane /
  //                               vaultwarden / paperclip / hass / files /
  //                               execute / alfred / alfred-ctrl OR a
  //                               composio toolkit like googlecalendar /
  //                               gmail / notion / linear / slack).
  //   context: string  optional — 1-2 sentences from the parent turn.
  //
  // Returns plain-text body — the subagent's reply, intended to be relayed
  // verbatim by the calling LLM.
  addRoute("POST", "/api/v1/agents/focused-subagent", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.task !== "string" || !(b.task as string).trim()) {
      throw new ValidationError("`task` is required (non-empty string)");
    }
    if (typeof b.domain !== "string" || !(b.domain as string).trim()) {
      throw new ValidationError("`domain` is required (non-empty string)");
    }
    const task = (b.task as string).trim();
    const domain = (b.domain as string).trim();
    const context = typeof b.context === "string" ? (b.context as string).trim() : "";

    // Session key shape: `focus-<sanitised-domain>-<short-hash>`
    // Hash incorporates a UUID slice so two simultaneous delegations on the
    // same domain don't share a session key (and the workers profile's
    // per-session memory isn't accidentally polluted).
    const slug = _domainSlug(domain);
    const shortHash = crypto.randomBytes(4).toString("hex");
    const sessionKey = `focus-${slug}-${shortHash}`;

    // Skill directive — instructs the subagent to load the right skill for
    // the domain (either a per-MCP-server skill like alfred-sure-skill or a
    // composio toolkit skill). The workers profile resolves these from
    // /hermes-state/profiles/workers/skills/ (rendered at init time).
    const skillHint = `LOAD skill alfred-${slug}-skill.md OR alfred-composio-${slug}-skill.md if present; if neither exists, proceed with the workers-profile defaults.`;

    const persona = [
      "You are a focused subagent spawned by Alfred Black to handle ONE specific task.",
      "Identity + memory: same as Alfred main, but this session is one-shot.",
      "Reply in plain text — no JSON envelopes, no markdown decoration unless the answer truly needs it.",
      "The calling agent will relay your reply VERBATIM. Be concise, direct, and accurate.",
      skillHint,
    ].join("\n");

    const userMessage = context
      ? `Context from the parent turn:\n${context}\n\nTask:\n${task}`
      : `Task:\n${task}`;

    const workersKey = readWorkersApiKey();
    if (!workersKey) {
      sendJson(res, 500, {
        ok: false,
        error: "HERMES_WORKERS_KEY_MISSING",
        detail: `Hermes workers API key not found at ${HERMES_CONFIG_DIR}/workers/.env — has hermes-init run?`,
      });
      return;
    }

    // #297 — fail fast instead of burning the whole budget on a gateway that
    // is not answering. Costs ~3ms on the happy path (measured on home);
    // saves up to DELEGATE_TIMEOUT_MS per attempt when workers are down, and
    // stops chained fallbacks compounding a minute each.
    const unready = await probeWorkersGateway();
    if (unready) {
      sendJson(res, 503, {
        ok: false,
        error: "HERMES_WORKERS_UNAVAILABLE",
        detail: `${unready}. Refused before dispatch — no delegation budget was spent and nothing was started on the gateway.`,
        session_key: sessionKey,
        probe_timeout_ms: DELEGATE_PROBE_TIMEOUT_MS,
        retryable: true,
      });
      return;
    }

    const url = `${HERMES_WORKERS_GATEWAY_URL}/v1/responses`;
    const init: RequestInit & { signal: AbortSignal } = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${workersKey}`,
        "X-Hermes-Session-Key": sessionKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: [
          { role: "system", content: persona },
          { role: "user", content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(DELEGATE_TIMEOUT_MS),
    };

    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err: any) {
      // A client-side abort means we ran out of budget, NOT that the gateway
      // is down. Reporting both as UNREACHABLE is what made #325 undiagnosable.
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      sendJson(res, 504, {
        ok: false,
        error: timedOut ? "HERMES_WORKERS_TIMEOUT" : "HERMES_WORKERS_UNREACHABLE",
        detail: timedOut
          ? `Delegation exceeded its ${DELEGATE_TIMEOUT_MS}ms budget (raise HERMES_DELEGATE_TIMEOUT_MS); the run may still be executing on the workers gateway`
          : String(err?.message ?? err).slice(0, 300),
        session_key: sessionKey,
      });
      return;
    }

    const rawText = await resp.text();
    if (!resp.ok) {
      sendJson(res, resp.status === 401 ? 502 : resp.status, {
        ok: false,
        error: "HERMES_WORKERS_ERROR",
        status: resp.status,
        detail: rawText.slice(0, 500),
        session_key: sessionKey,
      });
      return;
    }

    // Extract plain-text reply. Hermes /v1/responses returns an OpenAI-style
    // envelope with `output` items; for a simple text reply the message body
    // lives at output[].content[].text. Fall back to dumping the raw envelope
    // if the shape is unfamiliar (better to surface SOMETHING than nothing).
    let reply = "";
    try {
      const env = JSON.parse(rawText);
      // shape 1 — Hermes-style envelope with output messages
      if (Array.isArray(env?.output)) {
        for (const item of env.output) {
          if (Array.isArray(item?.content)) {
            for (const part of item.content) {
              if (typeof part?.text === "string") reply += part.text;
            }
          } else if (typeof item?.text === "string") {
            reply += item.text;
          }
        }
      }
      // shape 2 — explicit top-level reply
      if (!reply && typeof env?.reply === "string") reply = env.reply;
      // shape 3 — explicit top-level text
      if (!reply && typeof env?.text === "string") reply = env.text;
    } catch {
      reply = rawText;
    }

    sendJson(res, 200, {
      ok: true,
      reply: reply.trim() || "(subagent returned empty reply)",
      session_key: sessionKey,
      domain,
    });
  });
}
