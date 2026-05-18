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
import { flushPendingOpenclawWrites } from "./routes/integrations.js";
import { getStateDb, closeStateDb } from "../db/state.js";
import { getIngestDb, startIngestSweep, closeIngestDb } from "../db/ingest.js";
import { reconcileVaultIndex } from "../db/vaultIndex.js";

const apiKey = process.env.AAS_API_KEY;
if (!apiKey) {
  console.error("FATAL: AAS_API_KEY environment variable is required");
  process.exit(1);
}

setApiKey(apiKey);

// ---------------------------------------------------------------------------
// Four-store boot (PLAN.md Part I).
//
//   1. Open state.db (Store 2) — ctrl-api is its SOLE write handle. This also
//      loads the sqlite-vec extension and creates the `embedding` vec0 table.
//   2. Open ingest.db (Store 4) and start the periodic 7-day TTL sweep.
//   3. Reconcile vault_index against the markdown vault (Store 1) — catches
//      out-of-band edits made while ctrl-api was down. Per-write hooks keep it
//      exact thereafter.
//
// A reconcile failure (e.g. the vault volume not yet mounted on a cold first
// boot) is logged but non-fatal — the index self-heals on the next vault
// write or an explicit POST /api/v1/vault-index/reconcile.
// ---------------------------------------------------------------------------
getStateDb();
getIngestDb();
startIngestSweep();
try {
  reconcileVaultIndex();
} catch (err) {
  console.error(`[boot] vault_index reconcile failed (non-fatal): ${err}`);
}

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

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down...`);
  flushPendingOpenclawWrites();
  closeIngestDb();
  closeStateDb();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("beforeExit", () => {
  flushPendingOpenclawWrites();
});
