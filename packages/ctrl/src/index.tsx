import fs from "fs";
import path from "path";

// Load .env if present (replaces dotenv)
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
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./app.js";
import { getDb, closeDb } from "./db/index.js";
import {
  listInstances,
  getInstance,
  getInstanceByName,
  getEvents,
} from "./db/queries.js";
import { provision, destroy, updateImages, rollback, deployApi, repairTunnel } from "./infra/provisioner.js";
import { runHealthChecks } from "./monitoring/health.js";
import { exec as sshExec } from "./infra/ssh.js";
import { DEFAULTS } from "./data/constants.js";
import { execSync } from "child_process";
import type { InstanceConfig } from "./data/types.js";

const program = new Command();

program
  .name("aas")
  .description("Alfred-as-a-Service — Fleet Management CLI")
  .version("0.1.0");

// Default: launch TUI
program.action(() => {
  getDb();
  const { waitUntilExit } = render(React.createElement(App));
  waitUntilExit().then(() => {
    closeDb();
    process.exit(0);
  });
});

// --- CLI commands ---

program
  .command("list")
  .description("List all instances")
  .option("--json", "Output as JSON")
  .option("--status <status>", "Filter by status")
  .action((opts) => {
    getDb();
    const instances = listInstances(opts.status);
    if (opts.json) {
      console.log(JSON.stringify(instances, null, 2));
    } else {
      if (instances.length === 0) {
        console.log("No instances.");
        closeDb();
        return;
      }
      console.log(
        `${"Name".padEnd(20)} ${"Status".padEnd(14)} ${"Tailscale".padEnd(35)} ${"IP".padEnd(16)} ${"Type".padEnd(8)} ${"Health".padEnd(10)}`
      );
      console.log("-".repeat(110));
      for (const inst of instances) {
        console.log(
          `${inst.customer_name.padEnd(20)} ${inst.status.padEnd(14)} ${(inst.tailscale_hostname ?? "--").padEnd(35)} ${(inst.ip_address ?? "--").padEnd(16)} ${inst.server_type.padEnd(8)} ${(inst.last_health_status ?? "--").padEnd(10)}`
        );
      }
    }
    closeDb();
  });

program
  .command("provision <name>")
  .description("Provision a new instance")
  .option("--type <type>", "Server type", process.env.DEFAULT_SERVER_TYPE ?? DEFAULTS.serverType)
  .option("--location <loc>", "Location", process.env.DEFAULT_LOCATION ?? DEFAULTS.location)
  .option("--ts-key <key>", "Tailscale auth key")
  .action(async (name, opts) => {
    getDb();

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      console.error("Error: name must contain only letters, numbers, hyphens, and underscores");
      closeDb();
      process.exit(1);
    }

    const tsKey = opts.tsKey ?? process.env.TAILSCALE_AUTHKEY;
    if (!tsKey) {
      console.error("Error: Tailscale auth key required (--ts-key or TAILSCALE_AUTHKEY env)");
      closeDb();
      process.exit(1);
    }

    const config: InstanceConfig = {
      customer_name: name,
      server_type: opts.type,
      location: opts.location,
      tailscale_authkey: tsKey,
      openrouter_api_key: process.env.OPENROUTER_API_KEY,
    };

    console.log(`Provisioning "${name}" (${opts.type} in ${opts.location})...`);
    const result = await provision(config, (state) => {
      const last = state.logs[state.logs.length - 1];
      if (last) console.log(last);
    });

    if (result.error) {
      console.error(`\nProvisioning failed: ${result.error}`);
      closeDb();
      process.exit(1);
    }

    console.log("\nProvisioning complete!");
    closeDb();
  });

program
  .command("destroy <name>")
  .description("Destroy an instance")
  .option("--yes", "Skip confirmation")
  .action(async (name, opts) => {
    getDb();
    const instance = getInstanceByName(name);
    if (!instance) {
      console.error(`Instance "${name}" not found`);
      closeDb();
      process.exit(1);
    }

    if (!opts.yes) {
      const readline = await import("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question(
          `Destroy "${name}"? This will delete the server, volume, and all data. [y/N] `,
          resolve
        );
      });
      rl.close();
      if (answer.toLowerCase() !== "y") {
        console.log("Cancelled.");
        closeDb();
        return;
      }
    }

    console.log(`Destroying "${name}"...`);
    await destroy(instance.id, console.log);
    closeDb();
  });

program
  .command("ssh <name>")
  .description("SSH into an instance")
  .action((name) => {
    getDb();
    const instance = getInstanceByName(name);
    if (!instance) {
      console.error(`Instance "${name}" not found`);
      closeDb();
      process.exit(1);
    }
    if (!instance.ip_address || !instance.ssh_key_path) {
      console.error("Instance not fully provisioned");
      closeDb();
      process.exit(1);
    }

    closeDb();
    execSync(
      `ssh -i "${instance.ssh_key_path}" -o StrictHostKeyChecking=no deploy@${instance.ip_address}`,
      { stdio: "inherit" }
    );
  });

program
  .command("update [name]")
  .description("Pull latest images and restart")
  .option("--all", "Update all running instances")
  .action(async (name, opts) => {
    getDb();

    if (opts.all) {
      const instances = listInstances("running");
      console.log(`Updating ${instances.length} running instance(s)...`);
      for (const inst of instances) {
        console.log(`\n--- ${inst.customer_name} ---`);
        try {
          await updateImages(inst.id, undefined, console.log);
        } catch (e: any) {
          console.error(`FAILED: ${e.message}`);
        }
      }
    } else if (name) {
      const instance = getInstanceByName(name);
      if (!instance) {
        console.error(`Instance "${name}" not found`);
        closeDb();
        process.exit(1);
      }
      await updateImages(instance.id, undefined, console.log);
    } else {
      console.error("Usage: update <name> or update --all");
      closeDb();
      process.exit(1);
    }
    closeDb();
  });

program
  .command("deploy-api [name]")
  .description("Deploy latest api.mjs to running tenant(s)")
  .option("--all", "Deploy to all running instances")
  .action(async (name, opts) => {
    getDb();

    if (opts.all || name === "--all") {
      const instances = listInstances("running");
      console.log(`Deploying api.mjs to ${instances.length} running instance(s)...`);
      for (const inst of instances) {
        console.log(`\n--- ${inst.customer_name} ---`);
        try {
          await deployApi(inst.id, console.log);
        } catch (e: any) {
          console.error(`FAILED: ${e.message}`);
        }
      }
    } else {
      if (!name) {
        console.error("Error: specify an instance name or use --all");
        closeDb();
        process.exit(1);
      }
      const instance = getInstanceByName(name);
      if (!instance) {
        console.error(`Instance "${name}" not found`);
        closeDb();
        process.exit(1);
      }
      await deployApi(instance.id, console.log);
    }
    closeDb();
  });

program
  .command("rollback <name>")
  .description("Rollback to last healthy image")
  .option("--sha <sha>", "Specific SHA to rollback to")
  .action(async (name, opts) => {
    getDb();
    const instance = getInstanceByName(name);
    if (!instance) {
      console.error(`Instance "${name}" not found`);
      closeDb();
      process.exit(1);
    }

    await rollback(instance.id, opts.sha, console.log);
    closeDb();
  });

program
  .command("repair-tunnel [name]")
  .description("Repair Cloudflare Tunnel on running instance(s)")
  .option("--all", "Repair all running instances")
  .action(async (name, opts) => {
    getDb();

    if (opts.all || name === "--all") {
      const instances = listInstances("running");
      console.log(`Repairing tunnels on ${instances.length} running instance(s)...`);
      for (const inst of instances) {
        if (!inst.cf_tunnel_id) {
          console.log(`\n--- ${inst.customer_name} --- SKIPPED (no tunnel configured)`);
          continue;
        }
        console.log(`\n--- ${inst.customer_name} ---`);
        try {
          await repairTunnel(inst.id, console.log);
        } catch (e: any) {
          console.error(`FAILED: ${e.message}`);
        }
      }
    } else {
      if (!name) {
        console.error("Error: specify an instance name or use --all");
        closeDb();
        process.exit(1);
      }
      const instance = getInstanceByName(name);
      if (!instance) {
        console.error(`Instance "${name}" not found`);
        closeDb();
        process.exit(1);
      }
      await repairTunnel(instance.id, console.log);
    }
    closeDb();
  });

program
  .command("health [name]")
  .description("Run health checks")
  .action(async (name) => {
    getDb();

    if (name) {
      const instance = getInstanceByName(name);
      if (!instance) {
        console.error(`Instance "${name}" not found`);
        closeDb();
        process.exit(1);
      }
      if (!instance.ip_address || !instance.ssh_key_path) {
        console.error("Instance not fully provisioned");
        closeDb();
        process.exit(1);
      }

      const result = await sshExec(
        instance.ip_address,
        instance.ssh_key_path,
        `${DEFAULTS.alfredBasePath}/healthcheck.sh`
      );
      console.log(result.stdout);
    } else {
      await runHealthChecks();
      const instances = listInstances("running");
      for (const inst of instances) {
        console.log(
          `${inst.customer_name}: ${inst.last_health_status ?? "unknown"}`
        );
      }
    }
    closeDb();
  });

program
  .command("logs <name>")
  .description("Tail docker compose logs via SSH")
  .option("--service <svc>", "Filter to specific service (e.g. alfred, openclaw, temporal)")
  .action(async (name, opts) => {
    getDb();
    const instance = getInstanceByName(name);
    if (!instance) {
      console.error(`Instance "${name}" not found`);
      closeDb();
      process.exit(1);
    }
    if (!instance.ip_address || !instance.ssh_key_path) {
      console.error("Instance not fully provisioned");
      closeDb();
      process.exit(1);
    }

    const svcArg = opts.service ? ` ${opts.service}` : "";
    closeDb();
    execSync(
      `ssh -i "${instance.ssh_key_path}" -o StrictHostKeyChecking=no deploy@${instance.ip_address} "cd ${DEFAULTS.dockerComposeDir} && docker compose logs --tail 100 -f${svcArg}"`,
      { stdio: "inherit" }
    );
  });

// --- info ---
program
  .command("info <name>")
  .description("Show all instance fields")
  .option("--json", "Output as JSON")
  .action((name, opts) => {
    getDb();
    const instance = getInstanceByName(name);
    if (!instance) {
      console.error(`Instance "${name}" not found`);
      closeDb();
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify(instance, null, 2));
    } else {
      for (const [key, value] of Object.entries(instance)) {
        console.log(`${key.padEnd(24)} ${value ?? "--"}`);
      }
    }
    closeDb();
  });

// --- events ---
program
  .command("events <name>")
  .description("Show events for an instance")
  .option("--limit <n>", "Number of events", "20")
  .action((name, opts) => {
    getDb();
    const instance = getInstanceByName(name);
    if (!instance) {
      console.error(`Instance "${name}" not found`);
      closeDb();
      process.exit(1);
    }
    const events = getEvents(instance.id, parseInt(opts.limit, 10));
    if (events.length === 0) {
      console.log("No events.");
    } else {
      for (const e of events) {
        console.log(`${e.created_at}  [${e.event_type}]  ${e.message}`);
      }
    }
    closeDb();
  });

// --- devices ---
function requireProvisionedInstance(name: string) {
  const instance = getInstanceByName(name);
  if (!instance) {
    console.error(`Instance "${name}" not found`);
    closeDb();
    process.exit(1);
  }
  if (!instance.ip_address || !instance.ssh_key_path) {
    console.error("Instance not fully provisioned");
    closeDb();
    process.exit(1);
  }
  return instance;
}

const DEVICE_CMD = `cd ${DEFAULTS.dockerComposeDir} && docker compose exec -T openclaw node openclaw.mjs devices`;

program
  .command("devices <name>")
  .description("List OpenClaw devices")
  .option("--json", "Output as JSON")
  .action(async (name, opts) => {
    getDb();
    const instance = requireProvisionedInstance(name);
    const result = await sshExec(instance.ip_address!, instance.ssh_key_path!, `${DEVICE_CMD} list --json`);
    if (result.code !== 0) {
      console.error(result.stderr || `Exit code ${result.code}`);
      closeDb();
      process.exit(1);
    }
    if (opts.json) {
      console.log(result.stdout);
    } else {
      const data = JSON.parse(result.stdout);
      const pending = data.pending ?? [];
      const paired = data.paired ?? [];
      if (pending.length > 0) {
        console.log("Pending:");
        for (const d of pending) {
          console.log(`  ${d.requestId}  ${d.displayName ?? d.deviceId}  (${d.platform})`);
        }
      }
      if (paired.length > 0) {
        console.log("Paired:");
        for (const d of paired) {
          console.log(`  ${d.deviceId}  ${d.displayName ?? d.deviceId}  (${d.platform})  role=${d.role}`);
        }
      }
      if (pending.length === 0 && paired.length === 0) {
        console.log("No devices.");
      }
    }
    closeDb();
  });

program
  .command("device-approve <name> <requestId>")
  .description("Approve a pending device")
  .action(async (name, requestId) => {
    getDb();
    const instance = requireProvisionedInstance(name);
    const result = await sshExec(instance.ip_address!, instance.ssh_key_path!, `${DEVICE_CMD} approve ${requestId}`);
    if (result.code !== 0) {
      console.error(result.stderr || result.stdout || `Exit code ${result.code}`);
      closeDb();
      process.exit(1);
    }
    console.log(result.stdout.trim() || "Device approved.");
    closeDb();
  });

program
  .command("device-reject <name> <requestId>")
  .description("Reject a pending device")
  .action(async (name, requestId) => {
    getDb();
    const instance = requireProvisionedInstance(name);
    const result = await sshExec(instance.ip_address!, instance.ssh_key_path!, `${DEVICE_CMD} reject ${requestId}`);
    if (result.code !== 0) {
      console.error(result.stderr || result.stdout || `Exit code ${result.code}`);
      closeDb();
      process.exit(1);
    }
    console.log(result.stdout.trim() || "Device rejected.");
    closeDb();
  });

program
  .command("device-remove <name> <deviceId>")
  .description("Remove a paired device")
  .action(async (name, deviceId) => {
    getDb();
    const instance = requireProvisionedInstance(name);
    const result = await sshExec(instance.ip_address!, instance.ssh_key_path!, `${DEVICE_CMD} remove ${deviceId}`);
    if (result.code !== 0) {
      console.error(result.stderr || result.stdout || `Exit code ${result.code}`);
      closeDb();
      process.exit(1);
    }
    console.log(result.stdout.trim() || "Device removed.");
    closeDb();
  });

// --- openclaw TUI ---
program
  .command("openclaw <name>")
  .description("Launch OpenClaw TUI via SSH")
  .action((name) => {
    getDb();
    const instance = requireProvisionedInstance(name);
    closeDb();
    execSync(
      `ssh -i "${instance.ssh_key_path}" -o StrictHostKeyChecking=no -t deploy@${instance.ip_address} "cd ${DEFAULTS.dockerComposeDir} && docker compose exec -it openclaw node openclaw.mjs tui"`,
      { stdio: "inherit" }
    );
  });

// --- alfred TUI ---
program
  .command("alfred-tui <name>")
  .description("Launch Alfred TUI via SSH")
  .action((name) => {
    getDb();
    const instance = requireProvisionedInstance(name);
    closeDb();
    execSync(
      `ssh -i "${instance.ssh_key_path}" -o StrictHostKeyChecking=no -t deploy@${instance.ip_address} "cd ${DEFAULTS.dockerComposeDir} && docker compose exec -it alfred alfred --config /app/data/config.yaml tui"`,
      { stdio: "inherit" }
    );
  });

// --- alfred logs ---
program
  .command("alfred-logs <name>")
  .description("Tail alfred container logs")
  .action((name) => {
    getDb();
    const instance = requireProvisionedInstance(name);
    closeDb();
    execSync(
      `ssh -i "${instance.ssh_key_path}" -o StrictHostKeyChecking=no deploy@${instance.ip_address} "cd ${DEFAULTS.dockerComposeDir} && docker compose logs --tail 100 -f alfred"`,
      { stdio: "inherit" }
    );
  });

// --- temporal UI ---
program
  .command("temporal-ui <name>")
  .description("Print Temporal UI URL")
  .option("--open", "Open in browser")
  .action((name, opts) => {
    getDb();
    const instance = getInstanceByName(name);
    if (!instance) {
      console.error(`Instance "${name}" not found`);
      closeDb();
      process.exit(1);
    }
    if (!instance.tailscale_hostname) {
      console.error("Tailscale hostname not available");
      closeDb();
      process.exit(1);
    }
    const url = `https://${instance.tailscale_hostname}:8233`;
    console.log(url);
    if (opts.open) {
      const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
      execSync(`${openCmd} "${url}"`);
    }
    closeDb();
  });

// --- API key retrieval ---
program
  .command("api-key <name>")
  .description("Retrieve tenant API key for an instance")
  .action((name) => {
    getDb();
    const instance = getInstanceByName(name);
    if (!instance) {
      console.error(`Instance "${name}" not found`);
      closeDb();
      process.exit(1);
    }
    if (!instance.api_key) {
      console.error("No API key deployed for this instance");
      closeDb();
      process.exit(1);
    }
    console.log(instance.api_key);
    closeDb();
  });

program.parse();
