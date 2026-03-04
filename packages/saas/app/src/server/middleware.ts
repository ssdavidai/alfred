import express from "express";
import type { MiddlewareConfigFn } from "wasp/server";

// Increase JSON body limit globally to support file uploads (base64-encoded).
// Default express.json limit is 100KB which is too small for binary files.
export const serverMiddlewareFn: MiddlewareConfigFn = (middlewareConfig) => {
  middlewareConfig.set("express.json", express.json({ limit: "50mb" }));
  return middlewareConfig;
};
