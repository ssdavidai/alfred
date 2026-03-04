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

const apiKey = process.env.AAS_API_KEY;
if (!apiKey) {
  console.error("FATAL: AAS_API_KEY environment variable is required");
  process.exit(1);
}

setApiKey(apiKey);

const port = parseInt(process.env.AAS_PORT ?? "3100", 10);
const host = process.env.AAS_HOST ?? "127.0.0.1";

const server = createApiServer();

// Terminal WebSocket — loaded dynamically to avoid blocking startup if ws fails
import("./routes/terminal.js")
  .then(({ attachTerminalUpgrade }) => {
    attachTerminalUpgrade(server);
    console.log("Terminal WebSocket endpoint attached");
  })
  .catch((err) => {
    console.error("Failed to load terminal module (non-fatal):", err.message);
  });

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
