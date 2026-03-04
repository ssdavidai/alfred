import * as ssh from "../infra/ssh.js";
import {
  listInstances,
  updateInstance,
  insertHealthCheck,
  insertEvent,
} from "../db/queries.js";
import { DEFAULTS } from "../data/constants.js";
import { sendAlert } from "./alerts.js";
import type { HealthStatus, ContainerStatus } from "../data/types.js";

interface HealthResponse {
  containers: ContainerStatus[];
  disk_percent: number;
  memory_percent: number;
  cloudflared_status?: string;
}

function classifyHealth(response: HealthResponse): HealthStatus {
  if (!response.containers || response.containers.length === 0) return "down";

  const allOk = response.containers.every(
    (c) =>
      c.State === "running" ||
      c.State === "healthy" ||
      (c.State === "exited" && c.ExitCode === 0) // one-shot containers (e.g. init)
  );
  if (!allOk) return "degraded";

  if (response.disk_percent > 90 || response.memory_percent > 95) {
    return "degraded";
  }

  // Check Cloudflare Tunnel health
  if (response.cloudflared_status && response.cloudflared_status !== "active") {
    return "degraded";
  }

  return "ok";
}

async function checkInstance(
  instanceId: number,
  ip: string,
  keyPath: string,
  hostKey?: string | null,
): Promise<HealthStatus> {
  try {
    const result = await ssh.exec(
      ip,
      keyPath,
      `${DEFAULTS.alfredBasePath}/healthcheck.sh`,
      undefined,
      hostKey ? { knownHostKey: hostKey } : undefined,
    );

    if (result.code !== 0) {
      return "down";
    }

    const response = JSON.parse(result.stdout.trim()) as HealthResponse;
    const status = classifyHealth(response);

    insertHealthCheck(
      instanceId,
      status,
      response.disk_percent,
      response.memory_percent,
      result.stdout.trim()
    );

    return status;
  } catch {
    return "unreachable";
  }
}

export type HealthListener = (
  instanceId: number,
  status: HealthStatus
) => void;

let intervalId: ReturnType<typeof setInterval> | null = null;
const listeners: HealthListener[] = [];

export function onHealthUpdate(listener: HealthListener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export async function runHealthChecks(): Promise<void> {
  const instances = listInstances("running");

  for (const instance of instances) {
    if (!instance.ip_address || !instance.ssh_key_path) continue;

    const newStatus = await checkInstance(
      instance.id,
      instance.ip_address,
      instance.ssh_key_path,
      (instance as any).ssh_host_key,
    );

    const previousStatus = instance.last_health_status;
    updateInstance(instance.id, {
      last_health_check: new Date().toISOString(),
      last_health_status: newStatus,
    });

    // Track healthy SHA for rollback
    if (newStatus === "ok" && instance.current_image_sha) {
      updateInstance(instance.id, {
        last_healthy_sha: instance.current_image_sha,
      });
    }

    // Log status changes
    if (previousStatus && previousStatus !== newStatus) {
      const eventType =
        newStatus === "ok"
          ? "health_ok"
          : newStatus === "degraded"
            ? "health_degraded"
            : newStatus === "down"
              ? "health_down"
              : "health_unreachable";

      insertEvent(
        instance.id,
        eventType,
        `Health changed: ${previousStatus} → ${newStatus}`
      );

      sendAlert(
        instance.customer_name,
        previousStatus,
        newStatus,
        instance.ip_address
      );
    }

    for (const listener of listeners) {
      listener(instance.id, newStatus);
    }
  }
}

export function startHealthMonitor(
  intervalMs = DEFAULTS.healthInterval
): void {
  if (intervalId) return;
  intervalId = setInterval(() => {
    runHealthChecks().catch((err) => {
      console.error("Health check error:", err);
    });
  }, intervalMs);

  // Run immediately on start
  runHealthChecks().catch((err) => {
    console.error("Initial health check error:", err);
  });
}

export function stopHealthMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
