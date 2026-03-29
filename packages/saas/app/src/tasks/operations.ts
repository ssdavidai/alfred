import type {
  GetTasks,
  GetTaskDetail,
  UpdateTaskStatus,
  UpdateTask,
  GetTriage,
  GetMatters,
  GetQuarantine,
  RetryQuarantine,
  DismissQuarantine,
  GetLedgerEntries,
  GetPendingApprovals,
  ApproveAction,
  RejectAction,
  PromoteTriage,
  CreateVaultRecord,
  TriggerErrandExecution,
  GetSchedules,
  TriggerSchedule,
  PauseSchedule,
  ResumeSchedule,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";

export const getTasks: GetTasks<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/vault/list/task",
  });
};

export const getTaskDetail: GetTaskDetail<{ path: string }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: `/api/v1/vault/records/${args.path}`,
  });
};

export const updateTask: UpdateTask<{ path: string; set: Record<string, any> }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: `/api/v1/vault/records/${args.path}`,
    body: { set: args.set },
  });
};

export const updateTaskStatus: UpdateTaskStatus<{ path: string; status: string }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: `/api/v1/vault/records/${args.path}`,
    body: { set: { status: args.status } },
  });
};

export const getTriage: GetTriage<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/vault/list/triage",
  });
};

export const getMatters: GetMatters<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/vault/list/matter",
  });
};

export const getQuarantine: GetQuarantine<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/learning/quarantine",
  });
};

export const retryQuarantine: RetryQuarantine<{ id: string }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/learning/quarantine/${args.id}/retry`,
  });
};

export const dismissQuarantine: DismissQuarantine<{ id: string }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/learning/quarantine/${args.id}/dismiss`,
  });
};

export const getLedgerEntries: GetLedgerEntries<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/vault/list/ledger_entry",
  });
};

export const getPendingApprovals: GetPendingApprovals<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/approvals/pending",
  });
};

export const approveAction: ApproveAction<{ path: string }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/approvals/${args.path}/approve`,
  });
};

export const rejectAction: RejectAction<{ path: string }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/approvals/${args.path}/reject`,
  });
};

export const promoteTriage: PromoteTriage<
  { triagePath: string; matter?: string; owner?: string; priority?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/vault/promote-triage",
    body: {
      triagePath: args.triagePath,
      matter: args.matter || "",
      owner: args.owner || "human",
      priority: args.priority || "normal",
    },
  });
};

export const createVaultRecord: CreateVaultRecord<
  { type: string; name: string; fields?: Record<string, string>; content?: string; description?: string },
  any
> = async (args, context) => {
  // Always generate content with frontmatter to avoid CLI issues with spaces in names
  const fields = args.fields || {};
  const fmLines = [
    "---",
    `type: ${args.type}`,
    `name: "${args.name}"`,
    ...Object.entries(fields).map(([k, v]) => `${k}: ${String(v)}`),
    `created: ${new Date().toISOString().slice(0, 10)}`,
    "---",
  ];
  const body = args.description ? `\n# ${args.name}\n\n${args.description}\n` : `\n# ${args.name}\n`;
  const content = args.content || (fmLines.join("\n") + "\n" + body);

  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/vault/records",
    body: {
      type: args.type,
      name: `${args.type}/${args.name}.md`,
      content,
    },
  });
};

export const triggerErrandExecution: TriggerErrandExecution<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/workflows/trigger",
    body: { workflowType: "TaskRunnerWorkflow", input: {} },
  });
};

export const getSchedules: GetSchedules<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/schedules",
  });
};

export const triggerSchedule: TriggerSchedule<{ id: string }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/schedules/${args.id}/trigger`,
  });
};

export const pauseSchedule: PauseSchedule<{ id: string }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/schedules/${args.id}/pause`,
  });
};

export const resumeSchedule: ResumeSchedule<{ id: string }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/schedules/${args.id}/unpause`,
  });
};
