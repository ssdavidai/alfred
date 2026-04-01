import nunjucks from "nunjucks";
import crypto from "crypto";

import { getHetznerClient, type HetznerImage } from "./hetzner.js";
import { generateKeyPair, cleanupKeyPair } from "./keys.js";
import { ensureFirewall } from "./firewall.js";
import * as ssh from "./ssh.js";
import type { SSHHostKeyOptions } from "./ssh.js";
import { DEFAULTS } from "../data/constants.js";

import cloudInitTemplate from "../templates/cloud-init.yaml.njk";
import dockerComposeTemplate from "../templates/docker-compose.yaml.njk";

nunjucks.configure({ autoescape: false });

const SNAPSHOT_LABEL = "alfred-golden";
const SNAPSHOT_LABEL_SELECTOR = `managed-by=alfred-ctrl,type=${SNAPSHOT_LABEL}`;

export interface SnapshotBuildResult {
  imageId: number;
  description: string;
  createdAt: string;
}

/**
 * Build a golden snapshot: spin up a throwaway VPS, run cloud-init,
 * pull all Docker images, clean up, snapshot, and destroy the VPS.
 */
export async function buildSnapshot(
  onLog?: (msg: string) => void,
  location: string = "fsn1",
): Promise<SnapshotBuildResult> {
  const hetzner = getHetznerClient();
  const log = (msg: string) => onLog?.(msg);

  const buildId = crypto.randomBytes(4).toString("hex");
  const name = `alfred-snapshot-builder-${buildId}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  let serverId: number | null = null;
  let sshKeyId: number | null = null;
  let keyPairPath: string | null = null;
  // Use a synthetic instance ID for keypair storage
  const syntheticId = Date.now();

  try {
    // --- Generate temp SSH keypair ---
    log("Generating temporary SSH keypair...");
    const keyPair = await generateKeyPair(syntheticId);
    keyPairPath = keyPair.privateKeyPath;

    // --- Upload SSH key ---
    log("Uploading SSH key to Hetzner...");
    const { ssh_key } = await hetzner.createSSHKey(`snapshot-builder-${buildId}`, keyPair.publicKey);
    sshKeyId = ssh_key.id;

    // --- Ensure firewall ---
    const firewallId = await ensureFirewall();

    // --- Create throwaway VPS with full cloud-init ---
    // Use a dummy volume_id=0 — cloud-init will skip LUKS since no volume is attached
    log("Rendering cloud-init for snapshot build...");
    const cloudInit = nunjucks.renderString(cloudInitTemplate, {
      ssh_public_key: keyPair.publicKey,
      volume_id: 0,
    });

    log(`Creating snapshot builder VPS (cx33 in ${location})...`);
    const { server } = await hetzner.createServer({
      name,
      server_type: "cx33",  // smallest viable — only needs to pull images
      location,
      ssh_keys: [ssh_key.id],
      user_data: cloudInit,
      firewalls: [{ firewall: firewallId }],
      labels: { purpose: "snapshot-builder" },
    });
    serverId = server.id;
    const ip = server.public_net.ipv4.ip;
    log(`VPS created (id: ${serverId}, ip: ${ip})`);

    // --- Wait for cloud-init ---
    log("Waiting for cloud-init (up to 10 min)...");
    let capturedHostKey: string | undefined;
    const captureHostKey: SSHHostKeyOptions = {
      onHostKey: (fp) => { if (!capturedHostKey) capturedHostKey = fp; },
    };
    await ssh.waitForFile(
      ip,
      keyPair.privateKeyPath,
      `${DEFAULTS.alfredBasePath}/.cloud-init-complete`,
      DEFAULTS.cloudInitTimeout,
      10_000,
      undefined,
      captureHostKey,
    );
    log("Cloud-init complete");

    const hostKeyOpts: SSHHostKeyOptions = capturedHostKey
      ? { knownHostKey: capturedHostKey }
      : {};

    // --- Upload docker-compose and pull all images ---
    log("Uploading docker-compose.yaml...");
    await ssh.exec(ip, keyPair.privateKeyPath, `sudo mkdir -p ${DEFAULTS.dockerComposeDir}`, undefined, hostKeyOpts);
    await ssh.upload(ip, keyPair.privateKeyPath, dockerComposeTemplate, `${DEFAULTS.dockerComposeDir}/docker-compose.yaml`, 0o644, undefined, hostKeyOpts);

    log("Pulling all Docker images (this may take several minutes)...");
    const pullResult = await ssh.exec(
      ip,
      keyPair.privateKeyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose pull 2>&1`,
      undefined,
      hostKeyOpts,
    );
    if (pullResult.code !== 0) {
      throw new Error(`Docker pull failed: ${pullResult.stderr || pullResult.stdout}`);
    }
    log("All images pulled");

    // --- Clean up for snapshot ---
    log("Cleaning up for snapshot...");
    await ssh.exec(
      ip,
      keyPair.privateKeyPath,
      [
        // Remove tenant-specific artifacts
        `rm -f ${DEFAULTS.dockerComposeDir}/docker-compose.yaml`,
        `rm -f ${DEFAULTS.dockerComposeDir}/.env`,
        `rm -f ${DEFAULTS.alfredBasePath}/.cloud-init-complete`,
        // Clean apt cache
        "sudo apt-get clean",
        "sudo rm -rf /var/lib/apt/lists/*",
        // Clean cloud-init state so it re-runs on next boot
        "sudo cloud-init clean --logs",
        // Remove SSH host keys — regenerated on snapshot boot
        "sudo rm -f /etc/ssh/ssh_host_*",
        // Remove machine-id — regenerated on snapshot boot
        "sudo rm -f /etc/machine-id /var/lib/dbus/machine-id",
        // Clean logs
        "sudo journalctl --vacuum-size=1M",
        "sudo truncate -s 0 /var/log/syslog /var/log/auth.log 2>/dev/null || true",
        // Remove the deploy user's authorized_keys (snapshot-specific key)
        "rm -f ~/.ssh/authorized_keys",
        // Sync to flush to disk
        "sync",
      ].join(" && "),
      undefined,
      hostKeyOpts,
    );
    log("Cleanup done");

    // --- Power off before snapshot (cleaner snapshot) ---
    log("Powering off VPS for clean snapshot...");
    await hetzner.poweroffServer(serverId);
    // Wait for server to be off
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const { server: s } = await hetzner.getServer(serverId);
      if (s.status === "off") break;
    }
    log("VPS powered off");

    // --- Create snapshot ---
    const description = `alfred-golden-${timestamp}`;
    log(`Creating snapshot: ${description}...`);
    const { image } = await hetzner.createImage(serverId, description, {
      type: SNAPSHOT_LABEL,
      built: timestamp,
    });
    log(`Snapshot created (id: ${image.id})`);

    // Wait for snapshot to be available
    log("Waiting for snapshot to be available...");
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const { image: img } = await hetzner.getImage(image.id);
      if (img.status === "available") break;
    }
    log("Snapshot ready");

    return {
      imageId: image.id,
      description,
      createdAt: image.created,
    };
  } finally {
    // --- Destroy throwaway VPS ---
    if (serverId) {
      log("Destroying snapshot builder VPS...");
      try {
        await hetzner.deleteServer(serverId);
        log("VPS destroyed");
      } catch (e) {
        log(`Warning: failed to destroy VPS ${serverId}: ${e}`);
      }
    }
    // --- Clean up SSH key ---
    if (sshKeyId) {
      try {
        await hetzner.deleteSSHKey(sshKeyId);
      } catch { /* best effort */ }
    }
    if (keyPairPath) {
      try {
        await cleanupKeyPair(syntheticId);
      } catch { /* best effort */ }
    }
  }
}

/**
 * List golden snapshots, newest first.
 */
export async function listSnapshots(): Promise<HetznerImage[]> {
  const hetzner = getHetznerClient();
  const { images } = await hetzner.listImages("snapshot", SNAPSHOT_LABEL_SELECTOR);
  return images.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
}

/**
 * Get the latest golden snapshot ID, or null if none exists.
 */
export async function getLatestSnapshotId(): Promise<number | null> {
  const images = await listSnapshots();
  return images.length > 0 ? images[0].id : null;
}

/**
 * Delete a snapshot by ID.
 */
export async function deleteSnapshot(imageId: number): Promise<void> {
  const hetzner = getHetznerClient();
  await hetzner.deleteImage(imageId);
}
