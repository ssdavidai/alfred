#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const CTRL_DIR = "/opt/alfred-saas/alfred-ctrl";
const DB_PATH = join(CTRL_DIR, "data", "alfred-ctrl.db");
const db = new DatabaseSync(DB_PATH);
const rows = db.prepare(
  `SELECT id, customer_name, ip_address, ssh_key_path FROM instances WHERE status='running' AND ip_address IS NOT NULL AND ssh_key_path IS NOT NULL`
).all();
db.close();

// Write a repair script to /tmp
const REPAIR_SCRIPT = `#!/bin/bash
set -e
CONF="/mnt/encrypted/openclaw/openclaw.json"
if [ -f "$CONF" ]; then
  python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
changed = False
if 'agents' in cfg and 'clerk' in cfg['agents']:
    del cfg['agents']['clerk']
    changed = True
if changed:
    with open(sys.argv[1], 'w') as f:
        json.dump(cfg, f, indent=2)
    print('Fixed: removed agents.clerk from config')
else:
    print('Config OK: no agents.clerk found')
" "$CONF"
fi
cd /opt/alfred/compose
docker compose restart openclaw alfred 2>&1
sleep 10
docker compose ps 2>&1
`;

writeFileSync("/tmp/repair-tenant.sh", REPAIR_SCRIPT);

let failures = 0;

for (const row of rows) {
  const { customer_name: name, ip_address: ip } = row;
  let keyPath = row.ssh_key_path;
  keyPath = keyPath.replace(/^\/app\/alfred-ctrl\//, `${CTRL_DIR}/`);
  if (!existsSync(keyPath)) { continue; }

  const sshOpts = `-o StrictHostKeyChecking=no -o ConnectTimeout=20 -i ${keyPath}`;
  const sshTarget = `deploy@${ip}`;

  console.log(`\n=== ${name} (${ip}) ===`);

  try {
    // Upload repair script
    execSync(`scp ${sshOpts} /tmp/repair-tenant.sh ${sshTarget}:/tmp/repair-tenant.sh`, { encoding: "utf8", timeout: 30000 });
    // Run it
    const result = execSync(`ssh ${sshOpts} ${sshTarget} "bash /tmp/repair-tenant.sh"`, { encoding: "utf8", timeout: 120000 });
    console.log(result);
    console.log(`  SUCCESS: ${name}`);
  } catch (err) {
    console.log(`  FAILED: ${name} — ${err.message.split("\\n")[0]}`);
    failures++;
  }
}

try { unlinkSync("/tmp/repair-tenant.sh"); } catch {}
if (failures > 0) process.exit(1);
