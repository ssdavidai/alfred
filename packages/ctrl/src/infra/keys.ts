import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

export interface KeyPair {
  publicKey: string;
  privateKeyPath: string;
  publicKeyPath: string;
}

export async function generateKeyPair(instanceId: number): Promise<KeyPair> {
  const keyDir = path.join(process.cwd(), "data", "ssh_keys", String(instanceId));
  await fs.mkdir(keyDir, { recursive: true });

  const privateKeyPath = path.join(keyDir, "id_ed25519");
  const publicKeyPath = `${privateKeyPath}.pub`;

  // Remove existing keys if any
  await fs.rm(privateKeyPath, { force: true });
  await fs.rm(publicKeyPath, { force: true });

  await execFileAsync("ssh-keygen", [
    "-t",
    "ed25519",
    "-f",
    privateKeyPath,
    "-N",
    "",
    "-C",
    `alfred-ctrl-${instanceId}`,
  ]);

  // Ensure the deploy user can read the keys (provisioner may run as root
  // inside Docker, but the aas CLI runs as deploy on the host).
  // Use numeric UID 1000 (standard first non-root user on Ubuntu/Debian VMs).
  const deployUid = process.env.DEPLOY_UID ?? "1000";
  const deployGid = process.env.DEPLOY_GID ?? "1000";
  try {
    await execFileAsync("chown", ["-R", `${deployUid}:${deployGid}`, keyDir]);
  } catch (err: unknown) {
    // Not running as root — keys are already owned by current user
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Operation not permitted")) {
      console.warn(`Warning: could not chown key directory: ${msg}`);
    }
  }

  const publicKey = await fs.readFile(publicKeyPath, "utf-8");
  return {
    publicKey: publicKey.trim(),
    privateKeyPath,
    publicKeyPath,
  };
}

export async function cleanupKeyPair(instanceId: number): Promise<void> {
  const keyDir = path.join(process.cwd(), "data", "ssh_keys", String(instanceId));
  await fs.rm(keyDir, { recursive: true, force: true });
}

export async function getPrivateKeyPath(instanceId: number): Promise<string> {
  const keyPath = path.join(
    process.cwd(),
    "data",
    "ssh_keys",
    String(instanceId),
    "id_ed25519"
  );
  await fs.access(keyPath);
  return keyPath;
}
