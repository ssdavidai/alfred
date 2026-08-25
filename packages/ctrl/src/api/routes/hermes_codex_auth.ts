// Codex OAuth ceremony from the dashboard (issue #565).
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
import { dockerExec } from "../helpers.js";

const COMPOSE_FILE =
  process.env.COMPOSE_FILE ??
  `${process.env.COMPOSE_DIR ?? "/srv/alfred-black"}/docker-compose.yaml`;
const HERMES_SVC = "hermes";
const CODEX_VERIFY_URI = "https://auth.openai.com/codex/device";
const CEREMONY_TTL_MS = 15 * 60 * 1_000; // matches hermes CLI's own window
let _terminalReuseMs = 60_000;

export function _setTerminalReuseMs(ms: number): void { _terminalReuseMs = ms; } // test-only

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
  if (_s.status !== "not_started" && Date.now() - _s.startedAt < _terminalReuseMs) {
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

/* ---------------------------------------------------------------------------
 * GET /api/v1/hermes/codex-auth/profiles
 *
 * Per-profile Codex credential state, so the dashboard can show whether each
 * supervised profile is actually authenticated rather than inferring it from
 * whether Hermes happens to be up.
 *
 * That distinction is the whole reason this exists. The auth banner gates on
 * Hermes health, and a gateway answering 200 says nothing about its Codex
 * credential: on the fleet we found tenants whose three gateways were healthy
 * while `tokens` was an empty object, and one where the openai-codex provider
 * had vanished from auth.json entirely. Both are invisible to a health check
 * and fatal to every clerk call.
 *
 * The four states are the cases observed in the wild, not invented:
 *   ok           — provider present, access_token present
 *   error        — token present but the last refresh failed (e.g. the refresh
 *                  token was consumed by another client); still worth flagging
 *   no_tokens    — provider present, `tokens` empty  → re-auth required
 *   no_provider  — openai-codex absent from auth.json → re-auth required
 *
 * Read-only: one docker exec, one python, no writes. A profile whose auth.json
 * is missing or unparseable reports no_provider rather than failing the call —
 * a partial answer is more useful here than none.
 * ------------------------------------------------------------------------- */
const AUTH_PROFILES = ["main", "workers", "heavy"] as const;

const READ_AUTH_PY = `
import json, sys

# A credential can live in either of two places, and which one depends on how
# it was obtained:
#   providers."openai-codex".tokens   — the legacy store, still holding older logins
#   credential_pool."openai-codex"[]  — where Hermes 0.20 puts a device-code login
# Reading only the first reports a SUCCESSFUL re-auth as no_tokens, because a
# fresh ceremony writes to the pool and leaves the legacy store empty.
#
# last_auth_error is also not evidence on its own: it persists after a
# successful re-login. It only counts when it happened AFTER the newest
# credential we hold — otherwise it describes a failure the login already fixed.
def newest(*vals):
    return max([v for v in vals if v], default=None)

out = []
for p in ${JSON.stringify(AUTH_PROFILES)}:
    rec = {"profile": p, "state": "no_provider", "last_refresh": None,
           "error": None, "source": None}
    try:
        d = json.load(open("/hermes-state/profiles/%s/auth.json" % p))
        prov = (d.get("providers") or {}).get("openai-codex")
        pool = [c for c in ((d.get("credential_pool") or {}).get("openai-codex") or [])
                if c.get("access_token")]
        legacy = bool(((prov or {}).get("tokens") or {}).get("access_token"))

        if prov is None and not pool:
            out.append(rec); continue

        pool_refresh = newest(*[c.get("last_refresh") for c in pool])
        legacy_refresh = (prov or {}).get("last_refresh") if legacy else None
        rec["last_refresh"] = newest(pool_refresh, legacy_refresh)
        rec["source"] = "pool" if pool else ("legacy" if legacy else None)

        if not pool and not legacy:
            rec["state"] = "no_tokens"
            err = (prov or {}).get("last_auth_error") or {}
            rec["error"] = err.get("code")
            out.append(rec); continue

        # A failure only counts if it is newer than the credential we hold.
        err = (prov or {}).get("last_auth_error") or {}
        live_err = None
        if err.get("code"):
            at = err.get("at")
            if not rec["last_refresh"] or (at and at > rec["last_refresh"]):
                live_err = err.get("code")
        # A pool entry records its own failures independently.
        for c in pool:
            if c.get("last_error_code"):
                live_err = live_err or c.get("last_error_code")

        rec["error"] = live_err
        rec["state"] = "error" if live_err else "ok"
    except Exception:
        pass
    out.append(rec)
json.dump({"profiles": out}, sys.stdout)
`;

export async function handleProfiles({ res }: ApiRequest): Promise<void> {
  let profiles: unknown[] = [];
  try {
    const raw = await dockerExec(HERMES_SVC, ["python3", "-c", READ_AUTH_PY]);
    profiles = JSON.parse(raw.trim()).profiles ?? [];
  } catch (err: any) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: { code: "HERMES_UNREACHABLE", message: err?.message ?? String(err) },
    }));
    return;
  }
  const all = profiles.length > 0 &&
    profiles.every((p: any) => p?.state === "ok");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ profiles, all_authenticated: all }));
}

export function registerCodexAuthRoutes(): void {
  addRoute("POST", "/api/v1/hermes/codex-auth/start", handleStart);
  addRoute("GET",  "/api/v1/hermes/codex-auth/status", handleStatus);
  addRoute("GET",  "/api/v1/hermes/codex-auth/profiles", handleProfiles);
}
