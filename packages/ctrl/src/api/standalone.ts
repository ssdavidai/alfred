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
import { openStateDb, runMigrations } from "../db/state.js";
import { scanVaultAndPopulate, vaultIndexIsEmpty } from "./vault_indexer.js";

const apiKey = process.env.AAS_API_KEY;
if (!apiKey) {
  console.error("FATAL: AAS_API_KEY environment variable is required");
  process.exit(1);
}

setApiKey(apiKey);

try {
  const stateDb = openStateDb();
  const result = await runMigrations(stateDb);
  console.log(
    `migrations.run: applied=[${result.applied.join(",")}] skipped=[${result.skipped.join(",")}]`,
  );

  // STORE-P1-2: backfill the vault_index read accelerator on first boot
  // after migration 002 lands. The boot blocks on the scan deliberately
  // — every list endpoint that we rewire onto vault_index in P1-4 needs
  // the table populated before it answers, and the alternative (lazy
  // first-request scan) would race with the SaaS proxy's first poll.
  if (vaultIndexIsEmpty(stateDb)) {
    console.log("vault_index empty — running initial scan...");
    const scan = await scanVaultAndPopulate({ db: stateDb });
    console.log(
      `vault_indexer.scan: scanned=${scan.scanned} inserted=${scan.inserted} elapsed_ms=${scan.ms}`,
    );
  } else {
    const row = stateDb
      .prepare("SELECT count(*) AS n FROM vault_index")
      .get() as { n: number };
    console.log(`vault_index has ${row.n} rows; skipping initial scan`);
  }
} catch (err) {
  console.error(`FATAL: state.db migrations failed: ${(err as Error).message}`);
  process.exit(1);
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

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  flushPendingOpenclawWrites();
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  flushPendingOpenclawWrites();
  server.close(() => process.exit(0));
});

process.on("beforeExit", () => {
  flushPendingOpenclawWrites();
});
