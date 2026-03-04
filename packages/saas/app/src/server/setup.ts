import type { ServerSetupFn } from "wasp/server";
import { v1ApiProxy } from "../apikeys/proxy";
import { registerWebhookReceiver } from "./webhookReceiver";
import { attachTerminalProxy } from "./terminalProxy";

export const serverSetup: ServerSetupFn = async ({ app, server }) => {
  app.use("/api/v1", v1ApiProxy);
  registerWebhookReceiver(app);
  try {
    attachTerminalProxy(server);
    console.log("[setup] Terminal proxy attached successfully, server type:", typeof server, "has 'on':", typeof server?.on);
  } catch (err) {
    console.error("[setup] Failed to attach terminal proxy:", err);
  }
};