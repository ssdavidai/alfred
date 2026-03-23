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

    // Use spawn instead of execFileAsync for streaming output
    const exitCode = await new Promise<number>((resolve, reject) => {
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
          "fsn1",
        ],
        {
          timeout: 1_200_000, // 20 minutes
          env: {
            ...process.env,
            NODE_NO_WARNINGS: "1",
          },
          cwd: process.env.ALFRED_CTRL_CWD || "/opt/alfred-saas/alfred-ctrl",
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

    if (exitCode !== 0) {
      throw new Error(
        `Provisioning exited with code ${exitCode}. Last log: ${logs[logs.length - 1] || "no output"}`,
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
