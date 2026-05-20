#!/usr/bin/env node --experimental-sqlite
/**
 * Push updated OpenClaw config to all running tenant instances.
 * Deep-merges with existing config (preserves gateway tokens etc).
 * Then restarts the openclaw container to pick up changes.
 * Runs on the control plane (deploy@DEPLOY_HOST).
 */
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
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

// The rendered OpenClaw config template
const OPENCLAW_CONFIG = {
  "agents": {
    "defaults": {
      "heartbeat": {
        "every": "4h",
        "prompt": "Read HEARTBEAT.md if it exists. Follow it strictly. Additionally: scan recent conversation for any new people, pets, places, or organizations not yet in MEMORY.md — add them as one-line entity facts now. If nothing needs attention and no new entities, reply HEARTBEAT_OK."
      },
      "compaction": {
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 60000,
          "prompt": "CRITICAL: Do ALL of the following before compaction:\n1. Write detailed conversation summary to memory/YYYY-MM-DD.md\n2. Write memory/current-task.md with current task breakdown\n3. Save last ~20 human+assistant messages to memory/pre-compact-dialogue.md\n4. Update MEMORY.md with any NEW entity facts from this session\nReply with NO_REPLY after writing all files."
        }
      }
    },
    "clerk": {
      "model": "anthropic/claude-sonnet-4-6",
      "systemPrompt": "You are a classification clerk for Alfred Black. You receive raw data (conversations, emails, events) and return structured JSON. You never converse — you only classify, extract, and return JSON. Be precise and consistent.",
      "tools": {},
      "heartbeat": { "enabled": false },
      "compaction": { "enabled": false }
    }
  },
  "memory": {
    "backend": "qmd",
    "citations": "auto",
    "qmd": {
      "searchMode": "search",
      "includeDefaultMemory": true,
      "paths": [
        {"path": "/home/node/.openclaw/workspace/vault", "name": "vault", "pattern": "**/*.md"}
      ],
      "update": {"interval": "5m", "debounceMs": 15000, "onBoot": true},
      "limits": {"maxResults": 8, "timeoutMs": 5000}
    }
  },
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "alfred-inbox": {
          "enabled": true,
          "flushTurns": 10,
          "flushIdleMs": 300000
        },
        "alfred-learn-observer": {
          "enabled": true
        }
      }
    }
  },
  "gateway": {
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true
    }
  }
};

let failures = 0;

for (const row of rows) {
  const { customer_name: name, ip_address: ip, id } = row;
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
    // Write config to temp file and SCP it
    const tmpFile = `/tmp/oc-config-${id}.json`;
    writeFileSync(tmpFile, JSON.stringify(OPENCLAW_CONFIG, null, 2));
    execSync(`scp ${sshOpts} ${tmpFile} ${sshTarget}:/tmp/openclaw-tenant-config.json`, { encoding: "utf8" });
    unlinkSync(tmpFile);

    // Deep-merge on tenant (preserves gateway tokens, existing settings)
    // SCP the merge script then run it (avoids inline quoting hell)
    const mergeScript = process.env.MERGE_SCRIPT || join(CTRL_DIR, "scripts", "deep-merge-config.py");
    execSync(`scp ${sshOpts} ${mergeScript} ${sshTarget}:/tmp/deep-merge-config.py`, { encoding: "utf8" });
    execSync(`ssh ${sshOpts} ${sshTarget} "python3 /tmp/deep-merge-config.py && rm /tmp/deep-merge-config.py"`, { encoding: "utf8" });

    console.log("  Config pushed and merged.");

    // Restart openclaw to pick up new config
    const result = execSync(
      `ssh ${sshOpts} ${sshTarget} "cd /opt/alfred/compose && docker compose restart openclaw 2>&1 && sleep 3 && docker compose ps openclaw"`,
      { encoding: "utf8", timeout: 60000 }
    );
    console.log(result);
    console.log(`  SUCCESS: ${name}`);
  } catch (err) {
    console.error(`  FAILED: ${name} — ${err.message}`);
    failures++;
  }
}

console.log("\n=== Config push complete ===");
process.exit(failures > 0 ? 1 : 0);
