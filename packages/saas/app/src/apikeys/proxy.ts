import crypto from "crypto";
import express from "express";
import type { MiddlewareConfigFn } from "wasp/server";
import { prisma } from "wasp/server";
import { decryptApiKey } from "../server/tenantProxy";

const TENANT_API_TIMEOUT = 15_000;

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export const apiProxyMiddleware: MiddlewareConfigFn = (middlewareConfig) => {
  // Disable Wasp's default auth — we handle auth via Bearer token
  middlewareConfig.delete("authMiddleware");
  return middlewareConfig;
};

async function authenticateAndProxy(
  req: any,
  res: any,
  tenantPath: string,
): Promise<void> {
  // Extract Bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header. Use: Bearer <api-key>" });
  }

  const token = authHeader.slice(7);
  if (!token.startsWith("alf_")) {
    return res.status(401).json({ error: "Invalid API key format" });
  }

  // Look up key by hash
  const keyHash = hashKey(token);
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: { user: { include: { instance: true } } },
  });

  if (!apiKey) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  // Update lastUsedAt (fire-and-forget)
  prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});

  const instance = apiKey.user.instance;
  if (!instance) {
    return res.status(404).json({ error: "No instance found. Please complete setup first." });
  }
  if (!instance.tailscaleHostname || !instance.apiKey) {
    return res.status(503).json({ error: "Instance is not ready yet." });
  }
  if (instance.status !== "running") {
    return res.status(503).json({ error: `Instance is ${instance.status}. It must be running.` });
  }

  const tenantApiKey = decryptApiKey(instance.apiKey);
  const tenantUrl = buildTenantUrl(instance.tailscaleHostname, tenantPath, req.query);

  // Forward request to tenant
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TENANT_API_TIMEOUT);

  try {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: {
        Authorization: `Bearer ${tenantApiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    };

    // Forward body for non-GET requests
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(tenantUrl, fetchOptions);

    // Forward status and headers
    res.status(response.status);

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      return res.json(data);
    }

    const text = await response.text();
    res.set("Content-Type", contentType || "text/plain");
    return res.send(text);
  } finally {
    clearTimeout(timeout);
  }
}

// Legacy route: /user-api/vault/context → tenant /api/v1/vault/context
export const userApiProxy = async (req: any, res: any, _context: any) => {
  try {
    const fullPath: string = req.originalUrl || req.url || "";
    const prefixIndex = fullPath.indexOf("/user-api/");
    const subPath = prefixIndex >= 0 ? fullPath.slice(prefixIndex + "/user-api/".length) : "";
    const subPathClean = subPath.split("?")[0];
    const tenantPath = `/api/v1/${subPathClean}`;
    return await authenticateAndProxy(req, res, tenantPath);
  } catch (error: any) {
    if (error.name === "AbortError") {
      return res.status(504).json({ error: "Tenant API request timed out" });
    }
    console.error("API proxy error:", error);
    return res.status(502).json({ error: `Failed to reach tenant: ${error.message}` });
  }
};

// Public API route: /api/v1/* → tenant /api/v1/* (pass-through)
// Uses an Express Router with its own json() middleware because Wasp's
// middleware config only applies to Wasp-defined api routes, not app.use().
// Without this, POST request bodies are undefined and never forwarded.
const v1Router = express.Router();
v1Router.use(express.json({ limit: "50mb" }));
v1Router.all("*", async (req: any, res: any) => {
  try {
    const fullPath: string = req.originalUrl || req.url || "";
    const tenantPath = fullPath.split("?")[0];
    return await authenticateAndProxy(req, res, tenantPath);
  } catch (error: any) {
    if (error.name === "AbortError") {
      return res.status(504).json({ error: "Tenant API request timed out" });
    }
    console.error("API proxy error:", error);
    return res.status(502).json({ error: `Failed to reach tenant: ${error.message}` });
  }
});
export const v1ApiProxy = v1Router;

function buildTenantUrl(
  hostname: string,
  path: string,
  query?: Record<string, string>,
): string {
  const base = `https://${hostname}:3100${path}`;
  if (!query || Object.keys(query).length === 0) return base;
  // Filter out express internal params
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k !== "path") {
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
