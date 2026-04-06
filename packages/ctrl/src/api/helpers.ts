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

export async function dockerExec(service: string, command: string[], envVars?: Record<string, string>): Promise<string> {
  const envFlags: string[] = [];
  if (envVars) {
    for (const [k, v] of Object.entries(envVars)) {
      envFlags.push("-e", `${k}=${v}`);
    }
  }
  const args = ["compose", "-f", `${COMPOSE_DIR}/docker-compose.yaml`, "exec", ...envFlags, "-T", service, ...command];
  const { stdout } = await execAsync("docker", args);
  return stdout;
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
