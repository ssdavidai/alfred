// Online-resize a tenant's encrypted data volume.
//
// Per-tenant flow (issue #781):
//   1. Hetzner API:  POST /volumes/<id>/actions/resize    -> block device grows live
//   2. SSH (sftp):   stage helper script to /opt/alfred/volume-resize.sh
//   3. SSH (exec):   sudo bash /opt/alfred/volume-resize.sh   -> cryptsetup + resize2fs + df
//
// Why a staged helper script instead of three direct `sudo cryptsetup …` /
// `sudo resize2fs …` SSH calls: the deploy user's sudoers allowlist (see
// `cloud-init.yaml.njk`) only permits `systemctl`, `tailscale`, `cloudflared`,
// `chown`, `mkdir -p /opt/alfred/*`, and crucially `bash /opt/alfred/*.sh`.
// Direct `sudo cryptsetup`/`sudo resize2fs` invocations would prompt for a
// password and fail in this non-interactive session. Staging the script under
// /opt/alfred (deploy-owned) and invoking it via the existing wildcard sudo
// rule keeps the resize working without widening the allowlist.
//
// Idempotent. Re-running with the same target size is a no-op:
//   - Hetzner step is skipped when the current volume size is already >= target
//     (size pre-checked via listVolumes, no exception-driven control flow).
//   - cryptsetup resize / resize2fs are themselves idempotent against an
//     already-extended device.
//
// This command does NOT mutate the provisioner default (DEFAULTS.volumeSizeGb).
// New tenants pick up the new default automatically; existing tenants need an
// explicit `volume-resize <name> <gb>` invocation per the operator runbook.

import { getInstanceByName } from "../db/queries.js";
import { getHetznerClient } from "./../infra/hetzner.js";
import { exec as sshExec, upload as sshUpload } from "../infra/ssh.js";
import type { SSHHostKeyOptions } from "../infra/ssh.js";

export interface VolumeResizeResult {
  /** Hetzner volume id that was targeted. */
  volumeId: number;
  /** Requested new size in GB. */
  requestedSizeGb: number;
  /** True if the Hetzner API step was skipped because the volume was already at >= target. */
  hetznerNoOp: boolean;
  /** Trimmed `df -h /mnt/encrypted` output for the operator to eyeball. */
  dfOutput: string;
}

export type LogFn = (msg: string) => void;

// Helper script. Staged under /opt/alfred (deploy-owned) and invoked via the
// existing `bash /opt/alfred/*.sh` sudoers entry, so it runs as root without
// requiring a password prompt.
const RESIZE_SCRIPT = `#!/usr/bin/env bash
# alfred-data online resize: LUKS layer -> ext4 -> verify.
# Invoked from alfred-ctrl volume-resize CLI.
set -euo pipefail

cryptsetup resize --key-file /opt/alfred/luks.key alfred-data
resize2fs /dev/mapper/alfred-data
echo "--- df ---"
df -h /mnt/encrypted
`;

const RESIZE_SCRIPT_PATH = "/opt/alfred/volume-resize.sh";

/**
 * Resolve the on-disk SSH key path. The DB may store a container-style path
 * (`/app/alfred-ctrl/...`) when the API server wrote it from inside Docker;
 * rewrite to the local cwd so the local CLI can read the key. Mirrors the
 * pattern used elsewhere in provisioner.ts and the `run` subcommand.
 */
function resolveSshKeyPath(rawPath: string): string {
  return rawPath.replace(/^\/app\/alfred-ctrl\//, process.cwd() + "/");
}

/**
 * Fetch current size of the volume from Hetzner. Returns null on lookup
 * failure so callers can decide whether to attempt the resize anyway.
 */
async function getCurrentVolumeSize(
  hetzner: ReturnType<typeof getHetznerClient>,
  volumeId: number,
): Promise<number | null> {
  try {
    const volumes = await hetzner.listVolumes();
    const v = volumes.find((vol) => vol.id === volumeId);
    return v?.size ?? null;
  } catch {
    return null;
  }
}

export async function resizeVolume(
  instanceName: string,
  newSizeGb: number,
  log: LogFn = console.log,
): Promise<VolumeResizeResult> {
  if (!Number.isFinite(newSizeGb) || newSizeGb <= 0 || !Number.isInteger(newSizeGb)) {
    throw new Error(`Invalid size: ${newSizeGb} (must be a positive integer GB)`);
  }

  const instance = getInstanceByName(instanceName);
  if (!instance) throw new Error(`Instance "${instanceName}" not found`);
  if (!instance.volume_id) throw new Error(`Instance "${instanceName}" has no attached volume`);
  if (!instance.ip_address || !instance.ssh_key_path) {
    throw new Error(`Instance "${instanceName}" not fully provisioned (missing ip or ssh key)`);
  }

  const hetzner = getHetznerClient();
  const sshKeyPath = resolveSshKeyPath(instance.ssh_key_path);
  const ip = instance.ip_address;
  const volumeId = instance.volume_id;
  // Pin the host key when the instance has one persisted (every fully-
  // provisioned tenant does — see provisioner.ts ssh_host_key capture).
  // Mirrors the hardening in provisioner.ts/health.ts; without it the SSH
  // calls fall back to TOFU and reintroduce MITM risk on the fleet.
  const hostKeyOpts: SSHHostKeyOptions | undefined = instance.ssh_host_key
    ? { knownHostKey: instance.ssh_host_key }
    : undefined;

  // --- Step 1: Hetzner API resize (idempotent — pre-check size) ---
  log(`[1/3] Hetzner API: resize volume ${volumeId} -> ${newSizeGb}GB ...`);
  const currentSize = await getCurrentVolumeSize(hetzner, volumeId);
  let hetznerNoOp = false;
  if (currentSize !== null && currentSize >= newSizeGb) {
    hetznerNoOp = true;
    log(
      `      no-op — volume already at ${currentSize}GB (>= ${newSizeGb}GB requested). ` +
        `Continuing with cryptsetup/resize2fs in case those drifted.`,
    );
  } else {
    await hetzner.resizeVolume(volumeId, newSizeGb);
    log(
      `      ok — block device grown to ${newSizeGb}GB` +
        (currentSize !== null ? ` (was ${currentSize}GB)` : ""),
    );
  }

  // --- Step 2: stage helper script ---
  log(`[2/3] SSH (sftp): stage ${RESIZE_SCRIPT_PATH} ...`);
  await sshUpload(
    ip,
    sshKeyPath,
    RESIZE_SCRIPT,
    RESIZE_SCRIPT_PATH,
    0o755,
    undefined,
    hostKeyOpts,
  );
  log(`      ok — script uploaded`);

  // --- Step 3: run via the existing `bash /opt/alfred/*.sh` sudoers entry ---
  log(`[3/3] SSH: sudo bash ${RESIZE_SCRIPT_PATH} ...`);
  const runRes = await sshExec(
    ip,
    sshKeyPath,
    `sudo /usr/bin/bash ${RESIZE_SCRIPT_PATH}`,
    undefined,
    hostKeyOpts,
  );
  if (runRes.code !== 0) {
    throw new Error(
      `volume-resize.sh failed (code ${runRes.code}): stderr=${runRes.stderr.trim() || "(empty)"} stdout=${runRes.stdout.trim() || "(empty)"}`,
    );
  }
  log(runRes.stdout.trimEnd().split("\n").map((line) => `      ${line}`).join("\n"));

  // Pull just the df portion (after the "--- df ---" marker) for the result.
  const dfMarker = "--- df ---";
  const dfIdx = runRes.stdout.indexOf(dfMarker);
  const dfOutput =
    dfIdx >= 0
      ? runRes.stdout.slice(dfIdx + dfMarker.length).trim()
      : runRes.stdout.trim();

  return { volumeId, requestedSizeGb: newSizeGb, hetznerNoOp, dfOutput };
}
