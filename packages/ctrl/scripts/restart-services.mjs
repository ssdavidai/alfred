#!/usr/bin/env node
/**
 * Restart Docker services on all running tenant instances.
 * Runs on the control plane.
 */
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const CTRL_DIR = "/opt/alfred-saas/alfred-ctrl";
const DB_PATH = join(CTRL_DIR, "data", "alfred-ctrl.db");

if (!existsSync(DB_PATH)) {
  console.error(`ERROR: DB not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const rows = db.prepare(
  `SELECT id, customer_name, ip_address, ssh_key_path FROM instances WHERE status='running' AND ip_address IS NOT NULL AND ssh_key_path IS NOT NULL`
).all();
db.close();

console.log(`Found ${rows.length} running instance(s)`);

let failures = 0;

for (const row of rows) {
  const { customer_name: name, ip_address: ip } = row;
  let keyPath = row.ssh_key_path;
  keyPath = keyPath.replace(/^\/app\/alfred-ctrl\//, `${CTRL_DIR}/`);

  if (!existsSync(keyPath)) {
    console.log(`SKIP ${name} (${ip}): key not found at ${keyPath}`);
    continue;
  }

  console.log(`\n=== ${name} (${ip}) ===`);
  const sshOpts = `-o StrictHostKeyChecking=no -o ConnectTimeout=20 -i ${keyPath}`;
  const sshTarget = `deploy@${ip}`;

  try {
    const result = execSync(
      `ssh ${sshOpts} ${sshTarget} "cd /opt/alfred/compose && docker compose restart openclaw alfred 2>&1; sleep 5; docker compose ps 2>&1"`,
      { encoding: "utf8", timeout: 120000 }
    );
    console.log(result);
    console.log(`  SUCCESS: ${name}`);
  } catch (err) {
    console.log(`  FAILED: ${name} — ${err.message.split("\n")[0]}`);
    failures++;
  }
}

console.log(`\n=== Restart complete ===`);
if (failures > 0) process.exit(1);
