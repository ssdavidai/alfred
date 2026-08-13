// Codex OAuth ceremony from the dashboard (issue #300).
//
// Hermes uses a standard OAuth2 device-authorization flow to authenticate with
// OpenAI Codex. The flow is entirely non-interactive — no TTY reads, no browser
// auto-open — which lets us drive it from the ctrl-api server process.
//
// Architecture:
//   POST /api/v1/hermes/codex-auth/start
//     Spawns `docker compose exec -T hermes hermes auth add openai-codex --type oauth`
//     as a background child process.  Returns 202 immediately; client polls /status.
//     Parses user_code + verification_uri from the CLI's stdout once emitted (~3 s).
//     The hermes CLI handles the full ceremony: device code request → polling →
//     token exchange → credential persistence in /hermes-state/auth.json.
//     On hermes restart, supervisor.sh propagates the credential to all profiles.
//
//   GET  /api/v1/hermes/codex-auth/status
//     Returns the current session: not_started | awaiting_approval | complete | failed | timeout.
//     Includes user_code + verification_uri while awaiting_approval.
//
// Safety guarantees:
//   - ctrl-api NEVER reads, logs, or returns any token value.
//     All credential I/O belongs to the hermes CLI subprocess.
//   - A failed ceremony cannot corrupt a previously saved credential:
//     ctrl-api writes nothing to auth.json; the hermes CLI is atomic on failure.
//   - Starting a new ceremony while one is in progress is a no-op (idempotent).
//   - Starting within 60 s of a terminal state returns that state rather than
//     spawning again (prevents accidental double-click races).

import { spawn } from "node:child_process";
import { addRoute, type ApiRequest } from "../server.js";

const COMPOSE_FILE =
  process.env.COMPOSE_FILE ??
  `${process.env.COMPOSE_DIR ?? "/srv/alfred-black"}/docker-compose.yaml`;
const HERMES_SVC = "hermes";
const CODEX_VERIFY_URI = "https://auth.openai.com/codex/device";
const CEREMONY_TTL_MS = 15 * 60 * 1_000; // matches hermes CLI's own window
const TERMINAL_REUSE_MS = 60_000;

type Status = "not_started" | "awaiting_approval" | "complete" | "failed" | "timeout";

interface Session {
  status: Status;
  user_code?: string;
  verification_uri?: string;
  error?: string;
  startedAt: number;
}

let _s: Session = { status: "not_started", startedAt: 0 };
let _proc: ReturnType<typeof spawn> | null = null;

/** Strip ANSI escape codes from CLI output. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[\d+(?:;\d+)*m/g, "").trim();
}

/** Extract the user_code from the hermes CLI's printed instructions. */
function parseUserCode(buf: string): string | undefined {
  // CLI prints:  "  2. Enter this code:\n     <ANSI>XXXX-XXXX<ANSI>\n"
  const m = buf.match(/Enter this code[^]*?\n[ \t]+(\S+)/);
  return m ? stripAnsi(m[1]) : undefined;
}

function startCeremony(): void {
  _s = { status: "awaiting_approval", startedAt: Date.now() };
  const args = [
    "compose", "-f", COMPOSE_FILE, "exec", "-T", HERMES_SVC,
    "hermes", "auth", "add", "openai-codex", "--type", "oauth",
  ];
  const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  _proc = proc;
  let buf = "";
  proc.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    if (!_s.user_code && buf.includes("Enter this code")) {
      const code = parseUserCode(buf);
      if (code) {
        _s.user_code = code;
        _s.verification_uri = CODEX_VERIFY_URI;
      }
    }
    // Never log buf — it contains the user_code but not the token;
    // still safer to discard rather than risk surfacing it via docker logs.
  });
  const killTimer = setTimeout(() => {
    proc.kill();
    if (_s.status === "awaiting_approval") {
      _s = { status: "timeout", startedAt: _s.startedAt };
    }
  }, CEREMONY_TTL_MS);
  killTimer.unref();
  proc.on("close", (code: number | null) => {
    clearTimeout(killTimer);
    _proc = null;
    if (_s.status !== "awaiting_approval") return; // already timed out
    _s.status = code === 0 ? "complete" : "failed";
    if (code !== 0) _s.error = `hermes auth exited with code ${code}`;
  });
}

async function handleStart({ res }: ApiRequest): Promise<void> {
  // In-progress: return current state without spawning again.
  if (_s.status === "awaiting_approval") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: _s.status,
      verification_uri: CODEX_VERIFY_URI,
      ...(_s.user_code && { user_code: _s.user_code }),
    }));
    return;
  }
  // Terminal state within the reuse window: return it without re-spawning.
  if (_s.status !== "not_started" && Date.now() - _s.startedAt < TERMINAL_REUSE_MS) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: _s.status, ...(_s.error && { error: _s.error }) }));
    return;
  }
  // Kill any orphaned process before starting fresh.
  if (_proc) { _proc.kill(); _proc = null; }
  startCeremony();
  res.writeHead(202, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "awaiting_approval", verification_uri: CODEX_VERIFY_URI }));
}

async function handleStatus({ res }: ApiRequest): Promise<void> {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    status: _s.status,
    ...(_s.user_code && { user_code: _s.user_code, verification_uri: CODEX_VERIFY_URI }),
    ...(_s.error && { error: _s.error }),
  }));
}

export function registerCodexAuthRoutes(): void {
  addRoute("POST", "/api/v1/hermes/codex-auth/start", handleStart);
  addRoute("GET",  "/api/v1/hermes/codex-auth/status", handleStatus);
}
