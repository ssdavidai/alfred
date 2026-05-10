import { decryptApiKey } from "../server/tenantProxy";

export async function healthMonitorJob(
  _args: unknown,
  context: any,
): Promise<void> {
  if (process.env.WASP_DISABLE_JOBS === 'true') {
    console.log('[WASP_DISABLE_JOBS] skipping healthMonitorJob');
    return;
  }
  const instances = await context.entities.Instance.findMany({
    where: { status: "running" },
  });

  for (const instance of instances) {
    if (!instance.tailscaleHostname || !instance.apiKey) continue;

    try {
      const apiKey = decryptApiKey(instance.apiKey);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(
        `https://${instance.tailscaleHostname}:3100/api/v1/admin/health`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        },
      );

      clearTimeout(timeout);

      let status = "unreachable";
      if (response.ok) {
        const data = await response.json();
        status = data.status || "ok";
      } else {
        status = "down";
      }

      await context.entities.Instance.update({
        where: { id: instance.id },
        data: {
          lastHealthCheck: new Date(),
          lastHealthStatus: status,
        },
      });
    } catch (error: any) {
      const status = error.name === "AbortError" ? "unreachable" : "down";
      await context.entities.Instance.update({
        where: { id: instance.id },
        data: {
          lastHealthCheck: new Date(),
          lastHealthStatus: status,
        },
      });
    }
  }
}
