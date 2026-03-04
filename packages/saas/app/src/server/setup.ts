import type { ServerSetupFn } from "wasp/server";
import { v1ApiProxy } from "../apikeys/proxy";
import { registerWebhookReceiver } from "./webhookReceiver";

export const serverSetup: ServerSetupFn = async ({ app }) => {
  app.use("/api/v1", v1ApiProxy);
  registerWebhookReceiver(app);
};