import { HttpError, prisma } from "wasp/server";
import type {
  GetDashboardData,
  GetInboxItems,
  GetVaultRecords,
  GetVaultRecord,
  GetVaultGraph,
  GetNebulaData,
  GetWorkerStatus,
  GetDevices,
  GetContainerLogs,
  GetActivityFeed,
  GetCredentials,
  GetAgentConfig,
  GetModelCatalog,
  GetWorkspaceFile,
  GetFirstBrief,
  GetOnboardingProgress,
} from "wasp/server/operations";
import type {
  SubmitInboxItem,
  TriggerWorker,
  ApproveDevice,
  RejectDevice,
  RemoveDevice,
  UpdateCredentials,
  UpdateAgentConfig,
  UpdateAgentModel,
  UpdateWorkspaceFile,
  StartOnboarding,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";

// ============================================================
// Dashboard Home
// ============================================================

/** Derive an overall status from the healthcheck response. */
function deriveHealthStatus(
  health: any,
): "ok" | "degraded" | "down" | "unknown" {
  if (!health || !Array.isArray(health.containers)) return "unknown";
  const containers: any[] = health.containers;
  if (containers.length === 0) return "down";
  const running = containers.filter(
    (c: any) => c.State === "running" || (c.State === "exited" && c.ExitCode === 0),
  );
  if (running.length === containers.length) return "ok";
  if (running.length > 0) return "degraded";
  return "down";
}

/** Transform raw vault context into the shape the dashboard expects. */
function transformVaultContext(raw: any): {
  total_records: number;
  types: Record<string, number>;
} | null {
  if (!raw || raw.error || raw.raw) return null;
  const byType: Record<string, any[]> = raw.records_by_type || {};
  const types: Record<string, number> = {};
  for (const [type, records] of Object.entries(byType)) {
    types[type] = Array.isArray(records) ? records.length : 0;
  }
  return {
    total_records: raw.total ?? 0,
    types,
  };
}

export const getDashboardData: GetDashboardData<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);

  // Single aggregated endpoint — one tunnel round-trip instead of six
  const raw = await proxyToTenant(instance, { path: "/api/v1/admin/dashboard" });

  const healthRaw = raw?.health ?? null;
  const vaultRaw = raw?.vault ?? null;
  const inboxRaw = raw?.inbox ?? null;
  const devicesRaw = raw?.devices ?? null;
  const containersRaw = raw?.containers ?? null;
  const openclawCfgRaw = raw?.openclawCfg ?? null;

  // Build health object with derived status
  const health = healthRaw
    ? {
        status: deriveHealthStatus(healthRaw),
        containers: Array.isArray(healthRaw.containers)
          ? healthRaw.containers.filter((c: any) => c.State === "running")
          : [],
        disk_percent: healthRaw.disk_percent,
        memory_percent: healthRaw.memory_percent,
      }
    : null;

  // Inbox file count (exclude "processed" directory)
  const inboxFiles = Array.isArray(inboxRaw?.files)
    ? inboxRaw.files.filter((f: string) => f !== "processed")
    : [];

  // Device counts
  const paired = Array.isArray(devicesRaw?.paired) ? devicesRaw.paired.length : 0;
  const pending = Array.isArray(devicesRaw?.pending) ? devicesRaw.pending.length : 0;

  // Full container list
  const containers = containersRaw
    ? Array.isArray(containersRaw?.containers)
      ? containersRaw.containers
      : Array.isArray(containersRaw)
        ? containersRaw
        : []
    : null;

  // Gateway token for OpenClaw UI link
  const gatewayToken: string | null =
    openclawCfgRaw?.gateway?.auth?.token ?? null;

  return {
    health,
    vault: transformVaultContext(vaultRaw),
    instance: {
      status: instance!.status,
      tier: instance!.tier,
      tailscaleHostname: instance!.tailscaleHostname ?? null,
      subdomainUrl: (instance as any).subdomainUrl ?? null,
    },
    inbox: inboxRaw ? { count: inboxFiles.length } : null,
    devices: devicesRaw ? { paired, pending } : null,
    containers,
    gatewayToken,
  };
};

// ============================================================
// Inbox
// ============================================================
export const getInboxItems: GetInboxItems<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/vault/inbox" });
};

export const submitInboxItem: SubmitInboxItem<
  { title: string; content: string; type?: string; filename?: string; encoding?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);

  // Raw file upload mode — preserve original filename and content as-is
  if (args.filename) {
    return proxyToTenant(instance, {
      method: "POST",
      path: "/api/v1/vault/inbox",
      body: {
        filename: args.filename,
        content: args.content,
        ...(args.encoding ? { encoding: args.encoding } : {}),
      },
      timeoutMs: 60_000,
    });
  }

  // Text note mode — wrap in markdown
  const filename = args.title.replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, "-") + ".md";
  const body = args.content
    ? `# ${args.title}\n\n${args.content}`
    : `# ${args.title}`;
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/vault/inbox",
    body: {
      filename,
      content: body,
    },
  });
};

// ============================================================
// Vault Browser
// ============================================================
export const getVaultRecords: GetVaultRecords<
  { type?: string; query?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);

  if (args.query) {
    return proxyToTenant(instance, {
      path: "/api/v1/vault/search",
      query: { grep: args.query },
    });
  }

  if (args.type) {
    // Inbox is a special folder backed by /api/v1/vault/inbox instead of /list
    if (args.type === "inbox") {
      const inboxData: any = await proxyToTenant(instance, {
        path: "/api/v1/vault/inbox",
      });
      const files: string[] = Array.isArray(inboxData?.files)
        ? inboxData.files.filter((f: string) => f !== "processed")
        : [];
      return {
        results: files.map((f: string) => ({
          name: f.replace(/\.md$/, "").replace(/[-_]/g, " "),
          path: `inbox/${f}`,
          type: "inbox",
        })),
        count: files.length,
      };
    }

    const data: any = await proxyToTenant(instance, {
      path: `/api/v1/vault/list/${args.type}`,
    });
    // vault list results don't include 'type' — inject it from the request
    if (data && Array.isArray(data.results)) {
      data.results = data.results.map((r: any) => ({ ...r, type: args.type }));
    }
    return data;
  }

  return proxyToTenant(instance, { path: "/api/v1/vault/context" });
};

export const getVaultRecord: GetVaultRecord<{ path: string }, any> = async (
  args,
  context,
) => {
  // Validate path to prevent directory traversal
  if (!args.path) {
    throw new HttpError(400, "Record path is required");
  }
  const normalized = args.path.replace(/\\/g, "/");
  if (
    normalized.includes("..") ||
    normalized.startsWith("/") ||
    normalized.includes("\0")
  ) {
    throw new HttpError(400, "Invalid record path");
  }

  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: `/api/v1/vault/records/${encodeURIComponent(args.path)}`,
  });
};

// ============================================================
// Vault Graph (3D knowledge graph)
// ============================================================
export const getVaultGraph: GetVaultGraph<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/vault/graph" });
};

// ============================================================
// Vault Nebula (cluster + wikilink visualization)
// ============================================================
export const getNebulaData: GetNebulaData<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/vault/nebula-data",
    timeoutMs: 30_000,
  });
};

// ============================================================
// AI Assistants (Workers)
// ============================================================
export const getWorkerStatus: GetWorkerStatus<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  const [containers, health] = await Promise.all([
    proxyToTenant(instance, { path: "/api/v1/admin/containers" }),
    proxyToTenant(instance, { path: "/api/v1/admin/health" }),
  ]);
  return { containers, health };
};

export const triggerWorker: TriggerWorker<
  { action: string; service?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);

  switch (args.action) {
    case "restart":
      return proxyToTenant(instance, {
        method: "POST",
        path: `/api/v1/admin/containers/${args.service || "alfred"}/restart`,
      });
    case "stop":
      return proxyToTenant(instance, {
        method: "POST",
        path: `/api/v1/admin/containers/${args.service || "alfred"}/stop`,
      });
    case "start":
      return proxyToTenant(instance, {
        method: "POST",
        path: `/api/v1/admin/containers/${args.service || "alfred"}/start`,
      });
    default:
      throw new HttpError(400, `Unknown action: ${args.action}`);
  }
};

// ============================================================
// Devices
// ============================================================
export const getDevices: GetDevices<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/devices" });
};

export const approveDevice: ApproveDevice<
  { requestId: string; name?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/devices/${args.requestId}/approve`,
    body: args.name ? { name: args.name } : undefined,
  });
};

export const rejectDevice: RejectDevice<{ requestId: string }, any> = async (
  args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/devices/${args.requestId}/reject`,
  });
};

export const removeDevice: RemoveDevice<{ deviceId: string }, any> = async (
  args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "DELETE",
    path: `/api/v1/devices/${args.deviceId}`,
  });
};

// ============================================================
// Activity Feed
// ============================================================
export const getActivityFeed: GetActivityFeed<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: "/api/v1/admin/activity",
    query: { limit: "50" },
  });
};

// ============================================================
// Container Logs
// ============================================================
export const getContainerLogs: GetContainerLogs<
  { service?: string; tail?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  const service = args.service || "alfred";
  const tail = args.tail || "200";
  return proxyToTenant(instance, {
    path: `/api/v1/admin/containers/${service}/logs`,
    query: { tail },
  });
};

// ============================================================
// Credentials
// ============================================================
export const getCredentials: GetCredentials<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/admin/credentials" });
};

export const updateCredentials: UpdateCredentials<
  Record<string, string | null>,
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: "/api/v1/admin/credentials",
    body: args,
  });
};

// ============================================================
// Agent Config
// ============================================================
export const getModelCatalog: GetModelCatalog<
  { refresh?: boolean } | void,
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  const refresh = (args as any)?.refresh ? "true" : "false";
  return proxyToTenant(instance, {
    path: "/api/v1/admin/models",
    query: { refresh },
    timeoutMs: 30_000, // model fetching can be slow (multiple provider APIs)
  });
};

export const getAgentConfig: GetAgentConfig<
  { agentId?: string } | void,
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  const agentId = (args as any)?.agentId;
  const path = agentId
    ? `/api/v1/admin/agents/${encodeURIComponent(agentId)}`
    : "/api/v1/admin/agents";
  return proxyToTenant(instance, { path });
};

export const updateAgentConfig: UpdateAgentConfig<
  Record<string, any>,
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: "/api/v1/admin/agents",
    body: args,
  });
};

// ============================================================
// Agent Model (per-agent)
// ============================================================
export const updateAgentModel: UpdateAgentModel<
  { agentId: string; model: string; field?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: `/api/v1/admin/agents/${encodeURIComponent(args.agentId)}/model`,
    body: { model: args.model, field: args.field },
  });
};

// ============================================================
// Workspace Files
// ============================================================
const WORKSPACE_FILES = ["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "TOOLS.md"];

export const getWorkspaceFile: GetWorkspaceFile<
  { filename: string },
  any
> = async (args, context) => {
  if (!WORKSPACE_FILES.includes(args.filename)) {
    throw new HttpError(400, `Invalid workspace file: ${args.filename}`);
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: `/api/v1/admin/workspace/${encodeURIComponent(args.filename)}`,
  });
};

export const updateWorkspaceFile: UpdateWorkspaceFile<
  { filename: string; content: string },
  any
> = async (args, context) => {
  if (!WORKSPACE_FILES.includes(args.filename)) {
    throw new HttpError(400, `Invalid workspace file: ${args.filename}`);
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PUT",
    path: `/api/v1/admin/workspace/${encodeURIComponent(args.filename)}`,
    body: { content: args.content },
  });
};

// ============================================================
// First Brief (Onboarding Brief)
// ============================================================

export const getFirstBrief: GetFirstBrief<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);

  // Search for onboarding brief in vault events
  try {
    const data: any = await proxyToTenant(instance, {
      path: "/api/v1/vault/list/event",
    });

    if (data && Array.isArray(data.results)) {
      // Look for the onboarding brief — it has "first-brief" or "onboarding" in its name
      const briefRecord = data.results.find(
        (r: any) =>
          r.name?.toLowerCase().includes("first-brief") ||
          r.name?.toLowerCase().includes("first brief") ||
          r.name?.toLowerCase().includes("onboarding-brief") ||
          r.path?.toLowerCase().includes("first-brief"),
      );

      if (briefRecord) {
        // Fetch the full content
        const fullRecord: any = await proxyToTenant(instance, {
          path: `/api/v1/vault/records/${encodeURIComponent(briefRecord.path || `event/${briefRecord.name}`)}`,
        });

        return {
          brief: fullRecord?.content ?? fullRecord?.body ?? null,
          path: briefRecord.path || `event/${briefRecord.name}`,
          name: briefRecord.name,
        };
      }
    }
  } catch (e) {
    // Vault may not be available yet — return empty
    console.error("Failed to fetch first brief:", e);
  }

  return { brief: null, path: null, name: null };
};

export const startOnboarding: StartOnboarding<
  { streamId?: string },
  any
> = async (_args, context) => {
  if (!context.user) throw new HttpError(401);
  const instance = await getUserInstance(context);
  const userId = context.user.id;

  // Step 1: Check if Gmail stream already exists
  let gmailStream = await context.entities.Stream.findFirst({
    where: { userId, source: "gmail" },
  });

  if (!gmailStream) {
    // Step 2: Check if Google OAuth credential exists
    const credential = await context.entities.OAuthCredential.findFirst({
      where: { userId, provider: "google" },
    });
    if (!credential) {
      return { status: "no_credential", message: "No Google credential found" };
    }

    // Step 3: Create Gmail stream in SaaS DB
    const crypto = await import("crypto");
    gmailStream = await context.entities.Stream.create({
      data: {
        userId,
        name: "Gmail",
        type: "scheduled",
        source: "gmail",
        config: {
          transport: "pull",
          parser: "gmail",
          pull: {
            endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
            method: "GET",
            intervalSeconds: 300,
            detailEndpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full",
            detailIdField: "messages[*].id",
          },
        },
        webhookToken: crypto.randomBytes(24).toString("hex"),
      },
    });

    // Step 4: Create stream on tenant
    try {
      await proxyToTenant(instance, {
        method: "POST",
        path: "/api/v1/streams",
        body: {
          id: gmailStream.id,
          name: "Gmail",
          type: "scheduled",
          source: "gmail",
          config: gmailStream.config,
          enabled: true,
        },
      });
    } catch (e: any) {
      console.error("[startOnboarding] Failed to create stream on tenant:", e?.message);
    }

    // Step 5: Create stream config on tenant (for pull engine)
    try {
      await proxyToTenant(instance, {
        method: "PATCH",
        path: `/api/v1/streams/${gmailStream.id}`,
        body: {
          pull_endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
          pull_method: "GET",
          detail_endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full",
          detail_id_field: "id",
          parser: "gmail",
          auth_type: "oauth2",
          auth_config: { provider: "google", user_id: userId },
          schedule_interval_seconds: 300,
        },
      });
    } catch (e: any) {
      console.error("[startOnboarding] Failed to create stream config:", e?.message);
    }

    // Step 6: Create Temporal schedule for Gmail pull
    try {
      await proxyToTenant(instance, {
        method: "POST",
        path: "/api/v1/schedules",
        body: {
          schedule_id: "al-stream-pull-gmail",
          workflow_type: "StreamPullerWorkflow",
          task_queue: "alfred-learn",
          cron: "*/5 * * * *",
          input: { stream_id: gmailStream.id },
          overlap_policy: "Skip",
        },
      });
    } catch (e: any) {
      console.error("[startOnboarding] Failed to create pull schedule:", e?.message);
    }

    // Step 7: Trigger immediate first pull
    try {
      await proxyToTenant(instance, {
        method: "POST",
        path: "/api/v1/schedules/al-stream-pull-gmail/trigger",
      });
    } catch (e: any) {
      console.error("[startOnboarding] Failed to trigger first pull:", e?.message);
    }
  }

  // Step 8: Trigger onboarding workflow ONLY if not already running
  try {
    const progress = await proxyToTenant(instance, {
      path: "/api/v1/onboarding/progress",
    });
    const stage = progress?.stage;
    if (stage && stage !== "not_started" && stage !== "unknown") {
      console.info(`[startOnboarding] Onboarding already at stage=${stage}, skipping workflow trigger`);
      return { status: "already_running", stage, streamId: gmailStream.id };
    }
  } catch {
    // Progress endpoint not available — proceed with trigger
  }

  try {
    await proxyToTenant(instance, {
      method: "POST",
      path: "/api/v1/workflows/onboarding/start",
      body: { user_id: userId, stream_id: gmailStream.id },
      timeoutMs: 30_000,
    });
  } catch (e: any) {
    console.error("[startOnboarding] Failed to trigger onboarding workflow:", e?.message);
  }

  return { status: "started", streamId: gmailStream.id };
};

// ============================================================
// Onboarding Progress (v2)
// ============================================================

export const getOnboardingProgress: GetOnboardingProgress<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);

  try {
    return await proxyToTenant(instance, {
      path: "/api/v1/onboarding/progress",
    });
  } catch (e) {
    console.error("Failed to fetch onboarding progress:", e);
    return {
      stage: "not_started",
      progress: { current_day: 0, total_days: 0, facts_count: 0, patterns_count: 0 },
      facts_count: 0,
      patterns_count: 0,
      automations_count: 0,
      brief: "",
    };
  }
};

// Submit fact corrections and trigger brief generation
export const submitFactCorrections: any = async (
  args: { corrections: Record<string, string> },
  context: any,
) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const instance = await getUserInstance(context);

  // Write corrections to onboard.json and update stage to "brief"
  await proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/onboarding/corrections",
    body: { corrections: args.corrections },
  });

  // Trigger the onboarding workflow to resume from "brief" stage
  const userId = context.user.id;
  const stream = await prisma.stream.findFirst({
    where: { userId, source: "gmail" },
  });

  await proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/workflows",
    body: {
      workflow_type: "OnboardingPipelineWorkflow",
      task_queue: "alfred-learn",
      workflow_id: `onboarding-brief-${Date.now()}`,
      input: { user_id: userId, stream_id: stream?.id || "" },
    },
  });

  return { status: "brief_generating" };
};
