import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const ALFRED_CTRL_PATH =
  process.env.ALFRED_CTRL_PATH || "/opt/alfred-saas/alfred-ctrl/dist/index.mjs";

const SUSPENDED_GRACE_DAYS = 30;

export async function destroyInstanceJob(
  _args: unknown,
  context: any,
): Promise<void> {
  const destroyable = await context.entities.Instance.findMany({
    where: { status: "destroying" },
  });

  for (const instance of destroyable) {
    try {
      console.info(`Destroying instance ${instance.customerName}`);

      await execFileAsync(
        process.execPath,
        ["--experimental-sqlite", ALFRED_CTRL_PATH, "destroy", instance.customerName, "--yes"],
        {
          timeout: 120_000,
          env: { ...process.env, NODE_NO_WARNINGS: "1" },
          cwd: process.env.ALFRED_CTRL_CWD || "/opt/alfred-saas/alfred-ctrl",
        },
      );

      await context.entities.Instance.update({
        where: { id: instance.id },
        data: { status: "destroyed" },
      });

      console.info(`Destroyed instance ${instance.customerName}`);
    } catch (error: any) {
      console.error(
        `Failed to destroy ${instance.customerName}:`,
        error.message,
      );
      // Reset status so the admin can retry — don't leave it stuck at "destroying"
      try {
        await context.entities.Instance.update({
          where: { id: instance.id },
          data: { status: "error" },
        });
      } catch (_) { /* best effort */ }
    }
  }
}

export async function syncSubscriptionsJob(
  _args: unknown,
  context: any,
): Promise<void> {
  // Find users with canceled subscriptions whose instances are still running
  const usersToSuspend = await context.entities.User.findMany({
    where: {
      subscriptionStatus: "deleted",
      instance: {
        status: "running",
      },
    },
    include: { instance: true },
  });

  for (const user of usersToSuspend) {
    if (!user.instance) continue;

    console.info(
      `Suspending instance ${user.instance.customerName} due to canceled subscription`,
    );

    await context.entities.Instance.update({
      where: { id: user.instance.id },
      data: {
        status: "suspended",
        suspendedAt: new Date(),
      },
    });

    // Stop containers on the instance via SSH/alfred-ctrl
    try {
      await execFileAsync(
        process.execPath,
        ["--experimental-sqlite", ALFRED_CTRL_PATH, "ssh", user.instance.customerName, "--", "docker", "compose", "-f", "/opt/alfred/compose/docker-compose.yaml", "stop"],
        {
          timeout: 60_000,
          env: { ...process.env, NODE_NO_WARNINGS: "1" },
          cwd: process.env.ALFRED_CTRL_CWD || "/opt/alfred-saas/alfred-ctrl",
        },
      );
    } catch (error: any) {
      console.error(
        `Failed to stop containers for ${user.instance.customerName}:`,
        error.message,
      );
    }
  }
}

export async function suspendedCleanupJob(
  _args: unknown,
  context: any,
): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SUSPENDED_GRACE_DAYS);

  const expiredInstances = await context.entities.Instance.findMany({
    where: {
      status: "suspended",
      suspendedAt: { lt: cutoff },
    },
  });

  for (const instance of expiredInstances) {
    console.info(
      `Instance ${instance.customerName} suspended > ${SUSPENDED_GRACE_DAYS} days, marking for destruction`,
    );

    await context.entities.Instance.update({
      where: { id: instance.id },
      data: { status: "destroying" },
    });
  }
}
