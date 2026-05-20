#!/usr/bin/env node --experimental-sqlite
/**
 * Bootstrap alfred-learn on all running tenant instances.
 * Runs on the control plane (deploy@DEPLOY_HOST).
 */
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
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

const SERVICE_BLOCK = `
  alfred-learn:
    image: ssdavidai00/alfred-learn:latest
    depends_on:
      temporal:
        condition: service_healthy
      openclaw:
        condition: service_healthy
    volumes:
      - /mnt/encrypted/vault:/vault
      - /mnt/encrypted/alfred:/alfred-data
    environment:
      - TEMPORAL_HOST=temporal:7233
      - OPENCLAW_GATEWAY_URL=http://openclaw:18789
      - OPENCLAW_WORKERS_GATEWAY_URL=http://openclaw-workers:18790
      - OPENCLAW_GATEWAY_TOKEN_FILE=/alfred-data/.gateway-token
      - VAULT_PATH=/vault
      - TASK_QUEUE=alfred-learn
      - ALFRED_LEARN_ENABLED=true
    env_file:
      - .env
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 1g
    pids_limit: 128
`;

let failures = 0;

for (const row of rows) {
  const { customer_name: name, ip_address: ip, id } = row;
  let keyPath = row.ssh_key_path;

  // Resolve container path → host path
  keyPath = keyPath.replace(/^\/app\/alfred-ctrl\//, `${CTRL_DIR}/`);

  if (!existsSync(keyPath)) {
    console.log(`SKIP ${name} (${ip}): key not found at ${keyPath}`);
    continue;
  }

  console.log(`\n=== ${name} (${ip}) ===`);

  const sshOpts = `-o StrictHostKeyChecking=no -o ConnectTimeout=20 -i ${keyPath}`;
  const sshTarget = `deploy@${ip}`;

  try {
    // Check if service already in compose
    const check = execSync(
      `ssh ${sshOpts} ${sshTarget} "grep -q 'alfred-learn:' /opt/alfred/compose/docker-compose.yaml && echo EXISTS || echo MISSING"`,
      { encoding: "utf8" }
    ).trim();

    if (check === "EXISTS") {
      console.log("  Service already in compose — pulling + restarting...");
    } else {
      console.log("  Adding alfred-learn service to compose...");
      const tmpFile = `/tmp/al-svc-${id}.txt`;
      writeFileSync(tmpFile, SERVICE_BLOCK);
      execSync(`scp ${sshOpts} ${tmpFile} ${sshTarget}:/tmp/alfred-learn-svc.txt`, { encoding: "utf8" });
      execSync(`ssh ${sshOpts} ${sshTarget} "cat /tmp/alfred-learn-svc.txt >> /opt/alfred/compose/docker-compose.yaml"`, { encoding: "utf8" });
      unlinkSync(tmpFile);
      console.log("  Service added.");
    }

    // Pull and start (single command — avoids compose validation issues with separate pull)
    const result = execSync(
      `ssh ${sshOpts} ${sshTarget} "cd /opt/alfred/compose && docker compose up -d --pull always --no-deps alfred-learn 2>&1; sleep 3; docker compose ps alfred-learn 2>&1"`,
      { encoding: "utf8", timeout: 180000 }
    );
    console.log(result);
    console.log(`  SUCCESS: ${name}`);
  } catch (err) {
    console.error(`  FAILED: ${name} — ${err.message}`);
    failures++;
  }
}

console.log("\n=== Bootstrap complete ===");
process.exit(failures > 0 ? 1 : 0);
