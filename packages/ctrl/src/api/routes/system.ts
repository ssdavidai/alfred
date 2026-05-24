// System routes — surface the tenant VM's basic shape (SSH, container
// names) for in-app cards that need to display "how to connect" without
// hard-coding host/key info in the SPA.
//
// Today's only consumer is the /channels Terminal card (Sir #8) — it shows
// the operator the SSH command to reach the VM and offers the operator's
// own pubkey for download.
import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";

const HERMES_CONTAINER = "alfred-black-hermes-1";
const HERMES_EXEC_CMD = `docker exec -it ${HERMES_CONTAINER} hermes`;
const DEFAULT_AUTHORIZED_KEYS = "/root/.ssh/authorized_keys";

/**
 * Pick the first usable line from an SSH `authorized_keys` file:
 *   - skip blank lines and lines whose first non-whitespace char is `#`,
 *   - return null if nothing usable remains.
 *
 * That's "the operator key installed at bootstrap" — cloud-init writes it
 * as the first non-comment line; subsequent lines are operator-managed.
 */
function firstAuthorizedKey(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return null;
}

export function registerSystemRoutes(): void {
  addRoute("GET", "/api/v1/system/ssh-info", async ({ res }) => {
    // Host comes from the env the rest of ctrl-api uses for apex URL
    // construction (see apps.ts). `localhost` is the safe fallback — never
    // crash because the operator hasn't set DOMAIN yet.
    const host = process.env.DOMAIN || process.env.TENANT_DOMAIN || "localhost";

    // AUTHORIZED_KEYS_PATH lets tests fake the file; production reads the
    // real /root/.ssh/authorized_keys mounted into the container.
    const keysPath = process.env.AUTHORIZED_KEYS_PATH || DEFAULT_AUTHORIZED_KEYS;

    let pubkey: string | null = null;
    let error: string | undefined;
    try {
      const raw = fs.readFileSync(keysPath, "utf8");
      pubkey = firstAuthorizedKey(raw);
      if (pubkey === null) error = "no_authorized_keys";
    } catch {
      // Missing or unreadable — the card still needs host/user/exec, so
      // surface a soft error rather than 500ing the whole request.
      error = "no_authorized_keys";
    }

    const body: Record<string, unknown> = {
      host,
      port: 22,
      user: "root",
      pubkey,
      container: HERMES_CONTAINER,
      exec_command: HERMES_EXEC_CMD,
    };
    if (error) body.error = error;

    sendJson(res, 200, body);
  });
}
