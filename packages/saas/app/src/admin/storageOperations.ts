// STORE-X-3: SaaS-side operations backing the /admin/storage dashboard.
//
// We proxy each tenant's /api/v1/admin/storage-metrics through Wasp so the
// dashboard renders one card per running tenant. The route handler caches
// per-tenant for 30 s in this process to avoid hammering ctrl-api during
// rapid React refetches.

import { HttpError } from "wasp/server";
import { proxyToTenant } from "../server/tenantProxy";

function requireAdmin(context: any) {
  if (!context.user?.isAdmin) {
    throw new HttpError(403, "Admin access required");
  }
}

interface CachedMetrics {
  value: any;
  expiresAt: number;
}

const TTL_MS = 30_000;
const cache = new Map<string, CachedMetrics>();

function readCached(instanceId: string): any | null {
  const hit = cache.get(instanceId);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(instanceId);
    return null;
  }
  return hit.value;
}

function writeCached(instanceId: string, value: any): void {
  cache.set(instanceId, { value, expiresAt: Date.now() + TTL_MS });
}

/**
 * Fetch storage metrics for a single tenant.
 * Returns the raw payload from ctrl-api, or a structured error object so
 * the dashboard can render an "unreachable" card without bringing the
 * whole grid down.
 */
async function fetchMetricsForInstance(instance: any): Promise<any> {
  const cached = readCached(instance.id);
  if (cached) return cached;

  if (instance.status !== "running" || !instance.tailscaleHostname || !instance.apiKey) {
    const payload = {
      tenantId: instance.id,
      tenantName: instance.customerName,
      tenantEmail: instance.user?.email ?? null,
      reachable: false,
      reason: `instance status: ${instance.status}`,
      metrics: null,
    };
    writeCached(instance.id, payload);
    return payload;
  }

  try {
    const metrics = await proxyToTenant(instance, {
      path: "/api/v1/admin/storage-metrics",
    });
    const payload = {
      tenantId: instance.id,
      tenantName: instance.customerName,
      tenantEmail: instance.user?.email ?? null,
      reachable: true,
      reason: null,
      metrics,
    };
    writeCached(instance.id, payload);
    return payload;
  } catch (err: any) {
    const payload = {
      tenantId: instance.id,
      tenantName: instance.customerName,
      tenantEmail: instance.user?.email ?? null,
      reachable: false,
      reason: err?.message || "unknown error",
      metrics: null,
    };
    // Cache failures briefly too so a flapping tenant doesn't pin us in a
    // retry loop while the dashboard polls.
    writeCached(instance.id, payload);
    return payload;
  }
}

/**
 * Get storage metrics across every instance the admin can see.
 * The dashboard renders one card per entry — failures are surfaced inline.
 */
export const getStorageMetrics = async (
  _args: void,
  context: any,
) => {
  requireAdmin(context);

  const instances = await context.entities.Instance.findMany({
    where: { status: { not: "destroyed" } },
    include: {
      user: { select: { id: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Fan out — proxyToTenant is independent per tenant, and the cache
  // prevents re-walking the vault. Promise.all is fine; failures are
  // converted to non-throwing payloads above.
  const results = await Promise.all(
    instances.map((instance: any) => fetchMetricsForInstance(instance)),
  );

  return { tenants: results, collected_at: new Date().toISOString() };
};
