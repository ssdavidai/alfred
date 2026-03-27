import type {
  GetTasks,
  GetTaskDetail,
  UpdateTaskStatus,
  UpdateTask,
  GetTriage,
  GetMatters,
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
