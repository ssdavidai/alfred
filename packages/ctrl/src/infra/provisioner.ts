import nunjucks from "nunjucks";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { getHetznerClient } from "./hetzner.js";
import { generateKeyPair } from "./keys.js";
import { ensureFirewall } from "./firewall.js";
import * as ssh from "./ssh.js";
import type { SSHHostKeyOptions } from "./ssh.js";
import { buildEnvWriteCommand } from "./env-write.js";
import * as tailscale from "./tailscale.js";
import * as cloudflare from "./cloudflare.js";
import { registerPeerOnPrime } from "./peer-registration.js";
import {
  generateSubdomain as _generateSubdomain,
  planeSlug as _planeSlug,
  planeHostnameFromCustomerName,
} from "./plane-hostname.js";
import {
  createInstance,
  updateInstance,
  insertEvent,
  getInstance,
} from "../db/queries.js";
import { DEFAULTS } from "../data/constants.js";
import type { InstanceConfig, ProvisioningState, ProvisioningStep } from "../data/types.js";

import cloudInitTemplate from "../templates/cloud-init.yaml.njk";
import cloudInitSnapshotTemplate from "../templates/cloud-init-snapshot.yaml.njk";
import dockerComposeTemplate from "../templates/docker-compose.yaml.njk";
import bootstrapTemplate from "../templates/bootstrap-openclaw.sh.njk";
import cloudflaredConfigTemplate from "../templates/cloudflared-config.yaml.njk";
import vexaStackTemplate from "../templates/vexa-stack.yaml.njk";
import openclawConfigTemplate from "../templates/openclaw-config.json.njk";
import openclawWorkersConfigTemplate from "../templates/openclaw-workers-config.json.njk";
import workflowAuthorSkill from "../templates/skills/workflow-author.md";
// Vault seed — skill graph files
import vaultSkillIndex from "../templates/vault-seed/skill/index.md";
import vaultSkillNoiseFiltering from "../templates/vault-seed/skill/input-noise-filtering.md";
import vaultSkillEntityExtraction from "../templates/vault-seed/skill/input-entity-extraction.md";
import vaultSkillSummarize from "../templates/vault-seed/skill/execution-summarize.md";
import vaultSkillResearch from "../templates/vault-seed/skill/execution-research.md";
import vaultSkillPropagation from "../templates/vault-seed/skill/propagation-task-creation.md";
import vaultSkillPreferenceOwner from "../templates/vault-seed/skill/preference-owner.md.njk";
// Vault seed — templates
import vaultTemplateTriage from "../templates/vault-seed/_templates/triage.md";
import vaultTemplateTask from "../templates/vault-seed/_templates/task.md";
import vaultTemplateSkill from "../templates/vault-seed/_templates/skill.md";
import vaultTemplateMatter from "../templates/vault-seed/_templates/matter.md";
import vaultTemplateLedgerEntry from "../templates/vault-seed/_templates/ledger_entry.md";
import workspaceAgents from "../templates/workspace/AGENTS.md";
import workspaceSoul from "../templates/workspace/SOUL.md";
import workspaceMemory from "../templates/workspace/MEMORY.md";
import workspaceUser from "../templates/workspace/USER.md";
import workspaceKnownContacts from "../templates/workspace/KNOWN_CONTACTS.md.njk";
import hookReadme from "../hooks/alfred-inbox/HOOK.md";
// @ts-expect-error esbuild plugin loads handler.js as text
import hookHandler from "../hooks/alfred-inbox/handler.js";
import observerHookReadme from "../hooks/alfred-learn-observer/HOOK.md";
// @ts-expect-error esbuild plugin loads handler.js as text
import observerHookHandler from "../hooks/alfred-learn-observer/handler.js";
import mediaHookReadme from "../hooks/alfred-learn-media/HOOK.md";
// @ts-expect-error esbuild plugin loads handler.js as text
import mediaHookHandler from "../hooks/alfred-learn-media/handler.js";

nunjucks.configure({ autoescape: false });

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

// Re-export so historical import paths keep working.
export const generateSubdomain = _generateSubdomain;
export { planeHostnameFromCustomerName };

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
      size: DEFAULTS.volumeSizeGb,
      location: config.location,
      labels: { customer: config.customer_name },
    });
    state.volume_id = volume.id;
    updateInstance(instance.id, { volume_id: volume.id });
    log(`Volume created (id: ${volume.id})`);

    // --- Render cloud-init ---
    setStep("render_cloud_init");
    const useSnapshot = !!config.snapshot_id;
    const ciTemplate = useSnapshot ? cloudInitSnapshotTemplate : cloudInitTemplate;
    log(`Rendering cloud-init (${useSnapshot ? "snapshot" : "full"})...`);
    const cloudInit = nunjucks.renderString(ciTemplate, {
      ssh_public_key: keyPair.publicKey,
      volume_id: volume.id,
    });
    log("Cloud-init rendered");

    // --- Create server ---
    setStep("create_server");
    log(`Creating server (${config.server_type} in ${config.location})...`);
    const serverLabels: Record<string, string> = {
      customer: config.customer_name,
    };
    // Plane + Sure are part of the standard tenant baseline. Pass
    // `planeEnabled: false` / `sureEnabled: false` on `config` to opt
    // a specific tenant out (rare — e.g. testing minimal stacks).
    const planeOnDefault = config.planeEnabled !== false;
    const sureOnDefault = config.sureEnabled !== false;
    // Vaultwarden is on by default for new tenants now that david's canary
    // soaked the full down/up cycle (#808). Pass `vaultwardenEnabled: false`
    // explicitly to opt out — useful for staging tenants where the extra
    // /admin/invite step adds no value.
    const vaultwardenOnDefault = config.vaultwardenEnabled !== false;
    // Vexa is OPT-IN (default off). The 9-container vexa stack pulls a
    // ~2.5 GB resource floor on top of alfred — only stand it up where
    // Steward Phase 4 (#840) is wanted. Pass `vexaEnabled: true` to opt in.
    const vexaOnDefault = config.vexaEnabled === true;
    if (planeOnDefault) {
      // Marks the tenant as carrying the Plane sidecar stack — used by later
      // fleet-wide scans (e.g. "list all tenants running Plane") without
      // having to SSH and check docker ps. See issue #536.
      serverLabels["plane-enabled"] = "true";
    }
    if (sureOnDefault) {
      serverLabels["sure-enabled"] = "true";
    }
    if (vaultwardenOnDefault) {
      serverLabels["vaultwarden-enabled"] = "true";
    }
    if (vexaOnDefault) {
      serverLabels["vexa-enabled"] = "true";
    }
    const { server } = await hetzner.createServer({
      name: `alfred-${config.customer_name}`,
      server_type: config.server_type,
      location: config.location,
      image: config.snapshot_id ?? undefined,
      ssh_keys: [ssh_key.id],
      user_data: cloudInit,
      firewalls: [{ firewall: firewallId }],
      labels: serverLabels,
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
    // Platform-level keys — shared across all tenants
    if (process.env.GROQ_API_KEY) {
      envLines.push(`GROQ_API_KEY=${process.env.GROQ_API_KEY}`);
    }

    // Composio per-tenant user_id — MUST be unique across the fleet so that
    // connected OAuth accounts are scoped to this tenant. Without this, the
    // single shared COMPOSIO_API_KEY would let every tenant see (and execute
    // against) every other tenant's connections. See #408.
    //
    // Format: alfred-<slug>-<instance_id> — the slug is derived from the
    // customer_name (already validated by VALID_NAME regex) with any stray
    // non-alphanumeric chars stripped, so e.g. customer_name="rapali-zsolt"
    // + instance.id=101 → "alfred-rapalizsolt-101".
    const composioSlug = config.customer_name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    const composioUserId = `alfred-${composioSlug}-${instance.id}`;
    envLines.push(`COMPOSIO_USER_ID=${composioUserId}`);
    // Inherit the platform-level Composio API key if present — single shared
    // key across all tenants; isolation comes from the user_id scoping.
    if (process.env.COMPOSIO_API_KEY) {
      envLines.push(`COMPOSIO_API_KEY=${process.env.COMPOSIO_API_KEY}`);
    }

    // AgentMail — per-tenant inbox credentials, provisioned by SaaS before
    // this job spawns and threaded through as TENANT_AGENTMAIL_* env vars
    // on the ctrl process. Tenant isolation here comes from the inbox-scoped
    // API key (single shared pod on the Developer plan;
    // see deploy/agentmail-bootstrap.md).
    const amInboxId = process.env.TENANT_AGENTMAIL_INBOX_ID;
    const amInboxAddress = process.env.TENANT_AGENTMAIL_INBOX_ADDRESS;
    const amInboxKey = process.env.TENANT_AGENTMAIL_API_KEY;
    if (amInboxId && amInboxAddress && amInboxKey) {
      envLines.push(`AGENTMAIL_INBOX_ID=${amInboxId}`);
      envLines.push(`AGENTMAIL_INBOX_ADDRESS=${amInboxAddress}`);
      envLines.push(`AGENTMAIL_API_KEY=${amInboxKey}`);
      log(`AgentMail: ${amInboxAddress}`);
    }

    // Owner email — used by the init container to seed authorized_senders.json
    // and by outbound email defaults (Reply-To, From display name).
    if (process.env.TENANT_OWNER_EMAIL) {
      envLines.push(`OWNER_EMAIL=${process.env.TENANT_OWNER_EMAIL}`);
    }

    // Sure sidecar gate — the init container's step-12 staging logic gates
    // on SURE_ENABLED=true, and ctrl-api's sure routes/proxy depend on
    // SURE_API_KEY being present (written below by setupSure once
    // sure-init has minted the key).
    if (sureOnDefault) {
      envLines.push(`SURE_ENABLED=true`);
    }

    // Tenant-scoped subdomain + domain + base URL — read by ctrl-api to build
    // public per-app URLs (e.g. <subdomain>-sure.<domain>) and ready-to-use
    // public webhook URLs (TENANT_BASE_URL is what makes the streams API
    // compose webhook_url server-side instead of asking the agent to guess).
    // The three values mirror what cloudflared and the SaaS dashboard use.
    const cfDomain = process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain;
    envLines.push(`TENANT_SUBDOMAIN=${subdomain}`);
    envLines.push(`TENANT_DOMAIN=${cfDomain}`);
    envLines.push(`TENANT_BASE_URL=https://${subdomain}.${cfDomain}`);

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

    // AgentMail fallback file — survives .env rewrites and can be read by
    // the init container even before docker compose loads env. Mirrors the
    // Composio fallback pattern (.composio-user-id).
    if (amInboxId && amInboxAddress && amInboxKey) {
      const amFallback = JSON.stringify(
        {
          inbox_id: amInboxId,
          inbox_address: amInboxAddress,
          api_key: amInboxKey,
        },
        null,
        2,
      );
      await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        `sudo mkdir -p /mnt/encrypted/alfred`,
        undefined,
        hostKeyOpts,
      );
      await ssh.upload(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        amFallback,
        `/mnt/encrypted/alfred/.agentmail-credentials.json`,
        0o600,
        undefined,
        hostKeyOpts,
      );
      log("AgentMail credentials fallback file written");
    }

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
    const compose = nunjucks.renderString(dockerComposeTemplate, {
      plane_enabled: planeOnDefault,
      sure_enabled: sureOnDefault,
      vaultwarden_enabled: vaultwardenOnDefault,
      vexa_enabled: vexaOnDefault,
      subdomain: subdomain ?? config.customer_name,
      domain: process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain,
      customer_name: config.customer_name,
    });
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
    if (useSnapshot) {
      log("Snapshot boot — skipping image pull (pre-baked)");
    } else {
      log("Pulling images...");
      // timeout: 10 min for image pull. Retry once on failure.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const pullResult = await ssh.exec(
          server.public_net.ipv4.ip,
          keyPair.privateKeyPath,
          `cd ${DEFAULTS.dockerComposeDir} && timeout 600 docker compose pull 2>&1`,
          undefined,
          hostKeyOpts,
        );
        if (pullResult.code === 0) break;
        if (attempt === 2) throw new Error(`Docker pull failed after 2 attempts: ${pullResult.stdout}`);
        log(`Image pull attempt ${attempt} failed (exit ${pullResult.code}), retrying...`);
      }
    }
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
    // Ensure OpenClaw workspace directory exists (init container may not create it)
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `mkdir -p /mnt/encrypted/openclaw/workspace`,
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

    // Upload workspace files (AGENTS.md, SOUL.md, MEMORY.md, USER.md, KNOWN_CONTACTS.md)
    // These provide the baked-in Alfred persona, entity-check rules, the
    // memory structure, and the channel-delivery shortcut table that every
    // tenant instance must start with.
    log("Uploading workspace files...");
    const workspaceBasePath = "/mnt/encrypted/openclaw/workspace";
    const renderedUser = nunjucks.renderString(workspaceUser, {
      customer_name: config.customer_name,
      customer_email: config.customer_email ?? "",
    });
    // KNOWN_CONTACTS.md.njk is rendered with whatever owner / channel data
    // we already know at provision time. Slack + Telegram IDs only become
    // available after the user pairs (so they start blank — the skill teaches
    // Alfred to fall back to discovery and write the IDs back here once
    // captured). AgentMail address is set if the inbox was provisioned ahead
    // of this job; AgentPhone number is provisioned later (in
    // provisionAgentPhone) and will land blank on first render.
    const renderedKnownContacts = nunjucks.renderString(workspaceKnownContacts, {
      customer_name: config.customer_name,
      customer_email: config.customer_email ?? "",
      owner_email: process.env.TENANT_OWNER_EMAIL ?? config.customer_email ?? "",
      owner_display_name: "",
      agentmail_inbox: process.env.TENANT_AGENTMAIL_INBOX_ADDRESS ?? "",
      agentphone_number: "",
    });
    await Promise.all([
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, workspaceAgents, `${workspaceBasePath}/AGENTS.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, workspaceSoul, `${workspaceBasePath}/SOUL.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, workspaceMemory, `${workspaceBasePath}/MEMORY.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, renderedUser, `${workspaceBasePath}/USER.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, renderedKnownContacts, `${workspaceBasePath}/KNOWN_CONTACTS.md`, 0o644, undefined, hostKeyOpts),
    ]);
    log("Workspace files uploaded");

    // Seed vault with skill graph, templates, and folder structure
    log("Seeding vault with skill graph + templates...");
    const vaultPath = "/mnt/encrypted/vault";
    const renderedPreference = nunjucks.renderString(vaultSkillPreferenceOwner, {
      customer_name: config.customer_name,
    });
    // Create vault directories
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `mkdir -p ${vaultPath}/skill ${vaultPath}/triage ${vaultPath}/task ${vaultPath}/matter ${vaultPath}/ledger_entry ${vaultPath}/_templates`,
      undefined,
      hostKeyOpts,
    );
    // Upload skill files
    await Promise.all([
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultSkillIndex, `${vaultPath}/skill/index.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultSkillNoiseFiltering, `${vaultPath}/skill/input-noise-filtering.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultSkillEntityExtraction, `${vaultPath}/skill/input-entity-extraction.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultSkillSummarize, `${vaultPath}/skill/execution-summarize.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultSkillResearch, `${vaultPath}/skill/execution-research.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultSkillPropagation, `${vaultPath}/skill/propagation-task-creation.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, renderedPreference, `${vaultPath}/skill/preference-owner.md`, 0o644, undefined, hostKeyOpts),
    ]);
    // Upload vault templates
    await Promise.all([
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultTemplateTriage, `${vaultPath}/_templates/triage.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultTemplateTask, `${vaultPath}/_templates/task.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultTemplateSkill, `${vaultPath}/_templates/skill.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultTemplateMatter, `${vaultPath}/_templates/matter.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, vaultTemplateLedgerEntry, `${vaultPath}/_templates/ledger_entry.md`, 0o644, undefined, hostKeyOpts),
    ]);
    log("Vault seed complete: 7 skills, 5 templates, 5 directories");

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

    // Upload alfred-learn-observer hook (captures routing patterns → observation queue for learning)
    log("Uploading alfred-learn-observer hook...");
    const observerHookBasePath = "/mnt/encrypted/openclaw/hooks/alfred-learn-observer";
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `mkdir -p ${observerHookBasePath}`,
      undefined,
      hostKeyOpts,
    );
    await Promise.all([
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, observerHookReadme, `${observerHookBasePath}/HOOK.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, observerHookHandler, `${observerHookBasePath}/handler.js`, 0o644, undefined, hostKeyOpts),
    ]);
    log("Observer hook uploaded");

    // Upload alfred-learn-media hook (captures attachment file-share events
    // from any channel → queues media ingestion so transcriptions/extracts
    // land in the vault alongside the chat text).
    log("Uploading alfred-learn-media hook...");
    const mediaHookBasePath = "/mnt/encrypted/openclaw/hooks/alfred-learn-media";
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `mkdir -p ${mediaHookBasePath}`,
      undefined,
      hostKeyOpts,
    );
    await Promise.all([
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, mediaHookReadme, `${mediaHookBasePath}/HOOK.md`, 0o644, undefined, hostKeyOpts),
      ssh.upload(server.public_net.ipv4.ip, keyPair.privateKeyPath, mediaHookHandler, `${mediaHookBasePath}/handler.js`, 0o644, undefined, hostKeyOpts),
    ]);
    log("Media hook uploaded");

    // Pre-configure openclaw.json with baked-in config before openclaw starts.
    // Includes: heartbeat (4h), compaction (60k token flush), qmd memory
    // backend, and controlUi for LAN binding. Deep-merged with any existing
    // config the init container created (preserving gateway tokens etc.).
    log("Pre-configuring OpenClaw...");
    // Generate a shared gateway token for both openclaw and openclaw-workers.
    // Both gateways must use the same token so alfred/alfred-learn can authenticate
    // against either one using the single .gateway-token file.
    const gatewayToken = crypto.randomBytes(24).toString("hex");
    // vault_path: where the vault volume is mounted inside the openclaw container
    // (per docker-compose.yaml.njk: /mnt/encrypted/vault → /home/node/.openclaw/workspace/vault)
    const openclawConfig = nunjucks.renderString(openclawConfigTemplate, {
      vault_path: "/home/node/.openclaw/workspace/vault",
      gateway_token: gatewayToken,
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

    // Write the shared gateway token to the .gateway-token file so alfred/alfred-learn
    // can read it on startup. This ensures all services use the same token from the start.
    await ssh.exec(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      `printf '%s' '${gatewayToken}' > /mnt/encrypted/alfred/.gateway-token && chmod 644 /mnt/encrypted/alfred/.gateway-token`,
      undefined,
      hostKeyOpts,
    );
    updateInstance(instance.id, { gateway_token: gatewayToken });
    log("Gateway token written");

    // Pre-configure openclaw-workers with worker-specific config (no user-facing agents)
    log("Pre-configuring OpenClaw Workers...");
    const workersConfig = nunjucks.renderString(openclawWorkersConfigTemplate, {
      vault_path: "/home/node/.openclaw/workspace/vault",
      gateway_token: gatewayToken,
    });
    await ssh.upload(
      server.public_net.ipv4.ip,
      keyPair.privateKeyPath,
      workersConfig,
      "/tmp/openclaw-workers-config.json",
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

os.makedirs('/mnt/encrypted/openclaw-workers', exist_ok=True)
p = '/mnt/encrypted/openclaw-workers/openclaw.json'
cfg = {}
if os.path.exists(p):
    with open(p) as f: cfg = json.load(f)
with open('/tmp/openclaw-workers-config.json') as f: tenant = json.load(f)
deep_merge(cfg, tenant)
with open(p, 'w') as f: json.dump(cfg, f, indent=2)
os.remove('/tmp/openclaw-workers-config.json')
os.makedirs('/mnt/encrypted/openclaw-workers/workspace', exist_ok=True)
"`,
      undefined,
      hostKeyOpts,
    );
    log("OpenClaw Workers configured");

    // --- Pre-deploy tenant API (must exist before bootstrap starts ctrl-api) ---
    {
      const preApiMjsPath = path.join(process.cwd(), "dist", "api.mjs");
      const preApiKey = crypto.randomBytes(32).toString("hex");
      try {
        log("Pre-deploying api.mjs for ctrl-api...");
        // Ensure target directory exists (cloud-init creates it, but be defensive)
        await ssh.exec(
          server.public_net.ipv4.ip,
          keyPair.privateKeyPath,
          `sudo mkdir -p ${DEFAULTS.alfredBasePath}`,
          undefined,
          hostKeyOpts,
        );
        await ssh.upload(
          server.public_net.ipv4.ip,
          keyPair.privateKeyPath,
          (await fs.readFile(preApiMjsPath, "utf-8")),
          `${DEFAULTS.alfredBasePath}/api.mjs`,
          0o644,
          undefined,
          hostKeyOpts,
        );
        // Verify upload produced a file (not a directory)
        const verifyResult = await ssh.exec(
          server.public_net.ipv4.ip,
          keyPair.privateKeyPath,
          `test -f ${DEFAULTS.alfredBasePath}/api.mjs && wc -c < ${DEFAULTS.alfredBasePath}/api.mjs`,
          undefined,
          hostKeyOpts,
        );
        log(`api.mjs uploaded (${verifyResult.stdout.trim()} bytes)`);
        await ssh.exec(
          server.public_net.ipv4.ip,
          keyPair.privateKeyPath,
          `echo 'AAS_API_KEY=${preApiKey}' >> ${DEFAULTS.dockerComposeDir}/.env`,
          undefined,
          hostKeyOpts,
        );
        updateInstance(instance.id, { api_key: preApiKey });
        log("AAS_API_KEY ready");

        // alfred-mcp-server pre-shared approval secret. Sir enters this
        // once per Claude Custom Connector add. Generated here so it's
        // available before mcp-server first boots (otherwise the container
        // crashloops because MCP_APPROVAL_SECRET is required).
        const mcpApprovalSecret = crypto.randomBytes(24).toString("hex");
        await ssh.exec(
          server.public_net.ipv4.ip,
          keyPair.privateKeyPath,
          `echo 'MCP_APPROVAL_SECRET=${mcpApprovalSecret}' >> ${DEFAULTS.dockerComposeDir}/.env`,
          undefined,
          hostKeyOpts,
        );
        log(`MCP_APPROVAL_SECRET written (${mcpApprovalSecret.length} chars)`);
      } catch (e) {
        log(`Warning: pre-deploy api.mjs failed: ${e}`);
      }
    }

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

    // Extract gateway token from OpenClaw config and write to shared .gateway-token file
    // so alfred-learn (and other services) can authenticate with the gateway.
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
        // Write gateway token to shared file for alfred-learn / worker access
        await ssh.exec(
          server.public_net.ipv4.ip,
          keyPair.privateKeyPath,
          `printf '%s' '${gatewayToken}' > /mnt/encrypted/alfred/.gateway-token && chmod 644 /mnt/encrypted/alfred/.gateway-token`,
          undefined,
          hostKeyOpts,
        );
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
      // Ensure deploy user can read backup files (provisioner runs as root
      // in Docker, but aas CLI runs as deploy on the host)
      const deployUid = process.env.DEPLOY_UID ?? "1000";
      const deployGid = process.env.DEPLOY_GID ?? "1000";
      try {
        const { execFile: execFileCb } = await import("child_process");
        const { promisify } = await import("util");
        await promisify(execFileCb)("chown", ["-R", `${deployUid}:${deployGid}`, backupDir]);
      } catch (chownErr: unknown) {
        const msg = chownErr instanceof Error ? chownErr.message : String(chownErr);
        if (!msg.includes("Operation not permitted")) {
          log(`Warning: could not chown backup directory: ${msg}`);
        }
      }
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
        plane_enabled: planeOnDefault,
        sure_enabled: sureOnDefault,
        vaultwarden_enabled: vaultwardenOnDefault,
        vexa_enabled: vexaOnDefault,
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

      // If Plane is being provisioned alongside the main stack, create the
      // sidecar DNS record too. `<subdomain>-plane.<domain>` stays a
      // SINGLE-level subdomain so the `*.alfred.black` wildcard cert
      // continues to cover it.
      let planeDnsRecordId: string | null = null;
      if (planeOnDefault) {
        try {
          const planeRec = await cloudflare.createDnsRecord(
            `${subdomain}-plane`,
            tunnel.id,
          );
          planeDnsRecordId = planeRec.id;
          log(`DNS record created: ${subdomain}-plane.${domain} → tunnel`);
        } catch (e) {
          log(
            `Warning: could not create Plane DNS record (${subdomain}-plane.${domain}): ${e}`,
          );
        }
      }

      let sureDnsRecordId: string | null = null;
      if (sureOnDefault) {
        try {
          const sureRec = await cloudflare.createDnsRecord(
            `${subdomain}-sure`,
            tunnel.id,
          );
          sureDnsRecordId = sureRec.id;
          log(`DNS record created: ${subdomain}-sure.${domain} → tunnel`);
        } catch (e) {
          log(
            `Warning: could not create Sure DNS record (${subdomain}-sure.${domain}): ${e}`,
          );
        }
      }

      // Vaultwarden gets `<subdomain>-vault.<domain>` (single-level — the
      // wildcard cert `*.<domain>` doesn't cover two-level subdomains, see
      // setup_plane / setup_sure for the same constraint). Access app
      // restricts to the owner's email so cloudflared fronts a Sir-only
      // login surface even though Vaultwarden itself is reachable from
      // the open internet behind the tunnel.
      let vaultDnsRecordId: string | null = null;
      let vaultAccessAppId: string | null = null;
      if (vaultwardenOnDefault) {
        try {
          const vaultRec = await cloudflare.createDnsRecord(
            `${subdomain}-vault`,
            tunnel.id,
          );
          vaultDnsRecordId = vaultRec.id;
          log(`DNS record created: ${subdomain}-vault.${domain} → tunnel`);
        } catch (e) {
          log(
            `Warning: could not create Vault DNS record (${subdomain}-vault.${domain}): ${e}`,
          );
        }
        const ownerEmail = process.env.TENANT_OWNER_EMAIL ?? config.customer_email;
        if (vaultDnsRecordId && ownerEmail) {
          try {
            const accessApp = await cloudflare.createAccessApplication(
              `${subdomain}-vault`,
              [ownerEmail],
            );
            vaultAccessAppId = accessApp.id;
            log(
              `Cloudflare Access app created for ${subdomain}-vault.${domain} (allowedEmails=[${ownerEmail}])`,
            );
          } catch (e) {
            log(
              `Warning: could not create Cloudflare Access app for vault: ${e} — vault.<subdomain> will be reachable WITHOUT SSO until this is fixed`,
            );
          }
        } else if (vaultDnsRecordId && !ownerEmail) {
          log(
            "Warning: TENANT_OWNER_EMAIL / customer_email not set — skipping Cloudflare Access app for vault. Configure manually before exposing.",
          );
        }
      }

      // Vexa Dashboard gets `<subdomain>-vexa.<domain>` (single-level —
      // wildcard cert constraint). Unlike vault, vexa is NOT behind
      // Cloudflare Access — the dashboard runs in direct-login mode and
      // its admin token already gates write paths; ingress on the open
      // tunnel is fine. Sir can layer Access on later if he wants.
      let vexaDnsRecordId: string | null = null;
      if (vexaOnDefault) {
        try {
          const vexaRec = await cloudflare.createDnsRecord(
            `${subdomain}-vexa`,
            tunnel.id,
          );
          vexaDnsRecordId = vexaRec.id;
          log(`DNS record created: ${subdomain}-vexa.${domain} → tunnel`);
        } catch (e) {
          log(
            `Warning: could not create Vexa DNS record (${subdomain}-vexa.${domain}): ${e}`,
          );
        }
      }

      // Update instance with tunnel metadata
      updateInstance(instance.id, {
        cf_tunnel_id: tunnel.id,
        cf_tunnel_name: tunnel.name,
        cf_dns_record_id: dnsRecord.id,
        cf_plane_dns_record_id: planeDnsRecordId,
        cf_sure_dns_record_id: sureDnsRecordId,
        cf_vault_dns_record_id: vaultDnsRecordId,
        cf_vault_access_app_id: vaultAccessAppId,
        cf_vexa_dns_record_id: vexaDnsRecordId,
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

    // --- Finalize tenant API (already pre-deployed before bootstrap) ---
    setStep("deploy_api");
    log("Finalizing tenant API...");
    try {
      // Restart ctrl-api to pick up any post-bootstrap config changes
      await ssh.exec(
        server.public_net.ipv4.ip,
        keyPair.privateKeyPath,
        `cd ${DEFAULTS.dockerComposeDir} && docker compose restart ctrl-api 2>/dev/null || true`,
        undefined,
        hostKeyOpts,
      );
      insertEvent(instance.id, "api_deployed", "Tenant API deployed");
      log("Tenant API finalized");
    } catch (e) {
      log(`Warning: tenant API finalization failed: ${e}`);
    }

    // --- Provision AgentPhone (Twilio number + tenant .env wiring) ---
    setStep("provision_phone");
    log("Provisioning AgentPhone number...");
    try {
      // Country resolution (issue #535):
      //   1. Per-instance `config.country` from the SaaS `Instance.country`
      //      column — set this once Twilio entitlement for that country
      //      exists (HU regulatory bundle is in flight).
      //   2. Fleet-wide override via `TWILIO_DEFAULT_COUNTRY` env.
      //   3. "US" — the only country our Twilio account can currently buy
      //      local numbers in. /AvailablePhoneNumbers/HU/Local.json returns
      //      404 until the HU regulatory bundle lands.
      const phoneCountry =
        config.country ?? process.env.TWILIO_DEFAULT_COUNTRY ?? "US";
      await provisionAgentPhone({
        customerName: config.customer_name,
        country: phoneCountry,
        serverIp: server.public_net.ipv4.ip,
        keyPath: keyPair.privateKeyPath,
        hostKeyOpts,
        log,
      });
    } catch (e) {
      // Phone is non-blocking — tenant boots without a number, can be
      // provisioned later via the SaaS dashboard or manual curl.
      log(`Warning: AgentPhone provisioning failed: ${e}`);
    }

    // --- Setup Plane (default-on per-tenant PM sidecar) ---
    if (planeOnDefault) {
      setStep("setup_plane");
      log("Setting up Plane (workspace + Alfred user + webhook)...");
      await setupPlane({
        customerName: config.customer_name,
        subdomain,
        serverIp: server.public_net.ipv4.ip,
        keyPath: keyPair.privateKeyPath,
        hostKeyOpts,
        log,
      });
      log("Plane setup complete");
    }

    // --- Setup Sure (default-on per-tenant personal-finance sidecar) ---
    if (sureOnDefault) {
      setStep("setup_sure");
      log("Setting up Sure (Rails secrets + health wait)...");
      await setupSure({
        serverIp: server.public_net.ipv4.ip,
        keyPath: keyPair.privateKeyPath,
        hostKeyOpts,
        log,
      });
      log("Sure setup complete");
    }

    // --- Setup Vaultwarden (opt-in per-tenant secrets manager) ---
    if (vaultwardenOnDefault) {
      const ownerEmail = process.env.TENANT_OWNER_EMAIL ?? config.customer_email;
      if (!ownerEmail) {
        log(
          "Warning: TENANT_OWNER_EMAIL / customer_email not set — skipping Vaultwarden setup. Configure manually with `setupVaultwarden`.",
        );
      } else {
        setStep("setup_vaultwarden");
        log("Setting up Vaultwarden (admin token + invite + health wait)...");
        await setupVaultwarden({
          serverIp: server.public_net.ipv4.ip,
          keyPath: keyPair.privateKeyPath,
          hostKeyOpts,
          ownerEmail,
          log,
        });
        log("Vaultwarden setup complete");
      }
    }

    // --- Setup Vexa (opt-in per-tenant transcript stack — Steward Phase 4) ---
    if (vexaOnDefault) {
      setStep("setup_vexa");
      log("Setting up Vexa (stack render + admin user + webhook registration)...");
      try {
        await setupVexa({
          subdomain: subdomain ?? config.customer_name,
          domain: process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain,
          serverIp: server.public_net.ipv4.ip,
          keyPath: keyPair.privateKeyPath,
          hostKeyOpts,
          log,
        });
        log("Vexa setup complete");
      } catch (e) {
        // Soft-fail: Vexa is opt-in and not on the critical path. The
        // tenant boots fine without it; operator can re-run setupVexa.
        log(`Warning: Vexa setup failed: ${e}`);
      }
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
      } catch {
        log(`Warning: subdomain not yet reachable — DNS propagation may take a few minutes`);
      }
    }

    // --- Register this tenant on Alfred Prime's peer list ---
    // Auto-append the new tenant to Prime's CROSS_TENANT_PEERS so the
    // `tenant` and `ask_alfred` MCP tools can reach it without manual
    // env-var editing. Non-fatal: if Prime can't be reached, log and move
    // on — the operator can still hand-edit Prime's .env.
    try {
      const fresh = getInstance(instance.id);
      const tailscaleHost = fresh?.tailscale_hostname
        ? `${fresh.tailscale_hostname}.${process.env.TAILSCALE_TAILNET ?? "tail5ec603.ts.net"}`
        : null;
      const tailscaleIp = fresh?.tailscale_ip ?? null;
      const apiKey = fresh?.api_key ?? null;
      if (tailscaleHost && tailscaleIp && apiKey) {
        await registerPeerOnPrime(
          {
            id: config.customer_name,
            tailscaleHost,
            tailscaleIp,
            apiKey,
            label: config.customer_name,
          },
          log,
        );
      } else {
        log(
          `Prime registration skipped: missing tailscale_hostname/ip/api_key on instance #${instance.id}.`,
        );
      }
    } catch (e) {
      log(`Prime registration failed (non-fatal): ${e}`);
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
      // Save all captured resource IDs so destroy() can clean them up.
      // These may have been set in the state object but not yet written
      // to DB if the failure happened between API call and updateInstance().
      const partialUpdate: Record<string, unknown> = { status: "error" };
      if (state.server_id) partialUpdate.server_id = state.server_id;
      if (state.volume_id) partialUpdate.volume_id = state.volume_id;
      if (state.ssh_key_id) partialUpdate.ssh_key_id = state.ssh_key_id;
      updateInstance(state.instance_id, partialUpdate as any);
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

  if (instance.cf_plane_dns_record_id) {
    log(`Deleting Plane DNS record ${instance.cf_plane_dns_record_id}...`);
    try {
      await cloudflare.deleteDnsRecord(instance.cf_plane_dns_record_id);
      log("Plane DNS record deleted");
    } catch (e) {
      log(`Warning: Plane DNS record deletion failed: ${e}`);
    }
  }

  if (instance.cf_sure_dns_record_id) {
    log(`Deleting Sure DNS record ${instance.cf_sure_dns_record_id}...`);
    try {
      await cloudflare.deleteDnsRecord(instance.cf_sure_dns_record_id);
      log("Sure DNS record deleted");
    } catch (e) {
      log(`Warning: Sure DNS record deletion failed: ${e}`);
    }
  }

  if (instance.cf_vault_dns_record_id) {
    log(`Deleting Vault DNS record ${instance.cf_vault_dns_record_id}...`);
    try {
      await cloudflare.deleteDnsRecord(instance.cf_vault_dns_record_id);
      log("Vault DNS record deleted");
    } catch (e) {
      log(`Warning: Vault DNS record deletion failed: ${e}`);
    }
  }

  if (instance.cf_vault_access_app_id) {
    log(`Deleting Vault Access app ${instance.cf_vault_access_app_id}...`);
    try {
      await cloudflare.deleteAccessApplication(instance.cf_vault_access_app_id);
      log("Vault Access app deleted");
    } catch (e) {
      log(`Warning: Vault Access app deletion failed: ${e}`);
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

  // Release AgentPhone number (idempotent — SaaS returns noop if none).
  // Customer name is the only stable identifier this layer knows.
  await releaseAgentPhone(instance.customer_name, log);

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

  // Remap SSH key path: DB may store /app/alfred-ctrl/... (container path)
  // but we may be running on the host where cwd is /opt/alfred-saas/alfred-ctrl
  const sshKeyPath = instance.ssh_key_path.replace(
    /^\/app\/alfred-ctrl\//,
    process.cwd() + "/"
  );

  log(`Pulling images (tag: ${tag})...`);
  const pullResult = await ssh.exec(
    instance.ip_address,
    sshKeyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose pull`
  );
  log(pullResult.stdout);

  log("Restarting containers...");
  const upResult = await ssh.exec(
    instance.ip_address,
    sshKeyPath,
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
  // Ensure target directory exists (defensive — may have been removed or never created)
  await ssh.exec(
    instance.ip_address,
    sshKeyPath,
    `sudo mkdir -p ${DEFAULTS.alfredBasePath}`,
  );
  const apiContent = await fs.readFile(apiMjsPath, "utf-8");
  await ssh.upload(
    instance.ip_address,
    sshKeyPath,
    apiContent,
    `${DEFAULTS.alfredBasePath}/api.mjs`,
    0o644
  );
  log(`api.mjs uploaded (${apiContent.length} bytes)`);

  // Check if tenant has the ctrl-api Docker service. If not, upgrade their
  // compose file and migrate from systemd to Docker.
  log("Checking for ctrl-api service...");
  let hasCtrlApi = false;
  try {
    const composeCheck = await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `grep -c "ctrl-api:" ${DEFAULTS.dockerComposeDir}/docker-compose.yaml`
    );
    hasCtrlApi = parseInt(composeCheck.stdout.trim(), 10) > 0;
  } catch { /* grep returns 1 if no match */ }

  if (!hasCtrlApi) {
    log("Upgrading compose file to include ctrl-api service...");
    // Preserve existing Plane / Sure-enabled state — if the tenant has any
    // plane-* / sure-* service running, re-render with that flag set so we
    // don't strip their sidecar stack on a compose refresh.
    let planeOn = false;
    try {
      const check = await ssh.exec(
        instance.ip_address,
        sshKeyPath,
        `docker ps --format '{{.Names}}' | grep -c '^compose-plane-api-' || echo 0`,
      );
      planeOn = parseInt(check.stdout.trim(), 10) > 0;
    } catch {
      planeOn = false;
    }
    let sureOn = false;
    try {
      const check = await ssh.exec(
        instance.ip_address,
        sshKeyPath,
        `docker ps --format '{{.Names}}' | grep -c '^compose-sure-web-' || echo 0`,
      );
      sureOn = parseInt(check.stdout.trim(), 10) > 0;
    } catch {
      sureOn = false;
    }
    const composeYaml = nunjucks.renderString(dockerComposeTemplate, {
      plane_enabled: planeOn,
      sure_enabled: sureOn,
    });
    await ssh.upload(
      instance.ip_address,
      sshKeyPath,
      composeYaml,
      `${DEFAULTS.dockerComposeDir}/docker-compose.yaml`,
      0o600
    );

    // Stop the systemd service (ctrl-api Docker service takes over)
    log("Stopping systemd alfred-api...");
    try {
      await ssh.exec(instance.ip_address, sshKeyPath,
        "sudo systemctl stop alfred-api 2>/dev/null; sudo systemctl disable alfred-api 2>/dev/null; true"
      );
    } catch { /* may not exist */ }

    // Start the new ctrl-api + update alfred-learn CTRL_URL
    log("Starting ctrl-api Docker service...");
    await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d --remove-orphans`
    );
  } else {
    // Restart the ctrl-api Docker service to pick up new api.mjs
    log("Restarting ctrl-api...");
    try {
      await ssh.exec(
        instance.ip_address,
        sshKeyPath,
        `cd ${DEFAULTS.dockerComposeDir} && docker compose restart ctrl-api`
      );
    } catch (dockerErr) {
      // Fallback: start if not running
      log(`Restart failed, trying up: ${dockerErr}`);
      await ssh.exec(
        instance.ip_address,
        sshKeyPath,
        `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d ctrl-api`
      );
    }
  }

  // Verify API is responding
  log("Verifying API...");
  try {
    const dockerCheck = await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `sleep 3 && cd ${DEFAULTS.dockerComposeDir} && docker compose ps ctrl-api --format json | head -1`
    );
    const parsed = JSON.parse(dockerCheck.stdout.trim());
    if (parsed.State !== "running") {
      throw new Error(`ctrl-api container state: ${parsed.State}`);
    }
  } catch (verifyErr) {
    // Last resort: try systemd
    log(`Docker verification failed (${verifyErr}), trying systemd fallback...`);
    try {
      await ssh.exec(instance.ip_address, sshKeyPath, "sudo systemctl start alfred-api");
      const check = await ssh.exec(instance.ip_address, sshKeyPath,
        "sleep 1 && systemctl is-active alfred-api"
      );
      if (check.stdout.trim() !== "active") {
        throw new Error(`systemd fallback also failed: ${check.stdout.trim()}`);
      }
    } catch (systemdErr) {
      throw new Error(`API unhealthy — Docker and systemd fallback both failed: ${systemdErr}`);
    }
  }

  // Sync gateway config: token + subagent permissions
  log("Syncing gateway config...");
  try {
    await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `python3 -c "
import json
p = '/mnt/encrypted/openclaw/openclaw.json'
with open(p) as f: cfg = json.load(f)
# Sync gateway token to shared file for alfred-learn
t = cfg.get('gateway',{}).get('auth',{}).get('token','')
if t: open('/mnt/encrypted/alfred/.gateway-token','w').write(t)
# Ensure subagent spawning is allowed (per-agent subagents.allowAgents)
for agent in cfg.get('agents',{}).get('list',[]):
    sa = agent.setdefault('subagents', {})
    sa['allowAgents'] = ['*']
# Remove invalid keys that crash OpenClaw
cfg.get('gateway',{}).get('tools',{}).pop('subagents', None)
cfg.get('agents',{}).get('defaults',{}).get('subagents',{}).pop('allowAgents', None)
# Ensure gateway tools allow list includes session tools
gt = cfg.setdefault('gateway',{}).setdefault('tools',{})
required = ['sessions_send','sessions_spawn','sessions_history','sessions_list']
allow = gt.get('allow',[])
for t in required:
    if t not in allow: allow.append(t)
gt['allow'] = allow
# Ensure cross-agent session visibility (required for Clerk polling)
tools = cfg.setdefault('tools', {})
tools.setdefault('sessions', {})['visibility'] = 'all'
a2a = tools.setdefault('agentToAgent', {})
a2a['enabled'] = True
a2a.setdefault('allow', ['*'])
with open(p, 'w') as f: json.dump(cfg, f, indent=2)
"`,
    );
  } catch (syncErr) {
    log(`Warning: could not sync gateway config: ${syncErr}`);
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

// ── AgentPhone provisioning helpers ─────────────────────────────────────────
//
// `provision_phone` step calls SaaS internal endpoints that own the master
// Twilio account. Tenants never hold Twilio credentials. Failure here is
// non-blocking — the tenant boots without a number and can be provisioned
// later via the SaaS dashboard.

const SAAS_INTERNAL_URL =
  process.env.SAAS_INTERNAL_URL ?? "https://alfred.black";
const VOICE_BRIDGE_INTERNAL_TOKEN =
  process.env.VOICE_BRIDGE_INTERNAL_TOKEN ?? "";

interface ProvisionAgentPhoneOpts {
  customerName: string;
  country: string;
  serverIp: string;
  keyPath: string;
  hostKeyOpts?: SSHHostKeyOptions;
  log: (msg: string) => void;
}

async function provisionAgentPhone(opts: ProvisionAgentPhoneOpts): Promise<void> {
  if (!VOICE_BRIDGE_INTERNAL_TOKEN) {
    opts.log("Skipping AgentPhone — VOICE_BRIDGE_INTERNAL_TOKEN not set");
    return;
  }

  // 1. Ask SaaS to buy a number + persist Instance fields. SaaS responds with
  //    {tenantId, phoneNumber, twilioNumberSid, country}.
  const res = await fetch(`${SAAS_INTERNAL_URL}/api/internal/twilio/provision`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOICE_BRIDGE_INTERNAL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customerName: opts.customerName,
      country: opts.country,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `SaaS provision failed (${res.status}): ${await res.text().catch(() => "")}`,
    );
  }
  const provision = (await res.json()) as {
    tenantId: string;
    phoneNumber: string;
    twilioNumberSid: string;
    country: string;
  };
  opts.log(
    `AgentPhone number provisioned: ${provision.phoneNumber} (${provision.country})`,
  );

  // 2. Push TENANT_ID + AGENTPHONE_PHONE_NUMBER to tenant .env so ctrl-api can
  //    use them (TENANT_ID is read by phone.ts to call SaaS for outbound, etc.).
  //    Use writeTenantEnv (sed-strip + printf '%s\n' per arg) so each KEY=VALUE
  //    lands on its own physical line. The earlier inline `printf '%s'` with a
  //    pre-joined string and `.replace(/\n/g, '\\n')` produced literal
  //    backslash-n characters in .env on every newer-wave tenant (#681), causing
  //    only TENANT_ID to parse and the rest to be silently dropped.
  await writeTenantEnv(opts, {
    TENANT_ID: provision.tenantId,
    AGENTPHONE_PHONE_NUMBER: provision.phoneNumber,
    SAAS_INTERNAL_URL,
    VOICE_BRIDGE_INTERNAL_TOKEN,
  });
  await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose restart ctrl-api 2>/dev/null || true`,
    undefined,
    opts.hostKeyOpts,
  );
  opts.log("AgentPhone env vars written to tenant .env, ctrl-api restarted");

  // 3. Bootstrap authorised-numbers list. Empty array by default. The
  //    onboarding pipeline (or the dashboard) will populate this from
  //    key_identity_facts.phone — that flow lives in alfred-learn, not here.
  await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `[ -f /mnt/encrypted/alfred/.authorized-phone-numbers.json ] || echo '[]' > /mnt/encrypted/alfred/.authorized-phone-numbers.json`,
    undefined,
    opts.hostKeyOpts,
  );
  opts.log("AgentPhone authorised-numbers list initialised (empty)");
}

async function releaseAgentPhone(
  customerName: string,
  log: (msg: string) => void,
): Promise<void> {
  if (!VOICE_BRIDGE_INTERNAL_TOKEN) return;
  try {
    const res = await fetch(`${SAAS_INTERNAL_URL}/api/internal/twilio/release`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VOICE_BRIDGE_INTERNAL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ customerName }),
    });
    if (res.ok) {
      log("AgentPhone number released");
    } else {
      log(`Warning: AgentPhone release returned ${res.status}`);
    }
  } catch (e) {
    log(`Warning: AgentPhone release failed: ${e}`);
  }
}

// ── Plane provisioning helpers (issue #536) ─────────────────────────────────
//
// setupPlane creates the Plane workspace + Alfred user + API token + webhook
// on a freshly-booted Plane sidecar stack. We use the Django ORM via
// `manage.py shell` inside the plane-api container — the Plane 1.3.0 public
// HTTP surface splits bootstrap across `/api/instances/admin/sign-up/` (CSRF-
// gated), `/auth/sign-in/` (anonymous-cookie gotchas), `/api/workspaces/...`
// (session-cookie auth) and `/api/v1/workspaces/<slug>/webhooks/` (PAT auth
// but webhook model is only mounted on the app, not public-api path); a
// single direct ORM shell script sidesteps all of that.
//
// Every step is idempotent — re-running on an already-configured tenant
// finds existing objects via get_or_create. Secrets are persisted to
// /opt/alfred/compose/.env on success so reruns skip.

interface SetupPlaneOpts {
  customerName: string;
  subdomain: string;
  serverIp: string;
  keyPath: string;
  hostKeyOpts?: SSHHostKeyOptions;
  log: (msg: string) => void;
}

const PLANE_PROXY_INTERNAL_URL = "http://127.0.0.1:8080";
const PLANE_READY_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — first boot pulls images + runs migrations
const PLANE_POLL_INTERVAL_MS = 5_000;

// `planeSlug` moved to ./plane-hostname.ts. Re-aliased below for any
// in-module usage not covered by planeHostnameFromCustomerName().
const planeSlug = _planeSlug;

/**
 * Append (or replace) one or more KEY=VALUE lines in /opt/alfred/compose/.env.
 * Used after each successful sub-step so a retry can resume. Replacement is
 * line-oriented: any existing line starting with `KEY=` is removed first,
 * then the new pairs are appended. This is why we write the master (PLANE_*)
 * keys one at a time rather than batching the whole set.
 */
async function writeTenantEnv(
  opts: Pick<SetupPlaneOpts, "serverIp" | "keyPath" | "hostKeyOpts">,
  entries: Record<string, string>,
): Promise<void> {
  const cmd = buildEnvWriteCommand(`${DEFAULTS.dockerComposeDir}/.env`, entries);
  if (cmd === null) return;
  const result = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    cmd,
    undefined,
    opts.hostKeyOpts,
  );
  if (result.code !== 0) {
    throw new Error(`Env write failed (exit ${result.code}): ${result.stderr}`);
  }
}

/**
 * Read a single KEY=... value from the tenant .env. Returns `undefined` if
 * the key is absent. Handles both quoted and unquoted values, strips the
 * optional surrounding single quotes we wrote in writeTenantEnv.
 */
async function readTenantEnv(
  opts: Pick<SetupPlaneOpts, "serverIp" | "keyPath" | "hostKeyOpts">,
  key: string,
): Promise<string | undefined> {
  const envPath = `${DEFAULTS.dockerComposeDir}/.env`;
  const cmd = `grep -E '^${key}=' ${envPath} 2>/dev/null | tail -n1 || true`;
  const result = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    cmd,
    undefined,
    opts.hostKeyOpts,
  );
  const line = result.stdout.trim();
  if (!line) return undefined;
  const eq = line.indexOf("=");
  if (eq === -1) return undefined;
  let val = line.slice(eq + 1);
  if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
    val = val.slice(1, -1);
  }
  return val;
}

/** Generate a URL-safe random secret of the requested byte length. */
function randomSecret(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Generate a strong admin password (32 base64url chars, ~192 bits entropy). */
function randomPassword(): string {
  return crypto.randomBytes(24).toString("base64url");
}

async function waitForPlaneReady(
  opts: Pick<SetupPlaneOpts, "serverIp" | "keyPath" | "hostKeyOpts" | "log">,
): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < PLANE_READY_TIMEOUT_MS) {
    const r = await ssh.exec(
      opts.serverIp,
      opts.keyPath,
      `curl -sS -o /dev/null -w '%{http_code}' ${PLANE_PROXY_INTERNAL_URL}/api/instances/ || true`,
      undefined,
      opts.hostKeyOpts,
    );
    last = r.stdout.trim();
    if (last === "200") {
      opts.log("Plane API ready (HTTP 200)");
      return;
    }
    await new Promise((r) => setTimeout(r, PLANE_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Plane API did not become ready within ${PLANE_READY_TIMEOUT_MS / 1000}s (last HTTP status: ${last || "unreachable"})`,
  );
}

/**
 * One-shot Plane bootstrap executed inside `plane-api` via `manage.py shell`.
 * Reads config from env vars (passed with `docker exec -e ...`), performs
 * idempotent get_or_create on every object, and prints a single JSON blob
 * prefixed by __PLANE_BOOT__ on stdout so the caller can parse it safely
 * even if Django's shell prints banner lines.
 */
const PLANE_BOOTSTRAP_PY = `import json, os, uuid
from django.db import transaction
from django.utils import timezone
from plane.db.models import User, Workspace, WorkspaceMember, APIToken, Webhook
from plane.license.models import Instance, InstanceAdmin

ADMIN_EMAIL    = os.environ["BOOT_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["BOOT_ADMIN_PASSWORD"]
ALFRED_EMAIL   = os.environ["BOOT_ALFRED_EMAIL"]
SLUG           = os.environ["BOOT_WORKSPACE_SLUG"]
WORKSPACE_NAME = os.environ.get("BOOT_WORKSPACE_NAME", "Alfred")
WEBHOOK_URL    = os.environ["BOOT_WEBHOOK_URL"]
WEBHOOK_SECRET = os.environ["BOOT_WEBHOOK_SECRET"]

def _ensure_user(email, first, last, is_admin=False, password=None):
    u = User.objects.filter(email=email).first()
    if u is None:
        u = User(
            username=str(uuid.uuid4()),
            email=email,
            first_name=first,
            last_name=last,
            is_active=True,
            is_email_verified=True,
            is_password_autoset=False,
            last_login_medium="email",
            last_login_time=timezone.now(),
        )
        if is_admin:
            u.is_superuser = True
            u.is_staff = True
        if password:
            u.set_password(password)
        else:
            u.set_unusable_password()
        u.save()
    return u

with transaction.atomic():
    admin  = _ensure_user(ADMIN_EMAIL, "Alfred", "Admin", is_admin=True, password=ADMIN_PASSWORD)
    alfred = _ensure_user(ALFRED_EMAIL, "Alfred", "Black", is_admin=False)

    instance = Instance.objects.order_by("created_at").last()
    if instance is None:
        raise SystemExit("No Instance row — plane-api entrypoint did not run register_instance")
    InstanceAdmin.objects.get_or_create(
        instance=instance, user=admin,
        defaults={"role": 20, "is_verified": True},
    )
    if not instance.is_setup_done:
        instance.is_setup_done = True
        instance.is_signup_screen_visited = True
        instance.save(update_fields=["is_setup_done", "is_signup_screen_visited"])

    ws, _ = Workspace.objects.get_or_create(
        slug=SLUG, defaults={"name": WORKSPACE_NAME, "owner": admin},
    )
    WorkspaceMember.objects.get_or_create(
        workspace=ws, member=admin,  defaults={"role": 20, "is_active": True},
    )
    WorkspaceMember.objects.get_or_create(
        workspace=ws, member=alfred, defaults={"role": 20, "is_active": True},
    )

    tok = APIToken.objects.filter(workspace=ws, user=alfred, label="alfred-ctrl").first()
    if tok is None:
        tok = APIToken.objects.create(
            user=alfred, workspace=ws, label="alfred-ctrl",
            description="Auto-generated by alfred-ctrl setup_plane",
            user_type=0, is_service=True,
        )

    wh = Webhook.objects.filter(workspace=ws, url=WEBHOOK_URL).first()
    if wh is None:
        wh = Webhook.objects.create(
            workspace=ws, url=WEBHOOK_URL, secret_key=WEBHOOK_SECRET,
            is_active=True, project=True, issue=True, issue_comment=True,
            module=True, cycle=True,
        )
    elif wh.secret_key != WEBHOOK_SECRET:
        wh.secret_key = WEBHOOK_SECRET
        wh.save(update_fields=["secret_key"])

print("__PLANE_BOOT__" + json.dumps({
    "workspace_slug": ws.slug,
    "alfred_user_id": str(alfred.id),
    "api_token":      tok.token,
    "webhook_secret": wh.secret_key,
}))
`;

interface PlaneBootstrapResult {
  workspace_slug: string;
  alfred_user_id: string;
  api_token: string;
  webhook_secret: string;
}

/**
 * Ship PLANE_BOOTSTRAP_PY into the plane-api container and run it via
 * `python manage.py shell`. Base64-encoded to survive two layers of shell
 * quoting (ssh → bash → docker exec).
 */
async function runPlaneBootstrap(
  opts: Pick<SetupPlaneOpts, "serverIp" | "keyPath" | "hostKeyOpts">,
  env: Record<string, string>,
): Promise<PlaneBootstrapResult> {
  const scriptB64 = Buffer.from(PLANE_BOOTSTRAP_PY, "utf-8").toString("base64");
  const envArgs = Object.entries(env)
    .map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`)
    .join(" ");
  const cmd = `printf %s ${scriptB64} | base64 -d | docker exec -i ${envArgs} compose-plane-api-1 python manage.py shell`;
  const result = await ssh.exec(opts.serverIp, opts.keyPath, cmd, undefined, opts.hostKeyOpts);
  if (result.code !== 0) {
    throw new Error(
      `Plane bootstrap exited ${result.code}: stderr=${result.stderr.slice(0, 500)} stdout=${result.stdout.slice(0, 500)}`,
    );
  }
  const marker = "__PLANE_BOOT__";
  const idx = result.stdout.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error(
      `Plane bootstrap output missing ${marker} marker. stdout=${result.stdout.slice(-500)}`,
    );
  }
  const jsonStart = idx + marker.length;
  const jsonEnd = result.stdout.indexOf("\n", jsonStart);
  const jsonStr = result.stdout.slice(jsonStart, jsonEnd === -1 ? undefined : jsonEnd);
  try {
    return JSON.parse(jsonStr) as PlaneBootstrapResult;
  } catch (e) {
    throw new Error(
      `Plane bootstrap returned invalid JSON: ${e instanceof Error ? e.message : String(e)} — payload=${jsonStr.slice(0, 400)}`,
    );
  }
}

/** Main entry — idempotent. See module comment. */
export async function setupPlane(opts: SetupPlaneOpts): Promise<void> {
  // The Plane webhook URL has to resolve to the public Cloudflare tunnel
  // hostname — otherwise Plane's 5-strike retry policy disables the webhook
  // and the tenant's reverse-sync silently stops. The public hostname is
  // always `generateSubdomain(customer_name).alfred.black` (SaaS always
  // generates `customerName` as the full Hetzner-slug form
  // `alfred-<slug>-<base36ts>`, and `generateSubdomain` is a lowercase-only
  // identity on that shape).
  //
  // `opts.subdomain` used to be trusted here, but it's vulnerable to DB drift
  // — David's ctrl-db had `subdomain=alfred-david` (short form) while the
  // actual DNS / cloudflared ingress was `alfred-david-mnbqn4jg.alfred.black`.
  // That silently registered a webhook pointing at an NXDOMAIN host and the
  // webhook auto-disabled after 5 retries. Deriving from `customer_name`
  // matches what cloudflare.createDnsRecord + the cloudflared template see
  // at provision time.
  const { hostname, slug, adminEmail, alfredEmail, webhookUrl } =
    planeHostnameFromCustomerName(opts.customerName);

  if (hostname !== opts.subdomain) {
    opts.log(
      `Plane: customer_name-derived hostname "${hostname}" differs from instance.subdomain "${opts.subdomain}" — using customer_name (matches Cloudflare DNS)`,
    );
  }
  opts.log(`Plane: workspace slug="${slug}", admin=${adminEmail}, alfred=${alfredEmail}`);

  // Fast-path idempotency: if the .env already has all four values we write,
  // a prior successful setupPlane ran — nothing to do.
  const existing = {
    token: await readTenantEnv(opts, "PLANE_API_TOKEN"),
    slug:  await readTenantEnv(opts, "PLANE_WORKSPACE_SLUG"),
    uid:   await readTenantEnv(opts, "PLANE_ALFRED_USER_ID"),
    hook:  await readTenantEnv(opts, "PLANE_WEBHOOK_SECRET"),
  };
  if (existing.token && existing.slug && existing.uid && existing.hook) {
    opts.log("All Plane secrets already in .env — skipping bootstrap");
    return;
  }

  opts.log("Waiting for Plane API to become ready (up to 10 min)...");
  await waitForPlaneReady(opts);

  // Generate or re-use durable secrets. Admin password is written FIRST so a
  // crash mid-bootstrap still lets us re-run against the same password.
  let adminPassword = await readTenantEnv(opts, "PLANE_ADMIN_PASSWORD");
  if (!adminPassword) {
    adminPassword = randomPassword();
    await writeTenantEnv(opts, {
      PLANE_ADMIN_EMAIL: adminEmail,
      PLANE_ADMIN_PASSWORD: adminPassword,
    });
  }
  const webhookSecret = existing.hook ?? randomSecret(32);

  opts.log("Running Plane bootstrap via manage.py shell...");
  const result = await runPlaneBootstrap(opts, {
    BOOT_ADMIN_EMAIL:    adminEmail,
    BOOT_ADMIN_PASSWORD: adminPassword,
    BOOT_ALFRED_EMAIL:   alfredEmail,
    BOOT_WORKSPACE_SLUG: slug,
    BOOT_WORKSPACE_NAME: opts.customerName || "Alfred",
    BOOT_WEBHOOK_URL:    webhookUrl,
    BOOT_WEBHOOK_SECRET: webhookSecret,
  });
  opts.log(`Plane bootstrap done (workspace=${result.workspace_slug})`);

  // Persist the four secrets the learn workflow reads, plus the env the
  // alfred-learn service uses to reach plane-proxy on the shared network.
  await writeTenantEnv(opts, {
    PLANE_API_TOKEN:      result.api_token,
    PLANE_WORKSPACE_SLUG: result.workspace_slug,
    PLANE_ALFRED_USER_ID: result.alfred_user_id,
    PLANE_WEBHOOK_SECRET: result.webhook_secret,
    // plane-proxy listens on :80 inside the compose network; the `:8080`
    // mapping is HOST-side only. alfred-learn reaches it via the internal
    // service name on port 80.
    PLANE_API_BASE_URL:   "http://plane-proxy/",
    PLANE_SYNC_ENABLED:   "true",
  });
  opts.log("Plane secrets persisted to .env; restarting alfred-learn...");

  const restartRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d --force-recreate alfred-learn`,
    undefined,
    opts.hostKeyOpts,
  );
  if (restartRes.code !== 0) {
    throw new Error(
      `alfred-learn restart failed (exit ${restartRes.code}): ${restartRes.stderr}`,
    );
  }
  opts.log("alfred-learn restarted with Plane env");
}

/**
 * CLI retrofit: enable Plane on an already-provisioned tenant.
 *
 * - If the Plane stack is already running (detected via `docker ps`), skip
 *   compose regeneration and jump straight to `setupPlane` (idempotent).
 * - Otherwise: re-render the compose template with plane_enabled=true,
 *   upload, generate baseline secrets into .env (DJANGO_SECRET_KEY,
 *   REDIS_PASSWORD, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD) so the services
 *   can boot, then `docker compose up -d` the Plane services.
 */
export async function deployPlane(
  instanceId: number,
  onLog?: (msg: string) => void,
): Promise<void> {
  const { getInstance } = await import("../db/queries.js");
  const instance = getInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);
  if (!instance.ip_address || !instance.ssh_key_path) {
    throw new Error("Instance not fully provisioned");
  }
  if (!instance.subdomain) {
    throw new Error(
      "Instance has no subdomain — setupPlane needs it for admin/alfred email + webhook URL",
    );
  }

  const log = (msg: string) => onLog?.(msg);

  // Remap SSH key path: same pattern as deployApi — the DB may store the
  // container-mounted path but we're running on the host.
  const sshKeyPath = instance.ssh_key_path.replace(
    /^\/app\/alfred-ctrl\//,
    process.cwd() + "/",
  );

  const sshOpts: Pick<SetupPlaneOpts, "serverIp" | "keyPath" | "hostKeyOpts"> = {
    serverIp: instance.ip_address,
    keyPath: sshKeyPath,
    hostKeyOpts: instance.ssh_host_key
      ? { knownHostKey: instance.ssh_host_key }
      : undefined,
  };

  // Check if Plane is already running on the tenant.
  log("Checking for existing Plane stack...");
  const psResult = await ssh.exec(
    instance.ip_address,
    sshKeyPath,
    `docker ps --format '{{.Names}}' | grep -c '^compose-plane-api-' || true`,
    undefined,
    sshOpts.hostKeyOpts,
  );
  const alreadyRunning = parseInt(psResult.stdout.trim(), 10) > 0;

  if (!alreadyRunning) {
    log("Plane stack not running — regenerating compose with plane_enabled=true");

    // Ensure the Plane persistent-data directory exists before Postgres
    // tries to bind-mount into it. Owned by root is fine — the container
    // bootstraps its own uid/gid.
    await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `sudo mkdir -p /mnt/encrypted/plane/pgdata /mnt/encrypted/plane/redis /mnt/encrypted/plane/rabbitmq /mnt/encrypted/plane/uploads && sudo chmod 700 /mnt/encrypted/plane`,
      undefined,
      sshOpts.hostKeyOpts,
    );

    // Render + upload new compose.
    const composeYaml = nunjucks.renderString(dockerComposeTemplate, {
      plane_enabled: true,
    });
    await ssh.upload(
      instance.ip_address,
      sshKeyPath,
      composeYaml,
      `${DEFAULTS.dockerComposeDir}/docker-compose.yaml`,
      0o600,
      undefined,
      sshOpts.hostKeyOpts,
    );
    log("docker-compose.yaml uploaded with Plane block");

    // Seed the baseline secrets needed for the containers to boot. These
    // are distinct from the Plane-app secrets (PLANE_API_TOKEN etc.) which
    // setupPlane() generates later against the running API.
    const seeded: Record<string, string> = {};
    for (const k of [
      "DJANGO_SECRET_KEY",
      "REDIS_PASSWORD",
      "POSTGRES_PASSWORD",
      "MINIO_ROOT_PASSWORD",
      "LIVE_SERVER_SECRET_KEY",
    ] as const) {
      const existing = await readTenantEnv(sshOpts, k);
      if (!existing) {
        seeded[k] = randomSecret(32);
      }
    }
    if (!(await readTenantEnv(sshOpts, "TENANT_SUBDOMAIN"))) {
      seeded.TENANT_SUBDOMAIN = instance.subdomain;
    }
    if (!(await readTenantEnv(sshOpts, "TENANT_DOMAIN"))) {
      seeded.TENANT_DOMAIN =
        process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain;
    }
    if (Object.keys(seeded).length > 0) {
      await writeTenantEnv(sshOpts, seeded);
      log(`Seeded ${Object.keys(seeded).length} baseline Plane secret(s) in .env`);
    } else {
      log("All baseline Plane secrets already present in .env");
    }

    // Pull + bring up ONLY the new Plane services; don't touch the rest of
    // the stack. docker compose up -d without an explicit list would also
    // (re)create existing services — we don't want to disturb openclaw etc.
    log("Pulling Plane images (first boot — up to ~3 min)...");
    const pullRes = await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `cd ${DEFAULTS.dockerComposeDir} && timeout 600 docker compose pull plane-db plane-redis plane-mq plane-minio plane-api plane-worker plane-beat plane-web plane-space plane-admin plane-live plane-proxy 2>&1`,
      undefined,
      sshOpts.hostKeyOpts,
    );
    if (pullRes.code !== 0) {
      throw new Error(`Plane image pull failed (exit ${pullRes.code}): ${pullRes.stdout}`);
    }
    log("Plane images pulled");

    log("Starting Plane services...");
    const upRes = await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d plane-db plane-redis plane-mq plane-minio plane-api plane-worker plane-beat plane-web plane-space plane-admin plane-live plane-proxy`,
      undefined,
      sshOpts.hostKeyOpts,
    );
    if (upRes.code !== 0) {
      throw new Error(`Plane up -d failed (exit ${upRes.code}): ${upRes.stderr}`);
    }
    log("Plane services started");
  } else {
    log("Plane stack already running — skipping compose regenerate");
  }

  // Run the idempotent setup steps (workspace, Alfred user, API token,
  // webhook). Safe to re-run even if some steps already succeeded.
  await setupPlane({
    customerName: instance.customer_name,
    subdomain: instance.subdomain,
    serverIp: instance.ip_address,
    keyPath: sshKeyPath,
    hostKeyOpts: sshOpts.hostKeyOpts,
    log,
  });

  // --- Plane DNS + cloudflared ingress ---
  //
  // Wires `<subdomain>-plane.<domain>` → plane-proxy (localhost:8080) via
  // the tenant's existing Cloudflare tunnel. Non-fatal: if Cloudflare
  // isn't configured on this host, or the API call fails, we log and move
  // on. The PLANE_* secrets are already written and Plane is running
  // locally; DNS can be retrofitted manually via the fallback procedure
  // in packages/ctrl/docs/PLANE_TENANT_ROLLOUT.md.
  if (cloudflare.isConfigured()) {
    const domain = process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain;
    const subdomain = instance.subdomain;

    try {
      if (!instance.cf_tunnel_id) {
        log(
          "Warning: instance has no cf_tunnel_id — skipping Plane DNS + cloudflared re-render. Add DNS manually.",
        );
      } else {
        // 5a — Create the <subdomain>-plane CNAME if we haven't already.
        if (!instance.cf_plane_dns_record_id) {
          try {
            const planeRec = await cloudflare.createDnsRecord(
              `${subdomain}-plane`,
              instance.cf_tunnel_id,
            );
            updateInstance(instance.id, {
              cf_plane_dns_record_id: planeRec.id,
            });
            log(
              `DNS record created: ${subdomain}-plane.${domain} → tunnel`,
            );
          } catch (e) {
            log(
              `Warning: Plane DNS record creation failed (may already exist): ${e}`,
            );
          }
        } else {
          log(
            `Plane DNS record already present (${instance.cf_plane_dns_record_id}) — skipping creation`,
          );
        }

        // 5b — Re-render /etc/cloudflared/config.yml with plane_enabled=true
        // and restart cloudflared. The directory is chown'd deploy:deploy
        // during initial provisioning so no sudo needed for the upload
        // itself; systemctl restart needs sudo (passwordless for deploy).
        const cfConfig = nunjucks.renderString(cloudflaredConfigTemplate, {
          tunnel_id: instance.cf_tunnel_id,
          subdomain,
          domain,
          plane_enabled: true,
        });
        try {
          await ssh.upload(
            instance.ip_address,
            sshKeyPath,
            cfConfig,
            `${DEFAULTS.cloudflaredDir}/config.yml`,
            0o644,
            undefined,
            sshOpts.hostKeyOpts,
          );
          log("Cloudflared config re-rendered with Plane ingress");

          const restartRes = await ssh.exec(
            instance.ip_address,
            sshKeyPath,
            "sudo systemctl restart cloudflared",
            undefined,
            sshOpts.hostKeyOpts,
          );
          if (restartRes.code !== 0) {
            log(
              `Warning: cloudflared restart failed (exit ${restartRes.code}): ${restartRes.stderr.trim()}`,
            );
          } else {
            // Give the service a moment to stabilise before probing.
            await new Promise((r) => setTimeout(r, 3000));
            const verifyRes = await ssh.exec(
              instance.ip_address,
              sshKeyPath,
              "systemctl is-active cloudflared",
              undefined,
              sshOpts.hostKeyOpts,
            );
            if (verifyRes.stdout.trim() !== "active") {
              log(
                `Warning: cloudflared is not active after restart (got "${verifyRes.stdout.trim()}")`,
              );
            } else {
              log("Cloudflared restarted and verified active");
            }
          }
        } catch (e) {
          log(`Warning: cloudflared re-render failed: ${e}`);
        }
      }
    } catch (e) {
      log(`Warning: Plane DNS/ingress wiring failed: ${e}`);
    }
  } else {
    log(
      "Skipping Plane DNS + cloudflared re-render (Cloudflare not configured on this host)",
    );
  }

  insertEvent(instanceId, "api_deployed", "Plane deployed + configured");
  log(
    `deploy-plane complete — Plane UI available at https://${instance.subdomain}-plane.${
      process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain
    }`,
  );
}

// ── Sure provisioning helpers ───────────────────────────────────────────────
//
// Sure is the upstream we-promise/sure Rails app, packaged as
// ghcr.io/we-promise/sure:stable. The compose template renders four services
// (sure-db, sure-redis, sure-web, sure-worker) gated by the `sure_enabled`
// flag. setupSure is idempotent: it generates the three Sure-owned secrets
// (SURE_POSTGRES_PASSWORD, SURE_REDIS_PASSWORD, SURE_SECRET_KEY_BASE) into
// the tenant's .env if they're missing, restarts the web/worker if .env
// changed, and waits for sure-web to report healthy on /up.

interface SetupSureOpts {
  serverIp: string;
  keyPath: string;
  hostKeyOpts?: SSHHostKeyOptions;
  log: (msg: string) => void;
}

const SURE_WEB_INTERNAL_URL = "http://127.0.0.1:3001/up";
const SURE_READY_TIMEOUT_MS = 10 * 60 * 1000;
const SURE_POLL_INTERVAL_MS = 5_000;

async function waitForSureReady(opts: SetupSureOpts): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < SURE_READY_TIMEOUT_MS) {
    const r = await ssh.exec(
      opts.serverIp,
      opts.keyPath,
      `curl -sS -o /dev/null -w '%{http_code}' ${SURE_WEB_INTERNAL_URL} || true`,
      undefined,
      opts.hostKeyOpts,
    );
    last = r.stdout.trim();
    if (last === "200") {
      opts.log("Sure web ready (HTTP 200 on /up)");
      return;
    }
    await new Promise((r) => setTimeout(r, SURE_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Sure web did not become ready within ${SURE_READY_TIMEOUT_MS / 1000}s (last HTTP status: ${last || "unreachable"})`,
  );
}

export async function setupSure(opts: SetupSureOpts): Promise<void> {
  const sshOpts: Pick<SetupSureOpts, "serverIp" | "keyPath" | "hostKeyOpts"> = {
    serverIp: opts.serverIp,
    keyPath: opts.keyPath,
    hostKeyOpts: opts.hostKeyOpts,
  };

  const seeded: Record<string, string> = {};
  const existingPg = await readTenantEnv(sshOpts, "SURE_POSTGRES_PASSWORD");
  if (!existingPg) seeded.SURE_POSTGRES_PASSWORD = randomSecret(32);
  const existingRedis = await readTenantEnv(sshOpts, "SURE_REDIS_PASSWORD");
  if (!existingRedis) seeded.SURE_REDIS_PASSWORD = randomSecret(32);
  const existingSkb = await readTenantEnv(sshOpts, "SURE_SECRET_KEY_BASE");
  // Rails convention: 64 random bytes → 128 hex chars. Matches `rails secret`.
  if (!existingSkb) seeded.SURE_SECRET_KEY_BASE = randomSecret(64);

  // Wire Sure's external assistant chat into Alfred via the ctrl-api bridge
  // (see packages/ctrl/src/api/routes/sureAssistant.ts). The bridge prepends
  // a finance-focused system prompt and rewrites X-Session-Key per family
  // so each Sure family gets a persistent OpenClaw session — instead of the
  // default behaviour where every Sure chat shares one global thread.
  const existingAssistantType = await readTenantEnv(sshOpts, "ASSISTANT_TYPE");
  if (!existingAssistantType) seeded.ASSISTANT_TYPE = "external";
  const existingAssistantUrl = await readTenantEnv(sshOpts, "EXTERNAL_ASSISTANT_URL");
  if (!existingAssistantUrl) {
    seeded.EXTERNAL_ASSISTANT_URL = "http://ctrl-api:3100/api/v1/sure/assistant";
  }
  const existingAssistantAgent = await readTenantEnv(sshOpts, "EXTERNAL_ASSISTANT_AGENT_ID");
  if (!existingAssistantAgent) seeded.EXTERNAL_ASSISTANT_AGENT_ID = "openclaw/main";
  const existingAssistantToken = await readTenantEnv(sshOpts, "EXTERNAL_ASSISTANT_TOKEN");
  if (!existingAssistantToken) {
    const aasKey = await readTenantEnv(sshOpts, "AAS_API_KEY");
    if (aasKey) {
      seeded.EXTERNAL_ASSISTANT_TOKEN = aasKey;
    } else {
      opts.log(
        "Warning: AAS_API_KEY not set on tenant — EXTERNAL_ASSISTANT_TOKEN cannot be seeded; Sure chat will fall back to builtin assistant",
      );
    }
  }

  const newSecrets = Object.keys(seeded).length > 0;
  if (newSecrets) {
    await writeTenantEnv(sshOpts, seeded);
    opts.log(`Seeded ${Object.keys(seeded).length} Sure secret(s) in .env`);

    // Re-create web + worker so they pick up the new env. Postgres and Redis
    // already booted with the correct password if it was seeded BEFORE first
    // up; on a re-seed (rare — only if .env was hand-wiped) the operator
    // will need to recreate the postgres volume manually.
    const restartRes = await ssh.exec(
      opts.serverIp,
      opts.keyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d --force-recreate sure-web sure-worker`,
      undefined,
      opts.hostKeyOpts,
    );
    if (restartRes.code !== 0) {
      throw new Error(
        `sure-web/sure-worker restart failed (exit ${restartRes.code}): ${restartRes.stderr}`,
      );
    }
    opts.log("sure-web + sure-worker recreated with seeded secrets");
  } else {
    opts.log("All Sure secrets already in .env — skipping seed");
  }

  opts.log("Waiting for Sure web to become ready (up to 10 min)...");
  await waitForSureReady(opts);

  const existingKey = await readTenantEnv(sshOpts, "SURE_API_KEY");
  if (existingKey) {
    opts.log("SURE_API_KEY already in .env — skipping sure-init bootstrap");
    return;
  }

  opts.log("Triggering sure-init bootstrap...");
  const upRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d sure-init`,
    undefined,
    opts.hostKeyOpts,
  );
  if (upRes.code !== 0) {
    throw new Error(`sure-init up failed (exit ${upRes.code}): ${upRes.stderr}`);
  }

  const waitRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `docker wait $(cd ${DEFAULTS.dockerComposeDir} && docker compose ps -q sure-init)`,
    undefined,
    opts.hostKeyOpts,
  );
  const exitCode = parseInt(waitRes.stdout.trim(), 10);
  if (Number.isNaN(exitCode) || exitCode !== 0) {
    const logsRes = await ssh.exec(
      opts.serverIp,
      opts.keyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose logs --tail 50 sure-init`,
      undefined,
      opts.hostKeyOpts,
    );
    throw new Error(
      `sure-init exited ${waitRes.stdout.trim() || "unknown"}. Logs:\n${logsRes.stdout}`,
    );
  }

  const keyRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cat /mnt/encrypted/alfred/.sure-api-key`,
    undefined,
    opts.hostKeyOpts,
  );
  const apiKey = keyRes.stdout.trim();
  if (!apiKey || apiKey.length < 32) {
    throw new Error(
      `sure-init produced unusable API key (length=${apiKey.length})`,
    );
  }

  await writeTenantEnv(sshOpts, { SURE_API_KEY: apiKey });
  opts.log(`SURE_API_KEY written to .env (length=${apiKey.length})`);

  const recreateRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d --force-recreate ctrl-api alfred alfred-learn`,
    undefined,
    opts.hostKeyOpts,
  );
  if (recreateRes.code !== 0) {
    throw new Error(
      `Recreating SURE_API_KEY consumers failed (exit ${recreateRes.code}): ${recreateRes.stderr}`,
    );
  }
  opts.log("ctrl-api + alfred + alfred-learn recreated with SURE_API_KEY");
}

/**
 * CLI retrofit: enable Sure on an already-provisioned tenant. Mirrors
 * deployPlane: detects whether the Sure stack is already running, regenerates
 * compose if not, seeds baseline secrets, brings up the four Sure services,
 * runs setupSure, creates the `<subdomain>-sure` DNS record, and re-renders
 * cloudflared with sure_enabled=true (preserving any existing plane_enabled
 * flag).
 */
export async function deploySure(
  instanceId: number,
  onLog?: (msg: string) => void,
): Promise<void> {
  const { getInstance } = await import("../db/queries.js");
  const instance = getInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);
  if (!instance.ip_address || !instance.ssh_key_path) {
    throw new Error("Instance not fully provisioned");
  }
  if (!instance.subdomain) {
    throw new Error(
      "Instance has no subdomain — deploySure needs it for the cloudflared ingress hostname",
    );
  }

  const log = (msg: string) => onLog?.(msg);

  const sshKeyPath = instance.ssh_key_path.replace(
    /^\/app\/alfred-ctrl\//,
    process.cwd() + "/",
  );

  const sshOpts: Pick<SetupSureOpts, "serverIp" | "keyPath" | "hostKeyOpts"> = {
    serverIp: instance.ip_address,
    keyPath: sshKeyPath,
    hostKeyOpts: instance.ssh_host_key
      ? { knownHostKey: instance.ssh_host_key }
      : undefined,
  };

  log("Checking for existing Sure stack...");
  const psResult = await ssh.exec(
    instance.ip_address,
    sshKeyPath,
    `docker ps --format '{{.Names}}' | grep -c '^compose-sure-web-' || true`,
    undefined,
    sshOpts.hostKeyOpts,
  );
  const alreadyRunning = parseInt(psResult.stdout.trim(), 10) > 0;

  // Detect existing Plane state so the compose regenerate doesn't strip
  // the Plane block on tenants that already have it. Same probe shape as
  // deployApi's Plane preservation logic.
  let planeOn = false;
  try {
    const check = await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `docker ps --format '{{.Names}}' | grep -c '^compose-plane-api-' || echo 0`,
      undefined,
      sshOpts.hostKeyOpts,
    );
    planeOn = parseInt(check.stdout.trim(), 10) > 0;
  } catch {
    planeOn = false;
  }

  if (!alreadyRunning) {
    log("Sure stack not running — regenerating compose with sure_enabled=true");

    await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `sudo mkdir -p /mnt/encrypted/sure/pgdata /mnt/encrypted/sure/redis && sudo chmod 700 /mnt/encrypted/sure`,
      undefined,
      sshOpts.hostKeyOpts,
    );

    const composeYaml = nunjucks.renderString(dockerComposeTemplate, {
      plane_enabled: planeOn,
      sure_enabled: true,
    });
    await ssh.upload(
      instance.ip_address,
      sshKeyPath,
      composeYaml,
      `${DEFAULTS.dockerComposeDir}/docker-compose.yaml`,
      0o600,
      undefined,
      sshOpts.hostKeyOpts,
    );
    log("docker-compose.yaml uploaded with Sure block");

    const seeded: Record<string, string> = {};
    if (!(await readTenantEnv(sshOpts, "SURE_POSTGRES_PASSWORD"))) {
      seeded.SURE_POSTGRES_PASSWORD = randomSecret(32);
    }
    if (!(await readTenantEnv(sshOpts, "SURE_REDIS_PASSWORD"))) {
      seeded.SURE_REDIS_PASSWORD = randomSecret(32);
    }
    if (!(await readTenantEnv(sshOpts, "SURE_SECRET_KEY_BASE"))) {
      seeded.SURE_SECRET_KEY_BASE = randomSecret(64);
    }
    if (!(await readTenantEnv(sshOpts, "SURE_ENABLED"))) {
      seeded.SURE_ENABLED = "true";
    }
    if (!(await readTenantEnv(sshOpts, "TENANT_SUBDOMAIN"))) {
      seeded.TENANT_SUBDOMAIN = instance.subdomain;
    }
    if (!(await readTenantEnv(sshOpts, "TENANT_DOMAIN"))) {
      seeded.TENANT_DOMAIN =
        process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain;
    }
    if (Object.keys(seeded).length > 0) {
      await writeTenantEnv(sshOpts, seeded);
      log(`Seeded ${Object.keys(seeded).length} baseline Sure secret(s) in .env`);
    } else {
      log("All baseline Sure secrets already present in .env");
    }

    log("Pulling Sure images (first boot — up to ~3 min)...");
    const pullRes = await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `cd ${DEFAULTS.dockerComposeDir} && timeout 600 docker compose pull sure-db sure-redis sure-web sure-worker 2>&1`,
      undefined,
      sshOpts.hostKeyOpts,
    );
    if (pullRes.code !== 0) {
      throw new Error(`Sure image pull failed (exit ${pullRes.code}): ${pullRes.stdout}`);
    }
    log("Sure images pulled");

    log("Starting Sure services...");
    const upRes = await ssh.exec(
      instance.ip_address,
      sshKeyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d sure-db sure-redis sure-web sure-worker`,
      undefined,
      sshOpts.hostKeyOpts,
    );
    if (upRes.code !== 0) {
      throw new Error(`Sure up -d failed (exit ${upRes.code}): ${upRes.stderr}`);
    }
    log("Sure services started");
  } else {
    log("Sure stack already running — skipping compose regenerate");
  }

  await setupSure({
    serverIp: instance.ip_address,
    keyPath: sshKeyPath,
    hostKeyOpts: sshOpts.hostKeyOpts,
    log,
  });

  if (cloudflare.isConfigured()) {
    const domain = process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain;
    const subdomain = instance.subdomain;

    try {
      if (!instance.cf_tunnel_id) {
        log(
          "Warning: instance has no cf_tunnel_id — skipping Sure DNS + cloudflared re-render. Add DNS manually.",
        );
      } else {
        if (!instance.cf_sure_dns_record_id) {
          try {
            const sureRec = await cloudflare.createDnsRecord(
              `${subdomain}-sure`,
              instance.cf_tunnel_id,
            );
            updateInstance(instance.id, {
              cf_sure_dns_record_id: sureRec.id,
            });
            log(`DNS record created: ${subdomain}-sure.${domain} → tunnel`);
          } catch (e) {
            log(
              `Warning: Sure DNS record creation failed (may already exist): ${e}`,
            );
          }
        } else {
          log(
            `Sure DNS record already present (${instance.cf_sure_dns_record_id}) — skipping creation`,
          );
        }

        const cfConfig = nunjucks.renderString(cloudflaredConfigTemplate, {
          tunnel_id: instance.cf_tunnel_id,
          subdomain,
          domain,
          plane_enabled: planeOn || !!instance.cf_plane_dns_record_id,
          sure_enabled: true,
        });
        try {
          await ssh.upload(
            instance.ip_address,
            sshKeyPath,
            cfConfig,
            `${DEFAULTS.cloudflaredDir}/config.yml`,
            0o644,
            undefined,
            sshOpts.hostKeyOpts,
          );
          log("Cloudflared config re-rendered with Sure ingress");

          const restartRes = await ssh.exec(
            instance.ip_address,
            sshKeyPath,
            "sudo systemctl restart cloudflared",
            undefined,
            sshOpts.hostKeyOpts,
          );
          if (restartRes.code !== 0) {
            log(
              `Warning: cloudflared restart failed (exit ${restartRes.code}): ${restartRes.stderr.trim()}`,
            );
          } else {
            await new Promise((r) => setTimeout(r, 3000));
            const verifyRes = await ssh.exec(
              instance.ip_address,
              sshKeyPath,
              "systemctl is-active cloudflared",
              undefined,
              sshOpts.hostKeyOpts,
            );
            if (verifyRes.stdout.trim() !== "active") {
              log(
                `Warning: cloudflared is not active after restart (got "${verifyRes.stdout.trim()}")`,
              );
            } else {
              log("Cloudflared restarted and verified active");
            }
          }
        } catch (e) {
          log(`Warning: cloudflared re-render failed: ${e}`);
        }
      }
    } catch (e) {
      log(`Warning: Sure DNS/ingress wiring failed: ${e}`);
    }
  } else {
    log(
      "Skipping Sure DNS + cloudflared re-render (Cloudflare not configured on this host)",
    );
  }

  insertEvent(instanceId, "api_deployed", "Sure deployed + configured");
  log(
    `deploy-sure complete — Sure UI available at https://${instance.subdomain}-sure.${
      process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain
    }`,
  );
}

// ── Vaultwarden setup ────────────────────────────────────────────────────────
//
// Per-tenant Vaultwarden: each tenant VPS runs its own Bitwarden-compatible
// secrets-manager container. Sir reaches the web UI at
// https://<subdomain>-vault.<domain> (behind Cloudflare Access — Google SSO
// scoped to the owner's email). Other tenant containers will eventually pull
// secrets from this Vaultwarden via vault-init (PR2 in the rollout); Phase 0
// just stands up Vaultwarden and prepares Sir's login so he can manually
// import his existing .env entries through the web UI.
//
// Idempotency: setupVaultwarden is safe to re-run. It generates secrets only
// when they're missing, and posts /admin/invite as a no-op if Sir's email is
// already invited (Vaultwarden returns 200 + a "user already exists" payload).
//
// Why /admin/invite + not /admin/users: Vaultwarden has NO admin endpoint
// that creates a user with a known password. The only path is invite +
// user-completes-signup. We POST /admin/invite to create the Invitation
// record, generate a master password, and surface it to Sir so he can do the
// one-time signup at the web UI using the pre-generated password (Vaultwarden
// honours the Invitation even with SIGNUPS_ALLOWED=false).

interface SetupVaultwardenOpts {
  serverIp: string;
  keyPath: string;
  hostKeyOpts?: SSHHostKeyOptions;
  ownerEmail: string;
  log: (msg: string) => void;
}

const VAULTWARDEN_INTERNAL_HEALTH_URL = "http://127.0.0.1:18080/alive";
const VAULTWARDEN_READY_TIMEOUT_MS = 5 * 60 * 1000;
const VAULTWARDEN_POLL_INTERVAL_MS = 3_000;

async function waitForVaultwardenReady(
  opts: Pick<SetupVaultwardenOpts, "serverIp" | "keyPath" | "hostKeyOpts" | "log">,
): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < VAULTWARDEN_READY_TIMEOUT_MS) {
    const r = await ssh.exec(
      opts.serverIp,
      opts.keyPath,
      `curl -sS -o /dev/null -w '%{http_code}' ${VAULTWARDEN_INTERNAL_HEALTH_URL} || true`,
      undefined,
      opts.hostKeyOpts,
    );
    last = r.stdout.trim();
    if (last === "200") {
      opts.log("Vaultwarden ready (HTTP 200 on /alive)");
      return;
    }
    await new Promise((r) => setTimeout(r, VAULTWARDEN_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Vaultwarden did not become ready within ${VAULTWARDEN_READY_TIMEOUT_MS / 1000}s (last HTTP status: ${last || "unreachable"})`,
  );
}

export async function setupVaultwarden(opts: SetupVaultwardenOpts): Promise<void> {
  const sshOpts: Pick<SetupVaultwardenOpts, "serverIp" | "keyPath" | "hostKeyOpts"> = {
    serverIp: opts.serverIp,
    keyPath: opts.keyPath,
    hostKeyOpts: opts.hostKeyOpts,
  };

  // 1. Generate / reuse bootstrap secrets.
  const seeded: Record<string, string> = {};
  const existingAdminToken = await readTenantEnv(sshOpts, "VAULTWARDEN_ADMIN_TOKEN");
  if (!existingAdminToken) seeded.VAULTWARDEN_ADMIN_TOKEN = randomSecret(32);
  const existingBwPassword = await readTenantEnv(sshOpts, "BW_PASSWORD");
  if (!existingBwPassword) seeded.BW_PASSWORD = randomPassword();
  const existingBwUser = await readTenantEnv(sshOpts, "BW_USER");
  if (!existingBwUser) seeded.BW_USER = opts.ownerEmail;
  const existingBwServerUrl = await readTenantEnv(sshOpts, "BW_SERVER_URL");
  // Internal compose-network alias — vault-init runs in the same compose
  // network and resolves "vaultwarden" to the container.
  if (!existingBwServerUrl) seeded.BW_SERVER_URL = "http://vaultwarden:80";

  if (Object.keys(seeded).length > 0) {
    await writeTenantEnv(sshOpts, seeded);
    opts.log(`Seeded ${Object.keys(seeded).length} Vaultwarden bootstrap secret(s) in .env`);
  } else {
    opts.log("All Vaultwarden bootstrap secrets already in .env — skipping seed");
  }

  // 2. Bring up the vaultwarden container (idempotent — `up -d` is a no-op
  //    if it's already running with the right env). The compose template's
  //    {% if vaultwarden_enabled %} guard means this fails harmlessly with
  //    "no such service" if the caller routed us here without the flag.
  const upRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d vaultwarden`,
    undefined,
    opts.hostKeyOpts,
  );
  if (upRes.code !== 0) {
    throw new Error(
      `Vaultwarden container up failed (exit ${upRes.code}): ${upRes.stderr}`,
    );
  }

  // 3. Wait for Vaultwarden's /alive endpoint.
  opts.log("Waiting for Vaultwarden to become ready (up to 5 min)...");
  await waitForVaultwardenReady({ ...sshOpts, log: opts.log });

  // 4. Bootstrap Sir's user via /admin/invite. Vaultwarden's admin API does
  //    NOT have a "create user with password" path; the closest thing is
  //    POST /admin/invite which creates an Invitation record. With
  //    SIGNUPS_ALLOWED=false but a pending Invitation, the user can still
  //    sign up at the web UI using the email + their own password. We
  //    surface the pre-generated BW_PASSWORD via the log so the dashboard
  //    can show it to Sir as the master password to use during signup.
  const adminToken = seeded.VAULTWARDEN_ADMIN_TOKEN ?? existingAdminToken!;
  const inviteRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    [
      `curl -sS -o /tmp/vw-invite.out -w '%{http_code}'`,
      `-X POST http://127.0.0.1:18080/admin/invite`,
      `-H 'Content-Type: application/json'`,
      `-H 'Cookie: VW_ADMIN=${adminToken}'`,
      `-d '${JSON.stringify({ email: opts.ownerEmail })}'`,
      `; echo; cat /tmp/vw-invite.out; rm -f /tmp/vw-invite.out`,
    ].join(" "),
    undefined,
    opts.hostKeyOpts,
  );
  // Vaultwarden returns 200 on success (also 200 if the user is already
  // invited — admin/invite is idempotent). We log non-2xx as a soft warning
  // because a tenant can still proceed; Sir can hit /admin manually if
  // needed.
  const lines = inviteRes.stdout.trim().split("\n");
  const status = (lines[0] ?? "").trim();
  if (status.startsWith("2")) {
    opts.log(`Vaultwarden invite created for ${opts.ownerEmail} (HTTP ${status})`);
  } else {
    opts.log(
      `Warning: Vaultwarden invite returned HTTP ${status || "?"} — Sir may need to invite ${opts.ownerEmail} manually via the /admin panel. Body: ${lines.slice(1).join(" ").slice(0, 200)}`,
    );
  }

  opts.log(
    `Vaultwarden invite recorded for ${opts.ownerEmail}; running auto-signup`,
  );

  // 5. Auto-signup via Bitwarden client crypto. The /admin/invite call
  // creates a pending User record; we then complete registration by POSTing
  // the encrypted-key payload to /identity/accounts/register, which the
  // existing Invitation gates open for. After this, BW_USER + BW_PASSWORD
  // can `bw login` against Vaultwarden — no Sir-action required.
  const signupRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose run --rm --entrypoint node vault-init /opt/vault-init/bootstrap-signup.mjs`,
    undefined,
    opts.hostKeyOpts,
  );
  if (signupRes.code !== 0) {
    // Soft-fail: bootstrap-signup may legitimately exit 2 if the user
    // already exists from a prior run (idempotent). Log and continue.
    opts.log(
      `Warning: bootstrap-signup exited ${signupRes.code} — may indicate the user already exists (idempotent re-run) or that the invite step partially succeeded. Stdout/stderr tail:\n${signupRes.stderr.slice(-500)}`,
    );
  } else {
    opts.log("Bootstrap-signup OK — Sir's account fully provisioned");
  }

  // 6. Migrate the existing .env into Vaultwarden. Idempotent on its own
  // (dedupes by item name), so re-running on a partially-migrated tenant
  // is safe.
  const migrateRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose run --rm vault-init bash /opt/vault-init/migrate.sh /host/compose/.env`,
    undefined,
    opts.hostKeyOpts,
  );
  if (migrateRes.code !== 0) {
    opts.log(
      `Warning: migrate.sh exited ${migrateRes.code}; some secrets may not have been imported. Tail:\n${migrateRes.stderr.slice(-500)}`,
    );
  } else {
    opts.log("Migrate OK — .env contents now in Vaultwarden");
  }

  // 7. Import the file-on-disk secrets that don't go through .env:
  //    .gateway-token, .sure-bootstrap-email, .sure-bootstrap-password.
  // These remain authoritative on disk; this step just snapshots them
  // into Vaultwarden for visibility.
  const importRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose run --rm -v /mnt/encrypted/alfred:/alfred-data:ro vault-init bash /opt/vault-init/import-files.sh`,
    undefined,
    opts.hostKeyOpts,
  );
  if (importRes.code !== 0) {
    opts.log(
      `Warning: import-files.sh exited ${importRes.code}; some file-based secrets may not be in Vaultwarden. Tail:\n${importRes.stderr.slice(-500)}`,
    );
  } else {
    opts.log("import-files OK — gateway token + Sure admin creds now in Vaultwarden");
  }

  // 8. Create combined login items so Vaultwarden's browser autofill works
  // on Sure / Plane / Vaultwarden's own login pages. These are NEW items
  // ("Sure", "Plane", "Vaultwarden") with username + password + uri set,
  // alongside (not replacing) the env-var-name items vault-init relies on.
  const importLoginsRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose run --rm -v /mnt/encrypted/alfred:/alfred-data:ro vault-init bash /opt/vault-init/import-logins.sh`,
    undefined,
    opts.hostKeyOpts,
  );
  if (importLoginsRes.code !== 0) {
    opts.log(
      `Warning: import-logins.sh exited ${importLoginsRes.code}; browser autofill may not work for Sure/Plane/Vaultwarden. Tail:\n${importLoginsRes.stderr.slice(-500)}`,
    );
  } else {
    opts.log("import-logins OK — Sure/Plane/Vaultwarden login items with autofill URIs created");
  }

  opts.log(
    `Vaultwarden setup complete. Sir browses https://<subdomain>-vault.<domain>; login=${opts.ownerEmail}, master password=BW_PASSWORD from .env (also surfaced in the dashboard).`,
  );
}

// ---------------------------------------------------------------------------
// setupVexa — Steward Phase 4 (#840) per-tenant transcription stack.
//
// Vexa is the open-source meeting-transcription engine used by Alfred to
// join Google Meet / MS Teams calls, transcribe via Groq Whisper, and POST
// `meeting.completed` webhooks back into ctrl-api. The full stack is 9
// containers (postgres / redis / minio / minio-init / admin-api /
// runtime-api / meeting-api / api-gateway / vexa-dashboard) so we keep it
// in a SEPARATE compose project at /opt/alfred/vexa/ — see the long-form
// rationale in templates/vexa-stack.yaml.njk's header.
//
// What setupVexa does, in order:
//   1. Generate / reuse the three bootstrap secrets (ADMIN_API_TOKEN,
//      INTERNAL_API_SECRET, VEXA_WEBHOOK_SECRET) and the static stack
//      env (IMAGE_TAG, BROWSER_IMAGE, DOCKER_GID). These live in
//      /opt/alfred/vexa/.env.
//   2. Render templates/vexa-stack.yaml.njk to
//      /opt/alfred/vexa/docker-compose.yaml with `alfred_network` set
//      to whatever the alfred compose project's default network is
//      named (auto-detected — usually `alfred_default`).
//   3. `docker compose up -d` the standalone vexa project. Wait for
//      vexa-api-gateway to come ready on http://127.0.0.1:18056/.
//   4. Mint a real Vexa user + API key via the admin API:
//        POST /admin/users           → user_id
//        POST /admin/users/<id>/tokens → api_token
//      Stores the token as VEXA_API_KEY in BOTH /opt/alfred/vexa/.env
//      (so the dashboard env-passthrough works) AND
//      /opt/alfred/compose/.env (so alfred-learn can use it).
//   5. Register the meeting-completed webhook by PUT /user/webhook
//      against the api-gateway, signed with VEXA_WEBHOOK_SECRET. The
//      webhook URL points at ctrl-api over the alfred_default network
//      so callbacks never leave the host.
//   6. Mirror VEXA_ENABLED=true + VEXA_API_URL into
//      /opt/alfred/compose/.env and recreate alfred-learn so the
//      transcript schedules get registered on its next workflow boot.
//   7. Re-run the vault-init import-files / import-logins scripts with
//      /opt/alfred/vexa mounted as /host/vexa:ro so the Vexa secrets
//      land in Vaultwarden alongside the other tenant credentials.
//   8. Install + start `vexa-stack-up.timer` (systemd) so the standalone
//      vexa compose comes up on every host boot — independent of the
//      alfred compose's own systemd unit. Same shape as the Plane and
//      Sure timers; just points at /opt/alfred/vexa instead.
//
// All steps are idempotent. Re-running setupVexa on an already-deployed
// tenant only refreshes whatever is missing (the secrets stay; .env is
// merged; the compose is re-rendered; the API key is reused if it's
// still valid).
// ---------------------------------------------------------------------------

interface SetupVexaOpts {
  serverIp: string;
  keyPath: string;
  hostKeyOpts?: SSHHostKeyOptions;
  subdomain: string;
  domain: string;
  log: (msg: string) => void;
}

const VEXA_DIR = "/opt/alfred/vexa";
const VEXA_GATEWAY_INTERNAL_URL = "http://127.0.0.1:18056/";
const VEXA_DASHBOARD_INTERNAL_URL = "http://127.0.0.1:18057/api/health";
const VEXA_READY_TIMEOUT_MS = 5 * 60 * 1000;
const VEXA_POLL_INTERVAL_MS = 5_000;
const VEXA_IMAGE_TAG = "0.10.6";
const VEXA_BROWSER_IMAGE = "vexaai/vexa-bot:0.10.6";

async function waitForVexaGatewayReady(
  opts: Pick<SetupVexaOpts, "serverIp" | "keyPath" | "hostKeyOpts" | "log">,
): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < VEXA_READY_TIMEOUT_MS) {
    const r = await ssh.exec(
      opts.serverIp,
      opts.keyPath,
      `curl -sS -o /dev/null -w '%{http_code}' ${VEXA_GATEWAY_INTERNAL_URL} || true`,
      undefined,
      opts.hostKeyOpts,
    );
    last = r.stdout.trim();
    // The api-gateway returns a JSON welcome payload at "/" with HTTP 200.
    if (last === "200") {
      opts.log("Vexa api-gateway ready (HTTP 200)");
      return;
    }
    await new Promise((r) => setTimeout(r, VEXA_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Vexa api-gateway did not become ready within ${VEXA_READY_TIMEOUT_MS / 1000}s (last HTTP status: ${last || "unreachable"})`,
  );
}

/**
 * Read a single KEY=... value from a non-default env file on the tenant
 * (e.g. /opt/alfred/vexa/.env). Mirrors readTenantEnv but takes an
 * explicit path. Returns `undefined` if absent.
 */
async function readEnvAt(
  opts: Pick<SetupVexaOpts, "serverIp" | "keyPath" | "hostKeyOpts">,
  envPath: string,
  key: string,
): Promise<string | undefined> {
  const cmd = `grep -E '^${key}=' ${envPath} 2>/dev/null | tail -n1 || true`;
  const result = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    cmd,
    undefined,
    opts.hostKeyOpts,
  );
  const line = result.stdout.trim();
  if (!line) return undefined;
  const eq = line.indexOf("=");
  if (eq === -1) return undefined;
  let val = line.slice(eq + 1);
  if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
    val = val.slice(1, -1);
  }
  return val;
}

/**
 * Append-or-replace KEY=VALUE pairs in an arbitrary .env on the tenant.
 * Mirrors writeTenantEnv but takes an explicit path. Used for both
 * /opt/alfred/vexa/.env and /opt/alfred/compose/.env.
 */
async function writeEnvAt(
  opts: Pick<SetupVexaOpts, "serverIp" | "keyPath" | "hostKeyOpts">,
  envPath: string,
  entries: Record<string, string>,
): Promise<void> {
  const cmd = buildEnvWriteCommand(envPath, entries);
  if (cmd === null) return;
  const result = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    cmd,
    undefined,
    opts.hostKeyOpts,
  );
  if (result.code !== 0) {
    throw new Error(`Env write to ${envPath} failed (exit ${result.code}): ${result.stderr}`);
  }
}

/**
 * Detect the alfred compose project's default network name. Compose
 * generates this from the directory basename — typically `compose_default`
 * or `alfred_default` depending on what the operator named the dir. We
 * ask docker directly so a tenant-specific override (COMPOSE_PROJECT_NAME)
 * is respected.
 */
async function detectAlfredNetwork(
  opts: Pick<SetupVexaOpts, "serverIp" | "keyPath" | "hostKeyOpts">,
): Promise<string> {
  const r = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose ls --format json 2>/dev/null | head -c 4096`,
    undefined,
    opts.hostKeyOpts,
  );
  // Best-effort parse; we only need the project name.
  let projectName: string | null = null;
  try {
    const list = JSON.parse(r.stdout.trim() || "[]");
    if (Array.isArray(list) && list.length > 0 && list[0]?.Name) {
      projectName = list[0].Name as string;
    }
  } catch {
    // ignore — fall through to docker network ls
  }
  if (projectName) {
    return `${projectName}_default`;
  }
  // Fallback: enumerate networks and pick one ending in _default that
  // any alfred container is attached to.
  const ls = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `docker network ls --format '{{.Name}}' | grep -E '_default$' | head -n1 || true`,
    undefined,
    opts.hostKeyOpts,
  );
  const fallback = ls.stdout.trim();
  return fallback || "alfred_default";
}

/**
 * Detect the host's `docker` group GID — Vexa's runtime-api needs this so
 * the spawned Vexa-bot containers can talk to the docker socket. Hetzner
 * Debian images typically use 998; some Ubuntu images use 999.
 */
async function detectDockerGid(
  opts: Pick<SetupVexaOpts, "serverIp" | "keyPath" | "hostKeyOpts">,
): Promise<string> {
  const r = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `getent group docker | cut -d: -f3 || echo 998`,
    undefined,
    opts.hostKeyOpts,
  );
  const gid = r.stdout.trim();
  return /^\d+$/.test(gid) ? gid : "998";
}

/**
 * Mint a Vexa user + API token via the admin API. The api-gateway proxies
 * /admin/* to admin-api (X-Admin-API-Key auth), so we hit the gateway on
 * the host-bound port to keep the curl simple. Returns the new token on
 * success; throws otherwise.
 */
async function mintVexaApiKey(
  opts: Pick<SetupVexaOpts, "serverIp" | "keyPath" | "hostKeyOpts" | "log">,
  adminToken: string,
  ownerEmail: string,
): Promise<string> {
  // 1. Create user (idempotent on the email — Vexa returns the existing
  //    user record if the email is already registered).
  const createUserCmd = [
    `curl -sS -o /tmp/vexa-user.json -w '%{http_code}'`,
    `-X POST http://127.0.0.1:18056/admin/users`,
    `-H 'Content-Type: application/json'`,
    `-H 'X-Admin-API-Key: ${adminToken}'`,
    `-d '${JSON.stringify({ email: ownerEmail, max_concurrent_bots: 3 })}'`,
    `; echo`,
    `; cat /tmp/vexa-user.json`,
    `; rm -f /tmp/vexa-user.json`,
  ].join(" ");
  const userRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    createUserCmd,
    undefined,
    opts.hostKeyOpts,
  );
  const userLines = userRes.stdout.trim().split("\n");
  const userStatus = (userLines[0] ?? "").trim();
  if (!userStatus.startsWith("2")) {
    throw new Error(
      `Vexa POST /admin/users returned HTTP ${userStatus} — body: ${userLines.slice(1).join(" ").slice(0, 300)}`,
    );
  }
  let userId: number | null = null;
  try {
    const body = JSON.parse(userLines.slice(1).join("\n"));
    userId =
      typeof body?.id === "number"
        ? body.id
        : typeof body?.user_id === "number"
        ? body.user_id
        : null;
  } catch {
    // fall through
  }
  if (userId === null) {
    throw new Error(
      `Vexa POST /admin/users returned 2xx but no parseable id — body: ${userLines.slice(1).join(" ").slice(0, 300)}`,
    );
  }
  opts.log(`Vexa user provisioned (id=${userId}, email=${ownerEmail})`);

  // 2. Mint a token for that user. Vexa's admin endpoint returns
  //    {"id": "...", "token": "...", "user_id": N} on 201.
  const mintTokenCmd = [
    `curl -sS -o /tmp/vexa-tok.json -w '%{http_code}'`,
    `-X POST http://127.0.0.1:18056/admin/users/${userId}/tokens`,
    `-H 'Content-Type: application/json'`,
    `-H 'X-Admin-API-Key: ${adminToken}'`,
    `-d '{}'`,
    `; echo`,
    `; cat /tmp/vexa-tok.json`,
    `; rm -f /tmp/vexa-tok.json`,
  ].join(" ");
  const tokenRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    mintTokenCmd,
    undefined,
    opts.hostKeyOpts,
  );
  const tokenLines = tokenRes.stdout.trim().split("\n");
  const tokenStatus = (tokenLines[0] ?? "").trim();
  if (!tokenStatus.startsWith("2")) {
    throw new Error(
      `Vexa POST /admin/users/${userId}/tokens returned HTTP ${tokenStatus} — body: ${tokenLines.slice(1).join(" ").slice(0, 300)}`,
    );
  }
  let token: string | null = null;
  try {
    const body = JSON.parse(tokenLines.slice(1).join("\n"));
    token =
      typeof body?.token === "string"
        ? body.token
        : typeof body?.api_token === "string"
        ? body.api_token
        : null;
  } catch {
    // fall through
  }
  if (!token || token.length < 16) {
    throw new Error(
      `Vexa token endpoint returned 2xx but no parseable token — body: ${tokenLines.slice(1).join(" ").slice(0, 300)}`,
    );
  }
  return token;
}

/**
 * Register the `meeting.completed` webhook URL with Vexa. PUT /user/webhook
 * against the api-gateway with the user-scoped X-API-Key.
 */
async function registerVexaWebhook(
  opts: Pick<SetupVexaOpts, "serverIp" | "keyPath" | "hostKeyOpts" | "log">,
  apiKey: string,
  webhookUrl: string,
  webhookSecret: string,
): Promise<void> {
  const cmd = [
    `curl -sS -o /tmp/vexa-hook.json -w '%{http_code}'`,
    `-X PUT http://127.0.0.1:18056/user/webhook`,
    `-H 'Content-Type: application/json'`,
    `-H 'X-API-Key: ${apiKey}'`,
    `-d '${JSON.stringify({ url: webhookUrl, secret: webhookSecret })}'`,
    `; echo`,
    `; cat /tmp/vexa-hook.json`,
    `; rm -f /tmp/vexa-hook.json`,
  ].join(" ");
  const r = await ssh.exec(opts.serverIp, opts.keyPath, cmd, undefined, opts.hostKeyOpts);
  const lines = r.stdout.trim().split("\n");
  const status = (lines[0] ?? "").trim();
  if (!status.startsWith("2")) {
    throw new Error(
      `Vexa PUT /user/webhook returned HTTP ${status} — body: ${lines.slice(1).join(" ").slice(0, 300)}`,
    );
  }
  opts.log(`Vexa webhook registered: url=${webhookUrl} (HTTP ${status})`);
}

const VEXA_STACK_TIMER_UNIT = `[Unit]
Description=Bring Vexa compose stack up after boot
Requires=docker.service alfred-data.service
After=docker.service alfred-data.service

[Service]
Type=oneshot
WorkingDirectory=${VEXA_DIR}
ExecStart=/usr/bin/docker compose up -d
RemainAfterExit=true
`;

const VEXA_STACK_TIMER_TIMER = `[Unit]
Description=Trigger Vexa compose stack on boot
After=docker.service

[Timer]
OnBootSec=2min
Unit=vexa-stack-up.service

[Install]
WantedBy=timers.target
`;

export async function setupVexa(opts: SetupVexaOpts): Promise<void> {
  const sshOpts: Pick<SetupVexaOpts, "serverIp" | "keyPath" | "hostKeyOpts"> = {
    serverIp: opts.serverIp,
    keyPath: opts.keyPath,
    hostKeyOpts: opts.hostKeyOpts,
  };

  // 0. mkdir for the standalone compose project.
  await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `sudo mkdir -p ${VEXA_DIR} && sudo chown deploy:deploy ${VEXA_DIR}`,
    undefined,
    opts.hostKeyOpts,
  );

  // 1. Generate / reuse the three bootstrap secrets + static config.
  const vexaEnvPath = `${VEXA_DIR}/.env`;
  const seeded: Record<string, string> = {};
  const existingAdminToken = await readEnvAt(sshOpts, vexaEnvPath, "ADMIN_API_TOKEN");
  if (!existingAdminToken) seeded.ADMIN_API_TOKEN = randomSecret(32);
  const existingInternal = await readEnvAt(sshOpts, vexaEnvPath, "INTERNAL_API_SECRET");
  if (!existingInternal) seeded.INTERNAL_API_SECRET = randomSecret(32);
  const existingHookSecret = await readEnvAt(sshOpts, vexaEnvPath, "VEXA_WEBHOOK_SECRET");
  if (!existingHookSecret) seeded.VEXA_WEBHOOK_SECRET = randomSecret(32);
  const existingImageTag = await readEnvAt(sshOpts, vexaEnvPath, "IMAGE_TAG");
  if (!existingImageTag) seeded.IMAGE_TAG = VEXA_IMAGE_TAG;
  const existingBrowserImage = await readEnvAt(sshOpts, vexaEnvPath, "BROWSER_IMAGE");
  if (!existingBrowserImage) seeded.BROWSER_IMAGE = VEXA_BROWSER_IMAGE;
  const existingDockerGid = await readEnvAt(sshOpts, vexaEnvPath, "DOCKER_GID");
  if (!existingDockerGid) seeded.DOCKER_GID = await detectDockerGid(sshOpts);

  // Groq Whisper transcription — read from the alfred .env (where the
  // operator dropped it) and mirror into vexa's .env so the meeting-api
  // can hit Groq directly. Skip if absent — the operator can manually
  // populate /opt/alfred/vexa/.env later.
  const existingGroqUrl = await readEnvAt(sshOpts, vexaEnvPath, "TRANSCRIPTION_SERVICE_URL");
  if (!existingGroqUrl) {
    seeded.TRANSCRIPTION_SERVICE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
  }
  const existingGroqToken = await readEnvAt(sshOpts, vexaEnvPath, "TRANSCRIPTION_SERVICE_TOKEN");
  if (!existingGroqToken) {
    const alfredEnvPath = `${DEFAULTS.dockerComposeDir}/.env`;
    const groqFromAlfred = await readEnvAt(sshOpts, alfredEnvPath, "GROQ_API_KEY");
    if (groqFromAlfred) {
      seeded.TRANSCRIPTION_SERVICE_TOKEN = groqFromAlfred;
    } else {
      opts.log(
        "Warning: GROQ_API_KEY not in /opt/alfred/compose/.env — vexa-meeting-api will fail to transcribe until TRANSCRIPTION_SERVICE_TOKEN is set in /opt/alfred/vexa/.env",
      );
    }
  }

  if (Object.keys(seeded).length > 0) {
    await writeEnvAt(sshOpts, vexaEnvPath, seeded);
    opts.log(`Seeded ${Object.keys(seeded).length} Vexa bootstrap value(s) in ${vexaEnvPath}`);
  } else {
    opts.log("All Vexa bootstrap values already present — skipping seed");
  }

  // 2. Render & upload vexa-stack.yaml.njk.
  const alfredNetwork = await detectAlfredNetwork(sshOpts);
  const vexaCompose = nunjucks.renderString(vexaStackTemplate, {
    alfred_network: alfredNetwork,
    tenant_id: "alfred",
  });
  await ssh.upload(
    opts.serverIp,
    opts.keyPath,
    vexaCompose,
    `${VEXA_DIR}/docker-compose.yaml`,
    0o600,
    undefined,
    opts.hostKeyOpts,
  );
  opts.log(`vexa-stack rendered to ${VEXA_DIR}/docker-compose.yaml (alfred_network=${alfredNetwork})`);

  // 3. Bring up the standalone vexa compose project. Soft-pull first so
  //    image-cold tenants don't block the whole step on registry latency.
  const pullRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${VEXA_DIR} && timeout 600 docker compose pull 2>&1 | tail -n 20`,
    undefined,
    opts.hostKeyOpts,
  );
  if (pullRes.code !== 0) {
    opts.log(`Warning: docker compose pull exited ${pullRes.code} — proceeding anyway. Tail:\n${pullRes.stderr.slice(-500)}`);
  }

  const upRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${VEXA_DIR} && docker compose up -d`,
    undefined,
    opts.hostKeyOpts,
  );
  if (upRes.code !== 0) {
    throw new Error(
      `vexa stack up failed (exit ${upRes.code}): ${upRes.stderr.slice(-500)}`,
    );
  }
  opts.log("vexa compose project up — waiting for api-gateway to become ready");

  await waitForVexaGatewayReady({ ...sshOpts, log: opts.log });

  // 4. Mint user + token via the admin-api proxied through api-gateway.
  //    We tag the user with the tenant subdomain (so a multi-user Vexa
  //    instance later — if we ever go that direction — can disambiguate
  //    Sir's account from operator accounts).
  const adminToken =
    seeded.ADMIN_API_TOKEN ??
    (await readEnvAt(sshOpts, vexaEnvPath, "ADMIN_API_TOKEN"));
  if (!adminToken) {
    throw new Error("Internal: ADMIN_API_TOKEN missing post-seed");
  }
  const ownerEmail =
    process.env.TENANT_OWNER_EMAIL ??
    (await readTenantEnv(sshOpts, "OWNER_EMAIL")) ??
    `alfred@${opts.subdomain}.${opts.domain}`;

  const existingApiKey = await readEnvAt(sshOpts, vexaEnvPath, "VEXA_API_KEY");
  let vexaApiKey: string;
  if (existingApiKey && existingApiKey.length >= 16) {
    vexaApiKey = existingApiKey;
    opts.log("VEXA_API_KEY already present in vexa/.env — reusing");
  } else {
    vexaApiKey = await mintVexaApiKey(
      { ...sshOpts, log: opts.log },
      adminToken,
      ownerEmail,
    );
    await writeEnvAt(sshOpts, vexaEnvPath, { VEXA_API_KEY: vexaApiKey });
    opts.log("VEXA_API_KEY minted + written to vexa/.env");
  }

  // 5. Register the meeting-completed webhook. Idempotent on Vexa's side
  //    (PUT replaces the existing record).
  const webhookSecret =
    seeded.VEXA_WEBHOOK_SECRET ??
    (await readEnvAt(sshOpts, vexaEnvPath, "VEXA_WEBHOOK_SECRET"));
  if (!webhookSecret) {
    throw new Error("Internal: VEXA_WEBHOOK_SECRET missing post-seed");
  }
  // Webhooks travel inside the alfred_default network — never out to the
  // public internet. The vexa-bot containers spawned by runtime-api join
  // alfred_default and resolve `ctrl-api` as an alias.
  const webhookUrl = "http://ctrl-api:3100/api/v1/webhooks/vexa";
  try {
    await registerVexaWebhook(
      { ...sshOpts, log: opts.log },
      vexaApiKey,
      webhookUrl,
      webhookSecret,
    );
  } catch (e) {
    opts.log(
      `Warning: webhook registration failed: ${e}. Run setupVexa again or curl PUT /user/webhook by hand.`,
    );
  }

  // 6. Mirror the alfred-side env so alfred-learn picks up the changes.
  const alfredEnvUpdates: Record<string, string> = {
    VEXA_ENABLED: "true",
    VEXA_API_URL: "http://vexa-api-gateway:8000",
    VEXA_API_KEY: vexaApiKey,
    VEXA_WEBHOOK_SECRET: webhookSecret,
  };
  await writeEnvAt(sshOpts, `${DEFAULTS.dockerComposeDir}/.env`, alfredEnvUpdates);
  opts.log("Mirrored VEXA_* env vars into /opt/alfred/compose/.env");

  // Recreate alfred-learn (so Temporal schedule registration picks up
  // VEXA_ENABLED=true) and ctrl-api (so the apps catalog now lists
  // Vexa). Best-effort — don't blow up the whole step on a recreate
  // hiccup.
  const recreateRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `cd ${DEFAULTS.dockerComposeDir} && docker compose up -d --force-recreate alfred-learn ctrl-api`,
    undefined,
    opts.hostKeyOpts,
  );
  if (recreateRes.code !== 0) {
    opts.log(
      `Warning: failed to recreate alfred-learn/ctrl-api (exit ${recreateRes.code}); restart manually with docker compose up -d --force-recreate. Tail:\n${recreateRes.stderr.slice(-500)}`,
    );
  } else {
    opts.log("alfred-learn + ctrl-api recreated with VEXA_ENABLED=true");
  }

  // 7. Push the new Vexa secrets into Vaultwarden via the import-files
  //    + import-logins scripts. Mount /opt/alfred/vexa as /host/vexa:ro
  //    so the scripts can read ADMIN_API_TOKEN / VEXA_WEBHOOK_SECRET
  //    out of vexa/.env without us having to copy them.
  const bwUser = await readTenantEnv(sshOpts, "BW_USER");
  if (bwUser) {
    const importRes = await ssh.exec(
      opts.serverIp,
      opts.keyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose run --rm -v /mnt/encrypted/alfred:/alfred-data:ro -v ${VEXA_DIR}:/host/vexa:ro vault-init bash /opt/vault-init/import-files.sh`,
      undefined,
      opts.hostKeyOpts,
    );
    if (importRes.code !== 0) {
      opts.log(
        `Warning: import-files.sh exited ${importRes.code} after Vexa setup; Vexa creds may not be in Vaultwarden. Tail:\n${importRes.stderr.slice(-500)}`,
      );
    } else {
      opts.log("Vexa secrets pushed to Vaultwarden via import-files.sh");
    }
    const importLoginsRes = await ssh.exec(
      opts.serverIp,
      opts.keyPath,
      `cd ${DEFAULTS.dockerComposeDir} && docker compose run --rm -v /mnt/encrypted/alfred:/alfred-data:ro -v ${VEXA_DIR}:/host/vexa:ro vault-init bash /opt/vault-init/import-logins.sh`,
      undefined,
      opts.hostKeyOpts,
    );
    if (importLoginsRes.code !== 0) {
      opts.log(
        `Warning: import-logins.sh exited ${importLoginsRes.code} after Vexa setup; Vexa autofill login may not have been created. Tail:\n${importLoginsRes.stderr.slice(-500)}`,
      );
    } else {
      opts.log("Vexa login item pushed to Vaultwarden via import-logins.sh");
    }
  } else {
    opts.log("BW_USER not set — skipping Vaultwarden import for Vexa secrets (manual step: re-run import-files.sh once Vaultwarden is up)");
  }

  // 8. Install the boot-time stack-up timer so Vexa starts even if the
  //    operator power-cycles the VM. The unit lives outside the alfred
  //    compose's own systemd surface; a separate timer + service pair
  //    keeps the lifecycles independent.
  const installTimer = [
    `sudo install -m 0644 /dev/stdin /etc/systemd/system/vexa-stack-up.service <<'__EOF_VEXA_SVC__'`,
    VEXA_STACK_TIMER_UNIT,
    `__EOF_VEXA_SVC__`,
    `sudo install -m 0644 /dev/stdin /etc/systemd/system/vexa-stack-up.timer <<'__EOF_VEXA_TIMER__'`,
    VEXA_STACK_TIMER_TIMER,
    `__EOF_VEXA_TIMER__`,
    `sudo systemctl daemon-reload`,
    `sudo systemctl enable --now vexa-stack-up.timer`,
  ].join("\n");
  const timerRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `bash -s <<'__OUTER_VEXA_TIMER__'
${installTimer}
__OUTER_VEXA_TIMER__
`,
    undefined,
    opts.hostKeyOpts,
  );
  if (timerRes.code !== 0) {
    opts.log(
      `Warning: vexa-stack-up.timer install exited ${timerRes.code}; Vexa will not auto-start on host reboot until fixed. Tail:\n${timerRes.stderr.slice(-500)}`,
    );
  } else {
    opts.log("vexa-stack-up.timer installed + enabled");
  }

  // 9. Sanity check — the dashboard should now answer 200 on /api/health.
  const healthRes = await ssh.exec(
    opts.serverIp,
    opts.keyPath,
    `curl -sS -o /dev/null -w '%{http_code}' ${VEXA_DASHBOARD_INTERNAL_URL} || true`,
    undefined,
    opts.hostKeyOpts,
  );
  const healthCode = healthRes.stdout.trim();
  if (healthCode === "200") {
    opts.log(
      `Vexa setup complete. Sir browses https://${opts.subdomain}-vexa.${opts.domain}; admin token in Vaultwarden as VEXA_ADMIN_API_TOKEN.`,
    );
  } else {
    opts.log(
      `Warning: vexa-dashboard /api/health returned HTTP ${healthCode || "?"}; the stack came up but the dashboard may still be initializing. Re-check in ~30s.`,
    );
  }
}

/**
 * CLI retrofit: enable Vexa on an already-provisioned tenant. Mirrors
 * `deploySure` shape — runs `setupVexa`, ensures the
 * `<subdomain>-vexa.<domain>` DNS record exists, and re-renders
 * cloudflared with `vexa_enabled=true` (preserving any existing
 * plane / sure / vaultwarden flags).
 */
export async function deployVexa(
  instanceId: number,
  onLog?: (msg: string) => void,
): Promise<void> {
  const { getInstance: getInstanceLazy } = await import("../db/queries.js");
  const instance = getInstanceLazy(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);
  if (!instance.ip_address || !instance.ssh_key_path) {
    throw new Error("Instance not fully provisioned");
  }
  if (!instance.subdomain) {
    throw new Error(
      "Instance has no subdomain — deployVexa needs it for the cloudflared ingress hostname",
    );
  }

  const log = (msg: string) => onLog?.(msg);

  // Re-resolve absolute SSH key path for non-container runs.
  const sshKeyPath = instance.ssh_key_path.replace(
    /^\/app\/alfred-ctrl\//,
    process.cwd() + "/",
  );
  const hostKeyOpts: SSHHostKeyOptions | undefined = instance.ssh_host_key
    ? { knownHostKey: instance.ssh_host_key }
    : undefined;

  const subdomain = instance.subdomain;
  const domain = process.env.CLOUDFLARE_DOMAIN ?? DEFAULTS.cloudflareDomain;

  // 1. Run the actual stack-up + bootstrap.
  await setupVexa({
    subdomain,
    domain,
    serverIp: instance.ip_address,
    keyPath: sshKeyPath,
    hostKeyOpts,
    log,
  });

  // 2. Ensure the public DNS record + re-render cloudflared (preserving
  // existing per-app flags by reading the per-instance DNS record IDs as
  // a proxy for whether each block is currently in the ingress list).
  if (cloudflare.isConfigured() && instance.cf_tunnel_id) {
    if (!instance.cf_vexa_dns_record_id) {
      try {
        const vexaRec = await cloudflare.createDnsRecord(
          `${subdomain}-vexa`,
          instance.cf_tunnel_id,
        );
        updateInstance(instance.id, { cf_vexa_dns_record_id: vexaRec.id });
        log(`DNS record created: ${subdomain}-vexa.${domain} → tunnel`);
      } catch (e) {
        log(
          `Warning: Vexa DNS record creation failed (may already exist): ${e}`,
        );
      }
    } else {
      log(
        `Vexa DNS record already present (${instance.cf_vexa_dns_record_id}) — skipping creation`,
      );
    }

    const cfConfig = nunjucks.renderString(cloudflaredConfigTemplate, {
      tunnel_id: instance.cf_tunnel_id,
      subdomain,
      domain,
      plane_enabled: !!instance.cf_plane_dns_record_id,
      sure_enabled: !!instance.cf_sure_dns_record_id,
      vaultwarden_enabled: !!instance.cf_vault_dns_record_id,
      vexa_enabled: true,
    });
    try {
      await ssh.upload(
        instance.ip_address,
        sshKeyPath,
        cfConfig,
        `${DEFAULTS.cloudflaredDir}/config.yml`,
        0o644,
        undefined,
        hostKeyOpts,
      );
      log("Cloudflared config re-rendered with Vexa ingress");

      const restartRes = await ssh.exec(
        instance.ip_address,
        sshKeyPath,
        "sudo systemctl restart cloudflared",
        undefined,
        hostKeyOpts,
      );
      if (restartRes.code !== 0) {
        log(
          `Warning: cloudflared restart failed (exit ${restartRes.code}): ${restartRes.stderr.trim()}`,
        );
      } else {
        log("cloudflared restarted");
      }
    } catch (e) {
      log(`Warning: cloudflared re-render failed: ${e}`);
    }
  } else {
    log(
      "Cloudflare not configured (or tenant has no tunnel) — skipping DNS + cloudflared. Vexa is reachable internally only.",
    );
  }

  // Note: this retrofit deliberately does NOT update the Hetzner
  // ``vexa-enabled`` label — the existing Plane / Sure retrofits don't
  // either, since Hetzner labels are advisory and the tenant's actual
  // vexa state is now in /opt/alfred/vexa/.env + the cf_vexa_dns_record_id
  // column. Add it back here if a fleet-wide Vexa scan ever needs label
  // discovery.
}
