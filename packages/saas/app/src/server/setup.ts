import type { ServerSetupFn } from "wasp/server";
import { v1ApiProxy } from "../apikeys/proxy";
import { registerWebhookReceiver } from "./webhookReceiver";
import { registerOAuth2Routes } from "./oauth2";
import { attachTerminalProxy, registerTerminalStatusRoute } from "./terminalProxy";
import { attachAdminTerminalProxy, registerAdminTerminalStatusRoute } from "./adminTerminalProxy";

export const serverSetup: ServerSetupFn = async ({ app, server }) => {
  app.use("/api/v1", v1ApiProxy);
  registerWebhookReceiver(app);
  registerOAuth2Routes(app);
  try {
    registerTerminalStatusRoute(app);
    attachTerminalProxy(server);
    console.log("[setup] Terminal proxy attached successfully");
  } catch (err) {
    console.error("[setup] Failed to attach terminal proxy:", err);
  }
  try {
    registerAdminTerminalStatusRoute(app);
    attachAdminTerminalProxy(server);
    console.log("[setup] Admin terminal proxy attached successfully");
  } catch (err) {
    console.error("[setup] Failed to attach admin terminal proxy:", err);
  }
};