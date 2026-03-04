import nunjucks from "nunjucks";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { getHetznerClient } from "./hetzner.js";
import { generateKeyPair } from "./keys.js";
import { ensureFirewall } from "./firewall.js";
import * as ssh from "./ssh.js";
import type { SSHHostKeyOptions } from "./ssh.js";
import * as tailscale from "./tailscale.js";
import * as cloudflare from "./cloudflare.js";
import {
  createInstance,
  updateInstance,
  insertEvent,
} from "../db/queries.js";
import { DEFAULTS } from "../data/constants.js";
import type { InstanceConfig, ProvisioningState, ProvisioningStep } from "../data/types.js";

import cloudInitTemplate from "../templates/cloud-init.yaml.njk";
import dockerComposeTemplate from "../templates/docker-compose.yaml.njk";
import bootstrapTemplate from "../templates/bootstrap-openclaw.sh.njk";
import cloudflaredConfigTemplate from "../templates/cloudflared-config.yaml.njk";
import openclawConfigTemplate from "../templates/openclaw-config.json.njk";
import workflowAuthorSkill from "../templates/skills/workflow-author.md";
import workspaceAgents from "../templates/workspace/AGENTS.md";
import workspaceSoul from "../templates/workspace/SOUL.md";
import workspaceMemory from "../templates/workspace/MEMORY.md";
import workspaceUser from "../templates/workspace/USER.md";
import hookReadme from "../hooks/alfred-inbox/HOOK.md";
// @ts-expect-error esbuild plugin loads handler.js as text
import hookHandler from "../hooks/alfred-inbox/handler.js";

nunjucks.configure({ autoescape: false });

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

function generateSubdomain(customerName: string): string {
  return customerName.toLowerCase().replace(/_/g, "-");
}

type StepCallback = (state: ProvisioningState) => void;

export async function provision(
  config: InstanceConfig,
  onStep?: StepCallback
): Promise<ProvisioningState> {
  const state: ProvisioningState = {
    step: "generate_keypair",
    instance_id: null,
    server_id: null,
    volume_id: null,
    ssh_key_id: null,
    ip_address: null,
    error: null,
    logs: [],
  };

  const log = (msg: string) => {
    state.logs.push(msg);
    onStep?.(state);
  };

  const setStep = (step: ProvisioningStep) => {
    state.step = step;
    onStep?.(state);
  };

  if (!VALID_NAME.test(config.customer_name)) {
    throw new Error(
      `Invalid customer name "${config.customer_name}": must match /^[a-zA-Z0-9_-]+$/`
    );
  }

  const hetzner = getHetznerClient();

  try {
    // --- Create DB record ---
    const instance = createInstance(
      config.customer_name,
      config.server_type,
      config.location
    );
    state.instance_id = instance.id;
    log(`Created instance record #${instance.id}`);

    // Store tenant Tailscale tag and subdomain
    // All tenant VMs share tag:tenant for ACL enforcement;
    // individual VMs are identified by hostname (alfred-{name})
    const tenantTag = config.tailscale_tag ?? "tenant";
    const subdomain = config.subdomain ?? generateSubdomain(config.customer_name);
    updateInstance(instance.id, {
      tailscale_tag: tenantTag,
      subdomain,
    });
    log(`Tenant tag: ${tenantTag}, subdomain: ${subdomain}`);

    // --- Generate SSH keypair ---
    setStep("generate_keypair");
    log("Generating Ed25519 SSH keypair...");
    const keyPair = await generateKeyPair(instance.id);
    updateInstance(instance.id, { ssh_key_path: keyPair.privateKeyPath });
    log("SSH keypair generated");

    // --- Upload SSH key to Hetzner ---
    setStep("upload_ssh_key");
    log("Uploading SSH key to Hetzner...");
    const { ssh_key } = await hetzner.createSSHKey(
      `alfred-ctrl-${config.customer_name}`,
      keyPair.publicKey
    );
    state.ssh_key_id = ssh_key.id;
    updateInstance(instance.id, { ssh_key_id: ssh_key.id });
    log(`SSH key uploaded (id: ${ssh_key.id})`);

    // --- Ensure firewall exists ---
    setStep("ensure_firewall");
    log("Ensuring firewall...");
    const firewallId = await ensureFirewall();
    log(`Firewall ready (id: ${firewallId})`);

    // --- Create volume ---
    setStep("create_volume");
    log("Creating encrypted volume...");
    const { volume } = await hetzner.createVolume({
      name: `alfred-${config.customer_name}-data`,
      size: 20,
      location: config.location,
      labels: { customer: config.customer_name },
    });
    state.volume_id = volume.id;
    updateInstance(instance.id, { volume_id: volume.id });
    log(`Volume created (id: ${volume.id})`);

    // --- Render cloud-init ---
    setStep("render_cloud_init");
    log("Rendering cloud-init...");
    const cloudInit = nunjucks.renderString(cloudInitTemplate, {
      ssh_public_key: keyPair.publicKey,
      volume_id: volume.id,
    });
    log("Cloud-init rendered");

    // --- Create server ---
    setStep("create_server");
    log(`Creating server (${config.server_type} in ${config.location})...`);
    const { server } = await hetzner.createServer({
      name: `alfred-${config.customer_name}`,
      server_type: config.server_type,
      location: config.location,
      ssh_keys: [ssh_key.id],
      user_data: cloudInit,
      firewalls: [{ firewall: firewallId }],
      labels: { customer: config.customer_name },
    });
    state.server_id = server.id;
    state.ip_address = server.public_net.ipv4.ip;
    updateInstance(instance.id, {
      server_id: server.id,
      ip_address: server.public_net.ipv4.ip,
      status: "cloud_init",
    });
    log(`Server created (id: ${server.id}, ip: ${server.public_net.ipv4.ip})`);
    insertEvent(instance.id, "provisioned", `Server ${server.id} created`);

    // Remove stale SSH host keys for this IP (Hetzner reuses IPs)
    try {
      const { execSync } = await import("child_process");
      execSync(`ssh-keygen -R ${server.public_net.ipv4.ip} 2>/dev/null`, {
        stdio: "ignore",
      });
    } catch {
      // No existing entry, that's fine
    }

    // --- Enable automatic backups ---
    log("Enabling automatic server backups...");
    await hetzner.enableBackup(server.id);
    log("Server backups enabled (weekly, +20% server cost)");

    // --- Attach volume ---
    log("Attaching volume to server...");
    await hetzner.attachVolume(volume.id, server.id, false);
    log("Volume attached");

    // --- Wait for cloud-init (and capture SSH host key) ---
    setStep("wait_cloud_init");
    log("Waiting for cloud-init to complete (up to 5 min)...");
    let capturedHostKey: string | undefined;
    const captureHostKey: SSHHostKeyOptions = {
      onHostKey: (fp) => {
        if (!capturedHostKey) capturedHostKey = fp;
      },
    };
    await ssh.waitForFile(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `${DEFAULTS.alfredBasePath}/.cloud-init-complete`,
      DEFAULTS.cloudInitTimeout,
      10_000,
      undefined,
      captureHostKey,
    );
    log("Cloud-init complete");
    if (capturedHostKey) {
      updateInstance(instance.id, { ssh_host_key: capturedHostKey });
      log(`SSH host key pinned: ${capturedHostKey.slice(0, 16)}...`);
    }
    insertEvent(instance.id, "cloud_init_complete", "Cloud-init finished");

    // All subsequent SSH connections verify against the pinned host key
    const hostKeyOpts: SSHHostKeyOptions = capturedHostKey
      ? { knownHostKey: capturedHostKey }
      : {};

    // --- Upload .env file (secrets via SSH, NOT cloud-init) ---
    // Gateway token is auto-generated per instance by the init container.
    // Only pass through optional API keys the user provides.
    setStep("upload_env");
    log("Uploading env via SSH...");
    const envLines = [];
    if (config.openrouter_api_key) {
      envLines.push(`OPENROUTER_API_KEY=${config.openrouter_api_key}`);
    }
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `sudo mkdir -p ${DEFAULTS.dockerComposeDir}`,
      undefined,
      hostKeyOpts,
    );
    await ssh.upload(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      envLines.join("\n") + "\n",
      `${DEFAULTS.dockerComposeDir}/.env`,
      0o600,
      undefined,
      hostKeyOpts,
    );
    log("Env uploaded");

    // --- Configure restic backups ---
    const s3AccessKey = process.env.HETZNER_S3_ACCESS_KEY;
    const s3SecretKey = process.env.HETZNER_S3_SECRET_KEY;
    const s3Bucket = process.env.HETZNER_S3_BUCKET ?? "alfred-backups";
    const s3Endpoint = process.env.HETZNER_S3_ENDPOINT ?? "fsn1.your-objectstorage.com";

    if (s3AccessKey && s3SecretKey) {
      setStep("configure_backups");
      log("Configuring restic backups to Hetzner Object Storage...");
      const resticEnv = [
        `AWS_ACCESS_KEY_ID=${s3AccessKey}`,
        `AWS_SECRET_ACCESS_KEY=${s3SecretKey}`,
        `RESTIC_REPOSITORY=s3:https://${s3Endpoint}/${s3Bucket}/${config.customer_name}`,
        `RESTIC_PASSWORD=${crypto.randomBytes(32).toString("hex")}`,
      ].join("\n");
      await ssh.upload(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        resticEnv,
        `${DEFAULTS.alfredBasePath}/restic.env`,
        0o600,
        undefined,
        hostKeyOpts,
      );
      // Initialize restic repo
      await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        `sudo bash -c 'set -a && source ${DEFAULTS.alfredBasePath}/restic.env && restic init 2>/dev/null || true'`,
        undefined,
        hostKeyOpts,
      );
      // Enable the backup timer
      await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        "sudo systemctl enable --now alfred-backup.timer",
        undefined,
        hostKeyOpts,
      );
      log("Restic backups configured (daily to Object Storage)");

      // Backup the restic password locally for disaster recovery.
      // This MUST succeed — without it, all backups are irrecoverable.
      const backupDir = path.join(
        process.cwd(), "data", "ssh_keys", String(instance.id)
      );
      await fs.writeFile(
        path.join(backupDir, "restic.env"),
        resticEnv,
        { mode: 0o600 }
      );
      log("Restic credentials backed up locally");
    } else {
      throw new Error(
        "Restic backup not configured: HETZNER_S3_ACCESS_KEY and HETZNER_S3_SECRET_KEY are required"
      );
    }

    // --- Upload docker-compose ---
    setStep("upload_compose");
    log("Uploading docker-compose.yaml...");
    const compose = dockerComposeTemplate;
    await ssh.upload(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      compose,
      `${DEFAULTS.dockerComposeDir}/docker-compose.yaml`,
      0o600,
      undefined,
      hostKeyOpts,
    );
    log("docker-compose.yaml uploaded");

    // --- Start containers ---
    setStep("start_containers");
    log("Pulling images...");
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose pull`,
      undefined,
      hostKeyOpts,
    );
    log("Starting init + temporal...");
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d init temporal`,
      undefined,
      hostKeyOpts,
    );
    // Wait for init container to finish (sets up vault scaffold + openclaw state dir)
    log("Waiting for init container...");
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose wait init`,
      undefined,
      hostKeyOpts,
    );
    // Upload workflow authoring skill to OpenClaw workspace
    log("Uploading workflow-author skill...");
    await ssh.upload(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      workflowAuthorSkill,
      "/mnt/encrypted/openclaw/workspace/workflow-author.md",
      0o644,
      undefined,
      hostKeyOpts,
    );

    // Upload workspace files (AGENTS.md, SOUL.md, MEMORY.md, USER.md)
    // These provide the baked-in Alfred persona, entity-check rules, and
    // memory structure that every tenant instance must start with.
    log("Uploading workspace files...");
    const workspaceBasePath = "/mnt/encrypted/openclaw/workspace";
    const renderedUser = nunjucks.renderString(workspaceUser, {
      customer_name: config.customer_name,
      customer_email: config.customer_email ?? "",
    });
    await Promise.all([
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, workspaceAgents, `${workspaceBasePath}/AGENTS.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, workspaceSoul, `${workspaceBasePath}/SOUL.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, workspaceMemory, `${workspaceBasePath}/MEMORY.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, renderedUser, `${workspaceBasePath}/USER.md`, 0o644, undefined, hostKeyOpts),
    ]);
    log("Workspace files uploaded");

    // Upload alfred-inbox hook for OpenClaw (captures chat sessions → vault inbox)
    log("Uploading alfred-inbox hook...");
    const hookBasePath = "/mnt/encrypted/openclaw/hooks/alfred-inbox";
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `mkdir -p ${hookBasePath}`,
      undefined,
      hostKeyOpts,
    );
    await Promise.all([
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, hookReadme, `${hookBasePath}/HOOK.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, hookHandler, `${hookBasePath}/handler.js`, 0o644, undefined, hostKeyOpts),
    ]);
    log("Hook uploaded");

    // Pre-configure openclaw.json with baked-in config before openclaw starts.
    // Includes: heartbeat (4h), compaction (60k token flush), qmd memory
    // backend, and controlUi for LAN binding. Deep-merged with any existing
    // config the init container created (preserving gateway tokens etc.).
    log("Pre-configuring OpenClaw...");
    // vault_path: where the vault volume is mounted inside the openclaw container
    // (per docker-compose.yaml.njk: /mnt/encrypted/vault → /home/node/.openclaw/workspace/vault)
    const openclawConfig = nunjucks.renderString(openclawConfigTemplate, {
      vault_path: "/home/node/.openclaw/workspace/vault",
    });
    await ssh.upload(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      openclawConfig,
      "/tmp/openclaw-tenant-config.json",
      0o644,
      undefined,
      hostKeyOpts,
    );
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `python3 -c "
import json, os

def deep_merge(base, overlay):
    for k, v in overlay.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            deep_merge(base[k], v)
        else:
            base[k] = v
    return base

p = '/mnt/encrypted/openclaw/openclaw.json'
cfg = {}
if os.path.exists(p):
    with open(p) as f: cfg = json.load(f)
with open('/tmp/openclaw-tenant-config.json') as f: tenant = json.load(f)
deep_merge(cfg, tenant)
with open(p, 'w') as f: json.dump(cfg, f, indent=2)
os.remove('/tmp/openclaw-tenant-config.json')
"`,
      undefined,
      hostKeyOpts,
    );
    log("OpenClaw configured");

    // --- Bootstrap OpenClaw + Tailscale ---
    setStep("bootstrap_openclaw");
    updateInstance(instance.id, { status: "bootstrapping" });
    log("Running OpenClaw + Tailscale bootstrap...");

    const tailnetName =
      process.env.TAILSCALE_TAILNET ?? "your-tailnet.ts.net";

    const bootstrapScript = nunjucks.renderString(bootstrapTemplate, {
      customer_name: config.customer_name,
      tailnet_name: tailnetName,
      ts_authkey: config.tailscale_authkey,
    });
    await ssh.upload(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      bootstrapScript,
      `${DEFAULTS.alfredBasePath}/bootstrap.sh`,
      0o700,
      undefined,
      hostKeyOpts,
    );
    const bootstrapResult = await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `bash ${DEFAULTS.alfredBasePath}/bootstrap.sh`,
      undefined,
      hostKeyOpts,
    );
    log(bootstrapResult.stdout);

    // Save Tailscale info before checking exit code — Tailscale connects
    // early in the bootstrap (phase 0), so it's often available even if
    // later phases fail.
    let tsHostname: string | undefined;
    try {
      const tsInfo = await tailscale.verifyConnected(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath
      );
      if (tsInfo) {
        tsHostname = tsInfo.hostname;
        updateInstance(instance.id, {
          tailscale_hostname: tsInfo.hostname,
          tailscale_ip: tsInfo.ip,
        });
        log(`Tailscale: ${tsInfo.hostname} (${tsInfo.ip})`);
      }
    } catch {
      // Tailscale may not be connected yet if bootstrap failed early
    }

    if (bootstrapResult.code !== 0) {
      throw new Error(
        `Bootstrap failed: ${bootstrapResult.stderr}`
      );
    }

    // Extract gateway token from OpenClaw config
    try {
      const tokenResult = await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        `python3 -c "import json; print(json.load(open('/mnt/encrypted/openclaw/openclaw.json'))['gateway']['auth']['token'])"`,
        undefined,
        hostKeyOpts,
      );
      const gatewayToken = tokenResult.stdout.trim();
      if (gatewayToken) {
        updateInstance(instance.id, { gateway_token: gatewayToken });
        const hostname = tsHostname ?? instance.ip_address;
        log(`Gateway URL: https://${hostname}/?token=${gatewayToken}`);
      }
    } catch (e) {
      log(`Warning: could not extract gateway token: ${e}`);
    }

    // Remove bootstrap script (contains Tailscale auth key)
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `rm -f ${DEFAULTS.alfredBasePath}/bootstrap.sh`,
      undefined,
      hostKeyOpts,
    );
    insertEvent(
      instance.id,
      "bootstrap_complete",
      "OpenClaw + Tailscale bootstrapped"
    );

    // --- Backup LUKS keyfile ---
    setStep("backup_luks_key");
    log("Backing up LUKS keyfile...");
    try {
      const luksKey = await ssh.download(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        `${DEFAULTS.alfredBasePath}/luks.key`,
        "root",
        hostKeyOpts,
      );
      const backupDir = path.join(
        process.cwd(),
        "data",
        "ssh_keys",
        String(instance.id)
      );
      await fs.writeFile(path.join(backupDir, "luks.key"), luksKey, {
        mode: 0o600,
      });
      log("LUKS keyfile backed up locally");
    } catch (e) {
      log(`Warning: could not backup LUKS key: ${e}`);
    }

    // --- Setup Cloudflare Tunnel ---
    if (cloudflare.isConfigured()) {
      setStep("setup_tunnel");
      log("Setting up Cloudflare Tunnel...");

      const domain = process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain;

      // Create tunnel
      const tunnelName = `alfred-${subdomain}`;
      const tunnel = await cloudflare.createTunnel(tunnelName);
      log(`Tunnel created: ${tunnel.name} (${tunnel.id})`);

      // Ensure cloudflared dir is writable by deploy user for SFTP uploads
      await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        `sudo chown deploy:deploy ${DEFAULTS.cloudflaredDir}`,
        undefined,
        hostKeyOpts,
      );

      // Upload tunnel credentials
      await ssh.upload(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        JSON.stringify(tunnel.credentials, null, 2) + "\n",
        `${DEFAULTS.cloudflaredDir}/credentials.json`,
        0o600,
        undefined,
        hostKeyOpts,
      );
      log("Tunnel credentials uploaded");

      // Render and upload cloudflared config
      const cfConfig = nunjucks.renderString(cloudflaredConfigTemplate, {
        tunnel_id: tunnel.id,
        subdomain,
        domain,
      });
      await ssh.upload(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        cfConfig,
        `${DEFAULTS.cloudflaredDir}/config.yml`,
        0o644,
        undefined,
        hostKeyOpts,
      );
      log("Cloudflared config uploaded");

      // Ensure files are synced to disk before service install
      await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        "sync",
        undefined,
        hostKeyOpts,
      );

      // Install cloudflared as systemd service
      const installResult = await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        "sudo cloudflared service install",
        undefined,
        hostKeyOpts,
      );
      if (installResult.code !== 0) {
        log(`Warning: cloudflared service install stderr: ${installResult.stderr.trim()}`);
        throw new Error(
          `cloudflared service install failed (exit ${installResult.code}): ${installResult.stderr.trim()}`
        );
      }

      // Enable and start the service
      const startResult = await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        "sudo systemctl enable --now cloudflared",
        undefined,
        hostKeyOpts,
      );
      if (startResult.code !== 0) {
        throw new Error(
          `cloudflared systemctl enable failed (exit ${startResult.code}): ${startResult.stderr.trim()}`
        );
      }

      // Verify the service actually started
      await new Promise((r) => setTimeout(r, 3000));
      const verifyResult = await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        "systemctl is-active cloudflared",
        undefined,
        hostKeyOpts,
      );
      if (verifyResult.stdout.trim() !== "active") {
        const journalResult = await ssh.exec(
          server.public_net.ipv4.ip,
          keyPair.privateKeyPath,
          "sudo journalctl -u cloudflared -n 20 --no-pager",
          undefined,
          hostKeyOpts,
        );
        log(`Cloudflared journal:\n${journalResult.stdout}`);
        throw new Error("cloudflared service is not active after start");
      }
      log("Cloudflared service verified active");

      // Create DNS CNAME record
      const dnsRecord = await cloudflare.createDnsRecord(subdomain, tunnel.id);
      log(`DNS record created: ${subdomain}.${domain} → tunnel`);

      // Update instance with tunnel metadata
      updateInstance(instance.id, {
        cf_tunnel_id: tunnel.id,
        cf_tunnel_name: tunnel.name,
        cf_dns_record_id: dnsRecord.id,
      });

      insertEvent(
        instance.id,
        "running",
        `Cloudflare Tunnel active: https://${subdomain}.${domain}`
      );
      log(`Tunnel live at https://${subdomain}.${domain}`);
    } else {
      log("Skipping Cloudflare Tunnel setup (not configured)");
    }

    // --- Deploy tenant API ---
    setStep("deploy_api");
    log("Deploying tenant API...");
    const apiKey = crypto.randomBytes(32).toString("hex");
    const apiMjsPath = path.join(process.cwd(), "dist", "api.mjs");
    try {
      await ssh.upload(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        (await fs.readFile(apiMjsPath, "utf-8")),
        `${DEFAULTS.alfredBasePath}/api.mjs`,
        0o644,
        undefined,
        hostKeyOpts,
      );

      // Append API key to .env
      await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        `echo 'AAS_API_KEY=${apiKey}' >> ${DEFAULTS.dockerComposeDir}/.env`,
        undefined,
        hostKeyOpts,
      );

      // Enable and start the API service
      await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        "sudo systemctl enable --now alfred-api.service",
        undefined,
        hostKeyOpts,
      );

      updateInstance(instance.id, { api_key: apiKey });
      insertEvent(instance.id, "api_deployed", "Tenant API deployed");
      log("Tenant API deployed and running");
    } catch (e) {
      log(`Warning: tenant API deployment failed: ${e}`);
    }

    // --- Health check ---
    setStep("health_check");
    log("Running initial health check...");
    const healthResult = await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `${DEFAULTS.alfredBasePath}/healthcheck.sh`,
      undefined,
      hostKeyOpts,
    );
    log(`Health: ${healthResult.stdout.trim()}`);

    // --- Verify subdomain reachability ---
    if (cloudflare.isConfigured() && subdomain) {
      const domain = process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain;
      const subdomainUrl = `https://${subdomain}.${domain}`;
      log(`Verifying subdomain reachability: ${subdomainUrl}...`);
      try {
        const res = await fetch(subdomainUrl, {
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok || res.status === 401 || res.status === 403) {
          // 401/403 = Cloudflare Access gate, still means tunnel works
          log(`Subdomain reachable (HTTP ${res.status})`);
        } else {
          log(`Warning: subdomain returned HTTP ${res.status}`);
        }
      } catch (e) {
        log(`Warning: subdomain not yet reachable (may take a few minutes for DNS propagation): ${e}`);
      }
    }

    // --- Done ---
    setStep("done");
    updateInstance(instance.id, { status: "running" });
    insertEvent(instance.id, "running", "Instance is running");
    log("Provisioning complete!");

    return state;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    state.error = errMsg;
    log(`ERROR: ${errMsg}`);

    if (state.instance_id) {
      updateInstance(state.instance_id, { status: "error" });
      insertEvent(state.instance_id, "error", errMsg);
    }

    return state;
  }
}

export async function destroy(
  instanceId: number,
  onLog?: (msg: string) => void
): Promise<void> {
  const hetzner = getHetznerClient();
  const { getInstance } = await import("../db/queries.js");
  const instance = getInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  const log = (msg: string) => onLog?.(msg);

  updateInstance(instanceId, { status: "destroying" });
  insertEvent(instanceId, "destroying", "Destruction started");

  // Clean up Cloudflare resources (before server deletion)
  if (instance.cf_access_app_id) {
    log(`Deleting Cloudflare Access app ${instance.cf_access_app_id}...`);
    try {
      await cloudflare.deleteAccessApplication(instance.cf_access_app_id);
      log("Access app deleted");
    } catch (e) {
      log(`Warning: Access app deletion failed: ${e}`);
    }
  }

  if (instance.cf_dns_record_id) {
    log(`Deleting DNS record ${instance.cf_dns_record_id}...`);
    try {
      await cloudflare.deleteDnsRecord(instance.cf_dns_record_id);
      log("DNS record deleted");
    } catch (e) {
      log(`Warning: DNS record deletion failed: ${e}`);
    }
  }

  if (instance.cf_tunnel_id) {
    log(`Deleting Cloudflare Tunnel ${instance.cf_tunnel_id}...`);
    try {
      await cloudflare.deleteTunnel(instance.cf_tunnel_id);
      log("Tunnel deleted");
    } catch (e) {
      log(`Warning: Tunnel deletion failed: ${e}`);
    }
  }

  if (instance.server_id) {
    log(`Deleting server ${instance.server_id}...`);
    await hetzner.deleteServer(instance.server_id);
    log("Server deleted");
  }

  if (instance.volume_id) {
    // Volume must be detached before deletion; server deletion detaches it
    // but may take a moment
    await new Promise((r) => setTimeout(r, 5000));
    log(`Deleting volume ${instance.volume_id}...`);
    try {
      await hetzner.deleteVolume(instance.volume_id);
      log("Volume deleted");
    } catch (e) {
      log(`Warning: volume deletion failed (may need manual cleanup): ${e}`);
    }
  }

  if (instance.ssh_key_id) {
    log(`Deleting SSH key ${instance.ssh_key_id}...`);
    await hetzner.deleteSSHKey(instance.ssh_key_id);
    log("SSH key deleted");
  }

  updateInstance(instanceId, { status: "destroyed" });
  insertEvent(instanceId, "destroyed", "Instance destroyed");
  log("Destruction complete");
}

export async function updateImages(
  instanceId: number,
  sha?: string,
  onLog?: (msg: string) => void
): Promise<void> {
  const { getInstance } = await import("../db/queries.js");
  const instance = getInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);
  if (!instance.ip_address || !instance.ssh_key_path) {
    throw new Error("Instance not fully provisioned");
  }

  const log = (msg: string) => onLog?.(msg);
  const tag = sha ?? "latest";

  log(`Pulling images (tag: ${tag})...`);
  const pullResult = await ssh.exec(
    instance.ip_address,
    instance.ssh_key_path,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose pull`
  );
  log(pullResult.stdout);

  log("Restarting containers...");
  const upResult = await ssh.exec(
    instance.ip_address,
    instance.ssh_key_path,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d --remove-orphans`
  );
  log(upResult.stdout);

  if (sha) {
    updateInstance(instanceId, { current_image_sha: sha });
  }
  insertEvent(instanceId, "updated", `Updated to ${tag}`);
  log("Update complete");
}

export async function deployApi(
  instanceId: number,
  onLog?: (msg: string) => void
): Promise<void> {
  const { getInstance } = await import("../db/queries.js");
  const instance = getInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);
  if (!instance.ip_address || !instance.ssh_key_path) {
    throw new Error("Instance not fully provisioned");
  }

  const log = (msg: string) => onLog?.(msg);

  // Remap SSH key path: DB may store /app/alfred-ctrl/... (container path)
  // but we may be running on the host where cwd is /opt/alfred-saas/alfred-ctrl
  const sshKeyPath = instance.ssh_key_path.replace(
    /^\/app\/alfred-ctrl\//,
    process.cwd() + "/"
  );

  const apiMjsPath = path.join(process.cwd(), "dist", "api.mjs");
  try {
    await fs.access(apiMjsPath);
  } catch {
    throw new Error(`api.mjs not found at ${apiMjsPath}`);
  }

  log("Uploading api.mjs...");
  const apiContent = await fs.readFile(apiMjsPath, "utf-8");
  await ssh.upload(
    instance.ip_address,
    sshKeyPath,
    apiContent,
    `${DEFAULTS.alfredBasePath}/api.mjs`,
    0o644
  );

  log("Restarting alfred-api service...");
  await ssh.exec(
    instance.ip_address,
    sshKeyPath,
    "sudo systemctl restart alfred-api"
  );

  log("Verifying service is active...");
  const check = await ssh.exec(
    instance.ip_address,
    sshKeyPath,
    "sleep 1 && systemctl is-active alfred-api"
  );
  if (check.stdout.trim() !== "active") {
    throw new Error(`alfred-api not active: ${check.stdout.trim()} ${check.stderr.trim()}`);
  }

  insertEvent(instanceId, "api_deployed", "Tenant API updated");
  log("API deployed successfully");
}

export async function rollback(
  instanceId: number,
  sha?: string,
  onLog?: (msg: string) => void
): Promise<void> {
  const { getInstance } = await import("../db/queries.js");
  const instance = getInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  const targetSha = sha ?? instance.last_healthy_sha;
  if (!targetSha) throw new Error("No healthy SHA available for rollback");

  onLog?.(`Rolling back to ${targetSha}...`);
  await updateImages(instanceId, targetSha, onLog);
  insertEvent(instanceId, "rolled_back", `Rolled back to ${targetSha}`);
  onLog?.("Rollback complete");
}

/**
 * Repair Cloudflare Tunnel on an existing instance.
 *
 * Fixes the sudoers rules (missing cloudflared entry), then reinstalls and
 * verifies the cloudflared systemd service. Requires the instance to already
 * have tunnel credentials in the database (cf_tunnel_id set).
 */
export async function repairTunnel(
  instanceId: number,
  onLog?: (msg: string) => void
): Promise<void> {
  const { getInstance } = await import("../db/queries.js");
  const instance = getInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);
  if (!instance.ip_address || !instance.ssh_key_path) {
    throw new Error("Instance not fully provisioned");
  }
  if (!instance.cf_tunnel_id) {
    throw new Error("Instance has no Cloudflare tunnel configured");
  }

  const log = (msg: string) => onLog?.(msg);

  // Remap SSH key path (same as deployApi)
  const sshKeyPath = instance.ssh_key_path.replace(
    /^\/app\/alfred-ctrl\//,
    process.cwd() + "/"
  );

  // Upload a fix script that runs as root (deploy can sudo bash /opt/alfred/*.sh)
  const fixScript = `#!/bin/bash
set -euo pipefail

echo "=== Repairing Cloudflare Tunnel ==="

# Fix sudoers: add cloudflared and chown if missing
SUDOERS_FILE="/etc/sudoers.d/99-alfred-deploy"
if [ ! -f "$SUDOERS_FILE" ] || ! grep -q cloudflared "$SUDOERS_FILE" 2>/dev/null; then
  echo "Fixing sudoers rules..."
  cat > "$SUDOERS_FILE" << 'SUDOERS'
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl *
deploy ALL=(ALL) NOPASSWD: /usr/bin/tailscale *
deploy ALL=(ALL) NOPASSWD: /usr/bin/cloudflared *
deploy ALL=(ALL) NOPASSWD: /usr/local/bin/cloudflared *
deploy ALL=(ALL) NOPASSWD: /usr/bin/chown *
deploy ALL=(ALL) NOPASSWD: /usr/bin/mkdir -p /opt/alfred/*
deploy ALL=(ALL) NOPASSWD: /usr/bin/bash /opt/alfred/*.sh
deploy ALL=(ALL) NOPASSWD: /usr/bin/bash -c set -a && source /opt/alfred/*.env *
SUDOERS
  chmod 440 "$SUDOERS_FILE"
  echo "Sudoers updated"
fi

# Verify credentials exist
if [ ! -f /etc/cloudflared/credentials.json ]; then
  echo "ERROR: /etc/cloudflared/credentials.json not found"
  exit 1
fi

if [ ! -f /etc/cloudflared/config.yml ]; then
  echo "ERROR: /etc/cloudflared/config.yml not found"
  exit 1
fi

# If cloudflared is already active, skip reinstall
if systemctl is-active --quiet cloudflared 2>/dev/null; then
  echo "cloudflared service is already ACTIVE — skipping reinstall"
else
  # Fully uninstall existing service (cleans up both cloudflared.service and cloudflared-update.service)
  cloudflared service uninstall 2>/dev/null || true
  systemctl daemon-reload

  # Reinstall and start
  cloudflared service install
  systemctl enable --now cloudflared
fi

# Wait and verify
sleep 3
if systemctl is-active --quiet cloudflared; then
  echo "cloudflared service is ACTIVE"
else
  echo "ERROR: cloudflared service failed to start"
  journalctl -u cloudflared -n 20 --no-pager
  exit 1
fi

echo "=== Tunnel repair complete ==="
`;

  log("Uploading tunnel repair script...");
  await ssh.upload(
    instance.ip_address,
    sshKeyPath,
    fixScript,
    `${DEFAULTS.alfredBasePath}/fix-tunnel.sh`,
    0o700,
  );

  log("Running tunnel repair (as root via sudo)...");
  const result = await ssh.exec(
    instance.ip_address,
    sshKeyPath,
    `sudo bash ${DEFAULTS.alfredBasePath}/fix-tunnel.sh`,
  );
  log(result.stdout);
  if (result.stderr) log(result.stderr);

  if (result.code !== 0) {
    throw new Error(`Tunnel repair failed (exit ${result.code})`);
  }

  // Clean up
  await ssh.exec(
    instance.ip_address,
    sshKeyPath,
    `rm -f ${DEFAULTS.alfredBasePath}/fix-tunnel.sh`,
  );

  insertEvent(instanceId, "tunnel_repaired", "Cloudflare Tunnel repaired");
  log("Tunnel repair complete");
}
