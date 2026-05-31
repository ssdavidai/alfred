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

export { REGISTRY_PATH };
