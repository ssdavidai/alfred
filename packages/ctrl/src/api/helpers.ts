import { execFile as execFileCb, spawn } from "node:child_process";
import { ExecError } from "./errors.js";

// ---------------------------------------------------------------------------
// Compose project directory.
//
// alfred-black is a single-VM `docker compose up` deployment: the user clones
// the repo and runs compose from the repo root. ctrl-api restarts sibling
// containers via the bind-mounted docker socket, so it needs the path of the
// directory that holds docker-compose.yaml.
//
//   COMPOSE_DIR  — absolute path to the directory containing
//                  docker-compose.yaml. Defaults to `/srv/alfred-black`.
//                  Point this at wherever the repo was cloned.
//   COMPOSE_FILE — full override of the compose file path; takes precedence
//                  over COMPOSE_DIR when set.
//
// `COMPOSE_PROJECT_NAME` is honoured implicitly: every `docker compose`
// invocation inherits the ambient process environment (which carries
// COMPOSE_PROJECT_NAME from the container's `.env`), so sibling-container
// targeting resolves correctly regardless of the project name compose was
// brought up under.
// ---------------------------------------------------------------------------
const COMPOSE_DIR = process.env.COMPOSE_DIR ?? "/srv/alfred-black";
const COMPOSE_FILE = process.env.COMPOSE_FILE ?? `${COMPOSE_DIR}/docker-compose.yaml`;

interface ExecResult {
  stdout: string;
  stderr: string;
}

export function execAsync(cmd: string, args: string[], timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const exitCode = (err as any).status ?? (err as any).code;
        // Capture both stderr and stdout — some CLIs (notably the alfred
        // CLI's `vault delete`) emit structured error payloads to stdout
        // on non-zero exit, and downstream handlers need to inspect both
        // streams to classify the failure (e.g. map "File not found" to
        // HTTP 404 rather than a generic 500).
        const stdoutStr = typeof stdout === "string" ? stdout : stdout?.toString() ?? "";
        const stderrStr = typeof stderr === "string" ? stderr : stderr?.toString() ?? "";
        reject(new ExecError(
          `${cmd} failed (${exitCode}): ${stderrStr || err.message}`,
          stderrStr,
          stdoutStr,
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Concurrency cap for docker-exec calls (#593).
//
// Each `docker compose exec ...` invocation forks several processes in
// the ctrl-api container (docker CLI + compose plugin + containerd
// helper). Under fleet load — plane_sync, plane_reverse_sync,
// hourly_enrichment, composio sync, stream_puller — bursts of
// simultaneous docker-exec calls can saturate the container's
// pids_limit. The kernel returns EAGAIN on fork; docker's CLI-plugin
// loader surfaces it either as
//   ``fork/exec … resource temporarily unavailable`` (clean EAGAIN)
// or — more confusingly — as
//   ``unknown shorthand flag: 'f' in -f``
// when the compose plugin fails to load mid-parse and docker falls
// back to treating `compose` as an unknown subcommand (so `-f` is
// re-parsed against the base docker CLI which rejects it).
//
// Capping in-flight docker-exec to 8 throttles bursts below the fork
// budget while still letting normal workloads (2–3 parallel execs)
// proceed without queueing. Requests above the cap wait in FIFO order
// instead of failing.
// ---------------------------------------------------------------------------

const DOCKER_EXEC_CONCURRENCY = 8;
let _dockerExecInFlight = 0;
const _dockerExecWaiters: Array<() => void> = [];

async function _acquireDockerExecSlot(): Promise<void> {
  if (_dockerExecInFlight < DOCKER_EXEC_CONCURRENCY) {
    _dockerExecInFlight++;
    return;
  }
  await new Promise<void>((resolve) => {
    _dockerExecWaiters.push(resolve);
  });
  _dockerExecInFlight++;
}

function _releaseDockerExecSlot(): void {
  _dockerExecInFlight--;
  const next = _dockerExecWaiters.shift();
  if (next) next();
}

export async function dockerExec(service: string, command: string[], envVars?: Record<string, string>): Promise<string> {
  const envFlags: string[] = [];
  if (envVars) {
    for (const [k, v] of Object.entries(envVars)) {
      envFlags.push("-e", `${k}=${v}`);
    }
  }
  const args = ["compose", "-f", COMPOSE_FILE, "exec", ...envFlags, "-T", service, ...command];
  await _acquireDockerExecSlot();
  try {
    const { stdout } = await execAsync("docker", args);
    return stdout;
  } finally {
    _releaseDockerExecSlot();
  }
}

// dockerExecWithStdin pipes a string into the stdin of a `docker compose
// exec` child process and returns its stdout. Used by long-running CLI
// invocations (e.g. alfred-learn's transaction clustering) that need to
// receive a payload too large for argv.
export async function dockerExecWithStdin(
  service: string,
  command: string[],
  stdinPayload: string,
  timeoutMs = 120_000,
  envVars?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const envFlags: string[] = [];
  if (envVars) {
    for (const [k, v] of Object.entries(envVars)) {
      envFlags.push("-e", `${k}=${v}`);
    }
  }
  const args = [
    "compose",
    "-f",
    COMPOSE_FILE,
    "exec",
    ...envFlags,
    "-T",
    service,
    ...command,
  ];
  await _acquireDockerExecSlot();
  try {
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new ExecError(`docker exec ${service} timed out after ${timeoutMs}ms`, stderr, stdout));
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (err) => {
        clearTimeout(killTimer);
        reject(new ExecError(`docker exec ${service} failed to spawn: ${err.message}`, stderr, stdout));
      });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new ExecError(
            `docker exec ${service} exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`,
            stderr,
            stdout,
          ));
        }
      });
      child.stdin.end(stdinPayload);
    });
  } finally {
    _releaseDockerExecSlot();
  }
}

export async function dockerComposeCmd(command: string[]): Promise<string> {
  const args = ["compose", "-f", COMPOSE_FILE, ...command];
  const { stdout } = await execAsync("docker", args);
  return stdout;
}

export function hostExec(cmd: string, args: string[]): Promise<string> {
  return execAsync(cmd, args).then(r => r.stdout);
}

export function sudoExec(cmd: string, args: string[]): Promise<string> {
  return execAsync("sudo", [cmd, ...args]).then(r => r.stdout);
}

export const ALFRED_CMD = ["alfred", "--config", "/app/data/config.yaml"];

// ---------------------------------------------------------------------------
// Hermes runtime.
//
// alfred-black replaces the two-container OpenClaw split (`openclaw` +
// `openclaw-workers`) with a single `hermes` container running two profiles.
// `hermes` is on PATH inside the image, so the in-container CLI invocation is
// just `["hermes"]` — no `node openclaw.mjs` shim.
//
//   HERMES_CMD       — argv prefix for in-container Hermes CLI calls.
//   HERMES_CONTAINER — compose service name of the runtime container.
//
// `OPENCLAW_CMD` / `OPENCLAW_CONTAINER` are kept as aliases for one release so
// callers that still reference the old names compile unchanged; they resolve
// to the same Hermes values.
// ---------------------------------------------------------------------------
export const HERMES_CMD = ["hermes"];
export const HERMES_CONTAINER = "hermes";

/** @deprecated alias of HERMES_CMD — removed next release. */
export const OPENCLAW_CMD = HERMES_CMD;
/** @deprecated alias of HERMES_CONTAINER — removed next release. */
export const OPENCLAW_CONTAINER = HERMES_CONTAINER;

export function parseJsonLines(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Try parsing as a single JSON document first (handles pretty-printed arrays from Temporal CLI)
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall back to line-by-line JSONL parsing
  }
  const results: unknown[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      results.push(JSON.parse(t));
    } catch {
      // skip non-JSON lines
    }
  }
  return results;
}

export function getQuery(url: string): URLSearchParams {
  const idx = url.indexOf("?");
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : "");
}

export function validateServiceName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new ExecError("Invalid service name");
  }
}

export { COMPOSE_DIR };
