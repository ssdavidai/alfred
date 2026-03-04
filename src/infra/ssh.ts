import { Client } from "ssh2";
import crypto from "crypto";
import fs from "fs/promises";
import { DEFAULTS } from "../data/constants.js";

export interface SSHResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SSHHostKeyOptions {
  /** Known host key fingerprint (SHA-256 hex). If set, connections are rejected on mismatch. */
  knownHostKey?: string;
  /** Called with the host key fingerprint on successful connection. Use to capture and store the key. */
  onHostKey?: (fingerprint: string) => void;
}

function fingerprintKey(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function buildConnectOptions(
  host: string,
  privateKey: Buffer,
  user: string,
  hostKeyOpts?: SSHHostKeyOptions,
) {
  return {
    host,
    port: 22,
    username: user,
    privateKey,
    hostVerify: (key: Buffer) => {
      const fp = fingerprintKey(key);
      hostKeyOpts?.onHostKey?.(fp);
      if (hostKeyOpts?.knownHostKey && hostKeyOpts.knownHostKey !== fp) {
        return false;
      }
      return true;
    },
  };
}

export async function exec(
  host: string,
  keyPath: string,
  command: string,
  user: string = DEFAULTS.sshUser,
  hostKeyOpts?: SSHHostKeyOptions,
): Promise<SSHResult> {
  const privateKey = await fs.readFile(keyPath);

  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on("close", (code: number) => {
          conn.end();
          resolve({ stdout, stderr, code: code ?? 0 });
        });
      });
    });

    conn.on("error", reject);

    conn.connect(buildConnectOptions(host, privateKey, user, hostKeyOpts));
  });
}

export async function upload(
  host: string,
  keyPath: string,
  content: string,
  remotePath: string,
  mode?: number,
  user: string = DEFAULTS.sshUser,
  hostKeyOpts?: SSHHostKeyOptions,
): Promise<void> {
  const privateKey = await fs.readFile(keyPath);

  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        const writeStream = sftp.createWriteStream(remotePath, {
          mode: mode ?? 0o644,
        });

        writeStream.on("close", () => {
          conn.end();
          resolve();
        });

        writeStream.on("error", (writeErr: Error) => {
          conn.end();
          reject(writeErr);
        });

        writeStream.end(content);
      });
    });

    conn.on("error", reject);

    conn.connect(buildConnectOptions(host, privateKey, user, hostKeyOpts));
  });
}

export async function download(
  host: string,
  keyPath: string,
  remotePath: string,
  user: string = DEFAULTS.sshUser,
  hostKeyOpts?: SSHHostKeyOptions,
): Promise<string> {
  const privateKey = await fs.readFile(keyPath);

  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        let data = "";
        const readStream = sftp.createReadStream(remotePath);

        readStream.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });

        readStream.on("end", () => {
          conn.end();
          resolve(data);
        });

        readStream.on("error", (readErr: Error) => {
          conn.end();
          reject(readErr);
        });
      });
    });

    conn.on("error", reject);

    conn.connect(buildConnectOptions(host, privateKey, user, hostKeyOpts));
  });
}

export async function waitForFile(
  host: string,
  keyPath: string,
  filePath: string,
  timeoutMs = DEFAULTS.cloudInitTimeout,
  pollMs = 10_000,
  user: string = DEFAULTS.sshUser,
  hostKeyOpts?: SSHHostKeyOptions,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const result = await exec(host, keyPath, `test -f ${filePath} && echo ok`, user, hostKeyOpts);
      if (result.stdout.trim() === "ok") return;
    } catch {
      // SSH not ready yet, keep polling
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(`Timed out waiting for ${filePath} after ${timeoutMs}ms`);
}
