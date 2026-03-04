import express from "express";
import type { MiddlewareConfigFn } from "wasp/server";
import { proxyToTenant } from "../server/tenantProxy";

// Allow up to 50MB JSON bodies for file uploads (base64-encoded files)
export const uploadMiddleware: MiddlewareConfigFn = (middlewareConfig) => {
  middlewareConfig.set("express.json", express.json({ limit: "50mb" }));
  return middlewareConfig;
};

export const uploadToInbox = async (req: any, res: any, context: any) => {
  if (!context.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const instance = await context.entities.Instance.findUnique({
    where: { userId: context.user.id },
  });

  if (!instance) {
    return res.status(404).json({ error: "No instance found. Please complete setup first." });
  }

  const { filename, content, encoding } = req.body;
  if (typeof filename !== "string" || typeof content !== "string") {
    return res.status(400).json({ error: "filename and content are required" });
  }

  try {
    const result = await proxyToTenant(instance, {
      method: "POST",
      path: "/api/v1/vault/inbox",
      body: { filename, content, ...(encoding ? { encoding } : {}) },
      timeoutMs: 60_000,
    });
    return res.json(result);
  } catch (error: any) {
    const status = error.statusCode || 500;
    return res.status(status).json({ error: error.message || "Upload failed" });
  }
};
