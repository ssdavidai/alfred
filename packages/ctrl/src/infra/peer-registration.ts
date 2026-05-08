/**
 * Peer registration on Alfred Prime.
 *
 * When a new tenant is provisioned, append it to Prime's
 * CROSS_TENANT_PEERS env var so Prime's MCP `tenant` and `ask_alfred`
 * tools can reach the new tenant. The .env file lives at
 * /opt/alfred/compose/.env on Prime's host; after editing we restart
 * openclaw / openclaw-workers / ctrl-api so they pick up the new env.
 *
 * Configured via env vars:
 *   ALFRED_PRIME_INSTANCE_NAME — customer_name of Prime in the local
 *                                 ctrl SQLite (default: "david")
 *
 * If Prime can't be found in the DB or SSH fails, the function logs a
 * warning and returns — provisioning is NOT failed by a peer-list miss.
 * Prime's peer list can still be hand-edited.
 */
import { existsSync } from "node:fs";
import * as ssh from "./ssh.js";
import type { SSHHostKeyOptions } from "./ssh.js";
import { getInstanceByName } from "../db/queries.js";
import { DEFAULTS } from "../data/constants.js";

/**
 * Resolve a stored ssh_key_path to a path that's actually readable in the
 * current process. The DB stores HOST paths (`/opt/alfred-saas/alfred-ctrl/...`)
 * but provisioning code runs INSIDE the alfred-saas-app-1 container where
 * the same files are at `/app/alfred-ctrl/...` (bind mount). Conversely
 * when running on the host directly (TUI / CLI / CI's deploy-api step)
 * the host path is correct and `/app/alfred-ctrl/...` doesn't exist.
 *
 * Strategy: try the path as-is, then try the swapped form. Return whichever
 * exists. If neither exists, return the original so the caller hits a clear
 * ENOENT (rather than us silently substituting a non-existent path).
 *
 * Surfaced 2026-05-08: peer-registration ran from inside alfred-saas-app-1
 * with prime.ssh_key_path = host path → ENOENT → "Prime registration
 * failed (non-fatal)" on every fresh provision. deployApi already had its
 * own remap (provisioner.ts:1610) but peer-registration was missed.
 */
function resolveSshKeyPath(stored: string): string {
  if (existsSync(stored)) return stored;

  // host path → container path
  const containerPath = stored.replace(
    /^\/opt\/alfred-saas\/alfred-ctrl\//,
    "/app/alfred-ctrl/",
  );
  if (containerPath !== stored && existsSync(containerPath)) return containerPath;

  // container path → cwd-relative (for host-side CLI runs)
  const cwdPath = stored.replace(/^\/app\/alfred-ctrl\//, process.cwd() + "/");
  if (cwdPath !== stored && existsSync(cwdPath)) return cwdPath;

  return stored;
}

export interface PeerRegistration {
  id: string;
  tailscaleHost: string;
  tailscaleIp: string;
  apiKey: string;
  label: string;
}

/**
 * Append `peer` to Prime's CROSS_TENANT_PEERS, deduplicating by `id`.
 * Returns true on success, false on any non-fatal failure.
 */
export async function registerPeerOnPrime(
  peer: PeerRegistration,
  log: (msg: string) => void = () => {},
): Promise<boolean> {
  const primeName = process.env.ALFRED_PRIME_INSTANCE_NAME ?? "david";

  const prime = getInstanceByName(primeName);
  if (!prime) {
    log(
      `Prime registration skipped: no instance "${primeName}" in local DB (set ALFRED_PRIME_INSTANCE_NAME if Prime is named differently).`,
    );
    return false;
  }
  if (!prime.ip_address) {
    log(`Prime registration skipped: instance "${primeName}" has no ip_address.`);
    return false;
  }
  if (!prime.ssh_key_path) {
    log(`Prime registration skipped: instance "${primeName}" has no ssh_key_path.`);
    return false;
  }

  // Refuse to register Prime against itself (would create a self-call loop).
  if (peer.id === primeName) {
    log(`Prime registration skipped: cannot register Prime as its own peer.`);
    return false;
  }

  // Build a Python one-liner that mutates /opt/alfred/compose/.env
  // idempotently: parses the JSON array, dedupes by id, appends the new
  // peer, writes back. The peer config is encoded as a JSON literal in
  // the script so we don't have to worry about shell quoting.
  const peerJson = JSON.stringify(peer);
  const script = `python3 - <<'PYEOF'
import json, re, pathlib
p = pathlib.Path("/opt/alfred/compose/.env")
text = p.read_text()
m = re.search(r"^CROSS_TENANT_PEERS=(.*)$", text, re.M)
if not m:
    print("CROSS_TENANT_PEERS not present — skipping (this host may not be Prime)")
    raise SystemExit(0)
peers = json.loads(m.group(1))
new_peer = ${peerJson}
existing_ids = {pp["id"] for pp in peers if isinstance(pp, dict) and "id" in pp}
if new_peer["id"] in existing_ids:
    print("peer already present, no change:", new_peer["id"])
    raise SystemExit(0)
peers.append(new_peer)
new_line = "CROSS_TENANT_PEERS=" + json.dumps(peers, ensure_ascii=False)
text = re.sub(r"^CROSS_TENANT_PEERS=.*$", lambda _: new_line, text, count=1, flags=re.M)
p.write_text(text)
print("appended peer:", new_peer["id"], "→ peer count:", len(peers))
PYEOF
cd /opt/alfred/compose && docker compose up -d openclaw openclaw-workers ctrl-api 2>&1 | tail -20`;

  log(`Registering "${peer.id}" on Prime (${primeName}, ${prime.ip_address})…`);
  try {
    const hostKeyOpts: SSHHostKeyOptions | undefined = prime.ssh_host_key
      ? { knownHostKey: prime.ssh_host_key }
      : undefined;
    const sshKeyPath = resolveSshKeyPath(prime.ssh_key_path);
    const result = await ssh.exec(
      prime.ip_address,
      sshKeyPath,
      script,
      DEFAULTS.sshUser,
      hostKeyOpts,
    );
    if (result.code !== 0) {
      log(
        `Prime registration: SSH exit ${result.code} — stderr: ${result.stderr.slice(0, 200)}`,
      );
      return false;
    }
    log(`Prime registration: ${result.stdout.trim().split("\n").slice(0, 3).join(" | ")}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Prime registration failed (non-fatal): ${msg}`);
    return false;
  }
}
