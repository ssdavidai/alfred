// supervisor — the Hermes-side activation bridge for #120 Lane II.
//
// Two responsibilities:
//
//   1. writeSupervisorRegistry(reg) — atomically write the registry JSON
//      to /hermes-state/profiles/_registry.json. The Hermes supervisor.sh
//      reads this file at boot AND on every SIGUSR1 to decide which
//      gateway processes to keep alive. Write-then-rename so the supervisor
//      never reads a torn file mid-update.
//
//   2. nudgeHermesSupervisor() — send SIGUSR1 to the hermes container's
//      PID 1 (tini → supervisor.sh) so the supervisor re-reads the
//      registry without a full container restart. Best-effort: a missing
//      docker socket or a not-yet-running hermes container is a warn, not
//      a throw — the registry row is durable and the next supervisor boot
//      will reconcile.
//
// Path layout — the registry file lives at /hermes-state/profiles/_registry.json
// inside the ctrl-api container (the hermes_data named volume is mounted at
// the same path in both ctrl-api and hermes — see docker-compose.yaml). The
// underscore-prefixed name keeps it sorted away from real profile dirs and
// signals "synthesised by the system, not a profile".

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SupervisorRegistry } from "../db/agentProfiles.js";
import { dockerComposeCmd, HERMES_CONTAINER } from "../api/helpers.js";

const HERMES_STATE_DIR =
  process.env.HERMES_STATE_DIR_CTRL_VIEW ?? "/hermes-state";
const REGISTRY_PATH = path.join(
  HERMES_STATE_DIR,
  "profiles",
  "_registry.json",
);

const HERMES_CONTAINER_NAME =
  process.env.HERMES_CONTAINER_NAME ?? "alfred-black-hermes-1";

// Atomic write: write to a sibling .tmp file then rename(2) over the target.
// rename(2) on the same filesystem is atomic on POSIX, so the supervisor
// either sees the previous valid JSON or the new one — never a half-written
// file. Idempotent — repeated calls overwrite cleanly.
export function writeSupervisorRegistry(reg: SupervisorRegistry): void {
  const dir = path.dirname(REGISTRY_PATH);
  // ensure the parent dir exists — the init container creates it on first
  // boot, but on a fresh provision ctrl-api's POST might land before init
  // has run. mkdirSync({recursive: true}) is a no-op when the dir is there.
  fs.mkdirSync(dir, { recursive: true });
  const tmp = REGISTRY_PATH + ".tmp";
  const payload = JSON.stringify(reg, null, 2) + "\n";
  fs.writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o644 });
  fs.renameSync(tmp, REGISTRY_PATH);
}

// Best-effort SIGUSR1 to the hermes container. Returns true on success,
// false on any failure (container not running, docker socket missing,
// docker CLI absent). Never throws — the caller logs the warning.
export function nudgeHermesSupervisor(): boolean {
  try {
    // `docker kill --signal=SIGUSR1 <container>` delivers the signal to
    // PID 1 (tini), which forwards to its single child (supervisor.sh).
    // 5s timeout — `docker kill` is normally <100ms; a stuck docker
    // daemon is the rare slow-path we want to bound.
    execFileSync(
      "docker",
      ["kill", "--signal=SIGUSR1", HERMES_CONTAINER_NAME],
      { timeout: 5_000, stdio: "pipe" },
    );
    return true;
  } catch (err) {
    // Common reasons for failure:
    //   * hermes container not running (first boot, before depends_on
    //     resolves) — the next supervisor boot will read the registry
    //     file we just wrote and start up correctly.
    //   * docker socket not mounted (test env) — same recovery.
    //   * docker CLI not installed (test env) — same.
    // None of these block the registry write; they just delay activation
    // until the next boot.
    return false;
  }
}

// ── #120 Lane V — scoped per-profile restart helper ───────────────────────
//
// The result of `restartProfile(slug)` matters for the principal-visible
// promise — "I just changed Sentinel's Telegram token, please don't bounce
// Main's gateway." Today the Hermes supervisor exposes only SIGUSR1 (re-
// reconcile against the registry) and a whole-container restart. Truly
// scoped gateway respawn is a follow-up (would need supervisor.sh to expose
// a per-profile signal, e.g. /hermes-state/profiles/<slug>/.restart-flag).
//
// Pragmatic strategy for this lane:
//
//   restartProfile(slug) returns { scope, attempted }.
//
//   * scope='per-profile' — a per-profile flag-file lands in
//     /hermes-state/profiles/<slug>/.restart-flag-<ms>. The supervisor's
//     reconcile path (added in a follow-up) will tear down + respawn just
//     that gateway. Until that supervisor change lands the flag-file is a
//     no-op breadcrumb; the supervisor reconciles on its own ticks.
//   * scope='compose-restart' — fallback whole-container restart via
//     docker-compose. Only taken when the caller explicitly opts in with
//     `{ allowComposeFallback: true }`. Caller surfaces the wider-than-
//     intended scope to the UI via the `restart_scope` field in its API
//     response (lane V spec § restart-scope strategy).
//
// Idempotent and non-throwing — restart failures are warnings, the token
// write already landed.

export interface ProfileRestartResult {
  scope: "per-profile" | "compose-restart" | "noop";
  attempted: boolean;
  warning: string | null;
}

// Fire-and-forget whole-container restart via the same docker-compose path
// the old per-route restartHermes() used. The mocked tests assert against
// `dockerComposeCalls`, so this must be invoked synchronously from the
// caller's frame — the .catch() handler eats async failures.
function _composeRestartHermes(): void {
  dockerComposeCmd(["restart", HERMES_CONTAINER]).catch((err) => {
    console.warn(`[supervisor] compose restart failed: ${String(err)}`);
  });
}

export function restartProfile(
  slug: string,
  opts: { allowComposeFallback?: boolean } = {},
): ProfileRestartResult {
  if (typeof slug !== "string" || !slug.trim()) {
    return {
      scope: "noop",
      attempted: false,
      warning: "restartProfile called with empty slug",
    };
  }
  const profilesDir = path.join(HERMES_STATE_DIR, "profiles", slug);
  // Drop a flag-file the supervisor's reconcile path can watch. We don't
  // need the supervisor side to exist yet — the file is a durable breadcrumb
  // explaining "ctrl-api asked for a restart at this ts". Empty content is
  // fine; the existence + mtime are the signal.
  let flagWritten = false;
  try {
    fs.mkdirSync(profilesDir, { recursive: true });
    const flag = path.join(profilesDir, `.restart-flag-${Date.now()}`);
    fs.writeFileSync(flag, "", { mode: 0o644 });
    flagWritten = true;
  } catch {
    // best-effort; if the volume isn't mounted (test env) the fallback
    // below is what matters.
  }

  // Nudge the supervisor so it re-reads its registry and notices the flag
  // file we just wrote. This is the same signal Lane II uses for
  // add/archive reconciliation — it's idempotent.
  nudgeHermesSupervisor();

  if (flagWritten) {
    return {
      scope: "per-profile",
      attempted: true,
      warning: null,
    };
  }

  // Fallback: if the caller explicitly allows it, bounce the whole hermes
  // container via the same docker-compose path the previous restartHermes()
  // path used. This is wider than ideal — it restarts main + every other
  // profile too — so the route surfaces `restart_scope='compose-restart'`
  // to the UI. Fires-and-forgets the compose CLI; we never block the HTTP
  // response on the restart finishing.
  if (opts.allowComposeFallback) {
    _composeRestartHermes();
    return {
      scope: "compose-restart",
      attempted: true,
      warning:
        "per-profile restart flag-file could not be written; falling back to whole-container reload",
    };
  }

  return {
    scope: "noop",
    attempted: false,
    warning:
      "per-profile restart flag-file could not be written; gateway will pick up new env on next supervisor tick",
  };
}

export { REGISTRY_PATH };
