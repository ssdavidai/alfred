/**
 * orphan-scanner.ts — Detect and optionally clean up orphaned Hetzner resources.
 *
 * Scans for Hetzner servers, volumes, and SSH keys that have alfred-ctrl labels
 * but no matching instance record in the local database. These are typically
 * left behind when provisioning fails mid-way.
 *
 * Usage:
 *   aas scan-orphans           # Report orphaned resources
 *   aas scan-orphans --cleanup # Report + destroy orphaned resources
 */

import { getHetznerClient } from "./hetzner.js";
import { getDb } from "../db/index.js";

export interface OrphanReport {
  servers: Array<{ id: number; name: string; ip: string; created: string }>;
  volumes: Array<{ id: number; name: string; size: number; location: string }>;
  sshKeys: Array<{ id: number; name: string }>;
  total: number;
}

/**
 * Scan for orphaned Hetzner resources that have no matching DB instance.
 */
export async function scanOrphans(): Promise<OrphanReport> {
  const hetzner = getHetznerClient();
  const db = getDb();

  // Get all instance server/volume/SSH key IDs from the DB
  const instances = db
    .prepare("SELECT server_id, volume_id, ssh_key_id, customer_name, status FROM instances")
    .all() as Array<{
      server_id: number | null;
      volume_id: number | null;
      ssh_key_id: number | null;
      customer_name: string;
      status: string;
    }>;

  const knownServerIds = new Set(instances.map((i) => i.server_id).filter(Boolean));
  const knownVolumeIds = new Set(instances.map((i) => i.volume_id).filter(Boolean));
  const knownSshKeyIds = new Set(instances.map((i) => i.ssh_key_id).filter(Boolean));
  const knownNames = new Set(instances.map((i) => i.customer_name));

  const report: OrphanReport = {
    servers: [],
    volumes: [],
    sshKeys: [],
    total: 0,
  };

  // --- Scan servers ---
  try {
    const { servers } = await hetzner.listServers();
    for (const server of servers) {
      // Check if this server belongs to alfred-ctrl (by label)
      const labels = server.labels || {};
      if (!labels["managed-by"]?.includes("alfred") && !labels.customer) continue;

      // Check if it's tracked in the DB
      if (!knownServerIds.has(server.id)) {
        report.servers.push({
          id: server.id,
          name: server.name,
          ip: server.public_net?.ipv4?.ip || "unknown",
          created: server.created,
        });
      }
    }
  } catch (e) {
    console.error("Failed to scan Hetzner servers:", e);
  }

  // --- Scan volumes ---
  try {
    const volumes = await hetzner.listVolumes();
    for (const volume of volumes) {
      // Check if it's an alfred volume (by name prefix)
      if (!volume.name.startsWith("alfred-")) continue;

      if (!knownVolumeIds.has(volume.id)) {
        report.volumes.push({
          id: volume.id,
          name: volume.name,
          size: volume.size,
          location: volume.location?.name || "unknown",
        });
      }
    }
  } catch (e) {
    console.error("Failed to scan Hetzner volumes:", e);
  }

  // --- Scan SSH keys ---
  try {
    const sshKeys = await hetzner.listSSHKeys();
    for (const key of sshKeys) {
      // Check if it's an alfred-ctrl key (by name prefix)
      if (!key.name.startsWith("alfred-ctrl-")) continue;

      if (!knownSshKeyIds.has(key.id)) {
        report.sshKeys.push({
          id: key.id,
          name: key.name,
        });
      }
    }
  } catch (e) {
    console.error("Failed to scan Hetzner SSH keys:", e);
  }

  report.total = report.servers.length + report.volumes.length + report.sshKeys.length;
  return report;
}

/**
 * Destroy all orphaned resources found by the scanner.
 */
export async function cleanupOrphans(
  report: OrphanReport,
  onLog?: (msg: string) => void
): Promise<{ deleted: number; errors: number }> {
  const hetzner = getHetznerClient();
  const log = (msg: string) => onLog?.(msg);
  let deleted = 0;
  let errors = 0;

  // Delete orphaned servers first (most expensive resource)
  for (const server of report.servers) {
    try {
      log(`Deleting orphaned server ${server.id} (${server.name})...`);
      await hetzner.deleteServer(server.id);
      deleted++;
      log(`  Deleted server ${server.id}`);
    } catch (e) {
      errors++;
      log(`  Failed to delete server ${server.id}: ${e}`);
    }
  }

  // Delete orphaned volumes
  for (const volume of report.volumes) {
    try {
      log(`Deleting orphaned volume ${volume.id} (${volume.name})...`);
      await hetzner.deleteVolume(volume.id);
      deleted++;
      log(`  Deleted volume ${volume.id}`);
    } catch (e) {
      errors++;
      log(`  Failed to delete volume ${volume.id}: ${e}`);
    }
  }

  // Delete orphaned SSH keys
  for (const sshKey of report.sshKeys) {
    try {
      log(`Deleting orphaned SSH key ${sshKey.id} (${sshKey.name})...`);
      await hetzner.deleteSSHKey(sshKey.id);
      deleted++;
      log(`  Deleted SSH key ${sshKey.id}`);
    } catch (e) {
      errors++;
      log(`  Failed to delete SSH key ${sshKey.id}: ${e}`);
    }
  }

  return { deleted, errors };
}
