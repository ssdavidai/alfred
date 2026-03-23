import { HttpError } from "wasp/server";
import { Instance } from "wasp/entities";
import crypto from "crypto";

const TENANT_API_TIMEOUT = 15_000;

interface ProxyOptions {
  method?: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  timeoutMs?: number;
}

export async function proxyToTenant(
  instance: Instance | null,
  options: ProxyOptions,
): Promise<any> {
  if (!instance) {
    throw new HttpError(404, "No instance found. Please complete setup first.");
  }

  if (!instance.tailscaleHostname || !instance.apiKey) {
    throw new HttpError(
      503,
      "Instance is not ready yet. Please wait for provisioning to complete.",
    );
  }

  if (instance.status !== "running") {
    throw new HttpError(
      503,
      `Instance is ${instance.status}. It must be running to access the dashboard.`,
    );
  }

  const apiKey = decryptApiKey(instance.apiKey);
  // Route through Cloudflare tunnel (subdomainUrl) since the Wasp
  // container runs on a Docker bridge network without Tailscale access.
  // The CF tunnel routes /api/v1/* to ctrl-api on port 3100.
  const url = instance.subdomainUrl
    ? buildSubdomainUrl(instance.subdomainUrl, options.path, options.query)
    : buildUrl(instance.tailscaleHostname, options.path, options.query);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || TENANT_API_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Sanitize error messages to avoid leaking internal details
      const safeMessage =
        response.status === 404
          ? "Resource not found"
          : response.status === 401
            ? "Authentication failed"
            : response.status >= 500
              ? "Internal tenant error"
              : text?.slice(0, 200) || response.statusText;
      throw new HttpError(response.status, safeMessage);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  } catch (error: any) {
    if (error instanceof HttpError) throw error;
    if (error.name === "AbortError") {
      throw new HttpError(504, "Tenant API request timed out");
    }
    throw new HttpError(502, "Failed to reach tenant instance");
  } finally {
    clearTimeout(timeout);
  }
}

function buildUrl(
  hostname: string,
  path: string,
  query?: Record<string, string>,
): string {
  const base = `https://${hostname}:3100${path}`;
  if (!query || Object.keys(query).length === 0) return base;
  const params = new URLSearchParams(query);
  return `${base}?${params.toString()}`;
}

function buildSubdomainUrl(
  subdomainUrl: string,
  path: string,
  query?: Record<string, string>,
): string {
  // Route through Cloudflare tunnel: https://tenant.alfred.black/api/v1/...
  const base = `${subdomainUrl.replace(/\/$/, "")}${path}`;
  if (!query || Object.keys(query).length === 0) return base;
  const params = new URLSearchParams(query);
  return `${base}?${params.toString()}`;
}

export async function getUserInstance(context: any): Promise<Instance | null> {
  if (!context.user) {
    throw new HttpError(401, "Not authenticated");
  }
  return context.entities.Instance.findUnique({
    where: { userId: context.user.id },
  });
}

// Encryption helpers for API keys stored in PostgreSQL
const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const key = process.env.COLUMN_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("COLUMN_ENCRYPTION_KEY environment variable is required");
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
