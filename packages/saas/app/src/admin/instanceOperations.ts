import crypto from "crypto";
import { HttpError } from "wasp/server";
import { provisionInstance, destroyInstance } from "wasp/server/jobs";
import { tierToServerType } from "../payment/plans";
import { proxyToTenant } from "../server/tenantProxy";

function requireAdmin(context: any) {
  if (!context.user?.isAdmin) {
    throw new HttpError(403, "Admin access required");
  }
}

async function getInstanceById(context: any, instanceId: string) {
  const instance = await context.entities.Instance.findUnique({
    where: { id: instanceId },
    include: {
      user: { select: { id: true, email: true, subscriptionStatus: true, subscriptionPlan: true } },
    },
  });
  if (!instance) throw new HttpError(404, "Instance not found");
  return instance;
}

// ============================================================
// Queries
// ============================================================

export const getAdminInstanceDetail = async (
  args: { instanceId: string },
  context: any,
) => {
  requireAdmin(context);
  const instance = await getInstanceById(context, args.instanceId);

  // Also fetch latest provisioning job
  const provisioningJob = await context.entities.ProvisioningJob.findFirst({
    where: { instanceId: instance.id },
    orderBy: { createdAt: "desc" },
  });

  // Fetch gateway token from tenant's openclaw config (best-effort)
  let gatewayToken: string | null = null;
  if (instance.status === "running" && instance.tailscaleHostname && instance.apiKey) {
    try {
      const cfg = await proxyToTenant(instance, { path: "/api/v1/admin/config/openclaw" });
      gatewayToken = cfg?.gateway?.auth?.token ?? null;
    } catch {
      // Non-critical — instance may not be reachable yet
    }
  }

  return { ...instance, provisioningJob, gatewayToken };
};

export const getAdminInstanceHealth = async (
  args: { instanceId: string },
  context: any,
) => {
  requireAdmin(context);
  const instance = await getInstanceById(context, args.instanceId);

  if (instance.status !== "running" || !instance.tailscaleHostname || !instance.apiKey) {
    return { status: instance.status, containers: null, health: null };
  }

  try {
    const [containers, health] = await Promise.all([
      proxyToTenant(instance, { path: "/api/v1/admin/containers" }),
      proxyToTenant(instance, { path: "/api/v1/admin/health" }),
    ]);
    return { status: instance.status, containers, health };
  } catch (error: any) {
    return { status: instance.status, containers: null, health: null, error: error.message };
  }
};

export const getAdminInstanceDevices = async (
  args: { instanceId: string },
  context: any,
) => {
  requireAdmin(context);
  const instance = await getInstanceById(context, args.instanceId);

  if (instance.status !== "running" || !instance.tailscaleHostname || !instance.apiKey) {
    return { pending: [], paired: [] };
  }

  try {
    return await proxyToTenant(instance, { path: "/api/v1/devices" });
  } catch {
    return { pending: [], paired: [] };
  }
};

export const getAdminProvisioningJobs = async (
  _args: void,
  context: any,
) => {
  requireAdmin(context);
  return context.entities.ProvisioningJob.findMany({
    include: {
      user: { select: { id: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
};

// ============================================================
// Actions
// ============================================================

export const adminDestroyInstance = async (
  args: { instanceId: string },
  context: any,
) => {
  requireAdmin(context);
  const instance = await getInstanceById(context, args.instanceId);

  if (instance.status === "destroyed" || instance.status === "destroying") {
    throw new HttpError(400, `Instance is already ${instance.status}`);
  }

  await context.entities.Instance.update({
    where: { id: instance.id },
    data: { status: "destroying" },
  });

  // Trigger the destroy job
  await destroyInstance.submit({});

  return { success: true, message: `Instance ${instance.customerName} marked for destruction` };
};

export const adminProvisionInstance = async (
  args: { instanceId: string },
  context: any,
) => {
  requireAdmin(context);
  const instance = await getInstanceById(context, args.instanceId);

  const allowedStatuses = ["error", "provisioning", "destroyed"];
  if (!allowedStatuses.includes(instance.status)) {
    throw new HttpError(400, `Cannot provision instance in ${instance.status} state`);
  }

  // For destroyed instances, clean up and generate a fresh customerName
  if (instance.status === "destroyed") {
    await context.entities.ProvisioningJob.deleteMany({
      where: { userId: instance.userId },
    });

    const slug = (instance.user?.email || "user")
      .split("@")[0]
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .toLowerCase()
      .slice(0, 20);
    const customerName = `alfred-${slug}-${Date.now().toString(36)}`;

    await context.entities.Instance.update({
      where: { id: instance.id },
      data: {
        status: "provisioning",
        customerName,
        ipAddress: null,
        tailscaleHostname: null,
        apiKey: null,
        subdomainUrl: null,
        provisionedAt: null,
        suspendedAt: null,
      },
    });

    await context.entities.ProvisioningJob.create({
      data: {
        userId: instance.userId,
        instanceId: instance.id,
        status: "pending",
      },
    });

    await provisionInstance.submit({});

    return { success: true, message: `Re-provisioning triggered as ${customerName}` };
  }

  // Reset instance status
  await context.entities.Instance.update({
    where: { id: instance.id },
    data: { status: "provisioning" },
  });

  // Create a new provisioning job
  await context.entities.ProvisioningJob.create({
    data: {
      userId: instance.userId,
      instanceId: instance.id,
      status: "pending",
    },
  });

  await provisionInstance.submit({});

  return { success: true, message: `Re-provisioning triggered for ${instance.customerName}` };
};

export const adminTriggerWorker = async (
  args: { instanceId: string; action: string; service?: string },
  context: any,
) => {
  requireAdmin(context);
  const instance = await getInstanceById(context, args.instanceId);

  if (instance.status !== "running") {
    throw new HttpError(400, "Instance must be running");
  }

  const service = args.service || "alfred";
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/admin/containers/${service}/${args.action}`,
  });
};

export const adminApproveDevice = async (
  args: { instanceId: string; requestId: string; name?: string },
  context: any,
) => {
  requireAdmin(context);
  const instance = await getInstanceById(context, args.instanceId);

  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/devices/${args.requestId}/approve`,
    body: args.name ? { name: args.name } : undefined,
  });
};

export const adminRejectDevice = async (
  args: { instanceId: string; requestId: string },
  context: any,
) => {
  requireAdmin(context);
  const instance = await getInstanceById(context, args.instanceId);

  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/devices/${args.requestId}/reject`,
  });
};

export const adminCreateInstance = async (
  args: { userId: string; tier: string },
  context: any,
) => {
  requireAdmin(context);

  const user = await context.entities.User.findUnique({
    where: { id: args.userId },
    include: { instance: true },
  });

  if (!user) throw new HttpError(404, "User not found");
  if (user.instance) throw new HttpError(400, "User already has an instance");

  // Validate tier
  const tier = args.tier.toLowerCase();
  const serverType = tierToServerType[tier];
  if (!serverType) throw new HttpError(400, `Invalid tier: ${args.tier}`);

  // Generate customer name: alfred-<email-slug>-<random8>
  const slug = (user.email || "user")
    .split("@")[0]
    .replace(/[^a-z0-9]/gi, "-")
    .toLowerCase()
    .slice(0, 20);
  const rand = crypto.randomBytes(4).toString("hex");
  const customerName = `alfred-${slug}-${rand}`;

  const instance = await context.entities.Instance.create({
    data: {
      userId: user.id,
      customerName,
      tier: tier.toUpperCase(),
      serverType,
      status: "provisioning",
    },
  });

  await context.entities.ProvisioningJob.create({
    data: {
      userId: user.id,
      instanceId: instance.id,
      status: "pending",
    },
  });

  await provisionInstance.submit({});

  return { success: true, message: `Provisioning started for ${customerName}`, instanceId: instance.id };
};

/**
 * Push a deep-merge config patch to all running instances.
 * Used for fleet-wide config migrations (e.g. enabling QMD memory backend).
 * Returns per-instance results so the caller can see what succeeded/failed.
 */
export const adminPatchAllInstanceConfigs = async (
  args: { patch: Record<string, unknown> },
  context: any,
) => {
  requireAdmin(context);

  const instances = await context.entities.Instance.findMany({
    where: { status: "running" },
    include: { user: { select: { email: true } } },
  });

  const results: Array<{ instanceId: string; customerName: string; status: "ok" | "error"; error?: string }> = [];

  for (const instance of instances) {
    if (!instance.tailscaleHostname || !instance.apiKey) {
      results.push({ instanceId: instance.id, customerName: instance.customerName, status: "error", error: "no tailscale hostname or api key" });
      continue;
    }
    try {
      await proxyToTenant(instance, {
        method: "PATCH",
        path: "/api/v1/admin/config/openclaw",
        body: args.patch,
      });
      // Restart OpenClaw to apply the new config
      await proxyToTenant(instance, {
        method: "POST",
        path: "/api/v1/admin/containers/openclaw/restart",
      });
      results.push({ instanceId: instance.id, customerName: instance.customerName, status: "ok" });
    } catch (e: any) {
      results.push({ instanceId: instance.id, customerName: instance.customerName, status: "error", error: e.message });
    }
  }

  return { results, total: instances.length, ok: results.filter(r => r.status === "ok").length };
};
