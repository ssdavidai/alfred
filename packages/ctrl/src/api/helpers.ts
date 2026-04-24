import { execFile as execFileCb } from "node:child_process";
import { ExecError } from "./errors.js";

const COMPOSE_DIR = "/opt/alfred/compose";

interface ExecResult {
  stdout: string;
  stderr: string;
}

export function execAsync(cmd: string, args: string[], timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const exitCode = (err as any).status ?? (err as any).code;
        reject(new ExecError(`${cmd} failed (${exitCode}): ${stderr || err.message}`, stderr));
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
  const args = ["compose", "-f", `${COMPOSE_DIR}/docker-compose.yaml`, "exec", ...envFlags, "-T", service, ...command];
  await _acquireDockerExecSlot();
  try {
    const { stdout } = await execAsync("docker", args);
    return stdout;
  } finally {
    _releaseDockerExecSlot();
  }
}

export async function dockerComposeCmd(command: string[]): Promise<string> {
  const args = ["compose", "-f", `${COMPOSE_DIR}/docker-compose.yaml`, ...command];
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
export const OPENCLAW_CMD = ["node", "openclaw.mjs"];

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
