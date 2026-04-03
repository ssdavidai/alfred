import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { encryptApiKey } from "../server/tenantProxy";
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

    // Pre-check location availability to avoid wasting resources.
    // Calls the ctrl CLI's check-location command which queries Hetzner API
    // without creating any resources.
    const availableLocations: string[] = [];
    for (const loc of LOCATIONS) {
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            "--experimental-sqlite",
            ALFRED_CTRL_PATH,
            "check-location",
            instance.serverType,
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
          logs.push(`Location ${loc}: unavailable for ${instance.serverType} (skipped)`);
          console.info(`[provision:${instance.customerName}] Skipping ${loc} — unavailable`);
        }
      } catch {
        // If check fails, include the location (let provisioner handle the error)
        availableLocations.push(loc);
      }
    }

    if (availableLocations.length === 0) {
      throw new Error(`No Hetzner locations available for server type ${instance.serverType}`);
    }

    logs.push(`Available locations: ${availableLocations.join(", ")}`);

    for (const location of availableLocations) {
      logs.push(`Trying location: ${location}`);
      console.info(
        `[provision:${instance.customerName}] Trying location: ${location}`,
      );
      lastStderr = "";

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
            instance.serverType,
            "--location",
            location,
            ...snapshotArgs,
          ],
          {
            timeout: 1_200_000, // 20 minutes
            env: {
              ...process.env,
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

      // If placement failed, destroy partial resources and try next location
      if (
        finalExitCode !== 0 &&
        lastStderr.includes("resource_unavailable") &&
        location !== LOCATIONS[LOCATIONS.length - 1]
      ) {
        logs.push(
          `Location ${location} unavailable, cleaning up and trying next...`,
        );
        console.info(
          `[provision:${instance.customerName}] ${location} unavailable, trying next location`,
        );
        try {
          // Pipe "y" to confirm destroy prompt
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
              cwd:
                process.env.ALFRED_CTRL_CWD || "/opt/alfred-saas/alfred-ctrl",
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
        continue; // try next location
      }

      break; // success or non-placement error — stop retrying
    } // end LOCATIONS loop

    if (finalExitCode !== 0) {
      throw new Error(
        `Provisioning exited with code ${finalExitCode}. Last log: ${logs[logs.length - 1] || "no output"}`,
      );
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
    try {
      const googleCred = await prisma.oAuthCredential.findUnique({
        where: {
          userId_provider: { userId: instance.userId, provider: "google" },
        },
      });
      if (googleCred) {
        await prisma.stream.upsert({
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
        console.info(`Auto-created Gmail stream for ${instance.customerName}`);
      }
    } catch (e: any) {
      console.error("Failed to auto-create Gmail stream:", e.message);
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
