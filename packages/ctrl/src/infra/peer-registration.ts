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
import * as ssh from "./ssh.js";
import type { SSHHostKeyOptions } from "./ssh.js";
import { getInstanceByName } from "../db/queries.js";
import { DEFAULTS } from "../data/constants.js";

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
    const result = await ssh.exec(
      prime.ip_address,
      prime.ssh_key_path,
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
