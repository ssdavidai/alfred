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

  const publicKey = await fs.readFile(publicKeyPath, "utf-8");
  return {
    publicKey: publicKey.trim(),
    privateKeyPath,
    publicKeyPath,
  };
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
