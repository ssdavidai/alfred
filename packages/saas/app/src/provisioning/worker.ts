import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { encryptApiKey, decryptApiKey } from "../server/tenantProxy";
import { ensureInstanceHasAgentMail } from "../server/agentmail";
import { prisma } from "wasp/server";

const execFileAsync = promisify(execFile);

// Path to alfred-ctrl CLI
const ALFRED_CTRL_PATH =
  process.env.ALFRED_CTRL_PATH || "/opt/alfred-saas/alfred-ctrl/dist/index.mjs";

// Map log output patterns to step names
const STEP_PATTERNS: [RegExp, string][] = [
  [/generating.*ssh|ssh keypair/i, "generate_keypair"],
  [/uploading ssh key/i, "upload_ssh_key"],
  [/ensuring firewall/i, "ensure_firewall"],
  [/creating.*volume/i, "create_volume"],
  [/rendering cloud-init/i, "render_cloud_init"],
  [/creating server/i, "create_server"],
  [/waiting for cloud-init/i, "wait_cloud_init"],
  [/uploading env/i, "upload_env"],
  [/configuring restic|backup/i, "configure_backups"],
  [/uploading docker-compose/i, "upload_compose"],
  [/pulling images|starting init|containers starting/i, "start_containers"],
  [/openclaw.*bootstrap|openclaw.*tailscale|running openclaw/i, "bootstrap_openclaw"],
  [/backing up luks/i, "backup_luks_key"],
  [/setting up cloudflare|tunnel created|tunnel live/i, "setup_tunnel"],
  [/deploying tenant api/i, "deploy_api"],
  [/running.*health check/i, "health_check"],
  [/provisioning complete/i, "done"],
];

function detectStep(line: string): string | null {
  for (const [pattern, step] of STEP_PATTERNS) {
    if (pattern.test(line)) return step;
  }
  return null;
}

// Track active provisioning child PIDs so we can distinguish
// genuinely running jobs from orphans left by a container restart.
const activeProvisionPids = new Set<string>();

export async function provisionInstanceJob(
  _args: unknown,
  context: any,
): Promise<void> {
  // Recover orphaned jobs: if a job is "running" but we have no active
  // child process for it, the container was restarted mid-provisioning.
  const runningJobs = await context.entities.ProvisioningJob.findMany({
    where: { status: "running" },
  });
  for (const orphan of runningJobs) {
    if (!activeProvisionPids.has(orphan.id)) {
      console.error(
        `[provision] Recovering orphaned job ${orphan.id} (was on step: ${orphan.currentStep})`,
      );
      await context.entities.ProvisioningJob.update({
        where: { id: orphan.id },
        data: {
          status: "failed",
          error: `Interrupted by server restart (was on step: ${orphan.currentStep})`,
          completedAt: new Date(),
        },
      });
      // Also mark the instance as error so auto-reprovision can kick in
      await context.entities.Instance.updateMany({
        where: { id: orphan.instanceId, status: "provisioning" },
        data: { status: "error" },
      });
    }
  }

  // Find pending provisioning jobs
  const pendingJobs = await context.entities.ProvisioningJob.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: 1,
  });

  if (pendingJobs.length === 0) return;

  const job = pendingJobs[0];

  // Track this job as actively running in this process
  activeProvisionPids.add(job.id);

  // Mark job as running
  await context.entities.ProvisioningJob.update({
    where: { id: job.id },
    data: { status: "running", startedAt: new Date() },
  });

  // Get the instance
  const instance = await context.entities.Instance.findUnique({
    where: { id: job.instanceId },
  });

  if (!instance) {
    await context.entities.ProvisioningJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        error: "Instance not found",
        completedAt: new Date(),
      },
    });
    return;
  }

  const logs: string[] = [];
  let currentStep = "generate_keypair";

  try {
    console.info(
      `Starting provisioning for ${instance.customerName} (${instance.serverType})`,
    );

    // Try multiple Hetzner locations in order of preference.
    // If placement fails (resource_unavailable), destroy the partial
    // instance and retry with the next location.
    const LOCATIONS = ["fsn1", "nbg1", "hel1"];
    let finalExitCode = 1;
    let lastStderr = "";

    // Auto-detect latest golden snapshot for fast provisioning.
    // Falls back to full cloud-init if no snapshot exists.
    let snapshotArgs: string[] = [];
    try {
      const { stdout: snapshotId } = await execFileAsync(
        process.execPath,
        ["--experimental-sqlite", ALFRED_CTRL_PATH, "snapshot", "latest"],
        {
          timeout: 15_000,
          env: { ...process.env, NODE_NO_WARNINGS: "1" },
          cwd: process.env.ALFRED_CTRL_CWD || "/opt/alfred-saas/alfred-ctrl",
        },
      );
      const id = snapshotId.trim();
      if (id) {
        snapshotArgs = ["--snapshot", id];
        logs.push(`Using golden snapshot: ${id}`);
        console.info(`[provision:${instance.customerName}] Using golden snapshot: ${id}`);
      }
    } catch {
      logs.push("No golden snapshot found, using full cloud-init");
      console.info(`[provision:${instance.customerName}] No golden snapshot, full cloud-init`);
    }

    // Server-type fallback chain. When the requested type has zero capacity
    // across all 3 EU DCs (the Intel cx5*/cx4*/cx3* line is regularly sold
    // out for hours at a time), automatically fall through to the AMD
    // cpx-equivalent — same shared-CPU class, equivalent specs, separate
    // physical inventory pool from Intel cx, so almost always available
    // when its Intel counterpart is exhausted. cpx62 = 16c/32GB AMD,
    // direct match for cx53's 16c/32GB Intel.
    //
    // ccx43 (dedicated-CPU, 16c/64GB) was tried as a fallback originally
    // but the SaaS Hetzner project's dedicated_core_limit was already
    // exhausted (resource_limit_exceeded → 403), so it can't even be
    // requested. Stick with shared-CPU fallbacks until that quota is
    // raised.
    //
    // Surfaced 2026-05-07/08: daveszab re-register hit cx53 sold-out
    // across all 3 EU DCs for 12+ hours straight. cpx62 was available
    // the entire time.
    const CPX_FALLBACK: Record<string, string> = {
      cx53: "cpx62", // 16c / 32GB
      cx43: "cpx52", // ~12c / 24GB
      cx33: "cpx42", // 8c / 16GB
      cx23: "cpx32", // 4c / 8GB
      cx22: "cpx22", // 2c / 4GB
    };
    const TYPE_CHAIN: string[] = (() => {
      const primary = instance.serverType;
      const fallback = CPX_FALLBACK[primary];
      if (!fallback || fallback === primary) return [primary];
      return [primary, fallback];
    })();
    logs.push(`Server-type chain: ${TYPE_CHAIN.join(" → ")}`);

    // Build the per-tenant env overlay ONCE, before the retry loop. Nothing
    // in here changes between location attempts — running `User.findUnique`
    // N times is wasted DB traffic (and hides the "no User in entities list"
    // bug deeper in the stack trace when it throws, see #446 followup).
    const agentmailEnv: Record<string, string> = {};

    // Owner email — used by init container to seed /vault/.auth/authorized_senders.json
    // and by outbound email defaults. Derive from the user record. Fetched
    // FIRST because the AgentMail mint step below needs it too.
    const owner = await context.entities.User.findUnique({
      where: { id: instance.userId },
    });
    if (owner?.email) {
      agentmailEnv.TENANT_OWNER_EMAIL = owner.email;
    }

    // AgentMail per-tenant inbox. Idempotent: if the Instance row already
    // has credentials persisted (e.g. by a previous run of this worker)
    // the helper just decrypts and returns them. Otherwise it mints a
    // fresh inbox + scoped API key, persists everything to the Instance
    // row encrypted, and hands back plaintext for the env overlay. Mint
    // failures are captured on the Instance row
    // (`agentmailProvisionStatus = "failed"`) but DO NOT abort VM
    // provisioning — the tenant still ships, just without an email
    // channel until a retry succeeds. See issue #686.
    //
    // Always run this even when `owner` resolves to null (User row deleted
    // or orphaned): the reused-credentials path doesn't need user fields,
    // and a fresh-mint attempt without an email will fail cleanly and be
    // captured on the Instance row. Gating the call on `owner` would
    // silently skip TENANT_AGENTMAIL_* env injection on reprovisions of
    // instances that DO have persisted credentials but no resolvable User.
    {
      const am = await ensureInstanceHasAgentMail({
        prismaInstance: context.entities.Instance,
        instance,
        user: owner ?? { id: instance.userId },
      });
      if (am.status === "ok" || am.status === "reused") {
        agentmailEnv.TENANT_AGENTMAIL_INBOX_ID = am.inboxId!;
        agentmailEnv.TENANT_AGENTMAIL_INBOX_ADDRESS = am.inboxAddress!;
        agentmailEnv.TENANT_AGENTMAIL_API_KEY = am.apiKey!;
        logs.push(
          `AgentMail inbox ${am.status}: ${am.inboxAddress}`,
        );
        console.info(
          `[provision:${instance.customerName}] AgentMail inbox ${am.status}: ${am.inboxAddress}`,
        );
      } else if (am.status === "failed") {
        logs.push(
          `AgentMail provisioning failed (continuing without email channel): ${am.error}`,
        );
        console.warn(
          `[provision:${instance.customerName}] AgentMail mint failed: ${am.error}`,
        );
      }
      // status === "skipped" → AGENTMAIL_ENABLED=false, nothing to log
    }

    // Helper: destroy any partial state for `customerName`. Idempotent —
    // alfred-ctrl's destroy() handles already-gone Hetzner resources
    // gracefully (returns 404 → continues). Used between location/type
    // attempts when placement fails, and as the safety net after the
    // current type's last location fails before falling to next type.
    const cleanupPartial = async (reason: string): Promise<void> => {
      logs.push(`${reason} — cleaning up partial state...`);
      console.info(`[provision:${instance.customerName}] ${reason} — cleaning up`);
      try {
        const destroyChild = spawn(
          process.execPath,
          [
            "--experimental-sqlite",
            ALFRED_CTRL_PATH,
            "destroy",
            instance.customerName,
          ],
          {
            timeout: 60_000,
            env: { ...process.env, NODE_NO_WARNINGS: "1" },
            cwd: process.env.ALFRED_CTRL_CWD || "/opt/alfred-saas/alfred-ctrl",
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        destroyChild.stdin?.write("y\n");
        destroyChild.stdin?.end();
        await new Promise<void>((res) =>
          destroyChild.on("close", () => res()),
        );
      } catch (e: any) {
        console.error(
          `[provision:${instance.customerName}] Cleanup failed: ${e.message}`,
        );
      }
    };

    let usedServerType: string | null = null;

    typeLoop: for (let typeIdx = 0; typeIdx < TYPE_CHAIN.length; typeIdx++) {
      const tryType = TYPE_CHAIN[typeIdx];
      const isLastType = typeIdx === TYPE_CHAIN.length - 1;

      if (typeIdx > 0) {
        logs.push(`Falling back to server type: ${tryType}`);
        console.info(
          `[provision:${instance.customerName}] Falling back to server type: ${tryType}`,
        );
      }

      // Pre-check location availability for THIS server type. ccx43
      // (the dedicated-CPU fallback) is only supported in the 3 EU
      // DCs anyway, same as cx53, so the location list is uniform.
      const availableLocations: string[] = [];
      for (const loc of LOCATIONS) {
        try {
          const { stdout } = await execFileAsync(
            process.execPath,
            [
              "--experimental-sqlite",
              ALFRED_CTRL_PATH,
              "check-location",
              tryType,
              loc,
            ],
            {
              timeout: 10_000,
              env: { ...process.env, NODE_NO_WARNINGS: "1" },
              cwd: process.env.ALFRED_CTRL_CWD || "/opt/alfred-saas/alfred-ctrl",
            },
          );
          if (stdout.trim() === "available") {
            availableLocations.push(loc);
          } else {
            logs.push(`Location ${loc}: unavailable for ${tryType}`);
          }
        } catch {
          // If check fails, include the location (let provisioner handle it)
          availableLocations.push(loc);
        }
      }

      if (availableLocations.length === 0) {
        logs.push(`No locations available for ${tryType}`);
        if (!isLastType) continue typeLoop;
        // Last type with no available locations — fall through to throw below
        finalExitCode = 1;
        break typeLoop;
      }

      logs.push(`Available locations for ${tryType}: ${availableLocations.join(", ")}`);

      for (let locIdx = 0; locIdx < availableLocations.length; locIdx++) {
        const location = availableLocations[locIdx];
        const isLastLocationForType = locIdx === availableLocations.length - 1;

        logs.push(`Trying ${tryType} in ${location}`);
        console.info(
          `[provision:${instance.customerName}] Trying ${tryType} in ${location}`,
        );
        lastStderr = "";

        // Per-instance country drives Twilio number provisioning (#535).
        // When unset, the ctrl provisioner falls back to its own
        // TWILIO_DEFAULT_COUNTRY → "US" chain so the behaviour is identical
        // to before.
        const countryArgs = instance.country
          ? ["--country", instance.country]
          : [];

        // Use spawn instead of execFileAsync for streaming output
        finalExitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--experimental-sqlite",
              ALFRED_CTRL_PATH,
              "provision",
              instance.customerName,
              "--type",
              tryType,
              "--location",
              location,
              ...snapshotArgs,
              ...countryArgs,
            ],
            {
              timeout: 1_200_000, // 20 minutes
              env: {
                ...process.env,
                ...agentmailEnv,
                NODE_NO_WARNINGS: "1",
              },
              cwd:
                process.env.ALFRED_CTRL_CWD || "/opt/alfred-saas/alfred-ctrl",
              stdio: ["ignore", "pipe", "pipe"],
            },
          );

          let lineBuffer = "";

          const processLine = async (line: string) => {
            if (!line.trim()) return;
            logs.push(line);
            console.info(`[provision:${instance.customerName}] ${line}`);

            const step = detectStep(line);
            if (step && step !== currentStep) {
              currentStep = step;
              // Fire-and-forget DB update for live tracking
              context.entities.ProvisioningJob.update({
                where: { id: job.id },
                data: { currentStep: step, logs: [...logs] },
              }).catch((e: any) =>
                console.error("Failed to update step:", e.message),
              );
            }
          };

          child.stdout.on("data", (chunk: Buffer) => {
            lineBuffer += chunk.toString();
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() || "";
            for (const line of lines) {
              processLine(line);
            }
          });

          child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();
            if (text) {
              lastStderr += text;
              logs.push(`[stderr] ${text}`);
              console.error(`[provision:${instance.customerName}] ${text}`);
            }
          });

          child.on("error", (err) => reject(err));

          child.on("close", (code) => {
            // Flush remaining buffer
            if (lineBuffer.trim()) processLine(lineBuffer);
            resolve(code ?? 1);
          });
        });

        const placementFailed =
          finalExitCode !== 0 && lastStderr.includes("resource_unavailable");

        // Real (non-placement) errors abort the whole chain — those are bugs,
        // not capacity problems, and trying a different type/location won't help.
        if (finalExitCode !== 0 && !placementFailed) {
          break typeLoop;
        }

        // Placement failed but more locations OR more types remain to try.
        // Always destroy first so the next attempt starts clean (without this,
        // the customer_name would conflict).
        if (placementFailed) {
          const willTryAgain = !isLastLocationForType || !isLastType;
          if (willTryAgain) {
            await cleanupPartial(`${tryType}/${location} unavailable`);
            if (isLastLocationForType) break; // exit location loop, try next type
            continue; // try next location for this type
          }
          // Last location of last type also failed — give up
          break typeLoop;
        }

        // Success
        usedServerType = tryType;
        break typeLoop;
      } // end location loop
    } // end type loop

    if (finalExitCode !== 0) {
      throw new Error(
        `Provisioning exited with code ${finalExitCode}. Last log: ${logs[logs.length - 1] || "no output"}`,
      );
    }

    // If we used a fallback type, persist that on the Instance row so the
    // dashboard reflects what's actually running. Don't fail provisioning
    // on a Prisma update error — the VM is up and the user can use it.
    if (usedServerType && usedServerType !== instance.serverType) {
      logs.push(
        `Provisioned with fallback type: ${usedServerType} (requested ${instance.serverType})`,
      );
      console.info(
        `[provision:${instance.customerName}] Used fallback type ${usedServerType} instead of ${instance.serverType}`,
      );
      try {
        await context.entities.Instance.update({
          where: { id: instance.id },
          data: { serverType: usedServerType },
        });
      } catch (e: any) {
        console.error(
          `[provision:${instance.customerName}] Failed to update Instance.serverType to ${usedServerType}: ${e.message}`,
        );
      }
    }

    // Read instance data from alfred-ctrl SQLite to get API key and Tailscale hostname
    const instanceData = await getInstanceFromAlfredCtrl(
      instance.customerName,
    );

    // Update instance with provisioning results
    const updateData: any = {
      status: "running",
      provisionedAt: new Date(),
    };

    if (instanceData) {
      if (instanceData.tailscale_hostname) {
        updateData.tailscaleHostname = instanceData.tailscale_hostname;
      }
      if (instanceData.ip_address) {
        updateData.ipAddress = instanceData.ip_address;
      }
      if (instanceData.api_key) {
        updateData.apiKey = encryptApiKey(instanceData.api_key);
      }
      if (instanceData.subdomain) {
        const domain = process.env.CLOUDFLARE_DOMAIN || "alfred.black";
        updateData.subdomainUrl = `https://${instanceData.subdomain}.${domain}`;
      }
    }

    await context.entities.Instance.update({
      where: { id: instance.id },
      data: updateData,
    });

    // Mark job as completed
    await context.entities.ProvisioningJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        currentStep: "done",
        logs,
        completedAt: new Date(),
      },
    });

    // Auto-create system stream for OpenClaw session harvesting
    try {
      await prisma.stream.upsert({
        where: { userId_source: { userId: instance.userId, source: "openclaw-sessions" } },
        create: {
          userId: instance.userId,
          name: "OpenClaw Chats",
          type: "system",
          source: "openclaw-sessions",
          isSystem: true,
          enabled: true,
          config: {},
        },
        update: {},
      });
    } catch (e: any) {
      console.error("Failed to create system stream:", e.message);
    }

    // Auto-create Gmail stream if user signed up with Google and has OAuth credentials
    let gmailStreamId: string | null = null;
    try {
      const googleCred = await prisma.oAuthCredential.findUnique({
        where: {
          userId_provider: { userId: instance.userId, provider: "google" },
        },
      });
      if (googleCred) {
        const stream = await prisma.stream.upsert({
          where: { userId_source: { userId: instance.userId, source: "gmail" } },
          create: {
            userId: instance.userId,
            name: "Gmail",
            type: "scheduled",
            source: "gmail",
            enabled: true,
            config: {},
          },
          update: {},
        });
        gmailStreamId = stream.id;
        console.info(`Auto-created Gmail stream for ${instance.customerName}`);

        // Push the stream config to the tenant's ctrl API
        const tenantApiKey = decryptApiKey(updateData.apiKey ?? instance.apiKey ?? "");
        const tenantUrl = `https://${updateData.tailscaleHostname}:3100`;
        try {
          await fetch(`${tenantUrl}/api/v1/streams`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tenantApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              id: stream.id,
              name: "Gmail",
              type: "scheduled",
              source: "gmail",
              enabled: true,
            }),
          });
          console.info(`Pushed Gmail stream to tenant ${instance.customerName}`);
        } catch (e: any) {
          console.error("Failed to push Gmail stream to tenant:", e.message);
        }
      }
    } catch (e: any) {
      console.error("Failed to auto-create Gmail stream:", e.message);
    }

    // Trigger onboarding if Gmail stream was created
    if (gmailStreamId) {
      try {
        const tenantApiKey = decryptApiKey(updateData.apiKey ?? instance.apiKey ?? "");
        const tenantUrl = `https://${updateData.tailscaleHostname}:3100`;
        await fetch(`${tenantUrl}/api/v1/workflows/onboarding/start`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tenantApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            user_id: instance.userId,
            stream_id: gmailStreamId,
          }),
        });
        console.info(`Triggered onboarding for ${instance.customerName}`);
      } catch (e: any) {
        console.error("Failed to trigger onboarding:", e.message);
      }
    }

    console.info(`Provisioning completed for ${instance.customerName}`);
    activeProvisionPids.delete(job.id);
  } catch (error: any) {
    console.error(
      `Provisioning failed for ${instance.customerName}:`,
      error,
    );

    await context.entities.Instance.update({
      where: { id: instance.id },
      data: { status: "error" },
    });

    await context.entities.ProvisioningJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        error: error.message || "Unknown error",
        currentStep,
        logs,
        completedAt: new Date(),
      },
    });
    activeProvisionPids.delete(job.id);
  }
}

async function getInstanceFromAlfredCtrl(
  customerName: string,
): Promise<any | null> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-sqlite", ALFRED_CTRL_PATH, "list", "--json"],
      {
        timeout: 10_000,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        cwd: process.env.ALFRED_CTRL_CWD || "/opt/alfred-saas/alfred-ctrl",
      },
    );

    // Parse the JSON output and find the instance
    const instances = JSON.parse(stdout);
    return (
      instances.find(
        (i: any) => i.customer_name === customerName,
      ) || null
    );
  } catch (error) {
    console.error("Failed to read instance from alfred-ctrl:", error);
    return null;
  }
}
