#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const CTRL_DIR = "/opt/alfred-saas/alfred-ctrl";
const DB_PATH = join(CTRL_DIR, "data", "alfred-ctrl.db");
const db = new DatabaseSync(DB_PATH);

// First list all instances to see what's there
const all = db.prepare(`SELECT id, customer_name, ip_address, status FROM instances`).all();
console.log("=== All instances ===");
for (const r of all) {
  console.log(`  ${r.id}: ${r.customer_name} | ip=${r.ip_address} | status=${r.status}`);
}

// Find Sir's instance
const rows = db.prepare(
  `SELECT id, customer_name, ip_address, ssh_key_path FROM instances WHERE customer_name LIKE '%david%' AND status='running' AND ip_address IS NOT NULL`
).all();
db.close();

if (!rows.length) { console.log("No matching Sir instance"); process.exit(1); }

for (const row of rows) {
  const { customer_name: name, ip_address: ip, id } = row;
  let keyPath = row.ssh_key_path;
  if (!keyPath) { console.log(`SKIP ${name}: no SSH key`); continue; }
  keyPath = keyPath.replace(/^\/app\/alfred-ctrl\//, `${CTRL_DIR}/`);
  if (!existsSync(keyPath)) { console.log(`SKIP ${name}: key not found at ${keyPath}`); continue; }

  const sshOpts = `-o StrictHostKeyChecking=no -o ConnectTimeout=20 -i ${keyPath}`;
  const sshTarget = `deploy@${ip}`;
  
  console.log(`\n=== ${name} (${ip}) ===`);

  try {
    console.log("\n--- Docker compose ps ---");
    console.log(execSync(`ssh ${sshOpts} ${sshTarget} "cd /opt/alfred/compose && docker compose ps 2>&1"`, { encoding: "utf8", timeout: 30000 }));
  } catch(e) { console.log("FAILED:", e.message.split("\n")[0]); }

  try {
    console.log("\n--- OpenClaw logs (last 30) ---");
    console.log(execSync(`ssh ${sshOpts} ${sshTarget} "cd /opt/alfred/compose && docker compose logs openclaw --tail 30 2>&1"`, { encoding: "utf8", timeout: 30000 }));
  } catch(e) { console.log("FAILED:", e.message.split("\n")[0]); }

  try {
    console.log("\n--- Alfred Learn logs (last 15) ---");
    console.log(execSync(`ssh ${sshOpts} ${sshTarget} "cd /opt/alfred/compose && docker compose logs alfred-learn --tail 15 2>&1"`, { encoding: "utf8", timeout: 30000 }));
  } catch(e) { console.log("FAILED:", e.message.split("\n")[0]); }
}
