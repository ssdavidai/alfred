import fs from "node:fs";
import path from "node:path";

// Load .env if present
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

import { setApiKey } from "./auth.js";
import { createApiServer } from "./server.js";
import { attachTerminalUpgrade } from "./routes/terminal.js";

const apiKey = process.env.AAS_API_KEY;
if (!apiKey) {
  console.error("FATAL: AAS_API_KEY environment variable is required");
  process.exit(1);
}

setApiKey(apiKey);

const port = parseInt(process.env.AAS_PORT ?? "3100", 10);
const host = process.env.AAS_HOST ?? "127.0.0.1";

const server = createApiServer();

// Attach terminal WebSocket upgrade handler
attachTerminalUpgrade(server);
(globalThis as any).__terminalReady = true;
console.log("Terminal WebSocket endpoint attached");

server.listen(port, host, () => {
  console.log(`Alfred tenant API listening on http://${host}:${port}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  server.close(() => process.exit(0));
});
