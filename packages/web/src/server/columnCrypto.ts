// Column-level encryption for API keys / secrets stored in PostgreSQL.
//
// Lifted out of `tenantProxy.ts` so callers (and tests) can import the
// crypto helpers without pulling in Wasp's `wasp/server` runtime, which
// only exists inside the generated `.wasp/out` tree and breaks plain
// `tsx --test` runs.
//
// AES-256-GCM, 12-byte random IV, 16-byte auth tag. Keyed off the
// `COLUMN_ENCRYPTION_KEY` env var (32 bytes hex-encoded — same key used
// by every encrypted column on the SaaS side).

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const key = process.env.COLUMN_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("COLUMN_ENCRYPTION_KEY environment variable is required");
  }
  // AES-256 wants 32 bytes = 64 hex chars. Validate up front so a misconfigured
  // env produces a clear error instead of a generic "Invalid key length" from
  // crypto.createCipheriv at the first encrypt/decrypt call.
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "COLUMN_ENCRYPTION_KEY must be 64 hex characters (32 bytes) for AES-256",
    );
  }
  return Buffer.from(key, "hex");
}

export function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

export function decryptApiKey(ciphertext: string): string {
  const key = getEncryptionKey();
  const [ivHex, tagHex, encrypted] = ciphertext.split(":");
  if (!ivHex || !tagHex || !encrypted) {
    // If not encrypted (e.g. during development), return as-is
    return ciphertext;
  }
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
