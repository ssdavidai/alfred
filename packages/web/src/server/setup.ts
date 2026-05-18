import type { ServerSetupFn } from "wasp/server";
import { v1ApiProxy } from "../apikeys/proxy";
import { registerWebhookReceiver } from "./webhookReceiver";
import { registerAgentMailReceiver } from "./agentmailReceiver";
import { registerOAuth2Routes } from "./oauth2";
import { attachTerminalProxy, registerTerminalStatusRoute } from "./terminalProxy";

export const serverSetup: ServerSetupFn = async ({ app, server }) => {
  app.use("/api/v1", v1ApiProxy);
  // AgentMail MUST register BEFORE the generic webhookReceiver. The generic
  // one owns /webhooks/:webhookToken which Express matches greedily —
  // /webhooks/agentmail would otherwise be routed to the generic handler with
  // "agentmail" as the webhookToken, then 404 because no Stream has that
  // token. Registering the specific route first makes Express match it
  // before falling through to the parameterized one.
  registerAgentMailReceiver(app);
  registerWebhookReceiver(app);
  registerOAuth2Routes(app);
  try {
    registerTerminalStatusRoute(app);
    attachTerminalProxy(server);
    console.log("[setup] Terminal proxy attached successfully");
  } catch (err) {
    console.error("[setup] Failed to attach terminal proxy:", err);
  }
};