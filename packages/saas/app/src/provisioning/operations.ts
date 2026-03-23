import { HttpError } from "wasp/server";
import type {
  GetProvisioningStatus,
  ReprovisionInstance,
} from "wasp/server/operations";
import { provisionInstance } from "wasp/server/jobs";
import { tierToServerType, SubscriptionStatus } from "../payment/plans";

export const getProvisioningStatus: GetProvisioningStatus<
  void,
  Record<string, any>
> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401, "Not authenticated");
  }

  const instance = await context.entities.Instance.findUnique({
    where: { userId: context.user.id },
  });

  const job = await context.entities.ProvisioningJob.findFirst({
    where: { userId: context.user.id },
    orderBy: { createdAt: "desc" },
  });

  // Reconcile: if the instance is gone but the job still says "running",
  // the provisioner was interrupted (e.g. container restart). Report as failed
  // so the UI doesn't show a forever-spinning progress bar.
  let jobStatus = job?.status ?? null;
  let jobError = job?.error ?? null;
  if (
    job &&
    job.status === "running" &&
    (!instance || instance.status === "destroyed" || instance.status === "error")
  ) {
    jobStatus = "failed";
    jobError = job.error || "Provisioning was interrupted — please retry";
  }

  return {
    instance: instance
      ? {
          id: instance.id,
          status: instance.status,
          customerName: instance.customerName,
          tier: instance.tier,
        }
      : null,
    job: job
      ? {
          id: job.id,
          status: jobStatus,
          currentStep: job.currentStep,
          logs: job.logs,
          error: jobError,
          startedAt: job.startedAt?.toISOString() ?? null,
          completedAt: job.completedAt?.toISOString() ?? null,
        }
      : null,
  };
};

export const reprovisionInstance: ReprovisionInstance<
  void,
  void
> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401, "Not authenticated");
  }

  const user = context.user;

  // Must have active subscription
  if (
    !user.subscriptionStatus ||
    user.subscriptionStatus === SubscriptionStatus.Deleted
  ) {
    throw new HttpError(403, "No active subscription");
  }

  // Must have a destroyed or errored instance
  const instance = await context.entities.Instance.findUnique({
    where: { userId: user.id },
  });

  if (
    !instance ||
    !["destroyed", "error", "provisioning"].includes(instance.status)
  ) {
    throw new HttpError(400, "No failed instance to reprovision");
  }

  // If instance is "provisioning", only allow reprovision if the job is
  // actually dead (failed/completed, or "running" with no active process —
  // the worker's orphan recovery will have marked it failed by now).
  if (instance.status === "provisioning") {
    const activeJob = await context.entities.ProvisioningJob.findFirst({
      where: { instanceId: instance.id, status: "running" },
    });
    if (activeJob) {
      throw new HttpError(409, "Provisioning is still in progress");
    }
  }

  // Clean up old jobs and destroyed instance
  await context.entities.ProvisioningJob.deleteMany({
    where: { userId: user.id },
  });
  await context.entities.Instance.delete({
    where: { id: instance.id },
  });

  // For re-provisioning, use the instance's existing tier and server type.
  // Grandfathered instances (STARTER/PRO) keep their original server type;
  // new instances (PREMIUM/BLACK) get cx53 via tierToServerType.
  const tierKey = instance.tier.toLowerCase();
  const serverType = tierToServerType[tierKey] ?? "cx53";

  // Generate new customer name
  const slug = (user.email || user.id)
    .split("@")[0]
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 20);
  const customerName = `alfred-${slug}-${Date.now().toString(36)}`;

  // Create fresh instance + job
  const newInstance = await context.entities.Instance.create({
    data: {
      userId: user.id,
      customerName,
      tier: instance.tier,
      serverType,
      status: "provisioning",
    },
  });

  await context.entities.ProvisioningJob.create({
    data: {
      userId: user.id,
      instanceId: newInstance.id,
      status: "pending",
    },
  });

  console.info(
    `Re-provisioning user ${user.id}: destroyed instance ${instance.id} → new instance ${newInstance.id}`,
  );

  await provisionInstance.submit({});
};
