import type {
  GetIntuitionStatus,
  GetIntuitionInstincts,
  GetIntuitionQueue,
  GetObservations,
  GetRecentJudgments,
  GetSessions,
  RouteInput,
  EnableIntuition,
  DisableIntuition,
  UpdateInstinct,
  ResolveInstinctPromotion,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";

export const getIntuitionStatus: GetIntuitionStatus<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "GET", path: "/api/v1/learning/status" });
};

export const getIntuitionInstincts: GetIntuitionInstincts<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "GET", path: "/api/v1/learning/instincts" });
};

export const getIntuitionQueue: GetIntuitionQueue<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "GET", path: "/api/v1/learning/queue" });
};

export const routeInput: RouteInput<any, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "POST", path: "/api/v1/learning/route", body: args });
};

export const enableIntuition: EnableIntuition<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "POST", path: "/api/v1/learning/enable" });
};

export const disableIntuition: DisableIntuition<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "POST", path: "/api/v1/learning/disable" });
};

export const getObservations: GetObservations<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/vault/list/observation",
    query: { limit: "10", sort: "date_desc" },
  });
};

export const getRecentJudgments: GetRecentJudgments<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/vault/list/observation",
    query: { limit: "20", sort: "date_desc" },
  });
};

export const getSessions: GetSessions<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/vault/list/session",
  });
};

export const updateInstinct: UpdateInstinct<{ path: string; set: { discretion_threshold?: number; status?: string } }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: `/api/v1/vault/records/${args.path}`,
    body: { set: args.set },
  });
};

// Approve or decline a pending Acting promotion (#452 / #459).
// Lane I ctrl-api endpoint: POST /api/v1/learning/instincts/:slug/promotion
// Body: { approved: boolean }  Response: { tier, pending_promotion }
export const resolveInstinctPromotion: ResolveInstinctPromotion<
  { path: string; approved: boolean },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  const slug = args.path.split("/").pop() ?? args.path;
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/learning/instincts/${encodeURIComponent(slug)}/promotion`,
    body: { approved: args.approved },
  });
};
