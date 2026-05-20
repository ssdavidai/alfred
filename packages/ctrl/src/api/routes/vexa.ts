// Vexa auto-join toggle — exposed to the SaaS dashboard so Sir can
// pause/resume the meeting bot without SSHing the tenant. Two surfaces:
//
//   GET  /api/v1/admin/vexa/auto-join  → { enabled, schedule_paused }
//   POST /api/v1/admin/vexa/auto-join  → body { enabled: boolean }
//
// Behaviour: flipping `enabled` updates VEXA_ENABLED in the alfred-side
// .env (so the next alfred-learn restart respects the setting) AND
// pauses/unpauses the `al-meeting-capture` Temporal schedule (so the
// effect is immediate — no docker compose restart required). The two
// halves are independent: pausing the schedule alone would let the .env
// drift out of sync and a restart would resurrect the workflow; updating
// only the .env would leave a queued workflow firing until the next
// restart.
//
// "Pause" rather than "delete" is deliberate. We want the schedule
// metadata (cron, args, overlap policy) preserved across toggles, and
// re-creating the schedule on every unpause would race with workflows
// already mid-execution.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { COMPOSE_DIR } from "../helpers.js";

const ENV_PATH = `${COMPOSE_DIR}/.env`;
const SCHEDULE_ID = "al-meeting-capture";

function readVexaEnabled(): boolean {
  try {
    const content = fs.readFileSync(ENV_PATH, "utf-8");
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("VEXA_ENABLED=")) continue;
      // Strip optional surrounding single/double quotes that env-write
      // may have wrapped the value in (see env-write.ts).
      const v = line
        .slice("VEXA_ENABLED=".length)
        .trim()
        .replace(/^['"]|['"]$/g, "")
        .toLowerCase();
      return v === "true" || v === "1" || v === "yes";
    }
  } catch {
    // .env doesn't exist yet — treat as disabled.
  }
  return false;
}

function writeVexaEnabled(enabled: boolean): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  } catch {
    lines = [];
  }
  const value = enabled ? "true" : "false";
  let found = false;
  const out = lines.map((raw) => {
    const line = raw.trim();
    if (!line.startsWith("VEXA_ENABLED=")) return raw;
    found = true;
    return `VEXA_ENABLED=${value}`;
  });
  if (!found) out.push(`VEXA_ENABLED=${value}`);
  const content = out.join("\n");
  fs.writeFileSync(ENV_PATH, content.endsWith("\n") ? content : content + "\n", "utf-8");
}

/**
 * Run a docker compose exec against the temporal CLI and resolve with
 * stdout. Rejects on non-zero exit. We shell out (rather than reach into
 * Temporal's gRPC API directly) to avoid taking on a temporalio Node
 * dependency for one toggle.
 */
function temporalCli(args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "docker",
      [
        "compose",
        "-f",
        `${COMPOSE_DIR}/docker-compose.yaml`,
        "exec",
        "-T",
        "temporal",
        "temporal",
        "schedule",
        ...args,
        "--address",
        "temporal:7233",
        "--namespace",
        "default",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (b) => (out += b.toString()));
    proc.stderr.on("data", (b) => (err += b.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`temporal CLI timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`temporal CLI exit ${code}: ${err.slice(0, 500)}`));
      } else {
        resolve(out);
      }
    });
  });
}

async function readSchedulePaused(): Promise<boolean | null> {
  try {
    const out = await temporalCli([
      "describe",
      "--schedule-id",
      SCHEDULE_ID,
      "--output",
      "json",
    ]);
    const parsed = JSON.parse(out);
    // Temporal CLI 1.7 wraps state under `schedule.state` and ONLY
    // emits the `paused` field when the schedule is paused — an
    // unpaused schedule has `state: {}`. So the absence of a paused
    // field on a schedule we know exists means "running normally".
    // Two shapes still tolerated below for forward-compat with newer
    // CLI versions that might include the field unconditionally.
    if (!parsed) return null;
    const stateNode =
      parsed?.schedule?.state ?? parsed?.state ?? null;
    if (stateNode === null) return null;
    const paused =
      parsed?.schedule?.state?.paused ??
      parsed?.state?.paused ??
      parsed?.paused ??
      false;
    return typeof paused === "boolean" ? paused : false;
  } catch {
    return null;
  }
}

async function setSchedulePaused(paused: boolean): Promise<void> {
  // Temporal CLI 1.7 doesn't have `schedule pause` / `schedule unpause`
  // subcommands — pausing goes through `schedule toggle --pause` /
  // `--unpause`. The earlier attempt used the standalone subcommand
  // names which fail with `unknown flag: --schedule-id` because the
  // CLI treats "pause" as an unrecognized positional arg and parses
  // the flags against the parent `schedule` command instead.
  await temporalCli([
    "toggle",
    "--schedule-id",
    SCHEDULE_ID,
    paused ? "--pause" : "--unpause",
    "--reason",
    paused
      ? "auto-join disabled via dashboard"
      : "auto-join enabled via dashboard",
  ]);
}

export function registerVexaRoutes(): void {
  addRoute("GET", "/api/v1/admin/vexa/auto-join", async ({ res }) => {
    const enabled = readVexaEnabled();
    const schedulePaused = await readSchedulePaused();
    sendJson(res, 200, {
      enabled,
      schedule_paused: schedulePaused,
    });
  });

  addRoute("POST", "/api/v1/admin/vexa/auto-join", async ({ req: _req, res, body }) => {
    const b = body as { enabled?: unknown } | undefined;
    if (!b || typeof b.enabled !== "boolean") {
      throw new ValidationError("Body must be {enabled: boolean}");
    }
    const enabled = b.enabled;

    // 1. Persist to .env so a future alfred-learn restart honours it.
    writeVexaEnabled(enabled);

    // 2. Pause/unpause the schedule so the change takes effect now.
    //    Best-effort — if the schedule is missing (tenant never had Vexa
    //    enabled, or temporal is wedged) we still report the env update.
    let scheduleErr: string | null = null;
    try {
      await setSchedulePaused(!enabled);
    } catch (e) {
      scheduleErr = e instanceof Error ? e.message : String(e);
    }

    sendJson(res, 200, {
      enabled,
      schedule_paused: scheduleErr ? null : !enabled,
      warning: scheduleErr,
    });
  });
}
