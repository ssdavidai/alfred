// Vexa auto-join toggle — exposed to the SaaS dashboard so Sir can
// pause/resume the meeting bot without SSHing the tenant. Two surfaces:
//
//   GET  /api/v1/admin/vexa/auto-join  → { enabled, schedule_paused }
//   POST /api/v1/admin/vexa/auto-join  → body { enabled: boolean }
//
// Behaviour: flipping `enabled` updates VEXA_ENABLED in the alfred-side .env
// (durable half — honoured on the next alfred-learn restart) AND pauses/
// unpauses BOTH VEXA-gated Temporal schedules — `al-meeting-capture` (bot
// dispatch) + `al-transcript-intake` (ingest) — for immediate effect.
//
// Resilience (F29): learn create-or-deletes these schedules at registration
// based on VEXA_ENABLED, so when VEXA was off the schedule is *deleted*, not
// paused, and a pause/unpause then fails NOT_FOUND. That must NOT 500: an
// absent schedule is a benign no-op (on enable learn re-creates it; on disable
// it's already gone). The schedule toggle is best-effort acceleration over the
// authoritative .env flip; per-schedule failures surface as warnings, never 5xx.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { COMPOSE_DIR } from "../helpers.js";

const ENV_PATH = `${COMPOSE_DIR}/.env`;
// Both VEXA-gated schedules toggle together. al-meeting-capture dispatches
// the bot; al-transcript-intake ingests the transcripts it produces. Pausing
// only the former (the old behaviour) left intake firing against an empty
// stream. (register_schedules.py: register_meeting_capture / register_transcript_intake.)
const SCHEDULE_IDS = ["al-meeting-capture", "al-transcript-intake"] as const;

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

/** Persist VEXA_ENABLED into the compose .env. Creates the file if it
 *  doesn't exist (a fresh tenant may not have one yet) and tolerates a
 *  transient read failure by starting from an empty file rather than
 *  throwing. Returns true on success; on a hard write failure (e.g. the
 *  bind-mount is read-only) it throws so the caller can surface a warning —
 *  the caller must NOT let that bubble into a 500. */
function writeVexaEnabled(enabled: boolean): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  } catch {
    // .env missing or unreadable — start fresh; we'll create it below.
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

async function readSchedulePaused(scheduleId: string): Promise<boolean | null> {
  try {
    const out = await temporalCli([
      "describe",
      "--schedule-id",
      scheduleId,
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

/** True when a temporal CLI error means the schedule simply doesn't exist
 *  (deleted by register_schedules while VEXA was off) — a benign no-op. */
function isScheduleNotFound(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("not found") ||
    m.includes("notfound") ||
    m.includes("no schedules") ||
    m.includes("schedule not running") ||
    m.includes("does not exist")
  );
}

async function setSchedulePaused(scheduleId: string, paused: boolean): Promise<void> {
  // Temporal CLI 1.7 doesn't have `schedule pause` / `schedule unpause`
  // subcommands — pausing goes through `schedule toggle --pause` /
  // `--unpause`. The earlier attempt used the standalone subcommand
  // names which fail with `unknown flag: --schedule-id` because the
  // CLI treats "pause" as an unrecognized positional arg and parses
  // the flags against the parent `schedule` command instead.
  await temporalCli([
    "toggle",
    "--schedule-id",
    scheduleId,
    paused ? "--pause" : "--unpause",
    "--reason",
    paused
      ? "auto-join disabled via dashboard"
      : "auto-join enabled via dashboard",
  ]);
}

/** Toggle every VEXA-gated schedule, tolerating absent handles. Returns a
 *  warning map (id → message) only for failures OTHER than "doesn't exist";
 *  a missing schedule is a silent no-op. Never throws. */
async function toggleAllSchedules(paused: boolean): Promise<Record<string, string>> {
  const warnings: Record<string, string> = {};
  await Promise.all(
    SCHEDULE_IDS.map(async (id) => {
      try {
        await setSchedulePaused(id, paused);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!isScheduleNotFound(msg)) warnings[id] = msg;
      }
    }),
  );
  return warnings;
}

export function registerVexaRoutes(): void {
  addRoute("GET", "/api/v1/admin/vexa/auto-join", async ({ res }) => {
    const enabled = readVexaEnabled();
    // Report the primary schedule's paused state for back-compat with the
    // existing response shape. If it's absent (null), fall back to the
    // intake schedule so the field still reflects reality when only one
    // exists.
    let schedulePaused = await readSchedulePaused(SCHEDULE_IDS[0]);
    if (schedulePaused === null) {
      schedulePaused = await readSchedulePaused(SCHEDULE_IDS[1]);
    }
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

    // 1. Persist to .env (durable half). A write failure (e.g. read-only
    //    bind-mount) is a warning, NOT a 500 — the toggle below still applies.
    let envErr: string | null = null;
    try {
      writeVexaEnabled(enabled);
    } catch (e) {
      envErr = e instanceof Error ? e.message : String(e);
    }

    // 2. Pause/unpause BOTH schedules now. Best-effort; an absent schedule is
    //    a benign no-op, never a 500 (see toggleAllSchedules).
    const scheduleWarnings = await toggleAllSchedules(!enabled);

    const warningParts: string[] = [];
    if (envErr) warningParts.push(`env: ${envErr}`);
    for (const [id, msg] of Object.entries(scheduleWarnings)) {
      warningParts.push(`${id}: ${msg}`);
    }
    const hadScheduleWarning = Object.keys(scheduleWarnings).length > 0;

    sendJson(res, 200, {
      enabled,
      // null when a schedule errored for a non-absence reason; else the
      // requested terminal paused-state.
      schedule_paused: hadScheduleWarning ? null : !enabled,
      warning: warningParts.length > 0 ? warningParts.join("; ") : null,
    });
  });
}

// Re-exported for tests.
export const _internal = {
  SCHEDULE_IDS,
  isScheduleNotFound,
};
